import { Injectable } from '@nestjs/common';

import { type AnyId, type WebhookDeliveryStateKey, asId } from '@edms/domain';
import { type Page, type PageRequest, toPage } from '@edms/utils';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  PendingDelivery,
  WebhookDeliveryRecord,
  WebhookEndpointCredential,
  WebhookEndpointRecord,
  WebhookRepository,
} from '../application/ports';

/**
 * Webhook endpoints and their deliveries.
 *
 * Every query joins the use case's transaction and is therefore under this tenant's row-level
 * security, exactly as every repository in the product has been since Phase 1. There is no
 * `tenantId` parameter on any method: a repository that accepts one is a repository that can be
 * handed the wrong one.
 *
 * The one thing worth reading carefully is the split between `findEndpoint` and
 * `findEndpointCredential`. The signing key is on the row and has to be, because a signature is
 * computed from it on every delivery — but a read path that returned it would put it on an
 * administrator's screen, and a configuration screen that shows the signing key turns every
 * screen-share into a disclosure. Two methods, and the `select` in the first is what enforces it
 * rather than a mapper remembering to drop a field.
 */
@Injectable()
export class PrismaWebhookRepository implements WebhookRepository {
  async listEndpoints(page: PageRequest): Promise<Page<WebhookEndpointRecord>> {
    const transaction = requireTransaction();
    const where = { deletedAt: null };
    const [rows, total] = await Promise.all([
      transaction.webhookEndpoint.findMany({
        where,
        select: ENDPOINT_FIELDS,
        orderBy: { createdAt: 'desc' },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      transaction.webhookEndpoint.count({ where }),
    ]);
    return toPage(rows.map(toEndpoint), total, page);
  }

  async findEndpoint(id: AnyId): Promise<WebhookEndpointRecord | null> {
    const row = await requireTransaction().webhookEndpoint.findFirst({
      where: { id, deletedAt: null },
      select: ENDPOINT_FIELDS,
    });
    return row ? toEndpoint(row) : null;
  }

  async findEndpointCredential(id: AnyId): Promise<WebhookEndpointCredential | null> {
    const row = await requireTransaction().webhookEndpoint.findFirst({
      where: { id, deletedAt: null },
      select: { ...ENDPOINT_FIELDS, secret: true },
    });
    return row ? { ...toEndpoint(row), secret: row.secret } : null;
  }

  async activeEndpoints(): Promise<readonly WebhookEndpointRecord[]> {
    const rows = await requireTransaction().webhookEndpoint.findMany({
      where: { deletedAt: null, enabled: true },
      select: ENDPOINT_FIELDS,
      // Bounded rather than unbounded, because the fan-out is per event: a tenant that configured
      // two hundred endpoints would otherwise turn one document publication into two hundred
      // outbound requests. The bound is deliberately generous and deliberately present.
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toEndpoint);
  }

  async createEndpoint(input: {
    readonly id: AnyId;
    readonly name: string;
    readonly url: string;
    readonly secret: string;
    readonly eventTypes: readonly string[];
    readonly enabled: boolean;
  }): Promise<WebhookEndpointRecord> {
    const context = requireContext();
    const row = await requireTransaction().webhookEndpoint.create({
      data: {
        id: input.id,
        tenantId: context.tenantId,
        name: input.name,
        url: input.url,
        secret: input.secret,
        eventTypes: [...input.eventTypes],
        enabled: input.enabled,
        createdBy: context.userId,
        updatedBy: context.userId,
      },
      select: ENDPOINT_FIELDS,
    });
    return toEndpoint(row);
  }

  async updateEndpoint(
    id: AnyId,
    expectedVersion: number,
    patch: {
      readonly name?: string;
      readonly url?: string;
      readonly secret?: string;
      readonly eventTypes?: readonly string[];
      readonly enabled?: boolean;
    },
  ): Promise<WebhookEndpointRecord> {
    const context = requireContext();
    const row = await requireTransaction().webhookEndpoint.update({
      where: { id, version: expectedVersion },
      data: {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.url !== undefined && { url: patch.url }),
        ...(patch.secret !== undefined && { secret: patch.secret }),
        ...(patch.eventTypes !== undefined && { eventTypes: [...patch.eventTypes] }),
        ...(patch.enabled !== undefined && {
          enabled: patch.enabled,
          // Re-enabling clears the automatic disablement *and* its counter. An endpoint whose
          // receiver has been fixed and which came back with nineteen failures still on it would
          // disable itself again on the next hiccup, which is not what the administrator asked
          // for.
          ...(patch.enabled && { failureCount: 0, disabledAt: null, disabledReason: null }),
        }),
        updatedBy: context.userId,
        version: { increment: 1 },
      },
      select: ENDPOINT_FIELDS,
    });
    return toEndpoint(row);
  }

  async deleteEndpoint(id: AnyId, at: Date): Promise<void> {
    const context = requireContext();
    await requireTransaction().webhookEndpoint.update({
      where: { id },
      data: { deletedAt: at, deletedBy: context.userId, enabled: false },
    });
  }

  async recordDelivery(input: {
    readonly id: AnyId;
    readonly endpointId: AnyId;
    readonly eventId: AnyId;
    readonly eventType: string;
    readonly payload: string;
    readonly nextAttemptAt: Date;
  }): Promise<{ created: boolean; id: AnyId }> {
    const context = requireContext();
    /**
     * `createMany` with `skipDuplicates` rather than a find-then-create.
     *
     * The unique index on `(endpoint_id, event_id)` is what makes redelivery a no-op, and reading
     * before writing would leave a window in which two dispatchers both read nothing and both
     * write — which under the index means one of them throws inside somebody's transaction rather
     * than the second quietly doing nothing. This asks the database the question once.
     */
    const result = await requireTransaction().webhookDelivery.createMany({
      data: [
        {
          id: input.id,
          tenantId: context.tenantId,
          endpointId: input.endpointId,
          eventId: input.eventId,
          eventType: input.eventType,
          payload: input.payload,
          nextAttemptAt: input.nextAttemptAt,
        },
      ],
      skipDuplicates: true,
    });
    return { created: result.count === 1, id: input.id };
  }

  async findDelivery(id: AnyId): Promise<PendingDelivery | null> {
    const row = await requireTransaction().webhookDelivery.findFirst({ where: { id } });
    return row ? { ...toDelivery(row), payload: row.payload } : null;
  }

  /**
   * Takes this delivery out of the due window and answers it, or answers null — Slice 51.
   *
   * The predicate is the whole of it: `state` and `next_attempt_at` are what `claimDue` selects on,
   * so moving `next_attempt_at` past the attempt's own deadline is what stops a second worker
   * meeting a row that is already in flight. The affected-row count is the truth, as it is for
   * every other claim in this product — one row means this caller owns the attempt, none means
   * somebody else does.
   *
   * A lease rather than `null`, because a worker that dies mid-send must not strand the delivery:
   * `leaseUntil` is the request timeout, so the row becomes due again exactly when the attempt it
   * is waiting for could no longer be outstanding.
   */
  async claimAttempt(id: AnyId, now: Date, leaseUntil: Date): Promise<PendingDelivery | null> {
    const tx = requireTransaction();
    const { count } = await tx.webhookDelivery.updateMany({
      where: { id, state: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lte: now } },
      data: { nextAttemptAt: leaseUntil },
    });
    if (count !== 1) {
      return null;
    }
    const row = await tx.webhookDelivery.findFirst({ where: { id } });
    return row ? { ...toDelivery(row), payload: row.payload } : null;
  }

  async claimDue(now: Date, limit: number): Promise<readonly PendingDelivery[]> {
    const rows = await requireTransaction().webhookDelivery.findMany({
      where: {
        state: { in: ['PENDING', 'RETRYING'] },
        nextAttemptAt: { lte: now },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({ ...toDelivery(row), payload: row.payload }));
  }

  async settleDelivered(id: AnyId, at: Date, status: number): Promise<void> {
    await requireTransaction().webhookDelivery.update({
      where: { id },
      data: {
        state: 'DELIVERED',
        deliveredAt: at,
        responseStatus: status,
        nextAttemptAt: null,
        lastError: null,
        attempts: { increment: 1 },
      },
    });
  }

  async settleRetrying(
    id: AnyId,
    nextAttemptAt: Date,
    status: number | null,
    error: string,
  ): Promise<void> {
    await requireTransaction().webhookDelivery.update({
      where: { id },
      data: {
        state: 'RETRYING',
        nextAttemptAt,
        responseStatus: status,
        lastError: error.slice(0, 500),
        attempts: { increment: 1 },
      },
    });
  }

  async settleDead(id: AnyId, status: number | null, error: string): Promise<void> {
    await requireTransaction().webhookDelivery.update({
      where: { id },
      data: {
        state: 'DEAD',
        // Null, so the sweep never picks it up again. The row and its payload survive, which is
        // what makes a manual replay possible.
        nextAttemptAt: null,
        responseStatus: status,
        lastError: error.slice(0, 500),
        attempts: { increment: 1 },
      },
    });
  }

  async recordEndpointOutcome(
    endpointId: AnyId,
    outcome: { readonly succeeded: boolean; readonly at: Date; readonly disableReason?: string },
  ): Promise<void> {
    await requireTransaction().webhookEndpoint.update({
      where: { id: endpointId },
      data: outcome.succeeded
        ? // Reset rather than decrement: the column measures "is this endpoint dead *now*", so one
          // success means the run of failures is over.
          { failureCount: 0, lastSuccessAt: outcome.at }
        : {
            failureCount: { increment: 1 },
            lastFailureAt: outcome.at,
            ...(outcome.disableReason !== undefined && {
              enabled: false,
              disabledAt: outcome.at,
              disabledReason: outcome.disableReason.slice(0, 500),
            }),
          },
    });
  }

  async listDeliveries(
    endpointId: AnyId,
    state: WebhookDeliveryStateKey | null,
    page: PageRequest,
  ): Promise<Page<WebhookDeliveryRecord>> {
    const transaction = requireTransaction();
    const where = { endpointId, ...(state !== null && { state }) };
    const [rows, total] = await Promise.all([
      transaction.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      transaction.webhookDelivery.count({ where }),
    ]);
    return toPage(rows.map(toDelivery), total, page);
  }
}

/** Every column but `secret`. The `select` is the enforcement, not a mapper's discipline. */
const ENDPOINT_FIELDS = {
  id: true,
  name: true,
  url: true,
  eventTypes: true,
  enabled: true,
  failureCount: true,
  disabledAt: true,
  disabledReason: true,
  lastSuccessAt: true,
  lastFailureAt: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
  deletedAt: true,
  deletedBy: true,
  version: true,
} as const;

interface EndpointRow {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  failureCount: number;
  disabledAt: Date | null;
  disabledReason: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  version: number;
}

function toEndpoint(row: EndpointRow): WebhookEndpointRecord {
  return {
    id: asId<AnyId>(row.id),
    name: row.name,
    url: row.url,
    eventTypes: row.eventTypes,
    enabled: row.enabled,
    failureCount: row.failureCount,
    disabledAt: row.disabledAt,
    disabledReason: row.disabledReason,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    version: row.version,
  };
}

interface DeliveryRow {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  state: string;
  attempts: number;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: Date;
}

function toDelivery(row: DeliveryRow): WebhookDeliveryRecord {
  return {
    id: asId<AnyId>(row.id),
    endpointId: asId<AnyId>(row.endpointId),
    eventId: asId<AnyId>(row.eventId),
    eventType: row.eventType,
    state: row.state as WebhookDeliveryStateKey,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    deliveredAt: row.deliveredAt,
    responseStatus: row.responseStatus,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}
