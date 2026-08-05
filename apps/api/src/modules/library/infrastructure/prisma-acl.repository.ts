import { Injectable } from '@nestjs/common';

import {
  type AnyId,
  type AclEffectKey,
  type AclSubjectTypeKey,
  type FolderId,
  type PermissionKey,
  type ScopeRef,
  type ScopeTypeKey,
  asId,
  isPermissionKey,
} from '@edms/domain';

import { RecordStamps } from '../../../core/persistence/record-stamps';
import { requireTransaction } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  AclEntryRecord,
  AclRepository,
  InheritanceRecord,
  StoredAclEntry,
} from '../application/ports';

/**
 * `acl_entry`, read the two ways the product asks about it and written the one way it is edited.
 *
 * **Reads are permission-scoped.** Both list methods take a permission, because both callers ask
 * about one: `resolve` answers one question, and `visibilityFilter` builds a predicate for one
 * column. Reading a node's entries for every permission is a third question — the permissions
 * screen's — and it has its own method, which is the only one that does not narrow.
 *
 * **A write replaces a node's set in one statement pair.** `replaceForScope` deletes what is no
 * longer wanted and inserts what is new, inside the caller's transaction, and reports the
 * difference. The alternative — delete-all then insert-all — is simpler and wrong: it rewrites
 * `created_at` and `created_by` on every entry that did not change, so "who granted this, and
 * when" would be answered with the timestamp of the last unrelated edit to the same folder.
 *
 * Row-level security scopes every statement here to the tenant; the explicit `tenantId` filters
 * are the second layer `05-database-design.md` §6 requires, not the only one.
 */
@Injectable()
export class PrismaAclRepository implements AclRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async listForChain(
    scopeIds: readonly string[],
    subjectIds: readonly string[] | null,
    permission: PermissionKey,
  ): Promise<readonly AclEntryRecord[]> {
    if (scopeIds.length === 0 || subjectIds?.length === 0) {
      return [];
    }
    const rows = await requireTransaction().aclEntry.findMany({
      where: {
        tenantId: requireContext().tenantId,
        scopeId: { in: [...scopeIds] },
        ...(subjectIds !== null && { subjectId: { in: [...subjectIds] } }),
        permission,
      },
      select: SELECTION,
    });
    return rows.map(toRecord);
  }

  async listForSubjects(
    subjectIds: readonly string[],
    permission: PermissionKey,
    limit: number,
  ): Promise<readonly AclEntryRecord[]> {
    if (subjectIds.length === 0) {
      return [];
    }
    const rows = await requireTransaction().aclEntry.findMany({
      where: {
        tenantId: requireContext().tenantId,
        subjectId: { in: [...subjectIds] },
        permission,
      },
      select: SELECTION,
      // Denies first, so a truncated read keeps the entries that subtract and loses the ones that
      // add. The resolver refuses to widen when it sees a full page; this ordering means that even
      // if it did, what survived would be the closed half.
      orderBy: [{ effect: 'desc' }, { scopeId: 'asc' }],
      take: limit,
    });
    return rows.map(toRecord);
  }

  async listForScope(scope: ScopeRef): Promise<readonly StoredAclEntry[]> {
    const rows = await requireTransaction().aclEntry.findMany({
      where: {
        tenantId: requireContext().tenantId,
        scopeType: scope.type as never,
        scopeId: String(scope.id),
      },
      select: { ...SELECTION, id: true, createdAt: true, createdBy: true },
      orderBy: [{ subjectType: 'asc' }, { subjectId: 'asc' }, { permission: 'asc' }],
    });
    return rows
      .filter((row) => isPermissionKey(row.permission))
      .map((row) => ({
        ...toRecord(row),
        id: asId<AnyId>(row.id),
        createdAt: row.createdAt,
        createdBy: row.createdBy,
      }));
  }

  async replaceForScope(
    scope: ScopeRef,
    entries: readonly AclEntryRecord[],
  ): Promise<{
    readonly granted: readonly AclEntryRecord[];
    readonly revoked: readonly AclEntryRecord[];
  }> {
    const tx = requireTransaction();
    const { tenantId, userId } = requireContext();
    const where = {
      tenantId,
      scopeType: scope.type as never,
      scopeId: String(scope.id),
    };

    const existing = await tx.aclEntry.findMany({ where, select: { ...SELECTION, id: true } });
    const wanted = new Map(entries.map((entry) => [keyOf(entry), entry]));
    const held = new Map(existing.map((row) => [keyOf(toRecord(row)), row]));

    const revoked: AclEntryRecord[] = [];
    const removedIds: string[] = [];
    for (const [key, row] of held) {
      if (!wanted.has(key)) {
        revoked.push(toRecord(row));
        removedIds.push(row.id);
      }
    }
    const granted: AclEntryRecord[] = [];
    for (const [key, entry] of wanted) {
      if (!held.has(key)) {
        granted.push(entry);
      }
    }

    if (removedIds.length > 0) {
      await tx.aclEntry.deleteMany({ where: { tenantId, id: { in: removedIds } } });
    }
    if (granted.length > 0) {
      const now = this.stamps.now();
      await tx.aclEntry.createMany({
        data: granted.map((entry) => ({
          id: this.stamps.nextId(),
          tenantId,
          scopeType: scope.type as never,
          scopeId: String(scope.id),
          subjectType: entry.subjectType as never,
          subjectId: entry.subjectId,
          permission: entry.permission,
          effect: entry.effect as never,
          createdAt: now,
          createdBy: userId,
          updatedAt: now,
          updatedBy: userId,
        })),
      });
    }
    return { granted, revoked };
  }

  async deleteForScope(scope: ScopeRef): Promise<readonly AclEntryRecord[]> {
    const tx = requireTransaction();
    const { tenantId } = requireContext();
    const where = { tenantId, scopeType: scope.type as never, scopeId: String(scope.id) };
    const existing = await tx.aclEntry.findMany({ where, select: SELECTION });
    if (existing.length > 0) {
      await tx.aclEntry.deleteMany({ where });
    }
    return existing.map(toRecord);
  }

  async findInheritance(folderId: FolderId): Promise<InheritanceRecord | null> {
    const row = await requireTransaction().folder.findFirst({
      where: { id: String(folderId), tenantId: requireContext().tenantId, deletedAt: null },
      select: { id: true, name: true, inheritAcl: true, version: true },
    });
    return row === null
      ? null
      : {
          id: asId<FolderId>(row.id),
          name: row.name,
          inheritAcl: row.inheritAcl,
          version: row.version,
        };
  }

  async setInheritance(folderId: FolderId, inherit: boolean): Promise<void> {
    await requireTransaction().folder.updateMany({
      where: { id: String(folderId), tenantId: requireContext().tenantId, deletedAt: null },
      data: { inheritAcl: inherit, version: { increment: 1 } },
    });
  }

  async rolesOf(userId: string): Promise<readonly string[] | null> {
    const tx = requireTransaction();
    const { tenantId } = requireContext();
    const user = await tx.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (user === null) {
      return null;
    }
    const roles = await tx.userRole.findMany({
      where: { tenantId, userId },
      select: { roleId: true },
    });
    return roles.map((row) => row.roleId);
  }
}

const SELECTION = {
  scopeType: true,
  scopeId: true,
  subjectType: true,
  subjectId: true,
  permission: true,
  effect: true,
} as const;

interface EntryRow {
  scopeType: string;
  scopeId: string;
  subjectType: string;
  subjectId: string;
  permission: string;
  effect: string;
}

function toRecord(row: EntryRow): AclEntryRecord {
  return {
    scope: { type: row.scopeType as ScopeTypeKey, id: asId<AnyId>(row.scopeId) },
    subjectType: row.subjectType as AclSubjectTypeKey,
    subjectId: row.subjectId,
    permission: row.permission as PermissionKey,
    effect: row.effect as AclEffectKey,
  };
}

/**
 * What makes two entries the same entry, for the purpose of diffing an edit.
 *
 * The **effect is part of it**, while the database's `uq_acl_entry` deliberately leaves it out.
 * That is not a disagreement: flipping a subject's `ALLOW` to a `DENY` is a revocation and a grant,
 * two acts an investigation asks about separately, and treating it as an in-place update would file
 * the most consequential edit in the product under neither audit action. The delete runs before the
 * insert in `replaceForScope`, so the unique constraint is satisfied by ordering rather than by
 * pretending the two rows are one.
 */
function keyOf(entry: AclEntryRecord): string {
  return `${entry.subjectType}:${entry.subjectId}:${entry.permission}:${entry.effect}`;
}
