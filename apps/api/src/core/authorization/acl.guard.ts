import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { type PermissionKey, asId } from '@edms/domain';

import { NotFoundError } from '../errors/application-errors';
import { requireContext } from '../tenancy/tenant-context';
import { AccessDenialRecorder } from './access-denial.recorder';
import { ACL_RESOLVER, type AclResolver, type AuthorizationSubject } from './acl-resolver.port';
import { PERMISSION_SCOPE, REQUIRED_PERMISSIONS, type ScopeBinding } from './permission.decorator';

/**
 * Question two of three: does the permission apply *here*?
 *
 * Runs before the use case, on the object named by `@ScopedTo`. A denial raises
 * `NotFoundError`, not `ForbiddenError`: a caller who may not reach an object is not told it
 * exists, because "403" on a document number is itself an answer worth harvesting
 * (`docs/architecture/15-api-architecture.md` §4).
 *
 * **The refusal is recorded.** 08 §7 requires every denied attempt on an existing object to be
 * audited as `ACCESS_DENIED`, and until Phase 9 nothing here wrote one — `writeStandalone` was
 * written in Phase 1 for exactly this caller and had none. The caller who is refused is told
 * nothing more than before; what changed is that the refusal is now evidence.
 *
 * The recorder runs before the throw rather than after it, because a `throw` that happened to be
 * caught somewhere would otherwise take the record with it.
 */
@Injectable()
export class AclGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ACL_RESOLVER) private readonly resolver: AclResolver,
    private readonly denials: AccessDenialRecorder,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const binding = this.reflector.getAllAndOverride<ScopeBinding | undefined>(PERMISSION_SCOPE, [
      context.getHandler(),
      context.getClass(),
    ]);
    const permissions = this.reflector.getAllAndOverride<readonly PermissionKey[] | undefined>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );
    if (!binding || !permissions || permissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const targetId = (request.params as Record<string, string | undefined>)[binding.param];
    if (!targetId) {
      throw new NotFoundError('The requested resource');
    }

    const subject = this.subjectFor();
    const scope = { type: binding.scopeType, id: asId(targetId) };

    for (const permission of permissions) {
      const decision = await this.resolver.resolve(subject, scope, permission);
      if (!decision.allowed) {
        await this.denials.record({
          scopeType: binding.scopeType,
          subjectId: scope.id,
          permission,
          reason: decision.reason,
        });
        throw new NotFoundError('The requested resource');
      }
    }
    return true;
  }

  /**
   * The subject the resolver walks the tree for. Role and department memberships come from
   * the request context; delegations are resolved by the implementation, since a delegation
   * can expire between the token being issued and this request arriving.
   */
  private subjectFor(): AuthorizationSubject {
    const context = requireContext();
    return {
      userId: context.userId ?? asId(''),
      roleIds: context.roles.map((role) => asId(role)),
      departmentIds: [],
      delegationIds: [],
    };
  }
}
