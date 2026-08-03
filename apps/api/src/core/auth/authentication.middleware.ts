import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { negotiateLocale } from '@edms/i18n';

import { correlationIdOf } from '../http/correlation-id.middleware';
import { LOGGER, type Logger } from '../observability/logger';
import { type RequestContext, runWithContext } from '../tenancy/tenant-context';
import { TOKEN_VERIFIER, type TokenVerifier } from './access-token';

/**
 * Establishes the request context and keeps it alive for the whole request.
 *
 * It runs as middleware, not as a guard, for one reason: `AsyncLocalStorage.run()` must wrap
 * everything downstream — guards, pipes, the controller, the use case and the repository —
 * and only a middleware that calls `next()` inside `run()` can do that.
 *
 * A missing or invalid token is **not** rejected here. It leaves the context unset, and
 * `AuthenticationGuard` decides whether this particular route tolerates that. Rejecting
 * here would make it impossible to serve a health check.
 */
@Injectable()
export class AuthenticationMiddleware implements NestMiddleware {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly tokenVerifier: TokenVerifier,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async use(request: Request, _response: Response, next: NextFunction): Promise<void> {
    const context = await this.resolveContext(request);
    if (!context) {
      next();
      return;
    }
    runWithContext(context, () => {
      next();
    });
  }

  private async resolveContext(request: Request): Promise<RequestContext | null> {
    const header = request.header('authorization');
    if (!header?.toLowerCase().startsWith('bearer ')) {
      return null;
    }
    const token = header.slice('bearer '.length).trim();
    try {
      const claims = await this.tokenVerifier.verify(token);
      return {
        tenantId: claims.tenantId,
        userId: claims.sub,
        roles: claims.roles,
        permissions: claims.permissions,
        sessionId: claims.sessionId,
        permissionVersion: claims.permVersion,
        correlationId: correlationIdOf(request),
        locale: negotiateLocale(request.headers['accept-language']),
      };
    } catch (error) {
      // A rejected token is a warning, never an error: it is the expected outcome of an
      // expired session. The token itself is never logged.
      this.logger.warn('Access token rejected', {
        correlationId: correlationIdOf(request),
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return null;
    }
  }
}
