import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

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
import {
  type AuthenticationResponse,
  type RefreshBody,
  type SignInBody,
  refreshSchema,
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
  me(): {
    userId: string | null;
    tenantId: string;
    roles: readonly string[];
    permissions: readonly string[];
  } {
    const context = requireContext();
    return {
      userId: context.userId,
      tenantId: context.tenantId,
      roles: context.roles,
      permissions: context.permissions,
    };
  }
}

function respond(result: AuthenticationResult): AuthenticationResponse {
  return {
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
    refreshToken: result.refreshToken,
    refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
    user: {
      id: result.user.id,
      email: result.user.email,
      displayName: result.user.displayName,
      roles: result.user.roles,
      permissions: result.user.permissions,
      mfaEnrolled: result.user.mfaEnrolled,
    },
  };
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
