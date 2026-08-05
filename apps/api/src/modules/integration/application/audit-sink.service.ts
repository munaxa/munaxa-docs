import { createHmac } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  Settings,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  asId,
  sinkCarries,
  webhookSignatureHeader,
  webhookSigningString,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { OUTBOUND_HTTP_PORT, type OutboundHttpPort } from '../../../ports/outbound-http.port';
import { IntegrationAudit } from '../domain/audit-actions';
import {
  AUDIT_SINK_REPOSITORY,
  AUDIT_STREAM_SOURCE,
  type AuditSinkRecord,
  type AuditSinkRepository,
  type AuditStreamSource,
} from './ports';
import { generateWebhookSecret } from './webhook-delivery.service';

export interface UpsertAuditSinkCommand {
  readonly kind: 'PULL' | 'PUSH';
  readonly name: string;
  readonly endpointUrl?: string;
  readonly secret?: string;
  readonly actions: readonly string[];
  readonly enabled: boolean;
}

/** One event, as a SIEM receives it. Flat, because that is what a collector's parser wants. */
export interface StreamedEvent {
  readonly sequence: string;
  readonly id: string;
  readonly occurredAt: string;
  readonly actorId: string | null;
  readonly onBehalfOfId: string | null;
  readonly apiClientId: string | null;
  readonly channel: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcome: string;
  readonly correlationId: string;
  readonly reason: string | null;
  /** The chain digest and the field set it covers, so a consumer can verify what it stored. */
  readonly hash: string;
  readonly previousHash: string;
  readonly chainHashVersion: number;
}

export interface StreamPage {
  readonly events: readonly StreamedEvent[];
  readonly cursor: bigint;
  readonly hasMore: boolean;
}

/**
 * 13 §6's SIEM row, and the three earlier phases waiting on it by name — Phase 9's optional
 * per-tenant sink, Phase 11's `DELEGATION_*` and Phase 12's `NOTIFICATION_SUPPRESSED`.
 *
 * ## What a sink is: both shapes, because they are not alternatives
 *
 * `PULL` is a cursor the customer's collector polls with an ordinary API key. It makes **no
 * outbound request at all**, which means it works for a collector inside the customer's own
 * network — the common case — and it cannot be the source of an SSRF because there is no URL.
 *
 * `PUSH` posts batches to an HTTPS collector on this deployment's allow-list, signed with the same
 * HMAC construction a webhook uses. It costs the whole of 17 §6's SSRF row, which is why the two
 * are configured separately rather than one being a mode of the other.
 *
 * ## The cursor, and why this integration is worth having
 *
 * `audit_event.sequence` is per-tenant, monotonic and **gap-free** — allocated as `max + 1` under
 * an advisory lock rather than from a PostgreSQL sequence, precisely so that a hole is visible
 * (13 §3). That is a stronger completeness guarantee than most SIEM integrations can offer: a
 * consumer that has stored sequence N and receives N+2 *knows* it missed one, rather than hoping a
 * timestamp window caught everything. Every page carries the hash and the chain version beside the
 * event, so a collector can verify the chain it stored without asking us again.
 *
 * The cursor is therefore a sequence and never an offset or a timestamp. An offset gives a
 * different answer depending on when it is asked; a timestamp cannot distinguish "nothing happened
 * in that second" from "something did and we missed it".
 *
 * ## What the stream is not filtered by
 *
 * Not by the ACL resolver, and that is 08 §10's decision rather than an omission here: the trail
 * is not ACL-filtered, which is why `audit:view` and `audit:export` exist as tenant-wide
 * permissions. A sink is `audit:export`'s reach by construction — a machine token reaching it
 * holds `AUDIT_READ`, whose scope admits exactly those two keys and nothing else.
 */
@Injectable()
export class AuditSinkService {
  constructor(
    @Inject(AUDIT_SINK_REPOSITORY) private readonly repository: AuditSinkRepository,
    @Inject(AUDIT_STREAM_SOURCE) private readonly audit: AuditStreamSource,
    @Inject(OUTBOUND_HTTP_PORT) private readonly http: OutboundHttpPort,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    private readonly writer: AdministeredWriter,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  get(): Promise<AuditSinkRecord | null> {
    return this.writer.read(() => this.repository.find());
  }

  async upsert(command: UpsertAuditSinkCommand): Promise<AuditSinkRecord> {
    // The pair is checked here rather than in the schema because it is a *relationship* between
    // two fields, and a zod refinement expressing it would have to be repeated in the web form.
    // The message names which of the two is wrong.
    if (command.kind === 'PUSH' && !command.endpointUrl) {
      throw new ValidationError('A push sink needs a collector URL.');
    }
    if (command.kind === 'PULL' && command.endpointUrl) {
      throw new ValidationError('A pull sink is polled and has no URL to post to.');
    }
    if (command.endpointUrl) {
      const verdict = await this.http.permits(command.endpointUrl);
      if (!verdict.allowed) {
        throw new ValidationError(verdict.reason ?? 'That URL cannot be used.');
      }
    }

    const id = asId<AnyId>(uuidv7(this.clock.now().getTime()));
    return this.writer.write(async () => {
      const existing = await this.repository.find();
      const upserted = await this.repository.upsert({
        id: existing?.id ?? id,
        kind: command.kind,
        name: command.name.trim(),
        endpointUrl: command.endpointUrl ?? null,
        // A push sink with no secret gets one generated: an unsigned batch of somebody's audit
        // trail arriving at a collector is a batch the collector cannot attribute to us.
        secret:
          command.secret ??
          (command.kind === 'PUSH' && existing === null ? generateWebhookSecret() : null),
        actions: command.actions,
        enabled: command.enabled,
      });
      return {
        result: upserted,
        change: {
          action: IntegrationAudit.AUDIT_SINK_CHANGED,
          subjectType: AuditSubjectType.INTEGRATION,
          subjectId: upserted.id,
          operation:
            existing === null ? AdministrativeOperation.CREATED : AdministrativeOperation.UPDATED,
          ...(existing && {
            before: {
              kind: existing.kind,
              endpointUrl: existing.endpointUrl,
              enabled: existing.enabled,
            },
          }),
          after: {
            kind: upserted.kind,
            endpointUrl: upserted.endpointUrl,
            enabled: upserted.enabled,
            actions: [...upserted.actions],
          },
        },
      };
    });
  }

  async remove(): Promise<void> {
    await this.writer.write(async () => {
      const existing = await this.repository.find();
      if (!existing) {
        throw new NotFoundError('audit sink');
      }
      await this.repository.remove(existing.id, this.clock.now());
      return {
        result: undefined,
        change: {
          action: IntegrationAudit.AUDIT_SINK_CHANGED,
          subjectType: AuditSubjectType.INTEGRATION,
          subjectId: existing.id,
          operation: AdministrativeOperation.DELETED,
          before: { kind: existing.kind, name: existing.name },
        },
      };
    });
  }

  /**
   * The pull cursor, served to a collector.
   *
   * Gated on the feature flag as well as on `audit:export`, because 13 §6 calls the sink *optional
   * per tenant* and a tenant that has not turned it on has not agreed to its trail being polled.
   * The refusal is `403` rather than `404`: the caller holds the permission and the surface exists,
   * which is exactly what 15 §4's table distinguishes the two by.
   */
  async page(afterSequence: bigint, limit: number | undefined): Promise<StreamPage> {
    const enabled = await this.settings.get(Settings.FEATURE_AUDIT_STREAMING);
    if (!enabled) {
      throw new ForbiddenError('stream this tenant’s audit trail', {
        requires: 'audit streaming to be enabled for this tenant',
      });
    }
    const size = limit ?? (await this.settings.get(Settings.AUDIT_STREAM_PAGE_SIZE));
    // One transaction for the sink row and the chain slice together, so a collector's page cannot
    // straddle a configuration change: reading the action filter and then the events in two
    // transactions could apply yesterday's filter to today's rows.
    return this.writer.read(async () => {
      const sink = await this.repository.find();
      return this.readPage(afterSequence, size, sink?.actions ?? []);
    });
  }

  /**
   * One push pass for this tenant — the `audit.stream-sinks` schedule's work.
   *
   * Reads from the stored cursor, posts, and advances the cursor **only on a 2xx**. The order is
   * the whole of the reliability argument: advancing first and posting second would lose a range
   * on any failure, and there is no way to discover which range was lost because the cursor no
   * longer points at it.
   *
   * A failure is recorded on the sink and the cursor stays where it was, so the next pass a minute
   * later sends the same range again. That is at-least-once, deliberately, and it is safe because
   * the events carry their sequence: a collector that already stored 400–500 and receives them
   * again stores them idempotently on that key.
   */
  async push(): Promise<{ readonly sent: number }> {
    const enabled = await this.settings.get(Settings.FEATURE_AUDIT_STREAMING);
    if (!enabled) {
      return { sent: 0 };
    }
    const sink = await this.writer.read(() => this.repository.findCredential());
    if (!sink || !sink.enabled || sink.kind !== 'PUSH' || !sink.endpointUrl || !sink.secret) {
      return { sent: 0 };
    }

    const size = await this.settings.get(Settings.AUDIT_STREAM_PAGE_SIZE);
    const page = await this.writer.read(() =>
      this.readPage(sink.lastStreamedSequence, size, sink.actions),
    );
    if (page.events.length === 0) {
      return { sent: 0 };
    }

    const body = JSON.stringify({ events: page.events, cursor: page.cursor.toString() });
    const timestamp = Math.floor(this.clock.now().getTime() / 1000);
    const signature = createHmac('sha256', sink.secret)
      .update(webhookSigningString(timestamp, body), 'utf8')
      .digest('hex');

    const result = await this.http.send({
      url: sink.endpointUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [WEBHOOK_SIGNATURE_HEADER]: webhookSignatureHeader(signature),
        [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
        'User-Agent': 'Munaxa-Docs-AuditStream/1',
      },
      body,
      timeoutMs: 30_000,
    });

    if (result.ok && result.response.status >= 200 && result.response.status < 300) {
      await this.writer.read(() => this.repository.advance(sink.id, page.cursor, this.clock.now()));
      return { sent: page.events.length };
    }

    const reason = result.ok
      ? `The collector answered ${result.response.status}.`
      : `${result.failure.kind}: ${result.failure.reason}`;
    await this.writer.read(() => this.repository.recordError(sink.id, reason));
    this.logger.warn('An audit sink push did not succeed', { sinkId: sink.id });
    return { sent: 0 };
  }

  /**
   * One contiguous range of the chain, filtered to the actions the sink asked for.
   *
   * The filter is applied **after** the slice rather than inside it, and the cursor advances past
   * the *whole* slice rather than past the last carried event. That is the decision that keeps the
   * stream terminating: a tenant streaming only `LOGIN_FAILED` whose next ten thousand rows are
   * document views would otherwise have a cursor that never moves, and every pass would re-read
   * the same ten thousand rows to send nothing.
   *
   * The consequence is stated rather than hidden: a **filtered** stream is no longer gap-free by
   * sequence, because the gaps are the rows the tenant asked not to receive. An **unfiltered**
   * sink — the default, an empty action list — keeps the guarantee in full, and that is the
   * configuration a consumer relying on completeness must use.
   */
  private async readPage(
    afterSequence: bigint,
    limit: number,
    actions: readonly string[],
  ): Promise<StreamPage> {
    const events = await this.audit.sliceBySequence(afterSequence, limit);
    if (events.length === 0) {
      return { events: [], cursor: afterSequence, hasMore: false };
    }
    const last = events[events.length - 1];
    return {
      events: events
        .filter((event) => sinkCarries(actions, event.action))
        .map((event) => ({
          sequence: event.sequence.toString(),
          id: event.id,
          occurredAt: event.occurredAt.toISOString(),
          actorId: event.actorId,
          onBehalfOfId: event.onBehalfOfId,
          apiClientId: event.apiClientId,
          channel: event.channel,
          action: event.action,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
          outcome: event.outcome,
          correlationId: event.correlationId,
          reason: event.reason,
          hash: event.hash,
          previousHash: event.previousHash,
          chainHashVersion: event.chainHashVersion,
        })),
      cursor: last?.sequence ?? afterSequence,
      hasMore: events.length === limit,
    };
  }
}
