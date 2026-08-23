import { Inject, Injectable } from '@nestjs/common';

import type { UserId } from '@edms/domain';

import type { PermissionVersionReader } from '../../../core/auth/permission-version';
import { UNIT_OF_WORK, type UnitOfWork, requireTransaction } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { CACHE_PORT, type CachePort } from '../../../ports/cache.port';

/**
 * The cache key one person's permission generation lives under.
 *
 * **Tenant-scoped, and that is load-bearing rather than decorative.** ADR-0015 gives every tenant
 * its own *database*, but Redis is shared across all of them, so it is the one store in the
 * product where two tenants' keys sit side by side. A key of `perm-version:<userId>` would be
 * correct only for as long as identifiers never collide, which is a property of uuidv7 rather than
 * a property this cache is entitled to assume.
 *
 * Exported so the reader below and the invalidation in `PrismaIdentityAdminRepository` cannot
 * drift apart: an invalidation that spelled the key differently would delete nothing and leave a
 * revoked token valid until the TTL, which is the failure this whole change exists to prevent.
 */
export function permissionVersionKey(tenantId: string, userId: string): string {
  return `perm-version:${tenantId}:${userId}`;
}

/**
 * A backstop, not the invalidation.
 *
 * `bumpPermissionVersion` deletes the key in the same transaction that raises the number, so the
 * TTL is only what covers an entry whose delete was lost — the same role the ACL cache's TTL plays
 * beside its prefix invalidation (`08 §8`). Five minutes matches `CachedSettingsReader`, and the
 * cost of being wrong for that long is bounded by the fact that nothing *grants* from here: a
 * stale entry can only delay a revocation, never widen one.
 */
const CACHE_TTL_SECONDS = 300;

/**
 * `PERMISSION_VERSION_READER` over Redis, falling through to the tenant's own database.
 *
 * The order is the security property. A hit answers from Redis; a miss reads PostgreSQL and
 * populates; a Redis *failure* throws, and is meant to. `ports/cache.port.ts` states the rule this
 * follows — "a cold cache must produce the same answer, never a different one" — and the existing
 * precedent for an unreachable Redis on an authorisation path is `PrismaAclResolver.readCache`,
 * which does not catch either: the request fails rather than proceeding on an unverified answer.
 * Catching here would turn a Redis outage into exactly the silent fail-open this port was added to
 * remove.
 */
@Injectable()
export class CachedPermissionVersionReader implements PermissionVersionReader {
  constructor(
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  async currentFor(userId: UserId): Promise<number | null> {
    const { tenantId } = requireContext();
    const key = permissionVersionKey(tenantId, String(userId));

    const cached = await this.cache.get<number>(key);
    if (typeof cached === 'number') {
      return cached;
    }

    // Its own unit of work: a guard runs before anything has opened one, which is the mistake
    // Slice 23 made and `NoActiveTransactionError` exists to report.
    const row = await this.unitOfWork.run(() =>
      requireTransaction().user.findFirst({
        // `deletedAt` is deliberately *not* filtered here. This port answers one question — which
        // generation — and account state is answered by the checks that already exist for it
        // (`canSignIn` at refresh, `revokeSessions` on disable and delete). Folding them together
        // would make a version match look like an account check and hide the day one of them
        // stopped running.
        where: { id: String(userId), tenantId },
        select: { permissionVersion: true },
      }),
    );
    if (row === null) {
      // Nobody here at all. Not cached: a row that does not exist is not a fact worth keeping, and
      // caching it would hold a restore out for the length of the TTL.
      return null;
    }

    await this.cache.set(key, row.permissionVersion, CACHE_TTL_SECONDS);
    return row.permissionVersion;
  }
}
