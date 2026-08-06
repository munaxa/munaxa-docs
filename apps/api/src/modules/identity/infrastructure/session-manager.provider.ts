import { Inject } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { SessionManager, sessionStoreOverFamilies } from '@munaxa/session';
import { unsafeId } from '@munaxa/types';
import type { SessionId } from '@munaxa/types';
import { uuidv7 } from '@edms/utils';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { PrismaRefreshFamilyStore } from './prisma-refresh-family.store';

export const SESSION_MANAGER = Symbol('SessionManager');

/**
 * The platform's `SessionManager`, over this product's refresh families.
 *
 * There is no sessions table and none is being added: `sessionStoreOverFamilies` presents
 * `session_family` as a `SessionStorePort`, so every session guarantee the platform states applies
 * to the rows this product already had.
 *
 * Two settings deserve to be read rather than skimmed.
 *
 * **`generateId`.** Family ids are `@db.Uuid`, with `refresh_token.family_id` a foreign key onto
 * them. The platform's default `sess_…` format cannot be stored in that column, and migrating the
 * column type plus every key referencing it in exchange for an identifier format is not a trade
 * worth making. `uuidv7(now)` is what this product has always minted, so ids are unchanged and
 * every existing row still matches.
 *
 * **`limitEnforcement`.** `PrismaRefreshFamilyStore` implements `createWithinLimit`, so the manager
 * runs in `store-transaction` mode: the concurrency limit is enforced by a locked read inside the
 * caller's transaction rather than by a hopeful count. The assertion below is deliberate — a
 * refactor that dropped `createWithinLimit` would silently downgrade the limit to a suggestion, and
 * that is exactly the failure this product is required not to ship.
 */
export function createSessionManager(
  config: AppConfig,
  clock: ClockPort,
  store: PrismaRefreshFamilyStore,
): SessionManager {
  const manager = new SessionManager({
    store: sessionStoreOverFamilies(store),
    clock: { now: () => clock.now().getTime() },
    generateId: (now) => unsafeId<SessionId>(uuidv7(now)),
    policy: {
      // A family that stops rotating dies when its refresh token would have. Preserving the
      // existing window means no active user is signed out by this migration.
      idleTimeout: config.auth.refreshTtlSeconds * 1_000,
      // The bound this product did not have. Previously a lineage kept alive by rotation lived
      // forever; now it dies here regardless of how diligently it is refreshed.
      absoluteTimeout: config.auth.sessionAbsoluteTtlSeconds * 1_000,
      maxConcurrent: config.auth.maxConcurrentSessions,
      onLimitReached: 'evict-oldest',
    },
  });

  if (manager.limitEnforcement !== 'store-transaction') {
    // Fail at wiring time rather than in production. A limit that is really a hint is worse than
    // no limit, because it is reported as enforced.
    throw new Error(
      `Session concurrency must be store-enforced; got ${manager.limitEnforcement}. ` +
        'PrismaRefreshFamilyStore.createWithinLimit is missing or was not wired.',
    );
  }

  return manager;
}

export const sessionManagerProvider: Provider = {
  provide: SESSION_MANAGER,
  useFactory: createSessionManager,
  inject: [APP_CONFIG, CLOCK_PORT, PrismaRefreshFamilyStore],
};

/** Injects the platform session manager. */
export const InjectSessionManager = (): ParameterDecorator => Inject(SESSION_MANAGER);
