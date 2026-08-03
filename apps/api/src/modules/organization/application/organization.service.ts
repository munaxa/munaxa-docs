import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, type ScopeTypeKey, ScopeType, asId } from '@edms/domain';

import { requireContext } from '../../../core/tenancy/tenant-context';
import { ancestorIdsOf } from '../domain/scope-tree';
import {
  SCOPE_REPOSITORY,
  type ScopeNodeRecord,
  type ScopeRepository,
} from './scope.ports';

/**
 * The scope tree, as everything above it needs to see it.
 *
 * One question dominates: **given a node, what is the chain from the tenant down to it?** That
 * is what the ACL resolver walks, once per authorisation decision, so it has to be one indexed
 * read rather than a climb — which is the entire reason `department.path` exists
 * (`docs/architecture/05-database-design.md` §8).
 *
 * A branch never appears in a chain. It is a location, and permission does not flow through
 * one; putting it in would give every ACL a level nobody grants on.
 */
@Injectable()
export class DefaultOrganizationService {
  constructor(@Inject(SCOPE_REPOSITORY) private readonly scopes: ScopeRepository) {}

  /**
   * The chain from the tenant down to a node, ancestors first.
   *
   * Always begins with the tenant, because every node has one and the resolver's outermost
   * grant lives there. Returns an empty chain for a node that does not exist, rather than a
   * chain of one — a caller must not be able to mistake "unknown node" for "tenant-wide".
   */
  async scopeChainFor(nodeId: AnyId, nodeType: ScopeTypeKey): Promise<readonly ScopeNodeRecord[]> {
    const { tenantId } = requireContext();
    const tenantNode: ScopeNodeRecord = {
      id: asId<AnyId>(tenantId),
      type: ScopeType.TENANT,
      code: '',
      name: '',
      parentId: null,
      path: tenantId,
    };

    if (nodeType === ScopeType.TENANT) {
      return [tenantNode];
    }

    const node = await this.scopes.findNode(nodeId, nodeType);
    if (!node) {
      return [];
    }

    switch (node.type) {
      case ScopeType.COMPANY:
        return [tenantNode, node];

      case ScopeType.ENTITY: {
        const company = node.parentId
          ? await this.scopes.findNode(node.parentId, ScopeType.COMPANY)
          : null;
        return company ? [tenantNode, company, node] : [tenantNode, node];
      }

      case ScopeType.DEPARTMENT: {
        // One read for every ancestor department, using the materialised path, then the
        // entity and company above them. A climb would be one query per level.
        const ancestors = await this.scopes.findDepartmentsByIds(ancestorIdsOf(node.path));
        const above = await this.scopeChainFor(node.entityId ?? asId<AnyId>(''), ScopeType.ENTITY);
        return [...above, ...ancestors, node];
      }

      default:
        // Libraries, folders and documents hang below this tree and are resolved by the
        // modules that own them; this service answers only for the organisational part.
        return [tenantNode];
    }
  }

  exists(nodeId: AnyId, nodeType: ScopeTypeKey): Promise<boolean> {
    if (nodeType === ScopeType.TENANT) {
      return Promise.resolve(nodeId === requireContext().tenantId);
    }
    return this.scopes.findNode(nodeId, nodeType).then((node) => node !== null);
  }

  /**
   * Every department a person's membership reaches, including nested ones.
   *
   * Membership in a department implies membership in what sits under it: somebody in "Quality"
   * is in "Quality / Documentation" too, and an ACL granted on the parent must reach them.
   */
  departmentsReachedBy(departmentIds: readonly AnyId[]): Promise<readonly ScopeNodeRecord[]> {
    return this.scopes.findSubtrees(departmentIds);
  }
}
