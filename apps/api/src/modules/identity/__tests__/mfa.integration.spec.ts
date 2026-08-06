import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type TenantId, type UserId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { RecordStamps } from '../../../core/persistence/record-stamps';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { sharedDatabase } from '../../../testing/tenant-database';
import { realAuditWriter } from '../../../testing/real-collaborators';
import { DefaultMfaService } from '../application/mfa.service';
import { totpCode } from '../domain/totp';
import { PrismaMfaRepository } from '../infrastructure/prisma-mfa.repository';
import { SessionManager } from '@munaxa/session';
import type { ClockPort } from '../../../ports/clock.port';

import { PrismaRefreshFamilyStore } from '../infrastructure/prisma-refresh-family.store';
import { createSessionManager } from '../infrastructure/session-manager.provider';

/**
 * The second factor against a real PostgreSQL.
 *
 * The unit suite (`domain/totp.spec.ts`) proves the algorithm against RFC 6238's published vectors.
 * This proves the parts only a database can be asked about: that the secret written is the secret
 * read back through the seal, that a step once consumed cannot be consumed again, that a recovery
 * code is single-use, that the failure counter stops an unbounded challenge, and that
 * `user.mfa_enrolled` — the boolean Phase 1 shipped and nothing wrote — now says what is true.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const TENANT = asId<TenantId>(uuidv7());
const ADA = asId<UserId>(uuidv7());

let now = new Date('2026-08-06T09:00:00.000Z');
const clock = {
  now: () => new Date(now),
  timestamp: () => now.getTime(),
  elapsedMs: () => 0,
};
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const config = {
  env: 'test',
  app: { name: 'Munaxa Docs', version: '0.1.0', port: 3001 },
  database: { url: APP_URL, poolSize: 10 },
  auth: {
    accessSecret: 'an-integration-suite-secret-of-at-least-32',
    refreshTtlSeconds: 2_592_000,
    sessionIdleTtlSeconds: 28_800,
    sessionAbsoluteTtlSeconds: 2_592_000,
    maxConcurrentSessions: 10,
  },
  mfa: {
    totpStepSeconds: 30,
    totpDigits: 6,
    totpSkewSteps: 1,
    recoveryCodeCount: 4,
    maxFailedAttempts: 3,
  },
} as unknown as AppConfig;

let owner: PrismaClient;
function platformSessions(cfg: AppConfig, c: ClockPort): SessionManager {
  return createSessionManager(cfg, c, new PrismaRefreshFamilyStore());
}

let unitOfWork: PrismaUnitOfWork;
let mfa: DefaultMfaService;

const context: RequestContext = {
  tenantId: TENANT,
  userId: ADA,
  roles: [],
  permissions: [],
  sessionId: null,
  correlationId: 'mfa-suite',
  permissionVersion: 1,
  locale: 'en',
};

const asAda = <T>(work: () => Promise<T>): Promise<T> => runWithContext(context, work);

const step = (): number => Math.floor(now.getTime() / 1_000 / 30);

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `mfa-${TENANT.replaceAll('-', '').slice(-16)}`,
      name: 'MFA Test',
      status: 'ACTIVE',
    },
  });
  await owner.user.create({
    data: {
      id: ADA,
      tenantId: TENANT,
      email: `${ADA}@mfa.test`,
      emailNormalized: `${ADA}@mfa.test`,
      displayName: 'Ada',
      status: 'ACTIVE',
      updatedAt: new Date(now),
    },
  });

  unitOfWork = new PrismaUnitOfWork(sharedDatabase(config, logger, APP_URL));
  mfa = new DefaultMfaService(
    new PrismaMfaRepository(config, new RecordStamps(clock)),
    platformSessions(config, clock),
    realAuditWriter(clock, unitOfWork),
    unitOfWork,
    clock,
    config,
  );
}, 120_000);

afterAll(async () => {
  await owner?.$disconnect();
});

describe('enrolling', () => {
  let secret = '';

  it('issues a secret and grants nothing until it is proved', async () => {
    const offer = await asAda(() => mfa.begin(ADA, 'ada@mfa.test'));
    secret = offer.secret;

    expect(offer.uri.startsWith('otpauth://totp/')).toBe(true);
    const status = await asAda(() => mfa.statusFor(ADA));
    // Started, not enrolled. A `begin` that flipped the boolean would lock somebody out of their
    // own account the moment their phone failed to scan the code.
    expect(status).toMatchObject({ enrolled: false, pending: true });
    const user = await owner.user.findUnique({ where: { id: ADA }, select: { mfaEnrolled: true } });
    expect(user?.mfaEnrolled).toBe(false);
  });

  it('refuses a code that is not the one the authenticator is showing', async () => {
    await expect(asAda(() => mfa.confirm(ADA, '000000'))).rejects.toThrowError(/did not match/);
  });

  it('confirms with a real code, issues the recovery codes once, and writes the boolean', async () => {
    const confirmation = await asAda(() => mfa.confirm(ADA, totpCode(secret, step(), 6)));

    expect(confirmation.recoveryCodes).toHaveLength(4);
    expect(new Set(confirmation.recoveryCodes).size).toBe(4);

    const user = await owner.user.findUnique({ where: { id: ADA }, select: { mfaEnrolled: true } });
    // The column Phase 1 shipped and nothing wrote, finally written by the thing it describes.
    expect(user?.mfaEnrolled).toBe(true);
    expect(await asAda(() => mfa.statusFor(ADA))).toMatchObject({
      enrolled: true,
      pending: false,
      recoveryCodesRemaining: 4,
    });
    // The secret is not in any read path but the one that issued it.
    const stored = await owner.mfaEnrolment.findFirst({ where: { userId: ADA } });
    expect(stored?.secret).not.toContain(secret);
  });

  it('refuses a second enrolment while one is confirmed', async () => {
    // Silently replacing it would invalidate recovery codes somebody may be holding on paper, as a
    // side effect of opening a screen.
    await expect(asAda(() => mfa.begin(ADA, 'ada@mfa.test'))).rejects.toThrowError(/already/);
  });

  it('writes MFA_ENROLLED and SESSION_REVOKED', async () => {
    const actions = await trailActions();
    expect(actions).toContain('MFA_ENROLLED');
    expect(actions).toContain('SESSION_REVOKED');
    // And the failure from the wrong code above.
    expect(actions).toContain('MFA_FAILED');
  });

  describe('challenging', () => {
    it('accepts the current code', async () => {
      now = new Date(now.getTime() + 60_000);
      expect(await asAda(() => mfa.challenge(ADA, totpCode(secret, step(), 6)))).toBe(true);
    });

    it('refuses the same code again inside its own window', async () => {
      // Arithmetically still correct, and spent. This is the thirty seconds in which a
      // shoulder-surfed code would otherwise be live.
      expect(await asAda(() => mfa.challenge(ADA, totpCode(secret, step(), 6)))).toBe(false);
    });

    it('accepts a recovery code once, and never again', async () => {
      const confirmation = await asAda(async () => {
        await mfa.remove(ADA);
        const offer = await mfa.begin(ADA, 'ada@mfa.test');
        secret = offer.secret;
        return mfa.confirm(ADA, totpCode(offer.secret, step(), 6));
      });
      const code = confirmation.recoveryCodes[0] ?? '';

      expect(await asAda(() => mfa.challenge(ADA, code))).toBe(true);
      expect(await asAda(() => mfa.statusFor(ADA))).toMatchObject({ recoveryCodesRemaining: 3 });
      expect(await asAda(() => mfa.challenge(ADA, code))).toBe(false);
    });

    it('stops answering after enough consecutive failures', async () => {
      now = new Date(now.getTime() + 120_000);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await asAda(() => mfa.challenge(ADA, '000000'))).toBe(false);
      }
      // A six-digit code is a million possibilities; an unbounded endpoint is an afternoon's work.
      // Even the *right* code is refused now, until an administrator un-enrols.
      expect(await asAda(() => mfa.challenge(ADA, totpCode(secret, step(), 6)))).toBe(false);
    });

    it('answers true for somebody with no factor, because none is owed', async () => {
      await asAda(() => mfa.remove(ADA));
      expect(await asAda(() => mfa.challenge(ADA, 'anything'))).toBe(true);
      expect(await asAda(() => mfa.isRequired(ADA))).toBe(false);
      const user = await owner.user.findUnique({
        where: { id: ADA },
        select: { mfaEnrolled: true },
      });
      expect(user?.mfaEnrolled).toBe(false);
      // The recovery codes went with it.
      expect(await owner.mfaRecoveryCode.count({ where: { tenantId: TENANT } })).toBe(0);
    });
  });
});

/**
 * Phase 18: the sealing key stopped being borrowed from the token secret, and became rotatable.
 *
 * Phase 14's report left this owed, asking for "a key management service". The deployment's secret
 * store already is one; what was missing is that the two keys shared a rotation clock and that a
 * sealed value did not say which key sealed it. Both are properties only a real database can be
 * asked about, because the whole question is what is readable after the key changes.
 */
describe('rotating the authenticator sealing key', () => {
  const BOB = asId<UserId>(uuidv7());
  const DEDICATED = 'a-dedicated-mfa-sealing-key-of-32-chars';

  const bobContext: RequestContext = { ...context, userId: BOB };
  const asBob = <T>(work: () => Promise<T>): Promise<T> => runWithContext(bobContext, work);

  /** A service whose repository holds the given key — how a rotation is expressed as a test. */
  function serviceSealingWith(sealingKey: string | null): DefaultMfaService {
    const rotated = { ...config, mfa: { ...config.mfa, sealingKey } } as unknown as AppConfig;
    return new DefaultMfaService(
      new PrismaMfaRepository(rotated, new RecordStamps(clock)),
      platformSessions(config, clock),
      realAuditWriter(clock, unitOfWork),
      unitOfWork,
      clock,
      rotated,
    );
  }

  const storedSecret = async (): Promise<string> =>
    (
      await owner.mfaEnrolment.findFirstOrThrow({
        where: { tenantId: TENANT, userId: BOB },
        select: { secret: true },
      })
    ).secret;

  beforeAll(async () => {
    await owner.user.create({
      data: {
        id: BOB,
        tenantId: TENANT,
        email: `${BOB}@mfa.test`,
        emailNormalized: `${BOB}@mfa.test`,
        displayName: 'Bob',
        status: 'ACTIVE',
        updatedAt: new Date(now),
      },
    });
  });

  let secret = '';

  it('seals in Phase 14’s exact format when no dedicated key is configured', async () => {
    // The property that makes this change deployable rather than a migration: a deployment that
    // has not opted in produces byte-compatible ciphertext, so every row already in the database
    // is still read by the code that wrote it.
    const legacy = serviceSealingWith(null);
    secret = (await asBob(() => legacy.begin(BOB, 'bob@mfa.test'))).secret;
    await asBob(() => legacy.confirm(BOB, totpCode(secret, step(), 6)));

    expect((await storedSecret()).split('.')).toHaveLength(3);
  });

  it('reads a secret sealed under the old key after the dedicated key arrives', async () => {
    // A rotation that could not read what it inherited would be a mass invalidation of every
    // enrolled authenticator in the deployment.
    now = new Date(now.getTime() + 60_000);
    const rotated = serviceSealingWith(DEDICATED);

    expect(await asBob(() => rotated.challenge(BOB, totpCode(secret, step(), 6)))).toBe(true);
  });

  it('re-seals under the current key when its owner next proves a code', async () => {
    // The one moment the plaintext and a successful proof of it exist together, which is why the
    // rotation happens here rather than in a deploy-time pass that would need every tenant's
    // secrets in one process.
    expect((await storedSecret()).startsWith('v2.')).toBe(true);
  });

  it('still verifies after the re-seal, against the same authenticator', async () => {
    now = new Date(now.getTime() + 60_000);
    const rotated = serviceSealingWith(DEDICATED);

    expect(await asBob(() => rotated.challenge(BOB, totpCode(secret, step(), 6)))).toBe(true);
    // Re-sealing changes the ciphertext and never the secret, so a second pass leaves it under v2
    // rather than flapping.
    expect((await storedSecret()).startsWith('v2.')).toBe(true);
  });

  it('refuses to guess when the key that sealed a row is gone', async () => {
    // The one failure this rotation can produce, and it must not look like a wrong code: an
    // operator who removed the variable gets an error naming it.
    now = new Date(now.getTime() + 60_000);
    const withoutKey = serviceSealingWith(null);

    await expect(
      asBob(() => withoutKey.challenge(BOB, totpCode(secret, step(), 6))),
    ).rejects.toThrowError(/MFA_TOTP_SEALING_KEY/);
  });
});

/** Fixture read of the trail; the audit read side has its own suite. */
async function trailActions(): Promise<readonly string[]> {
  const rows = await owner.auditEvent.findMany({
    where: { tenantId: TENANT },
    orderBy: { sequence: 'asc' },
    select: { action: true },
  });
  return rows.map((row) => row.action);
}
