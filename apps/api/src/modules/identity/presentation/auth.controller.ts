import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { negotiateLocale } from '@edms/i18n';

import { Public } from '../../../core/auth/public.decorator';
import type { AppConfig } from '../../../core/config/configuration';
import { APP_CONFIG } from '../../../core/config/config.module';
import { UnauthenticatedError } from '../../../core/errors/application-errors';
import { correlationIdOf } from '../../../core/http/correlation-id.middleware';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  AUTHENTICATION_SERVICE,
  type AuthenticationResult,
  type AuthenticationService,
  type SessionContext,
} from '../application/authentication.ports';
import { type AuthenticationResponse, type SignInBody, signInSchema } from './auth.dto';

/** The cookie the refresh token travels in. Never readable by script. */
const REFRESH_COOKIE = 'edms_refresh';

/**
 * Authentication endpoints.
 *
 * Every route here is `@Public`, and each says why: they are how a caller *becomes*
 * authenticated, so requiring authentication would be circular. `/me` is the exception —
 * it is behind the global guard like everything else.
 *
 * The refresh token is only ever set as an `httpOnly`, `Secure`, `SameSite=Lax` cookie and is
 * never in a response body. `Lax` rather than `Strict` because a user following a link into
 * the workspace from an email should not be silently signed out; the token is useless without
 * the access token the client must also send.
 */
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    @Inject(AUTHENTICATION_SERVICE) private readonly authentication: AuthenticationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Public('Signing in is how a caller obtains a token; requiring one would be circular.')
  async signIn(
    @Body(new ZodValidationPipe(signInSchema)) body: SignInBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthenticationResponse> {
    const result = await this.authentication.signIn({
      email: body.email,
      password: body.password,
      ...this.sessionContext(request, body.tenant),
    });
    return this.respond(result, response);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Public('Refreshing runs on an expired access token, which the guard would reject.')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthenticationResponse> {
    const result = await this.authentication.refresh(
      this.presentedRefreshToken(request),
      this.sessionContext(request),
    );
    return this.respond(result, response);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Public('Signing out must work with an expired access token, or a session cannot be ended.')
  async signOut(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const presented = this.readCookie(request, REFRESH_COOKIE);
    if (presented) {
      await this.authentication.signOut(presented, this.sessionContext(request));
    }
    // Cleared whether or not a token was presented: the caller's intent was to end the
    // session, and leaving a stale cookie behind serves nobody.
    response.clearCookie(REFRESH_COOKIE, this.cookieOptions(0));
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

  private respond(result: AuthenticationResult, response: Response): AuthenticationResponse {
    response.cookie(
      REFRESH_COOKIE,
      result.refreshToken,
      this.cookieOptions(result.refreshTokenExpiresAt.getTime() - Date.now()),
    );
    return {
      accessToken: result.accessToken,
      expiresAt: result.accessTokenExpiresAt.toISOString(),
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

  private presentedRefreshToken(request: Request): string {
    const presented = this.readCookie(request, REFRESH_COOKIE);
    if (!presented) {
      throw new UnauthenticatedError('That session is no longer valid.');
    }
    return presented;
  }

  /**
   * Reads one cookie from the request header.
   *
   * Parsed here rather than through `cookie-parser`, because this is the only cookie the API
   * reads and a middleware that decorates every request to serve one endpoint is not worth
   * the dependency. `Response.cookie()` needs no such help — it is Express's own.
   */
  private readCookie(request: Request, name: string): string | null {
    const header = request.headers.cookie;
    if (!header) {
      return null;
    }
    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0) {
        continue;
      }
      if (part.slice(0, separator).trim() === name) {
        return decodeURIComponent(part.slice(separator + 1).trim());
      }
    }
    return null;
  }

  private sessionContext(request: Request, explicitTenant?: string): SessionContext {
    return {
      tenantSlug: explicitTenant ?? this.tenantFromHost(request),
      ipAddress: request.ip ?? null,
      userAgent: request.header('user-agent') ?? null,
      correlationId: correlationIdOf(request),
      locale: negotiateLocale(request.headers['accept-language']),
    };
  }

  /**
   * The leftmost label of the host, when the host is a subdomain of the configured API host.
   *
   * This selects whose login screen this is and nothing more. What the caller may then do is
   * decided by the signed `tenantId` claim in the token — the host is never an authorisation
   * input (`docs/architecture/21-saas-commercial-architecture.md` §5).
   */
  private tenantFromHost(request: Request): string {
    const host = (request.hostname || '').toLowerCase();
    const labels = host.split('.');
    return labels.length > 2 ? (labels[0] ?? '') : '';
  }

  private cookieOptions(maxAgeMs: number): {
    httpOnly: true;
    secure: boolean;
    sameSite: 'lax';
    path: string;
    maxAge: number;
  } {
    return {
      httpOnly: true,
      // Off only where there is no TLS to require it, which configuration limits to
      // development. A cookie marked Secure is simply not sent over plain HTTP.
      secure: this.config.env !== 'development',
      sameSite: 'lax',
      path: '/',
      maxAge: Math.max(0, maxAgeMs),
    };
  }
}
