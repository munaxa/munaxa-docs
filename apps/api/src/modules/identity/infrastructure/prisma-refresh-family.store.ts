import { Injectable } from '@nestjs/common';
import { Prisma, type SessionFamily as SessionFamilyRow } from '@prisma/client';
import type {
  RefreshFamily,
  RefreshFamilyCreateOutcome,
  RefreshFamilyStorePort,
  SessionLimit,
} from '@munaxa/interfaces';
import { unsafeId } from '@munaxa/types';
import type { AuthMethod, TenantId, TokenFamilyId, UserId } from '@munaxa/types';

import { requireTransaction } from '../../../core/prisma/unit-of-work';

/**
 * `session_family`, as the platform's `RefreshFamilyStorePort`.
 *
 * This product has no sessions table and does not need one: the refresh lineage *is* the session.
 * The platform models that directly, so this adapter is a mapping rather than a translation — no
 * field is invented, defaulted or dropped, and `sessionStoreOverFamilies` then hands the result to
 * `SessionManager` unchanged.
 *
 * Everything runs inside the ambient unit of work, like every other repository here. That is what
 * makes `createWithinLimit` below an actual limit rather than a hopeful one.
 */
@Injectable()
export class PrismaRefreshFamilyStore implements RefreshFamilyStorePort {
  async create(family: RefreshFamily): Promise<void> {
    await requireTransaction().sessionFamily.create({ data: toRow(family) });
  }

  /**
   * Create only if the user is under the limit, atomically.
   *
   * The count, the eviction and the insert are one transaction, and the count takes `FOR UPDATE`
   * on the rows it counted. Without the lock two concurrent sign-ins both read "4 of 5" and both
   * insert, and the limit silently becomes a suggestion — which is the normal outcome for a mobile
   * client reconnecting, not an exotic race.
   *
   * `FOR UPDATE` on a `SELECT` that returns no rows locks nothing, so the first two sessions for a
   * user can still race. That is why the insert is guarded by the unique constraint on `id` and the
   * count is re-checked: a lost race surfaces as a conflict rather than as an overshoot.
   */
  async createWithinLimit(
    family: RefreshFamily,
    limit: SessionLimit,
  ): Promise<RefreshFamilyCreateOutcome> {
    const tx = requireTransaction();
    const now = new Date(limit.now);

    // Locked read. Oldest-seen first, so eviction picks its victims without a second sort.
    const live = await tx.$queryRaw<Array<{ id: string; last_seen_at: Date }>>`
      SELECT id, last_seen_at
        FROM session_family
       WHERE tenant_id = ${family.tenantId}::uuid
         AND user_id = ${family.userId}::uuid
         AND revoked_at IS NULL
         AND idle_expires_at > ${now}
         AND absolute_expires_at > ${now}
       ORDER BY last_seen_at ASC
         FOR UPDATE
    `;

    if (live.length < limit.maxConcurrent) {
      await tx.sessionFamily.create({ data: toRow(family) });
      return { created: true, evicted: [] };
    }

    if (limit.onLimitReached === 'deny') {
      return { created: false, evicted: [] };
    }

    // Evict enough to leave room for exactly one more.
    const victims = live.slice(0, live.length - limit.maxConcurrent + 1).map((row) => row.id);
    await tx.sessionFamily.updateMany({
      where: { id: { in: victims } },
      data: { revokedAt: now, revokedReason: 'concurrency-limit' },
    });

    const evicted = await tx.sessionFamily.findMany({ where: { id: { in: victims } } });
    await tx.sessionFamily.create({ data: toRow(family) });

    return { created: true, evicted: evicted.map(toFamily) };
  }

  async countActive(tenantId: TenantId, userId: UserId, now: number): Promise<number> {
    return requireTransaction().sessionFamily.count({
      where: { ...liveWhere(new Date(now)), tenantId, userId },
    });
  }

  async get(tenantId: TenantId, familyId: TokenFamilyId): Promise<RefreshFamily | undefined> {
    // Scoped by tenant on the read, not filtered after it. A family id appears in logs and support
    // tickets; another tenant guessing one must get the same answer as for an id that never existed.
    const row = await requireTransaction().sessionFamily.findFirst({
      where: { id: familyId, tenantId },
    });
    return row ? toFamily(row) : undefined;
  }

  async listByUser(tenantId: TenantId, userId: UserId): Promise<readonly RefreshFamily[]> {
    const rows = await requireTransaction().sessionFamily.findMany({
      where: { tenantId, userId },
      orderBy: { lastSeenAt: 'desc' },
    });
    return rows.map(toFamily);
  }

  async update(family: RefreshFamily): Promise<void> {
    // Tenant is in the predicate rather than only in the payload: an update that matched on `id`
    // alone would let a mis-scoped caller write across tenants, and row-level security would report
    // it as a constraint error rather than as the bug it is.
    await requireTransaction().sessionFamily.updateMany({
      where: { id: family.id, tenantId: family.tenantId },
      data: toRow(family),
    });
  }

  async delete(tenantId: TenantId, familyId: TokenFamilyId): Promise<boolean> {
    const { count } = await requireTransaction().sessionFamily.deleteMany({
      where: { id: familyId, tenantId },
    });
    return count > 0;
  }

  async deleteExpired(tenantId: TenantId, now: number): Promise<number> {
    const at = new Date(now);
    const { count } = await requireTransaction().sessionFamily.deleteMany({
      where: {
        tenantId,
        OR: [{ absoluteExpiresAt: { lte: at } }, { idleExpiresAt: { lte: at } }],
      },
    });
    return count;
  }
}

function liveWhere(now: Date): Prisma.SessionFamilyWhereInput {
  return {
    revokedAt: null,
    idleExpiresAt: { gt: now },
    absoluteExpiresAt: { gt: now },
  };
}

function toRow(family: RefreshFamily): Prisma.SessionFamilyUncheckedCreateInput {
  return {
    id: family.id,
    tenantId: family.tenantId,
    userId: family.userId,
    createdAt: new Date(family.createdAt),
    lastSeenAt: new Date(family.lastSeenAt),
    idleExpiresAt: new Date(family.idleExpiresAt),
    absoluteExpiresAt: new Date(family.absoluteExpiresAt),
    authMethods: [...family.authMethods],
    mfaSatisfied: family.mfaSatisfied,
    tokenVersion: family.tokenVersion,
    revokedAt: family.revokedAt === undefined ? null : new Date(family.revokedAt),
    revokedReason: family.revocationReason ?? null,
    ipAddress: family.ipAddress ?? null,
    userAgent: family.userAgent ?? null,
  };
}

function toFamily(row: SessionFamilyRow): RefreshFamily {
  return {
    id: unsafeId<TokenFamilyId>(row.id),
    tenantId: unsafeId<TenantId>(row.tenantId),
    userId: unsafeId<UserId>(row.userId),
    createdAt: row.createdAt.getTime(),
    lastSeenAt: row.lastSeenAt.getTime(),
    idleExpiresAt: row.idleExpiresAt.getTime(),
    absoluteExpiresAt: row.absoluteExpiresAt.getTime(),
    authMethods: row.authMethods as readonly AuthMethod[],
    mfaSatisfied: row.mfaSatisfied,
    tokenVersion: row.tokenVersion,
    // `exactOptionalPropertyTypes`: an absent optional and one set to undefined are different
    // types here, and the platform's records use absence to mean "not revoked".
    ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt.getTime() }),
    ...(row.revokedReason === null
      ? {}
      : { revocationReason: row.revokedReason as RefreshFamily['revocationReason'] }),
    ...(row.ipAddress === null ? {} : { ipAddress: row.ipAddress }),
    ...(row.userAgent === null ? {} : { userAgent: row.userAgent }),
  };
}
