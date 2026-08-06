import type { Provider } from '@nestjs/common';
import { RefreshTokenService } from '@munaxa/auth';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { PrismaRefreshTokenStore } from './prisma-refresh-token.store';

export const REFRESH_TOKEN_SERVICE = Symbol('RefreshTokenService');

/** The platform's service, named as a product capability. See `session-manager.provider.ts`. */
export type PlatformRefreshTokenService = RefreshTokenService;

/**
 * Refresh-token rotation, owned by `@munaxa/auth`.
 *
 * **No pepper, deliberately.** The platform hashes with `tokenFingerprint(token, pepper)`, which
 * without a pepper is `sha256(token)` in hex — byte-for-byte what this product has always stored.
 * That equality is the only reason rotation could move to the platform without invalidating a
 * single live refresh token. Adding a pepper later is a real option, but it is a migration with a
 * grace period, not a configuration change: every token issued before it would stop resolving, and
 * every signed-in user would be signed out at once.
 *
 * The TTL is the product's existing `JWT_REFRESH_TTL_SECONDS`, so tokens keep the lifetime they
 * have always had.
 */
export function createRefreshTokenService(
  config: AppConfig,
  clock: ClockPort,
  store: PrismaRefreshTokenStore,
): RefreshTokenService {
  if (!Number.isFinite(config.auth.refreshTtlSeconds) || config.auth.refreshTtlSeconds <= 0) {
    throw new Error(
      `Refresh tokens need a positive refreshTtlSeconds; got ${String(config.auth.refreshTtlSeconds)}.`,
    );
  }

  return new RefreshTokenService({
    store,
    clock: { now: () => clock.now().getTime() },
    ttl: config.auth.refreshTtlSeconds * 1_000,
  });
}

export const refreshTokenServiceProvider: Provider = {
  provide: REFRESH_TOKEN_SERVICE,
  useFactory: createRefreshTokenService,
  inject: [APP_CONFIG, CLOCK_PORT, PrismaRefreshTokenStore],
};
