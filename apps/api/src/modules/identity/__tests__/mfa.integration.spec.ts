import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AnyId, type TenantId, type UserId, asId } from '@edms/domain';
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
import { PrismaSessionRepository } from '../infrastructure/prisma-session.repository';

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
  auth: { accessSecret: 'an-integration-suite-secret-of-at-least-32' },
  mfa: {
    totpStepSeconds: 30,
    totpDigits: 6,
    totpSkewSteps: 1,
    recoveryCodeCount: 4,
    maxFailedAttempts: 3,
  },
} as unknown as AppConfig;

let owner: PrismaClient;
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
    new PrismaSessionRepository(clock),
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
      new PrismaSessionRepository(clock),
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

/**
 * One authenticator code proves one thing, however many challenges meet it — Slice 53.
 *
 * `challenge` reads the enrolment, decides `step > lastStep`, and then writes the step it proved.
 * The decision and the write are two statements in one transaction, and two challenges are two
 * transactions: both read the same `last_step`, both find the code arithmetically correct and
 * unspent, and both are told so. The service's own comment calls the second one a replay — "the
 * window a code is arithmetically correct for is thirty seconds wide, and one already spent inside
 * it is a replay" — and `IdentitySignerAuthenticator` goes through this method precisely so "the
 * replay window ... appl[ies] to a signature exactly as [it applies] to a sign-in".
 *
 * Both callers reach it from their own transaction: `challenge` opens a unit of work, and neither
 * of these is invoked from inside the other's callback, so neither joins the other's transaction.
 */
describe('one authenticator code, one proof, however many challenges meet it', () => {
  const CARA = asId<UserId>(uuidv7());
  const caraContext: RequestContext = { ...context, userId: CARA };
  const asCara = <T>(work: () => Promise<T>): Promise<T> => runWithContext(caraContext, work);

  /**
   * Two callers, each parked where it writes the step it proved.
   *
   * Ordinals are assigned by arrival, and the arrival order is fixed rather than observed: the
   * second challenge is not started until the first has parked, so the first is always ordinal
   * zero. Reaching the park at all is the evidence — a caller only writes a step it has already
   * decided is unspent, so two parked callers holding the same step is proof that both passed the
   * replay check, and not that one of them never looked.
   */
  class Turnstile {
    readonly proving: number[] = [];
    readonly reached: Promise<void>[] = [];
    private readonly arrivals: (() => void)[] = [];
    private readonly admissions: Promise<void>[] = [];
    private readonly admits: (() => void)[] = [];
    private armed = false;

    arm(callers: number): void {
      for (let index = 0; index < callers; index += 1) {
        let arrive: () => void = () => undefined;
        this.reached.push(
          new Promise<void>((resolve) => {
            arrive = resolve;
          }),
        );
        this.arrivals.push(arrive);
        let admit: () => void = () => undefined;
        this.admissions.push(
          new Promise<void>((resolve) => {
            admit = resolve;
          }),
        );
        this.admits.push(admit);
      }
      this.armed = true;
    }

    async park(step: number): Promise<void> {
      if (!this.armed) {
        return;
      }
      const ordinal = this.proving.length;
      this.proving.push(step);
      this.arrivals[ordinal]?.();
      await this.admissions[ordinal];
    }

    release(ordinal: number): void {
      this.admits[ordinal]?.();
    }
  }

  const turnstile = new Turnstile();

  /**
   * The real repository, subclassed rather than substituted: every statement is the production
   * one, and the override adds a place to stand between the decision and the write.
   */
  class ParkingMfaRepository extends PrismaMfaRepository {
    override async claimStep(enrolmentId: AnyId, step: number): Promise<boolean> {
      await turnstile.park(step);
      return super.claimStep(enrolmentId, step);
    }
  }

  /** Built in `beforeAll`, because the unit of work it needs is built in the suite's own. */
  let parking: DefaultMfaService;

  let secret = '';

  async function storedStep(): Promise<bigint | null> {
    const row = await owner.mfaEnrolment.findFirstOrThrow({
      where: { tenantId: TENANT, userId: CARA },
      select: { lastStep: true },
    });
    return row.lastStep;
  }

  async function replaysRecorded(): Promise<number> {
    const rows = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, subjectId: String(CARA), action: 'MFA_FAILED' },
      select: { payload: true },
    });
    return rows.filter((row) => JSON.stringify(row.payload).includes('REPLAYED')).length;
  }

  beforeAll(async () => {
    await owner.user.create({
      data: {
        id: CARA,
        tenantId: TENANT,
        email: `${CARA}@mfa.test`,
        emailNormalized: `${CARA}@mfa.test`,
        displayName: 'Cara',
        status: 'ACTIVE',
        updatedAt: new Date(now),
      },
    });
    parking = new DefaultMfaService(
      new ParkingMfaRepository(config, new RecordStamps(clock)),
      new PrismaSessionRepository(clock),
      realAuditWriter(clock, unitOfWork),
      unitOfWork,
      clock,
      config,
    );
    now = new Date(now.getTime() + 60_000);
    secret = (await asCara(() => parking.begin(CARA, 'cara@mfa.test'))).secret;
    await asCara(() => parking.confirm(CARA, totpCode(secret, step(), 6)));
  });

  it('accepts a code once', async () => {
    // The control. Without it every assertion below passes on a service that refuses everything.
    now = new Date(now.getTime() + 60_000);
    expect(await asCara(() => parking.challenge(CARA, totpCode(secret, step(), 6)))).toBe(true);
    expect(await storedStep()).toBe(BigInt(step()));
  });

  it('refuses the same code again when the two challenges are ordered', async () => {
    // The serial answer the concurrent one has to match, and the reason the failure below is
    // about concurrency rather than about the check being absent.
    expect(await asCara(() => parking.challenge(CARA, totpCode(secret, step(), 6)))).toBe(false);
  });

  it('proves one code once when two challenges hold it at the same moment', async () => {
    now = new Date(now.getTime() + 60_000);
    const spent = step();
    const code = totpCode(secret, spent, 6);
    const replaysBefore = await replaysRecorded();
    turnstile.arm(2);

    // Each from its own scope, so each opens its own transaction.
    const first = asCara(() => parking.challenge(CARA, code));
    await turnstile.reached[0];
    const second = asCara(() => parking.challenge(CARA, code));
    await turnstile.reached[1];

    // Both read the enrolment, both judged this code unspent, and both are about to say so.
    expect(turnstile.proving).toEqual([spent, spent]);

    turnstile.release(0);
    const firstAnswer = await first;
    turnstile.release(1);
    const secondAnswer = await second;

    // One code, one proof. The second challenge met a step that had already been spent, which is
    // the replay the ordered test above refuses.
    expect(firstAnswer).toBe(true);
    expect(secondAnswer).toBe(false);
    expect(await storedStep()).toBe(BigInt(spent));
    expect(await replaysRecorded()).toBe(replaysBefore + 1);
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
