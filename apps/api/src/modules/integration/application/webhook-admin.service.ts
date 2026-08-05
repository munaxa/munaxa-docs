import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, type WebhookDeliveryStateKey, AuditSubjectType, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';
import type { Page, PageRequest } from '@edms/utils';

import { NotFoundError, ValidationError } from '../../../core/errors/application-errors';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { OUTBOUND_HTTP_PORT, type OutboundHttpPort } from '../../../ports/outbound-http.port';
import { IntegrationAudit } from '../domain/audit-actions';
import { generateWebhookSecret } from './webhook-delivery.service';
import {
  WEBHOOK_REPOSITORY,
  type WebhookDeliveryRecord,
  type WebhookEndpointRecord,
  type WebhookRepository,
} from './ports';

export interface CreateWebhookCommand {
  readonly name: string;
  readonly url: string;
  readonly secret?: string;
  readonly eventTypes: readonly string[];
  readonly enabled: boolean;
}

export interface UpdateWebhookCommand {
  readonly name?: string;
  readonly url?: string;
  readonly secret?: string;
  readonly eventTypes?: readonly string[];
  readonly enabled?: boolean;
}

export interface CreatedWebhook {
  readonly endpoint: WebhookEndpointRecord;
  /** Returned once. Generated when the caller did not bring one; never readable again. */
  readonly secret: string;
}

/**
 * Administering webhook endpoints.
 *
 * The one decision worth reading is that **the URL is checked against the outbound allow-list at
 * save time**, not only at delivery time. It is checked at delivery time too — the port does that
 * unconditionally and cannot be talked out of it — but a save that succeeded and then produced a
 * `REFUSED` on every delivery would send an administrator hunting through a delivery log for a
 * fact this deployment knew the moment they pressed the button.
 *
 * `permits()` makes no request, so asking it is not itself an SSRF: it answers the policy question
 * — scheme, allow-list, resolved address — and opens no socket.
 */
@Injectable()
export class WebhookAdminService {
  constructor(
    @Inject(WEBHOOK_REPOSITORY) private readonly repository: WebhookRepository,
    @Inject(OUTBOUND_HTTP_PORT) private readonly http: OutboundHttpPort,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    private readonly writer: AdministeredWriter,
  ) {}

  list(page: PageRequest): Promise<Page<WebhookEndpointRecord>> {
    return this.writer.read(() => this.repository.listEndpoints(page));
  }

  async get(id: string): Promise<WebhookEndpointRecord> {
    const endpoint = await this.writer.read(() => this.repository.findEndpoint(asId<AnyId>(id)));
    if (!endpoint) {
      throw new NotFoundError('webhook endpoint');
    }
    return endpoint;
  }

  listDeliveries(
    endpointId: string,
    state: WebhookDeliveryStateKey | null,
    page: PageRequest,
  ): Promise<Page<WebhookDeliveryRecord>> {
    return this.writer.read(() =>
      this.repository.listDeliveries(asId<AnyId>(endpointId), state, page),
    );
  }

  async create(command: CreateWebhookCommand): Promise<CreatedWebhook> {
    await this.refuseUnreachable(command.url);
    const secret = command.secret ?? generateWebhookSecret();
    const id = asId<AnyId>(uuidv7(this.clock.now().getTime()));

    const endpoint = await this.writer.write(async () => {
      const created = await this.repository.createEndpoint({
        id,
        name: command.name.trim(),
        url: command.url,
        secret,
        eventTypes: command.eventTypes,
        enabled: command.enabled,
      });
      return {
        result: created,
        change: {
          action: IntegrationAudit.WEBHOOK_ENDPOINT_CHANGED,
          subjectType: AuditSubjectType.INTEGRATION,
          subjectId: id,
          operation: AdministrativeOperation.CREATED,
          // The URL is in the trail, and that is deliberate: where a tenant's events go is exactly
          // the fact an investigation into a leak needs. The **secret** is not, for the reason a
          // password hash is not — a trail carrying it would be a second store of the credential.
          after: {
            name: created.name,
            url: created.url,
            eventTypes: [...created.eventTypes],
            enabled: created.enabled,
          },
        },
      };
    });

    return { endpoint, secret };
  }

  async update(
    id: string,
    expectedVersion: number | undefined,
    command: UpdateWebhookCommand,
  ): Promise<WebhookEndpointRecord> {
    if (command.url !== undefined) {
      await this.refuseUnreachable(command.url);
    }
    const endpointId = asId<AnyId>(id);
    return this.writer.write(async () => {
      const existing = await this.repository.findEndpoint(endpointId);
      if (!existing) {
        throw new NotFoundError('webhook endpoint');
      }
      const updated = await this.repository.updateEndpoint(
        endpointId,
        expectedVersion ?? existing.version,
        command,
      );
      return {
        result: updated,
        change: {
          action: IntegrationAudit.WEBHOOK_ENDPOINT_CHANGED,
          subjectType: AuditSubjectType.INTEGRATION,
          subjectId: endpointId,
          operation: AdministrativeOperation.UPDATED,
          before: {
            url: existing.url,
            eventTypes: [...existing.eventTypes],
            enabled: existing.enabled,
          },
          after: {
            url: updated.url,
            eventTypes: [...updated.eventTypes],
            enabled: updated.enabled,
            // Whether the key was rotated, never what it was rotated to.
            ...(command.secret !== undefined && { secretRotated: true }),
          },
        },
      };
    });
  }

  async remove(id: string): Promise<void> {
    const endpointId = asId<AnyId>(id);
    await this.writer.write(async () => {
      const existing = await this.repository.findEndpoint(endpointId);
      if (!existing) {
        throw new NotFoundError('webhook endpoint');
      }
      await this.repository.deleteEndpoint(endpointId, this.clock.now());
      return {
        result: undefined,
        change: {
          action: IntegrationAudit.WEBHOOK_ENDPOINT_CHANGED,
          subjectType: AuditSubjectType.INTEGRATION,
          subjectId: endpointId,
          operation: AdministrativeOperation.DELETED,
          before: { name: existing.name, url: existing.url },
        },
      };
    });
  }

  /**
   * Refuses a URL this deployment would never send to, at the moment somebody saves it.
   *
   * The message carries the port's own reason — "that host is not on this deployment's outbound
   * allow-list" — because the fix is an operator's rather than the administrator's, and a generic
   * "invalid URL" would send them to check their typing instead of asking for a host to be
   * allowed.
   */
  private async refuseUnreachable(url: string): Promise<void> {
    const verdict = await this.http.permits(url);
    if (!verdict.allowed) {
      throw new ValidationError(verdict.reason ?? 'That URL cannot be used.');
    }
  }
}
