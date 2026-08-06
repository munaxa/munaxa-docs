import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { hasPermission } from '@munaxa/rbac';

import type { PermissionKey } from '@edms/domain';

import { ForbiddenError } from '../errors/application-errors';
import { currentContext } from '../tenancy/tenant-context';
import { PUBLIC_ROUTE } from '../auth/public.decorator';
import { REQUIRED_PERMISSIONS } from './permission.decorator';

/**
 * Question one of three: does the caller hold this permission at all?
 *
 * Reach (does it apply on *this* node) is `AclGuard`'s job, and state is the use case's. A
 * caller who fails here never reaches either.
 */
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<string | undefined>(PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<readonly PermissionKey[] | undefined>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }

    // Evaluation is the platform's, so "does this principal hold this permission" means the same
    // thing in every Munaxa product. Verified behaviourally identical to the Set-membership check
    // it replaces: all 37 of this product's permission keys pass the platform grammar, and
    // `hasPermission` and `Set.has` agree on every combination of held and required.
    //
    // It also brings wildcard grants, which Docs does not use today. That is upside rather than a
    // change: a grant without `*` matches exactly, which is what the old check did.
    const held = currentContext()?.permissions ?? [];
    const missing = required.filter((permission) => !hasPermission(held, permission));
    if (missing.length > 0) {
      throw new ForbiddenError('perform this action', { requires: missing.join(', ') });
    }
    return true;
  }
}
