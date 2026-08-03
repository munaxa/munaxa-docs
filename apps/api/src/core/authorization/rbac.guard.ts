import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

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

    const held = new Set(currentContext()?.permissions ?? []);
    const missing = required.filter((permission) => !held.has(permission));
    if (missing.length > 0) {
      throw new ForbiddenError('perform this action', { requires: missing.join(', ') });
    }
    return true;
  }
}
