import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { type TenantId, type UserId, Permission, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { UnitOfWork } from '../../../core/prisma/unit-of-work';
import { runWithContext } from '../../../core/tenancy/tenant-context';
import type { AuthenticationService } from '../application/authentication.ports';
import type { UserContact, UserDirectory } from '../application/ports';
import { AuthController } from './auth.controller';

/**
 * `/auth/me` carries the caller's own name and address — Phase 7.9.
 *
 * Phase 7.8 measured the account chip rendering two UUIDs, and established that the web
 * application had nothing else to render: this route returned identifiers only. The information was
 * never missing from the domain — `User` has carried `display_name` and `email` since Phase 1 — so
 * the fix is a response that includes what the record already holds, not a name derived from a
 * UUID.
 *
 * These assert the contract rather than the query: `UserDirectory` is a double here because the
 * question is what the route *returns* for a given caller, and the directory's own behaviour is
 * covered where it lives.
 */
const TENANT = asId<TenantId>(uuidv7());
const USER = asId<UserId>(uuidv7());

function contextFor(userId: UserId | null): Parameters<typeof runWithContext>[0] {
  return {
    tenantId: TENANT,
    userId,
    roles: ['QUALITY_MANAGER'],
    permissions: [Permission.DOCUMENT_VIEW],
    sessionId: null,
    correlationId: 'test',
    permissionVersion: 1,
    locale: 'en',
  };
}

/**
 * A pass-through unit of work.
 *
 * The route opens one because the API does not wrap requests in a transaction globally — the first
 * version of this change did not, threw `NoActiveTransactionError` into the route's own `catch`,
 * and returned nulls from a build that passed every gate. Running the work here rather than
 * doubling it away keeps that wiring inside what these tests exercise.
 */
const passThroughUnitOfWork: UnitOfWork = {
  run: <T>(work: () => Promise<T>): Promise<T> => work(),
};

function controllerWith(directory: Partial<UserDirectory>): AuthController {
  return new AuthController(
    {} as unknown as AuthenticationService,
    directory as unknown as UserDirectory,
    passThroughUnitOfWork,
  );
}

describe('GET /auth/me', () => {
  it('returns the caller’s display name and email', async () => {
    const contact: UserContact = {
      userId: USER,
      email: 'quality.manager@example.test',
      displayName: 'Quality Manager',
    };
    const controller = controllerWith({ contactFor: () => Promise.resolve(contact) });

    const me = await runWithContext(contextFor(USER), () => controller.me());

    expect(me.displayName).toBe('Quality Manager');
    expect(me.email).toBe('quality.manager@example.test');
    // The identifiers stay: the client still needs them, and this is an addition rather than a
    // replacement.
    expect(me.userId).toBe(USER);
    expect(me.tenantId).toBe(TENANT);
  });

  it('asks the directory for the caller and nobody else', async () => {
    const asked: UserId[] = [];
    const controller = controllerWith({
      contactFor: (userId) => {
        asked.push(userId);
        return Promise.resolve(null);
      },
    });

    await runWithContext(contextFor(USER), () => controller.me());

    expect(asked).toStrictEqual([USER]);
  });

  /**
   * A token need not stand for a person.
   *
   * An API-key caller has a tenant and permissions and nobody behind it (ADR-0018 keeps `userId`
   * the person the key acts as, but a context can still carry none). Null is the honest answer;
   * inventing a name for a machine is the thing this phase refuses to do.
   */
  it('returns nulls rather than a fabricated name when there is no user', async () => {
    let called = false;
    const controller = controllerWith({
      contactFor: () => {
        called = true;
        return Promise.resolve(null);
      },
    });

    const me = await runWithContext(contextFor(null), () => controller.me());

    expect(me.displayName).toBeNull();
    expect(me.email).toBeNull();
    expect(called, 'the directory was queried for a caller that is not a person').toBe(false);
  });

  /**
   * The account chip is not worth an authenticated request failing over.
   *
   * `/auth/me` is what the web application calls to decide whether it may render the workspace at
   * all — `(workspace)/layout.tsx` redirects to `/login` when it throws. A directory read that
   * fails must therefore degrade to "no name", not to "signed out".
   */
  it('still identifies the caller when the directory read fails', async () => {
    const controller = controllerWith({
      contactFor: () => Promise.reject(new Error('directory unavailable')),
    });

    const me = await runWithContext(contextFor(USER), () => controller.me());

    expect(me.userId).toBe(USER);
    expect(me.displayName).toBeNull();
    expect(me.permissions).toStrictEqual([Permission.DOCUMENT_VIEW]);
  });
});
