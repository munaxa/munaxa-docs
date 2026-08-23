import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ActorChannel } from '@edms/domain';

import { UnauthenticatedError } from '../errors/application-errors';
import { currentContext } from '../tenancy/tenant-context';
import { PUBLIC_ROUTE } from './public.decorator';
import { PERMISSION_VERSION_READER, type PermissionVersionReader } from './permission-version';

/**
 * Closed by default: a route is authenticated unless it carries `@Public(reason)`.
 *
 * The middleware has already verified any token; this decides whether the absence of a
 * context is acceptable here — and, since Slice 31, whether the authority the token asserts is
 * still the authority the tenant grants.
 *
 * ## Why the version check lives here and nowhere else
 *
 * It is one question — "is this credential still current" — so it is asked once, at the
 * authentication boundary, rather than in `RbacGuard` and `AclGuard` separately. Putting it in the
 * middleware was the other candidate and is wrong: middleware runs before routing, so it cannot
 * know that `/auth/login` and the health checks are `@Public`, and every one of them would have
 * grown a Redis round trip to authenticate a request that carries no credential at all. The early
 * return below is what keeps those routes exactly as cheap as they were.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PERMISSION_VERSION_READER) private readonly versions: PermissionVersionReader,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const publicReason = this.reflector.getAllAndOverride<string | undefined>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (publicReason) {
      return true;
    }
    const active = currentContext();
    if (!active) {
      throw new UnauthenticatedError();
    }

    /*
     * A machine caller is already current, so asking again would be a round trip for an answer it
     * cannot disagree with.
     *
     * ADR-0018: an API key's effective permissions are "the intersection of that person's
     * tenant-wide grants with the key's scopes, both read at authentication rather than
     * snapshotted — so removing a role removes it from every key bound to them on the next call".
     * `ApiKeyAuthenticator` reads them from the database on every request and reports
     * `permissionVersion: 0` for the provisional context it builds on the way, so comparing that
     * number against a real one would refuse every key in the product.
     */
    if (active.channel === ActorChannel.API) {
      return true;
    }
    /*
     * No person behind the credential — the lane consumers and the scheduled jobs, which construct
     * a context directly rather than presenting a token. They carry no `permVersion` to be stale.
     */
    if (active.userId === null) {
      return true;
    }

    const current = await this.versions.currentFor(active.userId);
    if (current === null || current !== active.permissionVersion) {
      /*
       * The same refusal an expired or forged token earns, deliberately.
       *
       * A distinct code or message would say "your permissions changed just now", and a caller who
       * can watch that transition learns when an administrator touched an account — the same
       * reasoning that makes `JwtTokenService.verify` throw one error for every rejection and
       * `signIn` fail identically for an unknown address and a wrong password. The client's
       * existing handling is already right: refresh, and the rotated token carries the new version.
       */
      throw new UnauthenticatedError();
    }
    return true;
  }
}
