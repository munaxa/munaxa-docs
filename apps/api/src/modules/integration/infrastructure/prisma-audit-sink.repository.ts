import { Injectable } from '@nestjs/common';

import { type AnyId, asId } from '@edms/domain';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  AuditSinkCredential,
  AuditSinkRecord,
  AuditSinkRepository,
} from '../application/ports';

/**
 * The tenant's audit sink — at most one, enforced by a unique index on `tenant_id`.
 *
 * One per tenant rather than many, and the reason is the cursor. Every sink would need its own
 * `last_streamed_sequence`, which is fine, but 13 §6 describes *"streaming of security events to
 * an external sink"* in the singular and a second sink is a second copy of the trail leaving the
 * building for no question the first cannot answer. A tenant that genuinely needs two collectors
 * fans out on their side, where they can see both.
 */
@Injectable()
export class PrismaAuditSinkRepository implements AuditSinkRepository {
  async find(): Promise<AuditSinkRecord | null> {
    const row = await requireTransaction().auditSink.findFirst({
      where: { deletedAt: null },
      select: SINK_FIELDS,
    });
    return row ? toRecord(row) : null;
  }

  async findCredential(): Promise<AuditSinkCredential | null> {
    const row = await requireTransaction().auditSink.findFirst({
      where: { deletedAt: null },
      select: { ...SINK_FIELDS, secret: true },
    });
    return row ? { ...toRecord(row), secret: row.secret } : null;
  }

  async upsert(input: {
    readonly id: AnyId;
    readonly kind: 'PULL' | 'PUSH';
    readonly name: string;
    readonly endpointUrl: string | null;
    readonly secret: string | null;
    readonly actions: readonly string[];
    readonly enabled: boolean;
  }): Promise<AuditSinkRecord> {
    const context = requireContext();
    const row = await requireTransaction().auditSink.upsert({
      where: { tenantId: context.tenantId },
      create: {
        id: input.id,
        tenantId: context.tenantId,
        kind: input.kind,
        name: input.name,
        endpointUrl: input.endpointUrl,
        secret: input.secret,
        actions: [...input.actions],
        enabled: input.enabled,
        createdBy: context.userId,
        updatedBy: context.userId,
      },
      update: {
        kind: input.kind,
        name: input.name,
        endpointUrl: input.endpointUrl,
        // A null secret on an update **keeps** the stored one rather than clearing it. The write
        // path is the only place a secret can be set and the read path never returns one, so an
        // administrator editing the actions list has nothing to send back — and clearing it would
        // silently unsign every subsequent push.
        ...(input.secret !== null && { secret: input.secret }),
        actions: [...input.actions],
        enabled: input.enabled,
        deletedAt: null,
        deletedBy: null,
        updatedBy: context.userId,
        version: { increment: 1 },
      },
      select: SINK_FIELDS,
    });
    return toRecord(row);
  }

  /**
   * Advances the cursor, and **never rewinds it**.
   *
   * The `gte` predicate in the `where` is what enforces that: an update naming a sequence below
   * the stored one matches no row and does nothing. Two pushes racing — which the lane's
   * `perTenantConcurrency: 1` should already prevent — cannot make the later one move the cursor
   * backwards and cause a range to be sent twice.
   *
   * A collector that genuinely needs a replay has an administrator move it, which goes through the
   * upsert path and is audited. That is the right shape: rewinding a stream is a decision, not a
   * side effect.
   */
  async advance(id: AnyId, sequence: bigint, at: Date): Promise<void> {
    await requireTransaction().auditSink.updateMany({
      where: { id, lastStreamedSequence: { lt: sequence } },
      data: { lastStreamedSequence: sequence, lastStreamedAt: at, lastError: null },
    });
  }

  async recordError(id: AnyId, error: string): Promise<void> {
    await requireTransaction().auditSink.update({
      where: { id },
      data: { lastError: error.slice(0, 500) },
    });
  }

  async remove(id: AnyId, at: Date): Promise<void> {
    const context = requireContext();
    await requireTransaction().auditSink.update({
      where: { id },
      data: { deletedAt: at, deletedBy: context.userId, enabled: false },
    });
  }
}

/** Every column but `secret`, for the reason the webhook repository's `ENDPOINT_FIELDS` gives. */
const SINK_FIELDS = {
  id: true,
  kind: true,
  name: true,
  endpointUrl: true,
  actions: true,
  lastStreamedSequence: true,
  lastStreamedAt: true,
  lastError: true,
  enabled: true,
  version: true,
} as const;

interface SinkRow {
  id: string;
  kind: string;
  name: string;
  endpointUrl: string | null;
  actions: string[];
  lastStreamedSequence: bigint;
  lastStreamedAt: Date | null;
  lastError: string | null;
  enabled: boolean;
  version: number;
}

function toRecord(row: SinkRow): AuditSinkRecord {
  return {
    id: asId<AnyId>(row.id),
    kind: row.kind as 'PULL' | 'PUSH',
    name: row.name,
    endpointUrl: row.endpointUrl,
    actions: row.actions,
    lastStreamedSequence: row.lastStreamedSequence,
    lastStreamedAt: row.lastStreamedAt,
    lastError: row.lastError,
    enabled: row.enabled,
    version: row.version,
  };
}
