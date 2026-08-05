import 'reflect-metadata';

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type AnyId,
  AuditOutcome,
  AuditSubjectType,
  Permission,
  type TenantId,
  type UserId,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AuditActor } from '../../../core/audit/audit-writer.port';
import {
  CHAIN_HASH_V1,
  CURRENT_CHAIN_HASH_VERSION,
  GENESIS_HASH,
  chainHash,
  verifyChain,
} from '../../../core/audit/hash-chain';
import type { AppConfig } from '../../../core/config/configuration';
import { PrismaUnitOfWork, requireTransaction } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { FakeClock } from '../../../testing/fake-ports';
import {
  type AuditStack,
  realAuditStack,
  realDocumentLibrary,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import { toChainLink } from '../application/audit-verification.service';
import { AuditExportState } from '../application/ports';
import { verifyManifestSignature } from '../domain/evidence-bundle';

/**
 * Phase 9 against a real PostgreSQL — the assertions only a database can be trusted about.
 *
 * - **A tampered row is refused, and detection is proved separately.** The table's trigger refuses
 *   the `UPDATE` for every role, owner included, so a "tamper then detect" test is impossible by
 *   construction — which is itself the strongest result. So the refusal is asserted, and detection
 *   is asserted against a chain deliberately built divergent: the same evidence, without asking the
 *   database to permit something it correctly forbids.
 * - **A gap in the sequence is detected**, which is the hole the digest alone cannot see.
 * - **The timeline refuses an entry the caller may not see**, through the real resolver.
 * - **A bundle's manifest digests match the bytes actually written**, read back from disk.
 * - **The chain holds under concurrent writes to one tenant**, verified rather than merely
 *   contiguous.
 * - **Buffered read auditing lands chained and contiguous**, which is what makes 13 §5's exemption
 *   safe rather than merely faster.
 * - **A forged checkpoint is refused**, which is what makes a checkpoint outside the database
 *   evidence rather than a note.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const TENANT = asId<TenantId>(uuidv7());
const SLUG = `audit9-${Date.now()}`;
const CHECKPOINT_SECRET = 'phase-9-checkpoint-secret-at-least-32';

const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));

let storageRoot: string;
let config: AppConfig;
let prisma: ReturnType<typeof sharedDatabase>;
let unitOfWork: PrismaUnitOfWork;
let stack: AuditStack;
let library: ReturnType<typeof realDocumentLibrary>;

function contextFor(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: TENANT,
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId: 'audit-compliance',
    permissionVersion: 0,
    locale: 'en',
    ...overrides,
  };
}

const actor: AuditActor = {
  tenantId: TENANT,
  userId: null,
  channel: 'SYSTEM',
  correlationId: 'audit-compliance',
  ipAddress: null,
  userAgent: null,
};

function entry(action: string, subjectId: AnyId = asId<AnyId>(uuidv7())) {
  return {
    action,
    subjectType: AuditSubjectType.CONFIGURATION,
    subjectId,
    outcome: AuditOutcome.SUCCESS,
    payload: { action },
  };
}

async function record(action: string, subjectId?: AnyId): Promise<void> {
  await runWithContext(contextFor(), () =>
    stack.writer.writeStandalone(actor, entry(action, subjectId)),
  );
}

/** Every event this tenant holds, in written order. */
async function trail() {
  return runWithContext(contextFor(), () =>
    unitOfWork.run(() => stack.repository.sliceBySequence(0n, 1_000)),
  );
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  storageRoot = await mkdtemp(join(tmpdir(), 'edms-audit9-'));

  config = {
    env: 'test',
    isProduction: false,
    database: { url: APP_URL, poolSize: 10 },
    storage: {
      driver: 'LOCAL',
      localRoot: storageRoot,
      signedUrlTtlSeconds: 300,
      maxUploadBytes: 1_073_741_824,
      streamPartBytes: 5_242_880,
      publicUrl: 'http://localhost:3001/v1/transfer',
    },
    audit: {
      readBufferSize: 1_000,
      readBufferMax: 10_000,
      readFlushIntervalMs: 3_600_000,
      checkpointSecret: CHECKPOINT_SECRET,
      verifyBatchSize: 5,
      verifyMaxEvents: 10_000,
      exportBatchSize: 5,
    },
  } as unknown as AppConfig;

  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as never;

  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.tenant.create({ data: { id: TENANT, slug: SLUG, name: SLUG, status: 'ACTIVE' } });
  await owner.$disconnect();

  prisma = sharedDatabase(config, logger, APP_URL);
  unitOfWork = new PrismaUnitOfWork(prisma);
  const registry = everyTenantRegistry(APP_URL, { [SLUG]: TENANT });

  library = realDocumentLibrary({
    clock,
    unitOfWork,
    config,
    registry,
    storageRoot,
    signingSecret: 'audit-compliance-signing-secret-32-chars',
    antivirus: {
      scan: () => Promise.resolve({ status: 'CLEAN', scanner: 'test', threat: null }),
    } as never,
    users: { get: () => Promise.resolve(null) } as never,
  });

  stack = realAuditStack({
    clock,
    unitOfWork,
    config,
    storage: library.storage,
    storagePort: library.storagePort,
  });
});

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

describe('the chain, verified against what the database actually holds', () => {
  it('verifies a chain the real writer appended, and checkpoints outside the database', async () => {
    await record('FIRST');
    await record('SECOND');
    await record('THIRD');

    const result = await runWithContext(contextFor(), () => stack.verification.verify());

    expect(result).toMatchObject({ intact: true, brokenAt: null, checkpointed: true });
    expect(result.eventsVerified).toBe(3);
    expect(result.toSequence).toBe(3n);

    // The checkpoint is in the object store, not the table it attests. That separation is the
    // whole of §4's claim, and a checkpoint row beside the events would not have it.
    const latest = await runWithContext(contextFor(), () => stack.checkpoints.latest());
    expect(latest?.sequence).toBe(3n);
    expect(stack.checkpoints.isAuthentic(latest as never)).toBe(true);

    // And it is genuinely a file in the tenant's own storage prefix, not a row anywhere.
    const written = await readFile(
      join(storageRoot, TENANT, 'audit', 'checkpoints', `${'3'.padStart(20, '0')}.json`),
      'utf8',
    );
    expect(JSON.parse(written)).toMatchObject({ sequence: '3', algorithm: 'HMAC-SHA256' });
  });

  it('resumes from the checkpoint rather than re-walking the trail', async () => {
    await record('FOURTH');

    const result = await runWithContext(contextFor(), () => stack.verification.verify());

    // Only the new event. A pass that re-walked from genesis every night would be a pass that
    // stops running on the day the trail gets large — which is the day it starts mattering.
    expect(result.fromSequence).toBe(3n);
    expect(result.eventsVerified).toBe(1);
    expect(result.toSequence).toBe(4n);
  });

  it('refuses a forged checkpoint, so resuming cannot be steered', async () => {
    const authentic = await runWithContext(contextFor(), () => stack.checkpoints.latest());
    expect(authentic).not.toBeNull();
    if (authentic === null) {
      return;
    }

    // A checkpoint that claims a different position, carrying the signature of the real one. If
    // this were accepted, an attacker with the bucket could move the resume point past rows they
    // had rewritten and the next pass would find nothing wrong.
    expect(stack.checkpoints.isAuthentic({ ...authentic, sequence: 99n })).toBe(false);
    expect(stack.checkpoints.isAuthentic({ ...authentic, hash: 'f'.repeat(64) })).toBe(false);
    expect(stack.checkpoints.isAuthentic(authentic)).toBe(true);
  });

  it('refuses an update or a delete, even for the owner — so tampering cannot be staged', async () => {
    const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    const attempt = (statement: string): Promise<unknown> =>
      owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", TENANT);
        return tx.$executeRawUnsafe(statement);
      });

    await expect(attempt("UPDATE audit_event SET action = 'TAMPERED'")).rejects.toThrowError(
      /append-only/,
    );
    await expect(attempt('DELETE FROM audit_event')).rejects.toThrowError(/append-only/);
    await owner.$disconnect();
  });

  it('detects a row whose field was altered, over the digest the database stored', async () => {
    // The database will not let a row be edited, so the alteration is applied to the *records*
    // read back from it. The digests, the links and the verifier are all the real ones: what is
    // simulated is only the tampering the table refuses to permit.
    const slice = await trail();
    const altered = slice.events.map((event, index) =>
      index === 1 ? { ...event, action: 'TAMPERED' } : event,
    );

    const result = verifyChain(altered.map(toChainLink), {
      from: slice.from,
      fromSequence: 1n,
    });

    expect(result.intact).toBe(false);
    expect(result.reason).toBe('DIGEST_MISMATCH');
    expect(result.brokenAt).toBe(slice.events[1]?.id);
  });

  it('detects an altered reason — the field the widened digest exists for', async () => {
    const slice = await trail();
    const altered = slice.events.map((event, index) =>
      index === 0 ? { ...event, reason: 'Fabricated authority' } : event,
    );

    // Under the Phase 1 digest this row would verify: `reason` was not in the material. Every row
    // written since Phase 9 carries the wider one, and this is what that buys.
    expect(slice.events[0]?.chainHashVersion).toBe(CURRENT_CHAIN_HASH_VERSION);
    expect(
      verifyChain(altered.map(toChainLink), { from: slice.from, fromSequence: 1n }).intact,
    ).toBe(false);
  });

  it('detects a gap in the sequence, which the digests alone cannot see', async () => {
    const slice = await trail();
    // Remove the *last* events: what remains still chains perfectly, because the removal took the
    // links with it. Only contiguity makes the hole visible, and only when the range's start is
    // asserted — which is what a signed checkpoint provides.
    const truncated = slice.events.slice(0, -2);
    expect(
      verifyChain(truncated.map(toChainLink), { from: slice.from, fromSequence: 1n }).intact,
    ).toBe(true);

    const middleRemoved = [...slice.events.slice(0, 1), ...slice.events.slice(2)];
    const result = verifyChain(middleRemoved.map(toChainLink), {
      from: slice.from,
      fromSequence: 1n,
    });
    expect(result.intact).toBe(false);
    expect(result.reason).toBe('SEQUENCE_GAP');
  });

  it('holds under concurrent writes to one tenant', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => record(`CONCURRENT_${index}`)));

    const result = await runWithContext(contextFor(), () => stack.verification.verify());
    expect(result.intact).toBe(true);

    const slice = await trail();
    expect(slice.events.map((event) => Number(event.sequence))).toEqual(
      Array.from({ length: slice.events.length }, (_unused, index) => index + 1),
    );
  });

  it('verifies a chain that spans both digest versions', () => {
    // What an upgraded deployment holds. Built here rather than seeded, because the rows the
    // database has were all written by the current writer — and a verifier that could not cross
    // the widening would fail on every real installation's first night.
    const first = {
      eventId: uuidv7(),
      tenantId: TENANT,
      sequence: 1n,
      occurredAt: new Date('2026-01-01T00:00:00Z'),
      actorId: null,
      onBehalfOfId: null,
      channel: 'SYSTEM',
      action: 'LEGACY',
      subjectType: 'CONFIGURATION',
      subjectId: uuidv7(),
      outcome: 'SUCCESS',
      payload: {},
      reason: null,
      correlationId: 'legacy',
      ipAddress: null,
      userAgent: null,
    };
    const firstHash = chainHash(GENESIS_HASH, first, CHAIN_HASH_V1);
    const second = { ...first, eventId: uuidv7(), sequence: 2n, action: 'CURRENT' };
    const secondHash = chainHash(firstHash, second, CURRENT_CHAIN_HASH_VERSION);

    expect(
      verifyChain(
        [
          { hash: firstHash, previousHash: GENESIS_HASH, version: CHAIN_HASH_V1, event: first },
          {
            hash: secondHash,
            previousHash: firstHash,
            version: CURRENT_CHAIN_HASH_VERSION,
            event: second,
          },
        ],
        { fromSequence: 1n },
      ).intact,
    ).toBe(true);
  });
});

describe('the timeline, filtered to what the caller may see', () => {
  const document = asId<AnyId>(uuidv7());

  it('answers a caller whose role grants document:view', async () => {
    await record('DOCUMENT_CHANGED', document);

    const role = asId<AnyId>(uuidv7());
    await grantRole(role, Permission.DOCUMENT_VIEW);

    const page = await runWithContext(
      contextFor({ userId: asId<UserId>(uuidv7()), roles: [role] }),
      () => stack.read.timelineFor(AuditSubjectType.DOCUMENT, document, { page: 1, pageSize: 25 }),
    );
    expect(page.meta.total).toBe(1);
  });

  it('refuses a caller whose roles hold nothing, and records the refusal', async () => {
    const before = (await trail()).events.length;

    await expect(
      runWithContext(contextFor({ userId: asId<UserId>(uuidv7()), roles: [] }), () =>
        stack.read.timelineFor(AuditSubjectType.DOCUMENT, document, { page: 1, pageSize: 25 }),
      ),
    ).rejects.toThrowError(/requested resource/);

    // 08 §7: the refusal is itself evidence. `ACCESS_DENIED` had no writer in the product until
    // this phase, and a compliance surface that could not say who was turned away would be the
    // wrong half of an audit trail.
    const after = await trail();
    expect(after.events.length).toBe(before + 1);
    const denial = after.events.at(-1);
    expect(denial?.action).toBe('ACCESS_DENIED');
    expect(denial?.outcome).toBe(AuditOutcome.DENIED);
    expect(denial?.subjectId).toBe(document);
  });

  it('answers an auditor without asking the object question at all', async () => {
    // `audit:view` is the trail-wide grant. Re-resolving each subject for its holder would deny
    // an auditor the timelines their role exists to read.
    const page = await runWithContext(
      contextFor({
        userId: asId<UserId>(uuidv7()),
        roles: [],
        permissions: [Permission.AUDIT_VIEW],
      }),
      () => stack.read.timelineFor(AuditSubjectType.DOCUMENT, document, { page: 1, pageSize: 25 }),
    );
    expect(page.meta.total).toBeGreaterThan(0);
  });

  it('refuses a subject with no scope of its own to a caller without the trail-wide grant', async () => {
    // A `SEARCH` row carries the actor's own user id — the first subject in the product that is
    // not a domain object. There is no object question to ask, so the only reading of "may see"
    // is the trail-wide grant, and this caller does not hold it.
    await expect(
      runWithContext(contextFor({ userId: asId<UserId>(uuidv7()), roles: [] }), () =>
        stack.read.timelineFor(AuditSubjectType.SEARCH, asId<AnyId>(uuidv7()), {
          page: 1,
          pageSize: 25,
        }),
      ),
    ).rejects.toThrowError(/requested resource/);
  });
});

describe('buffered read auditing', () => {
  it('lands chained and contiguous, a batch at a time under one lock', async () => {
    const subject = asId<AnyId>(uuidv7());
    const before = (await trail()).events.length;

    for (let index = 0; index < 5; index += 1) {
      await stack.readAudit.record(actor, {
        action: 'DOCUMENT_VIEWED',
        subjectType: AuditSubjectType.DOCUMENT,
        subjectId: subject,
        outcome: AuditOutcome.SUCCESS,
        payload: { view: index },
      });
    }
    // Nothing is durable yet — which is exactly the trade §5 accepts, and why the buffer's hard
    // bound is documented as "how much a crash would lose".
    expect((await trail()).events.length).toBe(before);
    expect(stack.readAudit.pending).toBe(5);

    const flushed = await stack.readAudit.flush();
    expect(flushed.written).toBe(5);
    expect(flushed.retained).toBe(0);

    const slice = await trail();
    expect(slice.events.length).toBe(before + 5);
    // The property that makes the exemption safe: buffered events are still hash-chained, and
    // the sequence is still gap-free across the join between buffered and synchronous writes.
    expect(
      verifyChain(slice.events.map(toChainLink), { from: slice.from, fromSequence: 1n }).intact,
    ).toBe(true);
  });

  it('keeps the instant of the read, not the instant of the flush', async () => {
    const subject = asId<AnyId>(uuidv7());
    clock.set(new Date('2026-03-01T10:00:00Z'));
    await stack.readAudit.record(actor, {
      action: 'DOCUMENT_VIEWED',
      subjectType: AuditSubjectType.DOCUMENT,
      subjectId: subject,
      outcome: AuditOutcome.SUCCESS,
      payload: {},
    });
    clock.set(new Date('2026-03-01T11:00:00Z'));
    await stack.readAudit.flush();

    const slice = await trail();
    const recorded = slice.events.filter((event) => event.subjectId === subject);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.occurredAt.toISOString()).toBe('2026-03-01T10:00:00.000Z');
  });
});

describe('the evidence bundle', () => {
  it('produces artefacts whose digests match the bytes on disk, and a manifest that verifies', async () => {
    const requester = asId<UserId>(uuidv7());

    const requested = await runWithContext(
      contextFor({ userId: requester, permissions: [Permission.AUDIT_EXPORT] }),
      () =>
        stack.exports.request(
          new Date('2020-01-01T00:00:00Z'),
          new Date('2030-01-01T00:00:00Z'),
          {},
        ),
    );
    expect(requested.state).toBe(AuditExportState.REQUESTED);
    // 202 at the endpoint, and the lane is what does the work.
    expect(stack.enqueuedJobs.at(-1)?.jobId).toBe(`audit:export:${requested.id}`);

    await runWithContext(contextFor(), () => stack.exports.run(requested.id));

    const produced = await runWithContext(contextFor(), () => stack.exports.get(requested.id));
    expect(produced?.state).toBe(AuditExportState.COMPLETED);
    expect(produced?.chainIntact).toBe(true);
    expect(produced?.eventCount).toBeGreaterThan(0);

    const named = new Map((produced?.artefacts ?? []).map((item) => [item.name, item]));
    expect([...named.keys()].sort()).toEqual([
      'events.csv',
      'events.jsonl',
      'manifest.json',
      'manifest.sig',
    ]);

    // The digests in the record are the digests of what genuinely reached the filesystem. A
    // manifest whose hashes were computed from anything else would be a bundle nobody could check.
    for (const artefact of produced?.artefacts ?? []) {
      const bytes = await readFile(join(storageRoot, TENANT, artefact.storageKey));
      expect(bytes.length).toBe(artefact.sizeBytes);
      expect(sha256(bytes)).toBe(artefact.sha256);
    }

    const manifestBytes = await readFile(
      join(storageRoot, TENANT, named.get('manifest.json')?.storageKey ?? ''),
    );
    const signatureBytes = await readFile(
      join(storageRoot, TENANT, named.get('manifest.sig')?.storageKey ?? ''),
    );
    const signature = signatureBytes.toString('utf8').trim().split(' ')[1] ?? '';
    expect(
      verifyManifestSignature(manifestBytes.toString('utf8'), signature, CHECKPOINT_SECRET),
    ).toBe(true);

    const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
    // The manifest's own count agrees with the rows it shipped, and the artefact digests it
    // states are the ones just checked against disk.
    expect(manifest['eventCount']).toBe(produced?.eventCount);
    const listed = manifest['artefacts'] as { name: string; sha256: string }[];
    expect(listed.find((item) => item.name === 'events.jsonl')?.sha256).toBe(
      named.get('events.jsonl')?.sha256,
    );
    // And the honesty clause is present rather than implied.
    expect((manifest['attests'] as unknown[]).length).toBeGreaterThan(0);

    // One JSONL line per exported row, and the line count agrees with the count claimed.
    const jsonl = await readFile(
      join(storageRoot, TENANT, named.get('events.jsonl')?.storageKey ?? ''),
      'utf8',
    );
    expect(jsonl.trimEnd().split('\n')).toHaveLength(produced?.eventCount ?? 0);
  });

  it('is idempotent under redelivery: a second run produces no second bundle', async () => {
    const requester = asId<UserId>(uuidv7());
    const requested = await runWithContext(
      contextFor({ userId: requester, permissions: [Permission.AUDIT_EXPORT] }),
      () =>
        stack.exports.request(new Date('2020-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'), {
          action: 'FIRST',
        }),
    );
    await runWithContext(contextFor(), () => stack.exports.run(requested.id));
    const first = await runWithContext(contextFor(), () => stack.exports.get(requested.id));

    await runWithContext(contextFor(), () => stack.exports.run(requested.id));
    const second = await runWithContext(contextFor(), () => stack.exports.get(requested.id));

    expect(second?.completedAt?.toISOString()).toBe(first?.completedAt?.toISOString());
    expect(second?.artefacts.map((item) => item.sha256)).toEqual(
      first?.artefacts.map((item) => item.sha256),
    );
  });

  it('applies its filters, so a narrowed bundle carries only what was asked for', async () => {
    const requester = asId<UserId>(uuidv7());
    const requested = await runWithContext(
      contextFor({ userId: requester, permissions: [Permission.AUDIT_EXPORT] }),
      () =>
        stack.exports.request(new Date('2020-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'), {
          action: 'ACCESS_DENIED',
        }),
    );
    await runWithContext(contextFor(), () => stack.exports.run(requested.id));
    const produced = await runWithContext(contextFor(), () => stack.exports.get(requested.id));

    const jsonl = await readFile(
      join(
        storageRoot,
        // The tenant's storage prefix, from the placement the registry resolved — which for a
        // suite constructing services directly is the tenant id itself. Reading through it rather
        // than around it is what makes this an assertion about isolation as well as about digests.
        TENANT,
        produced?.artefacts.find((item) => item.name === 'events.jsonl')?.storageKey ?? '',
      ),
      'utf8',
    );
    const rows = jsonl
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { action: string });
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.action))).toEqual(new Set(['ACCESS_DENIED']));

    // The chain is still verified over the *whole* range rather than over the filtered subset: a
    // subsequence of a chain never chains, because the links between the excluded rows are gone.
    expect(produced?.chainIntact).toBe(true);
  });

  it('audits the export itself, and the taking of it', async () => {
    const actions = (await trail()).events.map((event) => event.action);
    expect(actions).toContain('AUDIT_EXPORTED');
  });
});

/** A tenant-level role grant, which is what `PrismaAclResolver` resolves today (08 §9). */
async function grantRole(roleId: AnyId, permission: string): Promise<void> {
  await runWithContext(contextFor(), () =>
    unitOfWork.run(async () => {
      const tx = requireTransaction();
      await tx.role.create({
        data: {
          id: roleId,
          tenantId: TENANT,
          key: `role-${roleId.slice(0, 8)}`,
          name: 'Reader',
          isSystem: false,
        },
      });
      await tx.rolePermission.create({ data: { tenantId: TENANT, roleId, permission } });
    }),
  );
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
