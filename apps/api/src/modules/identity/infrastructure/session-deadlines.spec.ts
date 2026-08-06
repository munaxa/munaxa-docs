import { describe, expect, it } from 'vitest';
import {
  MemoryRefreshFamilyStore,
  SessionManager,
  sessionStoreOverFamilies,
} from '@munaxa/session';
import { unsafeId } from '@munaxa/types';
import type { SessionId, TenantId, UserId } from '@munaxa/types';

import { createSessionManager } from './session-manager.provider';
import type { AppConfig } from '../../../core/config';
import type { ClockPort } from '../../../ports/clock.port';

/**
 * The phase's absolute requirement, checked rather than asserted: a refresh lineage must never
 * remain valid indefinitely.
 *
 * Both deadlines are exercised against a movable clock, because the interesting cases are the ones
 * that only appear after time passes — and a suite that cannot move time cannot reach them.
 */

const TENANT = unsafeId<TenantId>('acme');
const USER = unsafeId<UserId>('u1');
const START = 1_700_000_000_000;

const IDLE_MS = 8 * 60 * 60 * 1_000;
const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1_000;

function fixture(): { manager: SessionManager; advance: (ms: number) => void } {
  let now = START;
  const manager = new SessionManager({
    store: sessionStoreOverFamilies(new MemoryRefreshFamilyStore()),
    clock: { now: () => now },
    policy: { idleTimeout: IDLE_MS, absoluteTimeout: ABSOLUTE_MS },
  });
  return {
    manager,
    advance: (ms) => {
      now += ms;
    },
  };
}

async function open(manager: SessionManager): Promise<SessionId> {
  const session = await manager.create({
    tenantId: TENANT,
    userId: USER,
    authMethods: ['password'],
    mfaSatisfied: false,
    tokenVersion: 1,
  });
  return session.id;
}

describe('session deadlines', () => {
  it('persists every lifecycle field the platform needs', async () => {
    const { manager } = fixture();
    const session = await manager.create({
      tenantId: TENANT,
      userId: USER,
      authMethods: ['password', 'totp'],
      mfaSatisfied: true,
      tokenVersion: 7,
    });

    expect(session.lastSeenAt).toBe(START);
    expect(session.idleExpiresAt).toBe(START + IDLE_MS);
    expect(session.absoluteExpiresAt).toBe(START + ABSOLUTE_MS);
    expect(session.authMethods).toEqual(['password', 'totp']);
    expect(session.mfaSatisfied).toBe(true);
    expect(session.tokenVersion).toBe(7);
  });

  it('expires a lineage that stops rotating', async () => {
    const { manager, advance } = fixture();
    const id = await open(manager);

    advance(IDLE_MS - 1);
    expect((await manager.validate(TENANT, id)).valid).toBe(true);

    advance(2);
    const result = await manager.validate(TENANT, id);
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe('idle-expired');
  });

  it('slides the idle window on rotation, so an active lineage survives', async () => {
    const { manager, advance } = fixture();
    const id = await open(manager);

    // Six rotations, each just inside the idle window. Well past it in total.
    for (let i = 0; i < 6; i++) {
      advance(IDLE_MS - 1_000);
      expect(await manager.touch(TENANT, id)).toBeDefined();
    }

    expect((await manager.validate(TENANT, id)).valid).toBe(true);
  });

  it('kills a lineage at the absolute deadline however diligently it rotates', async () => {
    // The case an idle timeout alone cannot catch, and the reason two deadlines exist: this is
    // exactly what a thief holding a stolen token does.
    const { manager, advance } = fixture();
    const id = await open(manager);

    for (let i = 0; i < 200; i++) {
      advance(IDLE_MS - 1_000);
      await manager.touch(TENANT, id);
    }

    const result = await manager.validate(TENANT, id);
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe('absolute-expired');
  });

  it('never lets rotation push the idle window past the absolute deadline', async () => {
    const { manager, advance } = fixture();
    const id = await open(manager);

    // Rotate steadily up to just inside the absolute deadline, so the lineage is alive when the
    // last touch lands — that is the only moment the clamp is observable.
    let elapsed = 0;
    while (elapsed + IDLE_MS - 1_000 < ABSOLUTE_MS - 1_000) {
      advance(IDLE_MS - 1_000);
      elapsed += IDLE_MS - 1_000;
      await manager.touch(TENANT, id);
    }
    advance(ABSOLUTE_MS - 1_000 - elapsed);
    const touched = await manager.touch(TENANT, id);

    expect(touched).toBeDefined();
    expect(touched?.idleExpiresAt).toBe(START + ABSOLUTE_MS);
  });
});

describe('the wiring the application actually builds', () => {
  const config = {
    auth: {
      sessionIdleTtlSeconds: 28_800,
      sessionAbsoluteTtlSeconds: 2_592_000,
      maxConcurrentSessions: 10,
    },
  } as unknown as AppConfig;

  const clock = { now: () => new Date(START), monotonicMs: () => START } as unknown as ClockPort;

  it('refuses a configuration that would write an invalid deadline', () => {
    // Without this the missing value becomes `new Date(NaN)`, Postgres rejects the insert, and the
    // operator sees a Prisma validation error a long way from the setting that caused it.
    const broken = {
      auth: { ...config.auth, sessionIdleTtlSeconds: undefined },
    } as unknown as AppConfig;
    expect(() => createSessionManager(broken, clock, {} as never)).toThrow(
      /positive sessionIdleTtlSeconds/,
    );
  });

  it('refuses to run without store-enforced concurrency', () => {
    // A store without `createWithinLimit` leaves the limit best-effort, which this product is
    // required not to ship. Failing at construction is what keeps that impossible.
    expect(() => createSessionManager(config, clock, {} as never)).toThrow(/store-enforced/);
  });
});
