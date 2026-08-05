import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, ScopeType, type ScopeRef, asId } from '@edms/domain';

import { requireTransaction } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  SCOPE_REPOSITORY,
  type ScopeRepository,
} from '../../organization/application/scope.ports';
import type { ChainNodeRecord, ScopeChainReader } from '../application/ports';

/**
 * The scope chain, read from the materialised paths ADR-0014 stores as `text`.
 *
 * `08 §3` requires the walk to be "one query, using the ltree paths", and the honest accounting is
 * that this is **one query per level of the tree that is a different table** — five at the very
 * worst, for a document in a folder in a library owned by a department — and *never* one per
 * ancestor. That is the property the materialised path buys and the one that matters: a folder
 * nested twenty deep costs the same as one nested two, because `folder.path` names every ancestor
 * and `IN (…)` reads them together.
 *
 * Collapsing the five into a literal single statement would mean a hand-written `UNION` across four
 * tables with four different shapes, in a repository that would then be the only place in the
 * product where the scope tree is expressed in SQL rather than in Prisma. The resolver caches the
 * chain per object instead, which removes the cost for the case that actually repeats — twenty
 * permission questions about one document, which is what `capabilitiesFor` is.
 *
 * **Soft-deleted nodes are excluded at every level**, for the reason `PrismaScopeRepository` gives:
 * a department that was removed must stop conferring access immediately, and a chain that still
 * crossed it would keep an ACL granted on it alive after the thing it was granted on is gone. A
 * chain that cannot be assembled returns `null`, and the guard turns that into a `404`.
 */
@Injectable()
export class PrismaScopeChainReader implements ScopeChainReader {
  constructor(@Inject(SCOPE_REPOSITORY) private readonly scopes: ScopeRepository) {}

  async chainFor(scope: ScopeRef): Promise<readonly ChainNodeRecord[] | null> {
    switch (scope.type) {
      case ScopeType.DOCUMENT:
        return this.fromDocument(scope);
      case ScopeType.FOLDER:
        return this.fromFolder(String(scope.id), null);
      case ScopeType.LIBRARY:
        return this.fromLibrary(String(scope.id), []);
      case ScopeType.TENANT:
        return [this.tenantNode()];
      default:
        return this.fromOrganisation(scope);
    }
  }

  async librariesUnder(scopes: readonly ScopeRef[]): Promise<readonly string[]> {
    if (scopes.length === 0) {
      return [];
    }
    const tx = requireTransaction();
    const { tenantId } = requireContext();

    const companyIds = idsOf(scopes, ScopeType.COMPANY);
    const entityIds = new Set(idsOf(scopes, ScopeType.ENTITY));
    const departmentIds = new Set(idsOf(scopes, ScopeType.DEPARTMENT));

    // A company reaches its entities, and those entities reach their departments. Two widening
    // reads rather than a recursive query, because the organisation tree is three levels by
    // construction (`03-domain-model.md` §3) and a `WITH RECURSIVE` would be machinery for a
    // depth the schema does not permit to grow.
    if (companyIds.length > 0) {
      const entities = await tx.entity.findMany({
        where: { tenantId, companyId: { in: companyIds }, deletedAt: null },
        select: { id: true },
      });
      for (const row of entities) {
        entityIds.add(row.id);
      }
    }
    if (entityIds.size > 0) {
      const departments = await tx.department.findMany({
        where: { tenantId, entityId: { in: [...entityIds] }, deletedAt: null },
        select: { id: true },
      });
      for (const row of departments) {
        departmentIds.add(row.id);
      }
    }
    // Departments nest, so a grant on one reaches the departments beneath it too.
    if (departmentIds.size > 0) {
      const subtree = await this.scopes.findSubtrees([...departmentIds].map((id) => asId<AnyId>(id)));
      for (const node of subtree) {
        departmentIds.add(String(node.id));
      }
    }

    const owners: { ownerScopeType: 'COMPANY' | 'ENTITY' | 'DEPARTMENT'; ids: string[] }[] = [
      { ownerScopeType: 'COMPANY', ids: companyIds },
      { ownerScopeType: 'ENTITY', ids: [...entityIds] },
      { ownerScopeType: 'DEPARTMENT', ids: [...departmentIds] },
    ];
    const libraries = await tx.library.findMany({
      where: {
        tenantId,
        deletedAt: null,
        OR: owners
          .filter((owner) => owner.ids.length > 0)
          .map((owner) => ({ ownerScopeType: owner.ownerScopeType, ownerScopeId: { in: owner.ids } })),
      },
      select: { id: true },
    });
    return libraries.map((row) => row.id);
  }

  async brokenInheritancePaths(): Promise<readonly string[]> {
    const rows = await requireTransaction().folder.findMany({
      where: { tenantId: requireContext().tenantId, inheritAcl: false, deletedAt: null },
      select: { path: true },
    });
    return rows.map((row) => row.path);
  }

  // --- Internals ---------------------------------------------------------------------------

  private async fromDocument(scope: ScopeRef): Promise<readonly ChainNodeRecord[] | null> {
    // Deleted documents are still resolvable: the recycle bin and the restore path both ask about
    // one, and answering `404` for a document somebody is looking at in the bin would make restore
    // impossible for anybody who is not a tenant administrator.
    const document = await requireTransaction().document.findFirst({
      where: { id: String(scope.id), tenantId: requireContext().tenantId },
      select: { id: true, title: true, folderId: true },
    });
    if (document === null) {
      return null;
    }
    const above = await this.fromFolder(document.folderId, null);
    if (above === null) {
      return null;
    }
    return [
      ...above,
      {
        scope: { type: ScopeType.DOCUMENT, id: asId<AnyId>(document.id) },
        breaksInheritance: false,
        path: null,
        name: document.title,
      },
    ];
  }

  /**
   * The folder and every folder above it, from one read of the materialised path.
   *
   * `folder.path` is dot-separated ancestor identifiers with the folder itself last, so the whole
   * ancestry is one `IN` — the property ADR-0014 exists for. The rows come back in whatever order
   * the database chose and are re-ordered by the path, because the chain's order *is* its meaning.
   */
  private async fromFolder(
    folderId: string,
    _unused: null,
  ): Promise<readonly ChainNodeRecord[] | null> {
    const tx = requireTransaction();
    const { tenantId } = requireContext();
    const folder = await tx.folder.findFirst({
      where: { id: folderId, tenantId, deletedAt: null },
      select: { id: true, path: true, libraryId: true },
    });
    if (folder === null) {
      return null;
    }
    const ancestry = folder.path.split('.').filter((part) => part !== '');
    const rows = await tx.folder.findMany({
      where: { tenantId, id: { in: ancestry }, deletedAt: null },
      select: { id: true, name: true, inheritAcl: true, path: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const folders: ChainNodeRecord[] = [];
    for (const id of ancestry) {
      const row = byId.get(id);
      if (row === undefined) {
        // An ancestor was soft-deleted out from under this folder. The chain is unresolvable, and
        // an unresolvable chain is a refusal rather than a shorter chain that grants more.
        return null;
      }
      folders.push({
        scope: { type: ScopeType.FOLDER, id: asId<AnyId>(row.id) },
        breaksInheritance: !row.inheritAcl,
        path: row.path,
        name: row.name,
      });
    }
    const above = await this.fromLibrary(folder.libraryId, []);
    return above === null ? null : [...above, ...folders];
  }

  private async fromLibrary(
    libraryId: string,
    _unused: readonly never[],
  ): Promise<readonly ChainNodeRecord[] | null> {
    const library = await requireTransaction().library.findFirst({
      where: { id: libraryId, tenantId: requireContext().tenantId, deletedAt: null },
      select: { id: true, name: true, ownerScopeType: true, ownerScopeId: true },
    });
    if (library === null) {
      return null;
    }
    const above =
      library.ownerScopeType === 'TENANT' || library.ownerScopeId === null
        ? [this.tenantNode()]
        : await this.fromOrganisation({
            type: library.ownerScopeType,
            id: asId<AnyId>(library.ownerScopeId),
          });
    if (above === null) {
      return null;
    }
    return [
      ...above,
      {
        scope: { type: ScopeType.LIBRARY, id: asId<AnyId>(library.id) },
        breaksInheritance: false,
        path: null,
        name: library.name,
      },
    ];
  }

  /**
   * Tenant → company → entity → department…, for an organisation node.
   *
   * Departments nest, so their own materialised path is read the same way a folder's is. Companies
   * and entities do not — the schema gives each exactly one parent — so they are two lookups.
   */
  private async fromOrganisation(scope: ScopeRef): Promise<readonly ChainNodeRecord[] | null> {
    const node = await this.scopes.findNode(scope.id, scope.type);
    if (node === null) {
      return null;
    }
    if (scope.type === ScopeType.COMPANY) {
      return [this.tenantNode(), organisationNode(scope.type, node.id, node.name)];
    }
    if (scope.type === ScopeType.ENTITY) {
      const company =
        node.parentId === null ? null : await this.scopes.findNode(node.parentId, ScopeType.COMPANY);
      return company === null
        ? null
        : [
            this.tenantNode(),
            organisationNode(ScopeType.COMPANY, company.id, company.name),
            organisationNode(ScopeType.ENTITY, node.id, node.name),
          ];
    }

    const ancestry = node.path.split('.').filter((part) => part !== '');
    const departments = await this.scopes.findDepartmentsByIds(ancestry);
    if (departments.length !== ancestry.length) {
      return null;
    }
    const above =
      node.entityId === undefined
        ? null
        : await this.fromOrganisation({ type: ScopeType.ENTITY, id: node.entityId });
    if (above === null) {
      return null;
    }
    return [
      ...above,
      ...departments.map((department) =>
        organisationNode(ScopeType.DEPARTMENT, department.id, department.name),
      ),
    ];
  }

  private tenantNode(): ChainNodeRecord {
    const { tenantId } = requireContext();
    return {
      scope: { type: ScopeType.TENANT, id: asId<AnyId>(tenantId) },
      breaksInheritance: false,
      path: null,
      // The tenant's own name is a `tenant` row read the operator console owns; the chain only
      // needs a label, and "Tenant" is what the screen renders beside the root either way.
      name: 'TENANT',
    };
  }
}

function organisationNode(
  type: 'COMPANY' | 'ENTITY' | 'DEPARTMENT',
  id: AnyId,
  name: string,
): ChainNodeRecord {
  return { scope: { type, id }, breaksInheritance: false, path: null, name };
}

function idsOf(scopes: readonly ScopeRef[], type: string): string[] {
  return scopes.filter((scope) => scope.type === type).map((scope) => String(scope.id));
}
