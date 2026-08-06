import { Injectable } from '@nestjs/common';
import type { RefreshToken as RefreshTokenRow } from '@prisma/client';
import type { RefreshTokenRecord, RefreshTokenStorePort } from '@munaxa/interfaces';
import { unsafeId } from '@munaxa/types';
import type { SessionId, TenantId, TokenFamilyId, UserId } from '@munaxa/types';

import { requireTransaction } from '../../../core/prisma/unit-of-work';

/**
 * `refresh_token`, as the platform's `RefreshTokenStorePort`.
 *
 * Rotation logic lives in `@munaxa/auth`'s `RefreshTokenService` from here; what remains here is
 * the four statements it needs, and one of them carries the whole security property.
 */
@Injectable()
export class PrismaRefreshTokenStore implements RefreshTokenStorePort {
  async save(record: RefreshTokenRecord): Promise<void> {
    await requireTransaction().refreshToken.create({
      data: {
        id: record.id,
        tenantId: record.tenantId,
        userId: record.userId,
        familyId: record.familyId,
        tokenHash: record.tokenHash,
        issuedAt: new Date(record.issuedAt),
        expiresAt: new Date(record.expiresAt),
        tokenVersion: record.tokenVersion,
      },
    });
  }

  async findByHash(tenantId: TenantId, tokenHash: string): Promise<RefreshTokenRecord | undefined> {
    const row = await requireTransaction().refreshToken.findFirst({
      where: { tokenHash, tenantId },
    });
    return row ? toRecord(row) : undefined;
  }

  async update(record: RefreshTokenRecord): Promise<void> {
    // Tenant in the predicate, not only in the payload: an update matching on `id` alone would let
    // a mis-scoped caller write across tenants, and row-level security would report it as a
    // constraint error rather than as the bug it is.
    await requireTransaction().refreshToken.updateMany({
      where: { id: record.id, tenantId: record.tenantId },
      data: {
        revokedAt: record.revokedAt === undefined ? null : new Date(record.revokedAt),
        revocationReason: record.revocationReason ?? null,
        rotatedAt: record.rotatedAt === undefined ? null : new Date(record.rotatedAt),
        replacedBy: record.replacedBy ?? null,
      },
    });
  }

  /**
   * Claim a token for rotation. Exactly one caller may ever be told `true`.
   *
   * The `rotatedAt: null` predicate is the entire mechanism, and it is the reason this is one
   * statement rather than a read followed by a write: two concurrent exchanges of the same token
   * both pass any earlier read, and precisely one of them updates a row here. The loser is
   * indistinguishable from a replay, which is the correct reading — two parties presented a
   * single-use token, and one of them should not have had it.
   *
   * Returning `true` when no row was affected would be a security defect, not a performance one.
   */
  async markRotated(
    tenantId: TenantId,
    id: string,
    at: number,
    replacedBy: string,
  ): Promise<boolean> {
    const { count } = await requireTransaction().refreshToken.updateMany({
      where: { id, tenantId, rotatedAt: null },
      data: { rotatedAt: new Date(at), replacedBy },
    });
    return count === 1;
  }

  async listFamily(
    tenantId: TenantId,
    familyId: TokenFamilyId,
  ): Promise<readonly RefreshTokenRecord[]> {
    const rows = await requireTransaction().refreshToken.findMany({
      where: { tenantId, familyId },
      orderBy: { issuedAt: 'asc' },
    });
    return rows.map(toRecord);
  }

  /**
   * Revoke every live token in a family, in one statement.
   *
   * One statement rather than a read followed by N writes, because this runs on the replay path:
   * a token issued between the read and the writes would survive the revocation it was supposed
   * to be caught by.
   */
  async revokeFamily(
    tenantId: TenantId,
    familyId: TokenFamilyId,
    at: number,
    reason: string,
  ): Promise<number> {
    const { count } = await requireTransaction().refreshToken.updateMany({
      where: { tenantId, familyId, revokedAt: null },
      data: { revokedAt: new Date(at), revocationReason: reason },
    });
    return count;
  }

  async revokeForUser(
    tenantId: TenantId,
    userId: UserId,
    at: number,
    reason: string,
  ): Promise<number> {
    const { count } = await requireTransaction().refreshToken.updateMany({
      where: { tenantId, userId, revokedAt: null },
      data: { revokedAt: new Date(at), revocationReason: reason },
    });
    return count;
  }

  async deleteExpired(tenantId: TenantId, now: number): Promise<number> {
    const { count } = await requireTransaction().refreshToken.deleteMany({
      where: { tenantId, expiresAt: { lte: new Date(now) } },
    });
    return count;
  }
}

function toRecord(row: RefreshTokenRow): RefreshTokenRecord {
  return {
    id: row.id,
    tenantId: unsafeId<TenantId>(row.tenantId),
    userId: unsafeId<UserId>(row.userId),
    familyId: unsafeId<TokenFamilyId>(row.familyId),
    tokenHash: row.tokenHash,
    issuedAt: row.issuedAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    tokenVersion: row.tokenVersion,
    // The lineage id doubles as the session id: this product's session *is* the family, which is
    // what `sessionStoreOverFamilies` established in P4.4A.
    sessionId: unsafeId<SessionId>(row.familyId),
    // `exactOptionalPropertyTypes`: absent and `undefined` are different types here, and the
    // platform reads absence as "not rotated" / "not revoked".
    ...(row.rotatedAt === null ? {} : { rotatedAt: row.rotatedAt.getTime() }),
    ...(row.replacedBy === null ? {} : { replacedBy: row.replacedBy }),
    ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt.getTime() }),
    ...(row.revocationReason === null ? {} : { revocationReason: row.revocationReason }),
  };
}
