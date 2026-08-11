import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { type UserId, asId } from '@edms/domain';
import { negotiateLocale } from '@edms/i18n';

import { Public } from '../../../core/auth/public.decorator';
import { correlationIdOf } from '../../../core/http/correlation-id.middleware';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  AUTHENTICATION_SERVICE,
  type AuthenticationResult,
  type AuthenticationService,
  type SessionContext,
} from '../application/authentication.ports';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { USER_DIRECTORY, type UserDirectory } from '../application/ports';
import {
  type AuthenticationResponse,
  type RefreshBody,
  type SignInBody,
  refreshSchema,
  respondWith,
  signInSchema,
} from './auth.dto';

/**
 * Authentication endpoints.
 *
 * Every route here but `/me` is `@Public`, and each says why: they are how a caller *becomes*
 * authenticated, so requiring authentication would be circular.
 *
 * **This controller sets no cookies and reads none.** It is a JSON API whose browser-facing
 * client is the Next.js application, and that application owns the `httpOnly` cookies the
 * tokens live in. An API that set its own cookie would give each token two owners, and the
 * web application would have to forward a `Set-Cookie` it did not issue.
 */
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    @Inject(AUTHENTICATION_SERVICE) private readonly authentication: AuthenticationService,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Public('Signing in is how a caller obtains a token; requiring one would be circular.')
  async signIn(
    @Body(new ZodValidationPipe(signInSchema)) body: SignInBody,
    @Req() request: Request,
  ): Promise<AuthenticationResponse> {
    return respond(
      await this.authentication.signIn({
        email: body.email,
        password: body.password,
        ...(body.mfaCode !== undefined && { mfaCode: body.mfaCode }),
        ...sessionContext(request, body.tenant),
      }),
    );
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Public('Refreshing runs on an expired access token, which the guard would reject.')
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshBody,
    @Req() request: Request,
  ): Promise<AuthenticationResponse> {
    return respond(
      await this.authentication.refresh(body.refreshToken, sessionContext(request, body.tenant)),
    );
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Public('Signing out must work with an expired access token, or a session cannot be ended.')
  async signOut(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshBody,
    @Req() request: Request,
  ): Promise<void> {
    await this.authentication.signOut(body.refreshToken, sessionContext(request, body.tenant));
  }

  /**
   * Who the caller is, according to the token they presented.
   *
   * Behind the global authentication guard, so reaching it at all proves the token verified.
   * The client uses it to render affordances; the API never trusts what the client concludes.
   */
  @Get('me')
  async me(): Promise<{
    userId: string | null;
    displayName: string | null;
    email: string | null;
    tenantId: string;
    roles: readonly string[];
    permissions: readonly string[];
  }> {
    const context = requireContext();

    /*
     * The name and the address — Phase 7.9, and the smallest correct extension.
     *
     * Phase 7.8 measured the account chip rendering two UUIDs and an avatar initial taken from the
     * first character of one of them, and established that nothing in the web application had a
     * human name to render: this route returned identifiers only, and the session cookie carries an
     * access token and a locale. The information was never missing from the *domain* — `User` has
     * carried `display_name` and `email` since Phase 1 — it was missing from this response.
     *
     * `UserDirectory.contactFor` is the existing way out of this module and returns exactly these
     * two fields; no new port, no query written here, and Identity's tables stay unread by anybody
     * else (`02-backend-architecture.md` §3). It is called *after* the guard, so it can only ever
     * describe the caller who already authenticated.
     *
     * The read opens a unit of work of its own, because nothing else on this route needs one: the
     * API does not wrap requests in a transaction globally, and the first version of this change
     * threw `NoActiveTransactionError` straight into the `catch` below and quietly returned nulls —
     * a passing build and an unchanged account chip. The E2E caught it; the `catch` is for a
     * database that is unreachable, not for a mistake in wiring.
     *
     * Null rather than absent when there is no user behind the token: an API-key caller has a
     * tenant and permissions but no person, and inventing a name for one is the thing this phase
     * refuses to do. The client renders what it is given and falls back on the identifier.
     */
    const userId = context.userId;
    const contact =
      userId === null
        ? null
        : await this.unitOfWork
            .run(() => this.users.contactFor(asId<UserId>(userId)))
            .catch(() => null);

    return {
      userId: context.userId,
      displayName: contact?.displayName ?? null,
      email: contact?.email ?? null,
      tenantId: context.tenantId,
      roles: context.roles,
      permissions: context.permissions,
    };
  }
}

/** One mapper, shared with the federation controller since Phase 17 — see `respondWith`. */
function respond(result: AuthenticationResult): AuthenticationResponse {
  return respondWith(result);
}

function sessionContext(request: Request, explicitTenant?: string): SessionContext {
  return {
    tenantSlug: explicitTenant ?? tenantFromHost(request),
    ipAddress: request.ip ?? null,
    userAgent: request.header('user-agent') ?? null,
    correlationId: correlationIdOf(request),
    locale: negotiateLocale(request.headers['accept-language']),
  };
}

/**
 * The leftmost label of the host, when the host has one to spare.
 *
 * This selects whose login screen this is and nothing more. What the caller may then do is
 * decided by the signed `tenantId` claim in the token — the host is never an authorisation
 * input (`docs/architecture/21-saas-commercial-architecture.md` §5).
 */
function tenantFromHost(request: Request): string {
  const host = (request.hostname || '').toLowerCase();
  const labels = host.split('.');
  return labels.length > 2 ? (labels[0] ?? '') : '';
}
