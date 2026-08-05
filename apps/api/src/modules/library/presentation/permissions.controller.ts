import { Body, Controller, Get, Inject, Param, Put, Query } from '@nestjs/common';

import {
  type EffectivePermissions,
  type ExplicitAcl,
  type ReplaceAclBody,
  type SetInheritanceBody,
  type StoredAclEntry,
  replaceAclSchema,
  scopeTypeSchema,
  setInheritanceSchema,
} from '@edms/contracts';
import {
  type AnyId,
  type FolderId,
  Permission,
  ScopeType,
  type ScopeRef,
  asId,
} from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { ValidationError } from '../../../core/errors/application-errors';
import { IfMatch } from '../../../core/http/admin-request';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { PERMISSION_SERVICE } from '../application/ports';
import type {
  EffectivePermissions as ResolvedPermissions,
  ExplicitAcl as ResolvedExplicitAcl,
  PermissionService,
  StoredAclEntry as StoredEntry,
} from '../application/ports';

/**
 * Reading and editing reach on a scope node.
 *
 * **One controller for seven node types, not seven controllers.** An ACL entry means the same thing
 * on a company as on a document; the walk crosses all of them and the screen edits all of them the
 * same way. Splitting by type would put one algorithm behind seven routes, and 08 §3's chain would
 * become a thing readers have to reassemble from the URL space.
 *
 * **`document:permission:manage` gates the whole class**, which is the capability half. The reach
 * half — may this caller manage permissions *on this node* — cannot be `@ScopedTo`, because the
 * scope type is a path segment rather than a decorator argument, so the service asks the resolver
 * for it directly and refuses with `404`. That is the same refusal `AclGuard` produces and for the
 * same reason: `403` on a node identifier is an existence answer worth harvesting.
 *
 * The permission has been in the catalogue and seeded to `TENANT_ADMIN` and `DOCUMENT_CONTROLLER`
 * since Phase 1, gating nothing. This is what it gates.
 */
@Controller({ path: 'scopes/:scopeType/:scopeId/permissions', version: '1' })
@RequirePermission(Permission.DOCUMENT_PERMISSION_MANAGE)
export class PermissionsController {
  constructor(@Inject(PERMISSION_SERVICE) private readonly permissions: PermissionService) {}

  /**
   * The entries written on this node. Nothing inherited — this is the editable set.
   *
   * "What does this folder say" and "what can Ahmed do here" are different questions with different
   * answers, and conflating them is how an administrator deletes an entry that was not the one
   * granting access. The screen renders both, from two calls, side by side.
   */
  @Get()
  async explicit(
    @Param('scopeType') scopeType: string,
    @Param('scopeId') scopeId: string,
  ): Promise<ExplicitAcl> {
    const scope = toScope(scopeType, scopeId);
    return toExplicit(await this.permissions.explicitFor(scope), scope);
  }

  /** ADR-0005's mitigation: the effective answer, and the node that decided each one. */
  @Get('effective')
  async effective(
    @Param('scopeType') scopeType: string,
    @Param('scopeId') scopeId: string,
    @Query('userId') userId?: string,
  ): Promise<EffectivePermissions> {
    if (userId === undefined || userId === '') {
      throw new ValidationError('Name the person whose effective permissions to resolve.', [
        { field: 'userId', message: 'Required.' },
      ]);
    }
    return toEffective(await this.permissions.effectiveFor(toScope(scopeType, scopeId), userId));
  }

  @Put()
  async replace(
    @Param('scopeType') scopeType: string,
    @Param('scopeId') scopeId: string,
    @Body(new ZodValidationPipe(replaceAclSchema)) body: ReplaceAclBody,
  ): Promise<ExplicitAcl> {
    const scope = toScope(scopeType, scopeId);
    return toExplicit(await this.permissions.replaceFor(scope, body.entries), scope);
  }

  /**
   * `folder.inherit_acl` — the column that has been on the schema since Phase 2 with no reader.
   *
   * Under this route rather than as a field on `PATCH /admin/folders/{id}` deliberately. Breaking
   * inheritance is not an edit to a folder's description; it is the operation ADR-0005 singles out
   * as "the one most likely to hide content from the people accountable for it", it writes its own
   * audit action, and it is gated on `document:permission:manage` rather than on `folder:manage` —
   * so somebody who may rename folders cannot silently detach one from the tenant's grants.
   *
   * `folderSchema.inheritAcl` and `updateFolderSchema.inheritAcl` stay where they are: the folder
   * screen still *shows* the flag, because a folder that does not inherit is a fact about the folder.
   * What it no longer does is set it — see the phase report's note on the one contract that narrowed.
   */
  @Put('inheritance')
  async setInheritance(
    @Param('scopeType') scopeType: string,
    @Param('scopeId') scopeId: string,
    @Body(new ZodValidationPipe(setInheritanceSchema)) body: SetInheritanceBody,
    @IfMatch() version: number | undefined,
  ): Promise<{ inheritAcl: boolean; changed: boolean }> {
    const scope = toScope(scopeType, scopeId);
    if (scope.type !== ScopeType.FOLDER) {
      throw new ValidationError(
        'Only a folder can break ACL inheritance; every other node on the chain inherits by construction.',
        [{ field: 'scopeType', message: `${scope.type} has no inheritance flag.` }],
      );
    }
    const changed = await this.permissions.setInheritance(
      asId<FolderId>(scopeId),
      body.inheritAcl,
      version,
    );
    return { inheritAcl: body.inheritAcl, changed };
  }
}

/** A path segment is untrusted text; the catalogue of node types is the only thing that accepts it. */
function toScope(scopeType: string, scopeId: string): ScopeRef {
  const parsed = scopeTypeSchema.safeParse(scopeType.toUpperCase());
  if (!parsed.success) {
    throw new ValidationError('That is not a node on the scope chain.', [
      { field: 'scopeType', message: `${scopeType} is not one of the seven scope types.` },
    ]);
  }
  return { type: parsed.data, id: asId<AnyId>(scopeId) };
}

function toStored(entry: StoredEntry, scope: ScopeRef): StoredAclEntry {
  return {
    id: String(entry.id),
    scopeType: scope.type,
    scopeId: String(scope.id),
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    permission: entry.permission,
    effect: entry.effect,
    createdAt: entry.createdAt.toISOString(),
    createdBy: entry.createdBy,
  };
}

function toExplicit(resolved: ResolvedExplicitAcl, scope: ScopeRef): ExplicitAcl {
  return {
    entries: resolved.entries.map((entry) => toStored(entry, scope)),
    chain: resolved.chain.map((node) => ({
      type: node.scope.type,
      id: String(node.scope.id),
      name: node.name,
      breaksInheritance: node.breaksInheritance,
    })),
    inheritanceBroken: resolved.inheritanceBroken,
    folderId: resolved.folderId === null ? null : String(resolved.folderId),
    folderInheritsAcl: resolved.folderInheritsAcl,
  };
}

function toEffective(resolved: ResolvedPermissions): EffectivePermissions {
  return {
    scopeType: resolved.scope.type,
    scopeId: String(resolved.scope.id),
    userId: resolved.userId,
    permissions: resolved.permissions.map((permission) => ({
      permission: permission.permission,
      allowed: permission.allowed,
      decidedAtType: permission.decidedAt?.type ?? null,
      decidedAtId: permission.decidedAt === null ? null : String(permission.decidedAt.id),
      decidedAtName: permission.decidedAtName,
      reason: permission.reason,
    })),
    chain: resolved.chain.map((node) => ({
      type: node.scope.type,
      id: String(node.scope.id),
      name: node.name,
      breaksInheritance: node.breaksInheritance,
    })),
    inheritanceBroken: resolved.inheritanceBroken,
  };
}
