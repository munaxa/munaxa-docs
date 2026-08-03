import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, type UserId, asId } from '@edms/domain';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import type { RefreshTokenRecord, SessionRepository } from '../application/ports';

/**
 * Session families and refresh tokens.
 *
 * `tenantId` is written from the ambient request context rather than passed in, for the same
 * reason the reads do not take one: a value a caller supplies is a value a caller can get
 * wrong, and row-level security would then reject the write with a constraint error instead
 * of the product noticing.
 */
@Injectable()
export class PrismaSessionRepository implements SessionRepository {
  constructor(@Inject(CLOCK_PORT) private readonly clock: ClockPort) {}

  async createFamily(family: {
    readonly id: AnyId;
    readonly userId: UserId;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  }): Promise<void> {
    await requireTransaction().sessionFamily.create({
      data: {
        id: family.id,
        tenantId: requireContext().tenantId,
        userId: family.userId,
        ipAddress: family.ipAddress,
        userAgent: family.userAgent,
      },
    });
  }

  async issueToken(token: {
    readonly id: AnyId;
    readonly familyId: AnyId;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    await requireTransaction().refreshToken.create({
      data: {
        id: token.id,
        tenantId: requireContext().tenantId,
        familyId: token.familyId,
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt,
      },
    });
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const row = await requireTransaction().refreshToken.findFirst({
      where: { tokenHash },
      include: { family: true },
    });
    if (!row) {
      return null;
    }
    return {
      id: asId<AnyId>(row.id),
      familyId: asId<AnyId>(row.familyId),
      userId: asId<UserId>(row.family.userId),
      expiresAt: row.expiresAt,
      usedAt: row.usedAt,
      familyRevokedAt: row.family.revokedAt,
    };
  }

  /**
   * Claims a token by marking it used, and reports whether this call is the one that did it.
   *
   * The `usedAt: null` predicate is the whole mechanism: two concurrent refreshes with the
   * same token both pass the earlier read, and exactly one of them updates a row here. The
   * loser is told `false` and treats it as replay, which is the correct reading — one of the
   * two callers is holding a token it should not have.
   */
  async markUsed(tokenId: AnyId, at: Date): Promise<boolean> {
    const { count } = await requireTransaction().refreshToken.updateMany({
      where: { id: tokenId, usedAt: null },
      data: { usedAt: at },
    });
    return count === 1;
  }

  async revokeFamily(familyId: AnyId, reason: string): Promise<void> {
    await requireTransaction().sessionFamily.updateMany({
      where: { id: familyId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
  }

  async revokeAllForUser(userId: UserId, reason: string): Promise<void> {
    await requireTransaction().sessionFamily.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
  }
}
