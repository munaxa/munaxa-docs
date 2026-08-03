import type { AnyId, TenantId, UserId } from './ids';

/**
 * The field contracts every persisted record inherits. They are types, not classes: a
 * domain entity in a module composes the ones it needs, and the Prisma schema mirrors the
 * same columns (`docs/architecture/05-database-design.md` §1). Keeping them as types means
 * a repository mapper cannot forget `tenantId` and still compile.
 */

/** Identity. Every record has a UUID v7 primary key. */
export interface BaseEntity {
  readonly id: AnyId;
}

/** When it happened. UTC, always. */
export interface TimestampEntity {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Who did it. Actorship is never inferred at read time. */
export interface AuditableEntity extends TimestampEntity {
  readonly createdBy: UserId;
  readonly updatedBy: UserId;
}

/** Nothing is destroyed by a user action; `deletedAt === null` means live. */
export interface SoftDeleteEntity {
  readonly deletedAt: Date | null;
  readonly deletedBy: UserId | null;
}

/** Every business record belongs to exactly one tenant and is invisible outside it. */
export interface TenantEntity {
  readonly tenantId: TenantId;
}

/** Optimistic locking. A second writer at the same version gets a 409, never a silent overwrite. */
export interface VersionedEntity {
  readonly version: number;
}

/**
 * What almost every aggregate root in the product is: tenant-scoped, audited, soft-deletable
 * and optimistically locked.
 */
export interface AggregateRootEntity
  extends BaseEntity, TenantEntity, AuditableEntity, SoftDeleteEntity, VersionedEntity {}

export function isLive(entity: SoftDeleteEntity): boolean {
  return entity.deletedAt === null;
}
