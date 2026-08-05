import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  type DelegationEdge,
  type DelegationId,
  type DelegationKindKey,
  DelegationStatus,
  type DelegationStatusKey,
  type PermissionKey,
  type UserId,
  asId,
} from '@edms/domain';
import { type Page, skipFor, toPage } from '@edms/utils';

import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  DelegationListRequest,
  DelegationRecord,
  DelegationRepository,
  DelegationUseRecord,
  DelegationView,
} from '../application/ports';

/**
 * Delegations, in the database.
 *
 * Three things here are worth reading rather than skimming.
 *
 * **`listActiveFor` filters on the period as well as the status**, in SQL. The authority predicate
 * is what makes an expired delegation inert, and pushing it into the query rather than filtering in
 * the service is what makes it inert *whatever* calls this — including a future caller that forgets
 * to check. `ix_delegation_delegate` is partial on `ACTIVE`, so the status half of the predicate is
 * the index and the period half is a range on rows already narrowed to a handful.
 *
 * **`transition` carries the expected status in its `WHERE`.** Zero rows affected means somebody
 * moved it first, which the service turns into a conflict rather than an overwrite — the same
 * shape as the engine's `decideIfPending`, and for the same reason: approving a delegation
 * somebody revoked a moment ago would put back an authority its delegator had taken away.
 *
 * **Nothing here deletes.** There is no `delete` method, and that absence is load-bearing:
 * `approval_task.delegation_id` restricts, so a delegation under which anything was decided cannot
 * be removed even by a caller that wanted to — and a revoked delegation is exactly the one an
 * investigation asks about.
 */
@Injectable()
export class PrismaDelegationRepository implements DelegationRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async findById(id: DelegationId): Promise<DelegationRecord | null> {
    const row = await requireTransaction().delegation.findFirst({
      where: { id, tenantId: this.tenantId() },
    });
    return row === null ? null : toRecord(row);
  }

  /**
   * The row lock every write path takes first.
   *
   * `FOR UPDATE` on the delegation alone, and it never contends with the workflow engine's own
   * lock: a decision locks its approval instance and *reads* this table, so the two orders never
   * cross. What it does serialise is two administrators acting on one delegation at once.
   */
  async lock(id: DelegationId): Promise<boolean> {
    const rows = await requireTransaction().$queryRaw<{ id: string }[]>`
      SELECT id FROM delegation
      WHERE id = ${id}::uuid AND tenant_id = ${this.tenantId()}::uuid
      FOR UPDATE
    `;
    return rows.length > 0;
  }

  async listActiveFor(delegateId: UserId, at: Date): Promise<readonly DelegationRecord[]> {
    const rows = await requireTransaction().delegation.findMany({
      where: {
        tenantId: this.tenantId(),
        delegateId,
        status: DelegationStatus.ACTIVE,
        // Half-open, matching `delegationCoversInstant`: a delegation ending at nine and one
        // starting at nine are never both in force for the same millisecond.
        startsAt: { lte: at },
        endsAt: { gt: at },
      },
      orderBy: { startsAt: Prisma.SortOrder.desc },
    });
    return rows.map(toRecord);
  }

  /**
   * Every delegation in force in the tenant, as chain edges.
   *
   * A whole-tenant read, deliberately, and it is the cheapest correct shape: a cycle is a property
   * of the graph rather than of any pair in it, and the graph is a handful of rows — a delegation
   * is a fortnight's arrangement between two people, not a row per document. Three columns, from
   * the partial index, and only on the creation path.
   */
  async liveEdges(at: Date): Promise<readonly DelegationEdge[]> {
    const rows = await requireTransaction().delegation.findMany({
      where: {
        tenantId: this.tenantId(),
        status: DelegationStatus.ACTIVE,
        startsAt: { lte: at },
        endsAt: { gt: at },
      },
      select: { delegatorId: true, delegateId: true, depth: true },
    });
    return rows.map((row) => ({
      delegatorId: row.delegatorId,
      delegateId: row.delegateId,
      depth: row.depth,
    }));
  }

  /** The sweep's read: in force, and past its end date. Oldest first, so a bounded pass is fair. */
  async listEndedButActive(at: Date, limit: number): Promise<readonly DelegationRecord[]> {
    const rows = await requireTransaction().delegation.findMany({
      where: {
        tenantId: this.tenantId(),
        status: DelegationStatus.ACTIVE,
        endsAt: { lte: at },
      },
      orderBy: { endsAt: Prisma.SortOrder.asc },
      take: limit,
    });
    return rows.map(toRecord);
  }

  async create(delegation: DelegationRecord): Promise<void> {
    await requireTransaction().delegation.create({
      data: {
        id: delegation.id,
        tenantId: this.tenantId(),
        delegatorId: delegation.delegatorId,
        delegateId: delegation.delegateId,
        kind: delegation.kind,
        status: delegation.status,
        permissions: [...delegation.permissions],
        startsAt: delegation.startsAt,
        endsAt: delegation.endsAt,
        reason: delegation.reason,
        depth: delegation.depth,
        requestedAt: delegation.requestedAt,
        approvedById: delegation.approvedById,
        approvedAt: delegation.approvedAt,
        ...this.stamps.creation(),
      },
    });
  }

  async transition(input: {
    readonly id: DelegationId;
    readonly from: readonly DelegationStatusKey[];
    readonly to: DelegationStatusKey;
    readonly at: Date;
    readonly approvedById?: UserId | null;
    readonly declineReason?: string | null;
    readonly revokedById?: UserId | null;
    readonly revokeReason?: string | null;
  }): Promise<boolean> {
    const result = await requireTransaction().delegation.updateMany({
      // The expected status is in the `WHERE`, which is what makes the race impossible rather than
      // unlikely. A read-then-write leaves a window however short the transaction is.
      where: {
        id: input.id,
        tenantId: this.tenantId(),
        status: { in: [...input.from] },
      },
      data: {
        status: input.to,
        ...(input.approvedById !== undefined && {
          approvedById: input.approvedById,
          approvedAt: input.at,
        }),
        ...(input.declineReason !== undefined && { declineReason: input.declineReason }),
        ...(input.revokedById !== undefined && {
          revokedById: input.revokedById,
          revokedAt: input.at,
        }),
        ...(input.revokeReason !== undefined && { revokeReason: input.revokeReason }),
        ...this.stamps.update(),
        version: { increment: 1 },
      },
    });
    return result.count > 0;
  }

  // --- The read side --------------------------------------------------------------------------

  async list(request: DelegationListRequest): Promise<Page<DelegationView>> {
    const tx = requireTransaction();
    const where = this.filterFor(request);

    const [rows, total] = await Promise.all([
      tx.delegation.findMany({
        where,
        orderBy: [{ requestedAt: Prisma.SortOrder.desc }],
        skip: skipFor(request),
        take: request.pageSize,
        include: {
          delegator: { select: { displayName: true } },
          delegate: { select: { displayName: true } },
          // Counted rather than loaded: the list shows "used three times" and the history screen
          // is what loads them. A list that loaded every decision under every delegation would be
          // a page whose cost grows with how much work the delegate did.
          _count: { select: { tasks: true } },
        },
      }),
      tx.delegation.count({ where }),
    ]);

    const approverIds = rows
      .map((row) => row.approvedById)
      .filter((id): id is string => id !== null);
    const approvers =
      approverIds.length === 0
        ? new Map<string, string>()
        : new Map(
            (
              await tx.user.findMany({
                where: { tenantId: this.tenantId(), id: { in: approverIds } },
                select: { id: true, displayName: true },
              })
            ).map((user) => [user.id, user.displayName]),
          );

    return toPage(
      rows.map((row) => ({
        ...toRecord(row),
        delegatorName: row.delegator.displayName,
        delegateName: row.delegate.displayName,
        approvedByName:
          row.approvedById === null ? null : (approvers.get(row.approvedById) ?? null),
        useCount: row._count.tasks,
      })),
      total,
      request,
    );
  }

  /**
   * Everything decided under one delegation — §4's visibility rule, as a query.
   *
   * Read from `approval_task` rather than from a table of its own, because the task *is* the
   * record: it carries the decision, both identities and the delegation, and a second table would
   * be a copy that could disagree with it.
   */
  async usesOf(id: DelegationId): Promise<readonly DelegationUseRecord[]> {
    const rows = await requireTransaction().approvalTask.findMany({
      where: { tenantId: this.tenantId(), delegationId: id },
      orderBy: { decidedAt: Prisma.SortOrder.desc },
      include: {
        instance: {
          select: {
            document: {
              select: { id: true, title: true, documentNumber: true },
            },
          },
        },
      },
    });

    const deciderIds = [
      ...new Set(rows.map((row) => row.decidedById).filter((id): id is string => id !== null)),
    ];
    const names =
      deciderIds.length === 0
        ? new Map<string, string>()
        : new Map(
            (
              await requireTransaction().user.findMany({
                where: { tenantId: this.tenantId(), id: { in: deciderIds } },
                select: { id: true, displayName: true },
              })
            ).map((user) => [user.id, user.displayName]),
          );

    return rows.map((row) => ({
      taskId: row.id,
      documentId: row.instance.document.id,
      documentTitle: row.instance.document.title,
      documentNumber: row.instance.document.documentNumber,
      decision: row.decision,
      decidedById: asId<UserId>(row.decidedById ?? ''),
      decidedByName: row.decidedById === null ? null : (names.get(row.decidedById) ?? null),
      onBehalfOfId: asId<UserId>(row.onBehalfOfId ?? ''),
      decidedAt: row.decidedAt,
    }));
  }

  /**
   * Which rows a list request asks for.
   *
   * `AWAITING_MY_APPROVAL` is not a filter over the other two and never could be: a request
   * awaiting me names me as neither delegator nor delegate. `approvableDelegatorIds` absent means
   * "no narrowing", which is what a tenant administrator's `user:manage` earns — an empty array
   * means "nobody", which is what somebody who manages no one sees.
   */
  private filterFor(request: DelegationListRequest): Prisma.DelegationWhereInput {
    const base: Prisma.DelegationWhereInput = { tenantId: this.tenantId() };

    if (request.direction === 'AWAITING_MY_APPROVAL') {
      return {
        ...base,
        status: DelegationStatus.PENDING_APPROVAL,
        // Never my own, on either side. The refusal in the service says the same thing; saying it
        // here too means the queue never shows a row the approval would then refuse.
        delegatorId: {
          not: request.userId,
          ...(request.approvableDelegatorIds !== undefined && {
            in: [...request.approvableDelegatorIds],
          }),
        },
        delegateId: { not: request.userId },
      };
    }

    return {
      ...base,
      ...(request.direction === 'GIVEN'
        ? { delegatorId: request.userId }
        : { delegateId: request.userId }),
      ...(request.status !== undefined
        ? { status: request.status }
        : request.includeEnded
          ? {}
          : { status: { in: [DelegationStatus.PENDING_APPROVAL, DelegationStatus.ACTIVE] } }),
    };
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

interface DelegationRow {
  readonly id: string;
  readonly delegatorId: string;
  readonly delegateId: string;
  readonly kind: string;
  readonly status: string;
  readonly permissions: string[];
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly reason: string | null;
  readonly depth: number;
  readonly requestedAt: Date;
  readonly approvedById: string | null;
  readonly approvedAt: Date | null;
  readonly declineReason: string | null;
  readonly revokedById: string | null;
  readonly revokedAt: Date | null;
  readonly revokeReason: string | null;
  readonly version: number;
}

function toRecord(row: DelegationRow): DelegationRecord {
  return {
    id: asId<DelegationId>(row.id),
    delegatorId: asId<UserId>(row.delegatorId),
    delegateId: asId<UserId>(row.delegateId),
    kind: row.kind as DelegationKindKey,
    status: row.status as DelegationStatusKey,
    permissions: row.permissions as readonly PermissionKey[],
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    reason: row.reason,
    depth: row.depth,
    requestedAt: row.requestedAt,
    approvedById: row.approvedById === null ? null : asId<UserId>(row.approvedById),
    approvedAt: row.approvedAt,
    declineReason: row.declineReason,
    revokedById: row.revokedById === null ? null : asId<UserId>(row.revokedById),
    revokedAt: row.revokedAt,
    revokeReason: row.revokeReason,
    version: row.version,
  };
}
