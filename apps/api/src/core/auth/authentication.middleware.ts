import { Inject, Injectable, Optional, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { ActorChannel, parseApiKey } from '@edms/domain';
import { negotiateLocale } from '@edms/i18n';

import { correlationIdOf } from '../http/correlation-id.middleware';
import { LOGGER, type Logger } from '../observability/logger';
import { type RequestContext, runWithContext } from '../tenancy/tenant-context';
import { API_KEY_AUTHENTICATOR, type ApiKeyAuthenticator } from './api-key.authenticator';
import { TOKEN_VERIFIER, type TokenVerifier } from './access-token';

/**
 * Establishes the request context and keeps it alive for the whole request.
 *
 * It runs as middleware, not as a guard, for one reason: `AsyncLocalStorage.run()` must wrap
 * everything downstream — guards, pipes, the controller, the use case and the repository —
 * and only a middleware that calls `next()` inside `run()` can do that.
 *
 * A missing or invalid credential is **not** rejected here. It leaves the context unset, and
 * `AuthenticationGuard` decides whether this particular route tolerates that. Rejecting
 * here would make it impossible to serve a health check.
 *
 * ## Two credentials, one header — Phase 17
 *
 * A machine caller presents its key in the same `Authorization: Bearer` header a person's access
 * token uses, and the two are told apart by the key's own prefix rather than by a second header.
 * That is the decision worth reading:
 *
 * - **A second header** (`X-Api-Key`) would mean every client library, every proxy configuration
 *   and every CORS allow-list learns a second name for "the credential", and a request carrying
 *   both would need a precedence rule nobody would remember.
 * - **A JWT minted for the key** would make revocation take up to an access token's lifetime,
 *   which for a credential in a script that somebody has just discovered on a laptop is the wrong
 *   direction entirely. A key is resolved on *every* request precisely so that revoking it is
 *   immediate.
 *
 * `parseApiKey` is a pure structural check — `mdk.<12>.<32+>` — so it is not a credential
 * decision and cannot be the thing that lets one through. It only says which of the two
 * resolvers to ask, and each resolver then does its own full verification.
 */
@Injectable()
export class AuthenticationMiddleware implements NestMiddleware {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly tokenVerifier: TokenVerifier,
    @Inject(LOGGER) private readonly logger: Logger,
    /**
     * Optional, so a deployment that binds no authenticator still boots and simply refuses every
     * key — the posture `AuthModule` has taken for `TOKEN_VERIFIER` since Phase 0.5.
     */
    @Optional()
    @Inject(API_KEY_AUTHENTICATOR)
    private readonly apiKeys: ApiKeyAuthenticator | null = null,
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
    const presented = header.slice('bearer '.length).trim();

    return parseApiKey(presented) !== null
      ? this.fromApiKey(request, presented)
      : this.fromAccessToken(request, presented);
  }

  private async fromAccessToken(request: Request, token: string): Promise<RequestContext | null> {
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
        channel: ActorChannel.WEB,
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

  /**
   * A machine caller's context.
   *
   * Three things are load-bearing and each is one line:
   *
   * **`userId` is the subject**, so every reach predicate in the product works unchanged and none
   * of them can meet the empty-predicate case that would return the whole tenant.
   *
   * **`sessionId` is null**, because a key exchanges for no session. Nothing may revoke a session
   * that does not exist, and `permVersion` reuse detection has nothing to detect — a key's
   * equivalent is revoking the key, which takes effect on the next request rather than at the end
   * of a token's life.
   *
   * **`channel` is `API`**, which is the value that has sat in the `actor_channel` enum since
   * Phase 0.5 with nothing writing it.
   */
  private async fromApiKey(request: Request, key: string): Promise<RequestContext | null> {
    if (!this.apiKeys) {
      return null;
    }
    try {
      const principal = await this.apiKeys.authenticate(tenantFromHost(request), key);
      if (!principal) {
        return null;
      }
      return {
        tenantId: principal.tenantId,
        userId: principal.subjectUserId,
        roles: principal.roleKeys,
        permissions: principal.permissions,
        sessionId: null,
        permissionVersion: principal.permissionVersion,
        correlationId: correlationIdOf(request),
        locale: negotiateLocale(request.headers['accept-language']),
        channel: ActorChannel.API,
        apiClientId: principal.apiClientId,
      };
    } catch (error) {
      // A key that could not be resolved because the tenant's database was unreachable is a
      // failure rather than a refusal, and it must not become an unauthenticated request that
      // some public route then serves. It is logged and the context stays unset, which
      // `AuthenticationGuard` turns into a 401 — the same answer a bad key gets, which is right:
      // the caller cannot act either way and learns nothing about which it was.
      this.logger.error('An API key could not be resolved', {
        correlationId: correlationIdOf(request),
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return null;
    }
  }
}

/**
 * The leftmost label of the host, when the host has one to spare.
 *
 * The same rule `AuthController` applies at sign-in, and with the same standing: it selects whose
 * directory this is and is never an authorisation input. What the caller may do is decided by the
 * `api_client` row this resolves to, inside that tenant's own database, under that tenant's RLS.
 *
 * Duplicated from the controller rather than shared, deliberately: `core/` may not import a
 * module, and lifting five lines into a shared helper to avoid repeating them would put a
 * host-parsing rule somewhere neither of its two readers would look for it.
 */
function tenantFromHost(request: Request): string {
  const host = (request.hostname || '').toLowerCase();
  const labels = host.split('.');
  return labels.length > 2 ? (labels[0] ?? '') : '';
}
