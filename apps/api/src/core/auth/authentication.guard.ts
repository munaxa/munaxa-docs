import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { UnauthenticatedError } from '../errors/application-errors';
import { currentContext } from '../tenancy/tenant-context';
import { PUBLIC_ROUTE } from './public.decorator';

/**
 * Closed by default: a route is authenticated unless it carries `@Public(reason)`.
 *
 * The middleware has already verified any token; this only decides whether the absence of a
 * context is acceptable here.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const publicReason = this.reflector.getAllAndOverride<string | undefined>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (publicReason) {
      return true;
    }
    if (!currentContext()) {
      throw new UnauthenticatedError();
    }
    return true;
  }
}
