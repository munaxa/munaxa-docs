import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type TenantId,
  Settings,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_FAILURE_DISABLE_THRESHOLD,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  asId,
  webhookBackoffMs,
  webhookSignatureHeader,
  webhookSigningString,
  webhookSubscribes,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { LOGGER, type Logger } from '../../../core/observability/logger';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { OUTBOUND_HTTP_PORT, type OutboundHttpPort } from '../../../ports/outbound-http.port';
import { buildEnvelope, serialiseEnvelope } from '../domain/webhook-envelope';
import { WEBHOOK_REPOSITORY, type WebhookDeliveryService, type WebhookRepository } from './ports';

/** How many due retries one sweep settles. Bounded so a backlog does not become one long job. */
const RETRY_BATCH = 100;

/**
 * Signing, sending, retrying and dead-lettering.
 *
 * ## Write first, attempt second — and why the attempt may be lost
 *
 * `fanOut` writes every delivery row and **commits** before it sends anything. The attempt then
 * happens outside that transaction, and if the process dies mid-attempt the row is `PENDING` with
 * a `nextAttemptAt` in the past and the sweep picks it up a minute later.
 *
 * The inverse — send, then record — is what most implementations do and it loses events in the one
 * case that matters. A crash between the `POST` and the write leaves no record that anything was
 * sent, so either the event is never delivered or it is delivered twice with nothing able to tell
 * which. This is ADR-0011's argument for the outbox itself, one layer out: *the record commits, and
 * the delivery is at-least-once against it*.
 *
 * ## The signature, and the thing receivers get wrong
 *
 * HMAC-SHA256 over `v1:{unix seconds}:{exact body}` — the timestamp is **inside** the signed
 * string. A receiver that checks only a body signature accepts a captured request forever, because
 * the signature over an unchanged body never expires. With the timestamp covered, a receiver
 * enforces a window and a replay outside it fails to verify.
 *
 * The signed body is the **stored bytes**, not a re-serialisation. A receiver that parses the JSON
 * and re-encodes it before verifying will compute a different digest — a documented property of
 * every implementation of this scheme, and the reason the headers are named in `@edms/domain`
 * where a client library can read them.
 *
 * ## Every failure is the endpoint's, and it is told which
 *
 * `OutboundFailureKind` separates `REFUSED` — this deployment's allow-list said no, no socket was
 * opened — from a timeout and a network error. That distinction reaches `webhook_delivery.last_error`
 * and therefore the administrator's screen, because sending somebody to debug a firewall that is
 * working correctly is worse than telling them nothing.
 */
@Injectable()
export class DefaultWebhookDeliveryService implements WebhookDeliveryService {
  constructor(
    @Inject(WEBHOOK_REPOSITORY) private readonly repository: WebhookRepository,
    @Inject(OUTBOUND_HTTP_PORT) private readonly http: OutboundHttpPort,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async fanOut(event: {
    readonly eventId: AnyId;
    readonly tenantId: TenantId;
    readonly eventType: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly occurredAt: Date;
    readonly payload: unknown;
    readonly correlationId: string;
  }): Promise<number> {
    const now = this.clock.now();

    const queued = await this.unitOfWork.run(async () => {
      if (!(await this.settings.get(Settings.FEATURE_WEBHOOKS))) {
        return [];
      }
      const endpoints = await this.repository.activeEndpoints();
      const subscribed = endpoints.filter((endpoint) =>
        webhookSubscribes(endpoint.eventTypes, event.eventType),
      );

      const rows: AnyId[] = [];
      for (const endpoint of subscribed) {
        const deliveryId = asId<AnyId>(uuidv7(now.getTime()));
        const envelope = buildEnvelope({
          deliveryId,
          eventId: event.eventId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          tenantId: event.tenantId,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          correlationId: event.correlationId,
          attempt: 1,
        });
        const recorded = await this.repository.recordDelivery({
          id: deliveryId,
          endpointId: endpoint.id,
          eventId: event.eventId,
          eventType: event.eventType,
          payload: serialiseEnvelope(envelope),
          // Due immediately. The first attempt happens below rather than waiting for the sweep, so
          // an ordinary delivery is not up to a minute late; this value is what the sweep would
          // use if the attempt never happens.
          nextAttemptAt: now,
        });
        // `created: false` is the at-least-once case: this event has already been recorded for
        // this endpoint, so the second arrival must not become a second POST.
        if (recorded.created) {
          rows.push(recorded.id);
        }
      }
      return rows;
    });

    // Outside the transaction, deliberately. A receiver taking ten seconds must not hold a
    // database transaction — and therefore a connection, and therefore a slot in the pool — for
    // the length of somebody else's server's response time.
    for (const id of queued) {
      await this.attempt(id);
    }
    return queued.length;
  }

  async retryDue(now: Date): Promise<number> {
    const due = await this.unitOfWork.run(() => this.repository.claimDue(now, RETRY_BATCH));
    for (const delivery of due) {
      await this.attempt(delivery.id);
    }
    return due.length;
  }

  /**
   * One attempt at one delivery.
   *
   * Reads the endpoint's credential inside a short transaction, sends outside it, and settles
   * inside another. Three transactions rather than one for the reason above: the middle step is
   * somebody else's latency.
   */
  private async attempt(deliveryId: AnyId): Promise<void> {
    const prepared = await this.unitOfWork.run(async () => {
      const delivery = await this.repository.findDelivery(deliveryId);
      if (!delivery || delivery.state === 'DELIVERED' || delivery.state === 'DEAD') {
        return null;
      }
      const endpoint = await this.repository.findEndpointCredential(delivery.endpointId);
      if (!endpoint || !endpoint.enabled) {
        return null;
      }
      const maxAttempts = await this.settings.get(Settings.WEBHOOK_MAX_ATTEMPTS);
      const timeoutSeconds = await this.settings.get(Settings.WEBHOOK_TIMEOUT_SECONDS);
      return { delivery, endpoint, maxAttempts, timeoutSeconds };
    });

    if (!prepared) {
      return;
    }
    const { delivery, endpoint, maxAttempts, timeoutSeconds } = prepared;
    const attempt = delivery.attempts + 1;
    const now = this.clock.now();
    const timestamp = Math.floor(now.getTime() / 1000);
    const signature = createHmac('sha256', endpoint.secret)
      .update(webhookSigningString(timestamp, delivery.payload), 'utf8')
      .digest('hex');

    const result = await this.http.send({
      url: endpoint.url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [WEBHOOK_SIGNATURE_HEADER]: webhookSignatureHeader(signature),
        [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
        [WEBHOOK_DELIVERY_HEADER]: delivery.id,
        [WEBHOOK_EVENT_HEADER]: delivery.eventType,
        'User-Agent': 'Munaxa-Docs-Webhooks/1',
      },
      body: delivery.payload,
      timeoutMs: timeoutSeconds * 1_000,
    });

    await this.unitOfWork.run(async () => {
      // Any 2xx is an acknowledgement. A 3xx is not — redirects are not followed, for the reason
      // the outbound port gives — and neither is a 4xx: an endpoint answering 404 is misconfigured
      // rather than saying "do not send this", and treating it as success would hide that forever.
      if (result.ok && result.response.status >= 200 && result.response.status < 300) {
        await this.repository.settleDelivered(delivery.id, now, result.response.status);
        await this.repository.recordEndpointOutcome(endpoint.id, { succeeded: true, at: now });
        return;
      }

      const status = result.ok ? result.response.status : null;
      const reason = result.ok
        ? `The endpoint answered ${result.response.status}.`
        : `${result.failure.kind}: ${result.failure.reason}`;

      if (attempt >= maxAttempts) {
        // Dead-lettered, with the payload intact. 18 §8's "never silently dropped" applied to a
        // system recipient: the row is what makes a manual replay possible a week later, when the
        // outbox row it came from may have been processed and the rendering may have changed.
        await this.repository.settleDead(delivery.id, status, reason);
      } else {
        await this.repository.settleRetrying(
          delivery.id,
          new Date(now.getTime() + webhookBackoffMs(attempt, Math.random())),
          status,
          reason,
        );
      }

      const failures = endpoint.failureCount + 1;
      await this.repository.recordEndpointOutcome(endpoint.id, {
        succeeded: false,
        at: now,
        // An endpoint that has been refusing this long is a URL somebody decommissioned without
        // telling anyone. Disabling is recorded and reversible; continuing would be an outbound
        // request per event, for ever.
        ...(failures >= WEBHOOK_FAILURE_DISABLE_THRESHOLD && {
          disableReason: `${failures} consecutive failures. Last: ${reason}`,
        }),
      });
    });

    this.logger.warn('A webhook delivery did not succeed', {
      deliveryId: delivery.id,
      attempt,
      // The endpoint's identifier, never its URL: a log line is not the place for a customer's
      // internal hostname.
      endpointId: endpoint.id,
    });
  }
}

/**
 * Verifying a signature the way a receiver would.
 *
 * Exported because the integration suite asserts it, and asserting it with the *sender's* own
 * `createHmac` call would prove only that a function equals itself. This is the receiver's half,
 * written from the documented scheme, and it is what a customer's code has to be able to do.
 *
 * `timingSafeEqual` rather than `===` for the reason it always is, and the length check before it
 * because `timingSafeEqual` throws on a length mismatch rather than returning false.
 */
export function verifyWebhookSignature(input: {
  readonly secret: string;
  readonly header: string;
  readonly timestamp: string;
  readonly body: string;
  readonly now: Date;
  readonly toleranceSeconds?: number;
}): boolean {
  const [version, presented] = input.header.split('=');
  if (version !== 'v1' || presented === undefined) {
    return false;
  }
  const seconds = Number(input.timestamp);
  if (!Number.isFinite(seconds)) {
    return false;
  }
  const tolerance = input.toleranceSeconds ?? 300;
  // The replay window, and the reason the timestamp is inside the signed string rather than
  // beside it: without this a captured request is valid for ever.
  if (Math.abs(Math.floor(input.now.getTime() / 1000) - seconds) > tolerance) {
    return false;
  }
  const expected = createHmac('sha256', input.secret)
    .update(webhookSigningString(seconds, input.body), 'utf8')
    .digest('hex');
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(presented, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A signing key for an endpoint that did not bring one. 32 bytes, hex, never shown twice. */
export function generateWebhookSecret(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
}
