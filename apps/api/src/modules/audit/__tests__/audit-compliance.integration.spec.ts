import 'reflect-metadata';

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  type AnyId,
  AuditOutcome,
  AuditSubjectType,
  Permission,
  Settings,
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
  type RetentionStack,
  realAuditStack,
  realDisposition,
  realDocumentLibrary,
  realDownloadRedemption,
  realRetention,
} from '../../../testing/real-collaborators';
import { seedRoleGrant } from '../../../testing/acl-seed';
import { grantOfLink } from '../../../testing/download-links';
import { AuditArtefactRedeemer } from '../application/audit-artefact.redeemer';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import { toChainLink } from '../application/audit-verification.service';
import { AuditExportState } from '../application/ports';
import { StorageCheckpointStore } from '../infrastructure/storage-checkpoint.store';
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
const LINK_SECRET = 'an-audit-suite-download-link-secret-32';

const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
/** A day later, for the one collaborator that has to run after the blob grace period. */
const sweepClock = new FakeClock(new Date('2026-01-02T00:00:00Z'));

let storageRoot: string;
let config: AppConfig;
let prisma: ReturnType<typeof sharedDatabase>;
let unitOfWork: PrismaUnitOfWork;
let stack: AuditStack;
let library: ReturnType<typeof realDocumentLibrary>;
let sweep: RetentionStack;

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
    antivirus: {
      icap: null,
      maxBytes: 134_217_728,
      timeoutMs: 120_000,
      budgetBytes: 268_435_456,
      queueTimeoutMs: 60_000,
    },
    providers: { antivirus: 'NONE' },
    // ADR-0026 §10: an evidence artefact's download is a verified link the API serves.
    app: { port: 3001 },
    auth: { accessSecret: LINK_SECRET },
    download: { linkTtlSeconds: 60, maxFileBytes: 32 * 1024 * 1024 },
    audit: {
      readBufferSize: 1_000,
      readBufferMax: 10_000,
      readFlushIntervalMs: 3_600_000,
      checkpointSecret: CHECKPOINT_SECRET,
      previousCheckpointSecrets: [],
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

  /*
   * The blob reaper, on a clock a day past everything this suite writes — Slice 101.
   *
   * `reclaimBlobs` selects `ref_count = 0` and `updated_at` older than the grace period, so a
   * sweep running on the suite's own instant would select nothing whatever the counts said, and
   * would prove the opposite of what it looks like it proves. A grace of zero days and a clock one
   * day ahead is the grace period having passed, stated as data rather than as a sleep.
   */
  sweep = realRetention({
    clock: sweepClock,
    unitOfWork,
    storage: library.storagePort,
    storageService: library.storage,
    disposition: realDisposition(sweepClock, library.storage, library.writer),
    settings: { [Settings.RETENTION_BLOB_GRACE_DAYS.key]: 0 },
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

  it('still accepts a checkpoint signed before a key rotation while the old key is held', async () => {
    // R-5 of the Hetzner readiness report. A checkpoint names no key, so each held key is tried;
    // the old key is held for reading only. Without it the checkpoint is ignored — verification
    // then starts further back, which is safe and loses only the shortcut.
    const authentic = await runWithContext(contextFor(), () => stack.checkpoints.latest());
    if (authentic === null) {
      throw new Error('A checkpoint was expected from the passes above.');
    }
    const ROTATED = 'the-checkpoint-key-after-the-rotation-2222';
    const storeWith = (previousCheckpointSecrets: readonly string[]): StorageCheckpointStore =>
      new StorageCheckpointStore(
        library.storagePort,
        {
          ...config,
          audit: { ...config.audit, checkpointSecret: ROTATED, previousCheckpointSecrets },
        },
        { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      );

    expect(storeWith([]).isAuthentic(authentic)).toBe(false);
    expect(storeWith([CHECKPOINT_SECRET]).isAuthentic(authentic)).toBe(true);
    // Holding the old key does not make a forgery pass.
    expect(storeWith([CHECKPOINT_SECRET]).isAuthentic({ ...authentic, sequence: 99n })).toBe(false);
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
      apiClientId: null,
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

  // Phase 14: the timeline resolves its *subject* through the resolver, and the resolver now walks
  // the object's chain. A document id naming nothing resolves to no chain and therefore to a
  // refusal — which is `AccessDenialRecorder`'s own prediction arriving: "when the ACL walk arrives
  // and decisions become object-dependent, the condition starts to matter". So the document exists.
  beforeAll(async () => {
    await seedDocument(document);
  });

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

  /**
   * The release candidate's D-8: a completed bundle can actually be taken.
   *
   * Every artefact is stored `derived`/`SKIPPED` — `storeStreamed` never calls the scanner — and the
   * link gate used to require `CLEAN`, so `download` refused every bundle it was ever asked for.
   */
  it('hands a completed bundle to its requester as signed links, from artefacts as the product stored them', async () => {
    const requester = asId<UserId>(uuidv7());
    const asRequester = <T>(work: () => Promise<T>): Promise<T> =>
      runWithContext(
        contextFor({ userId: requester, permissions: [Permission.AUDIT_EXPORT] }),
        work,
      );
    const requested = await asRequester(() =>
      stack.exports.request(new Date('2020-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'), {}),
    );
    await runWithContext(contextFor(), () => stack.exports.run(requested.id));
    const produced = await runWithContext(contextFor(), () => stack.exports.get(requested.id));
    expect(produced?.state).toBe(AuditExportState.COMPLETED);

    const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    try {
      for (const artefact of produced?.artefacts ?? []) {
        const file = await owner.fileObject.findUniqueOrThrow({
          where: { id: artefact.fileObjectId },
        });
        expect(file.derived).toBe(true);
        expect(file.scanStatus).toBe('SKIPPED');
      }
    } finally {
      await owner.$disconnect();
    }

    const links = await asRequester(() => stack.exports.download(requested.id));
    expect(links.map((link) => link.name).sort()).toEqual([
      'events.csv',
      'events.jsonl',
      'manifest.json',
      'manifest.sig',
    ]);
    for (const link of links) {
      expect(link.url).toBeTruthy();
    }
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

/**
 * The smallest chain the walk can cross, with one document at the end of it.
 *
 * Written through the unit of work under a request context — as a request would — rather than as
 * `edms_owner` past row-level security. The rows here are ordinary configuration, so either would
 * work; doing it this way keeps the suite honest about which writes it is entitled to make.
 */
async function seedDocument(documentId: AnyId): Promise<void> {
  const libraryId = uuidv7();
  const folderId = uuidv7();
  const ruleId = uuidv7();
  const levelId = uuidv7();
  const typeId = uuidv7();

  await runWithContext(contextFor(), () =>
    unitOfWork.run(async () => {
      const tx = requireTransaction();
      await tx.library.create({
        data: {
          id: libraryId,
          tenantId: TENANT,
          code: 'LIB',
          name: 'Quality',
          ownerScopeType: 'TENANT',
        },
      });
      await tx.folder.create({
        // `path` is the folder's own identifier: a materialised path is `pathFor(null, id)`, and a
        // label here would send the chain reader looking for a folder called "root".
        data: {
          id: folderId,
          tenantId: TENANT,
          libraryId,
          name: 'Root',
          path: folderId,
          isRoot: true,
        },
      });
      await tx.library.update({ where: { id: libraryId }, data: { rootFolderId: folderId } });
      await tx.confidentialityLevel.create({
        data: { id: levelId, tenantId: TENANT, code: 'INTERNAL', name: 'Internal', rank: 1 },
      });
      await tx.numberingRule.create({
        data: { id: ruleId, tenantId: TENANT, key: 'default', name: 'Default', segments: [] },
      });
      await tx.documentType.create({
        data: {
          id: typeId,
          tenantId: TENANT,
          code: 'PROC',
          name: 'Procedure',
          numberingRuleId: ruleId,
          defaultConfidentialityId: levelId,
        },
      });
      await tx.document.create({
        data: {
          id: documentId,
          tenantId: TENANT,
          folderId,
          documentTypeId: typeId,
          confidentialityId: levelId,
          title: 'Audited Procedure',
          status: 'DRAFT',
          ownerUserId: uuidv7(),
        },
      });
    }),
  );
}

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

/**
 * A completed evidence bundle and the blob reaper — Slice 101.
 *
 * `AuditExportService` writes each artefact with `StorageService.storeStreamed`, which inserts the
 * `file_object` at a reference count of **zero** exactly as `storeDerived` does, and then records
 * the four identifiers on the `audit_export` row through `complete`. Nothing in between takes a
 * reference.
 *
 * Every other place in this product that points a row at a blob takes one, and says why — a
 * revision on upload ("a revision holding an uncounted blob is one retention will delete
 * underneath"), a preview artefact, an OCR result, the bulk export's manifest, and, since Slice
 * 100, the report export. `retention.reclaim-blobs` selects `ref_count = 0` past a grace period
 * and `listReclaimable` does not exempt a derived blob.
 *
 * So the next sweep destroys a `COMPLETED` bundle's bytes while its own row still names them and
 * still attests `chainIntact`. The artefacts are stored as JSON rather than behind a foreign key,
 * so not even `onDelete: Restrict` is in the way — and an evidence bundle is the one artefact in
 * this product whose whole purpose is to still exist when somebody comes asking.
 */
describe('a completed evidence bundle and the blob reaper', () => {
  it('keeps every artefact the bundle points at out of the reaper’s reach', async () => {
    const requester = asId<UserId>(uuidv7());
    const requested = await runWithContext(
      contextFor({ userId: requester, permissions: [Permission.AUDIT_EXPORT] }),
      () =>
        stack.exports.request(new Date('2020-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'), {
          action: 'SLICE_101',
        }),
    );
    await runWithContext(contextFor(), () => stack.exports.run(requested.id));
    const produced = await runWithContext(contextFor(), () => stack.exports.get(requested.id));
    expect(produced?.state).toBe(AuditExportState.COMPLETED);
    expect(produced?.artefacts).toHaveLength(4);

    const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    try {
      /*
       * The invariant, read before the sweep: one reference per live row that points at the blob.
       *
       * Counted over every bundle's artefacts rather than asserted as `1`, because content
       * addressing means it need not be one — two narrowed bundles that shipped no rows produce
       * byte-identical artefacts and share a `file_object`, and each of them owes it a reference.
       * This is the assertion that fails before the fix: the count is zero however many bundles
       * name the file.
       */
      const bundles = await owner.auditExport.findMany({
        where: { tenantId: TENANT },
        select: { artefacts: true },
      });
      // Pointers, not rows: the artefacts live in a JSON array, so one bundle can legitimately
      // name a blob more than once when two of its artefacts came out byte-identical, and each
      // such pointer is owed its own reference.
      const pointersTo = (fileObjectId: string): number =>
        bundles
          .flatMap((bundle) => (bundle.artefacts ?? []) as { fileObjectId?: string }[])
          .filter((artefact) => artefact.fileObjectId === fileObjectId).length;

      for (const artefact of produced?.artefacts ?? []) {
        const blob = await owner.fileObject.findUniqueOrThrow({
          where: { id: artefact.fileObjectId },
        });
        expect(blob.refCount, `${artefact.name}: one reference for every pointer at the file`).toBe(
          pointersTo(artefact.fileObjectId),
        );
      }

      // The sweep the schedule runs nightly, through the real reaper, with the grace period past.
      // It must find nothing here to take.
      await runWithContext(contextFor(), () => sweep.retention.reclaimBlobs(100));

      for (const artefact of produced?.artefacts ?? []) {
        const after = await owner.fileObject.findUniqueOrThrow({
          where: { id: artefact.fileObjectId },
        });
        expect(
          after.deletedAt,
          `${artefact.name}: the reaper must not take an artefact a bundle points at`,
        ).toBeNull();

        // And the point of keeping the row: the evidence itself is still on disk, byte for byte
        // the thing the manifest attested.
        const bytes = await readFile(join(storageRoot, TENANT, artefact.storageKey));
        expect(sha256(bytes), `${artefact.name}: the bytes the manifest attested`).toBe(
          artefact.sha256,
        );
      }
    } finally {
      await owner.$disconnect();
    }
  }, 120_000);
});

/**
 * An evidence bundle's verified download links — ADR-0026 §10, the export design §3.3.
 *
 * Issued all or nothing (E-5), one verified link per artefact the API serves, never a store URL;
 * each re-asked when it is followed: the person, `audit:export` held now, the export still
 * `COMPLETED`, and the artefact the link names still the export's own, with its file, name and
 * media type. Any holder of `audit:export` may take any completed bundle — the policy as it was.
 *
 * Two bundles of the same range and filters write byte-identical `events.jsonl` and `events.csv`,
 * which content addressing stores once (E-9). Each export's record is still the authority on its
 * own artefacts; the shared blob decides nothing but whether its bytes are intact.
 */
describe('an evidence bundle is downloaded through verified links', () => {
  const DORA = asId<UserId>(uuidv7());
  const AUDITOR_ROLE = uuidv7();
  let owner: PrismaClient;
  let redemption: ReturnType<typeof realDownloadRedemption>['redemption'];
  const asDora = <T>(work: () => Promise<T>): Promise<T> =>
    runWithContext(
      contextFor({
        userId: DORA,
        roles: [AUDITOR_ROLE],
        permissions: [Permission.AUDIT_EXPORT],
        permissionVersion: 1,
      }),
      work,
    );

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    await owner.user.create({
      data: {
        id: DORA,
        tenantId: TENANT,
        email: `${DORA}@audit.test`,
        emailNormalized: `${DORA}@audit.test`,
        displayName: 'dora',
        status: 'ACTIVE',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await seedRoleGrant(owner, {
      tenantId: TENANT,
      roleId: AUDITOR_ROLE,
      key: 'AUDITOR',
      userIds: [DORA],
      permissions: [Permission.AUDIT_EXPORT, Permission.AUDIT_VIEW],
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const composed = realDownloadRedemption({ unitOfWork });
    new AuditArtefactRedeemer(composed.registry, stack.exports).onModuleInit();
    redemption = composed.redemption;
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  /** A completed bundle of the given range, produced by the lane's own `run`. */
  async function bundle(from = '2020-01-01T00:00:00Z', to = '2030-01-01T00:00:00Z') {
    const requested = await asDora(() => stack.exports.request(new Date(from), new Date(to), {}));
    await runWithContext(contextFor(), () => stack.exports.run(requested.id));
    const produced = await runWithContext(contextFor(), () => stack.exports.get(requested.id));
    expect(produced?.state).toBe(AuditExportState.COMPLETED);
    return produced!;
  }

  const count = (action: string, filter: Record<string, unknown> = {}) =>
    owner.auditEvent.count({ where: { tenantId: TENANT, action, ...filter } });

  const issuedFor = (exportId: string) =>
    owner.auditEvent.count({
      where: {
        tenantId: TENANT,
        action: 'FILE_DOWNLOAD_ISSUED',
        payload: { path: ['after', 'auditExportId'], equals: exportId },
      },
    });

  it('issues one verified link per artefact, all in one transaction with BULK_DOWNLOAD, and redeems each as its artefact', async () => {
    const produced = await bundle();
    const bulkBefore = await count('BULK_DOWNLOAD');

    const links = await asDora(() => stack.exports.download(produced.id));

    expect(links.map((link) => link.name).sort()).toEqual(
      produced.artefacts.map((artefact) => artefact.name).sort(),
    );
    expect(await issuedFor(produced.id)).toBe(produced.artefacts.length);
    expect(await count('BULK_DOWNLOAD')).toBe(bulkBefore + 1);
    for (const link of links) {
      const artefact = produced.artefacts.find((candidate) => candidate.name === link.name)!;
      const grant = grantOfLink(link.url, LINK_SECRET, new Date('2026-01-01T00:00:00Z'));
      expect(grant).toMatchObject({
        userId: DORA,
        subject: { kind: 'AUDIT_ARTEFACT', exportId: produced.id, artefact: artefact.name },
        fileObjectId: artefact.fileObjectId,
        mimeType: artefact.mediaType,
        filename: artefact.name,
      });
      await expect(redemption.redeem(grant, 'audit-suite')).resolves.toMatchObject({
        audit: { auditExportId: produced.id, artefact: artefact.name },
      });
    }
  }, 120_000);

  it('issues a single artefact on request, and says only that one was handed out', async () => {
    const produced = await bundle();
    const links = await asDora(() => stack.exports.download(produced.id, 'events.csv'));
    expect(links.map((link) => link.name)).toEqual(['events.csv']);
    expect(await issuedFor(produced.id)).toBe(1);
    const row = await owner.auditEvent.findFirstOrThrow({
      where: { tenantId: TENANT, action: 'BULK_DOWNLOAD', subjectId: produced.id },
    });
    expect(row.payload).toMatchObject({
      after: { artefacts: ['events.csv'], delivery: 'VERIFIED' },
    });
    await expect(
      asDora(() => stack.exports.download(produced.id, 'nothing.txt')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 120_000);

  it('issues nothing at all when one artefact is refused, and records nothing (E-5)', async () => {
    const produced = await bundle();
    const manifest = produced.artefacts.find((artefact) => artefact.name === 'manifest.json')!;
    const bulkBefore = await count('BULK_DOWNLOAD', { subjectId: produced.id });
    await owner.fileObject.update({
      where: { id: manifest.fileObjectId },
      data: { integrityStatus: 'MISMATCH' },
    });

    await expect(asDora(() => stack.exports.download(produced.id))).rejects.toMatchObject({
      code: 'CONTENT_NOT_SCANNED',
    });
    // Not even the artefacts checked before the refused one: the transaction took them back.
    expect(await issuedFor(produced.id)).toBe(0);
    expect(await count('BULK_DOWNLOAD', { subjectId: produced.id })).toBe(bulkBefore);

    // Another artefact of the same bundle is still its own download.
    await asDora(() => stack.exports.download(produced.id, 'events.csv'));
    expect(await issuedFor(produced.id)).toBe(1);
  }, 120_000);

  it('issues nothing when an artefact’s object is missing from the store', async () => {
    const produced = await bundle('2019-01-01T00:00:00Z', '2030-02-01T00:00:00Z');
    const csv = produced.artefacts.find((artefact) => artefact.name === 'events.csv')!;
    await runWithContext(contextFor(), () => library.storagePort.delete(csv.storageKey as never));

    await expect(asDora(() => stack.exports.download(produced.id))).rejects.toMatchObject({
      code: 'CONTENT_NOT_SCANNED',
    });
    expect(await issuedFor(produced.id)).toBe(0);
  }, 120_000);

  it('refuses at redemption once audit:export is withdrawn, or the person’s permissions moved', async () => {
    const produced = await bundle();
    const [link] = await asDora(() => stack.exports.download(produced.id, 'events.jsonl'));
    const grant = grantOfLink(link!.url, LINK_SECRET, new Date('2026-01-01T00:00:00Z'));

    await owner.userRole.deleteMany({ where: { userId: DORA, roleId: AUDITOR_ROLE } });
    await expect(redemption.redeem(grant, 'audit-suite')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await owner.userRole.create({
      data: { tenantId: TENANT, userId: DORA, roleId: AUDITOR_ROLE, assignedAt: new Date() },
    });
    await redemption.redeem(grant, 'audit-suite');

    await owner.user.update({ where: { id: DORA }, data: { permissionVersion: 2 } });
    await expect(redemption.redeem(grant, 'audit-suite')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await owner.user.update({ where: { id: DORA }, data: { permissionVersion: 1 } });
  }, 120_000);

  it('refuses a link whose artefact, file, name or media type is not the export’s own, and one of another kind', async () => {
    const produced = await bundle();
    const [link] = await asDora(() => stack.exports.download(produced.id, 'events.jsonl'));
    const grant = grantOfLink(link!.url, LINK_SECRET, new Date('2026-01-01T00:00:00Z'));
    const manifest = produced.artefacts.find((artefact) => artefact.name === 'manifest.json')!;
    const refused = [
      // Another artefact's name over this artefact's file: the substitution a shared blob invites.
      { ...grant, subject: { ...grant.subject, artefact: 'manifest.json' } },
      // This artefact's name over another artefact's file.
      { ...grant, fileObjectId: manifest.fileObjectId },
      { ...grant, filename: 'events.html' },
      { ...grant, mimeType: 'text/html' },
      { ...grant, subject: { ...grant.subject, exportId: uuidv7() } },
      { ...grant, subject: { kind: 'REPORT_EXPORT' as const, exportId: produced.id } },
      { ...grant, tenantId: asId<TenantId>(uuidv7()) },
    ];
    for (const candidate of refused) {
      await expect(
        redemption.redeem(candidate, 'audit-suite'),
        JSON.stringify(candidate.subject),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  }, 120_000);

  it('keeps each export the authority on its own artefacts when two share a blob (E-9)', async () => {
    // A range with no events in it: both bundles' event files are byte-identical, and stored once.
    const first = await bundle('2001-01-01T00:00:00Z', '2001-01-02T00:00:00Z');
    const second = await bundle('2001-01-01T00:00:00Z', '2001-01-02T00:00:00Z');
    const jsonlOf = (record: typeof first) =>
      record.artefacts.find((artefact) => artefact.name === 'events.jsonl')!;
    const manifestOf = (record: typeof first) =>
      record.artefacts.find((artefact) => artefact.name === 'manifest.json')!;
    expect(jsonlOf(first).fileObjectId).toBe(jsonlOf(second).fileObjectId);
    // The manifests name their own export, so they are not shared.
    expect(manifestOf(first).fileObjectId).not.toBe(manifestOf(second).fileObjectId);

    const [link] = await asDora(() => stack.exports.download(first.id, 'events.jsonl'));
    const grant = grantOfLink(link!.url, LINK_SECRET, new Date('2026-01-01T00:00:00Z'));
    // The same file under the second export's name is answered by the second export's record.
    await expect(
      redemption.redeem(
        {
          ...grant,
          subject: {
            kind: 'AUDIT_ARTEFACT' as const,
            exportId: String(second.id),
            artefact: 'events.jsonl',
          },
        },
        'audit-suite',
      ),
    ).resolves.toMatchObject({ audit: { auditExportId: second.id, artefact: 'events.jsonl' } });

    // The second export failing takes nothing from the first.
    await owner.auditExport.update({ where: { id: second.id }, data: { state: 'FAILED' } });
    await expect(
      redemption.redeem(
        {
          ...grant,
          subject: {
            kind: 'AUDIT_ARTEFACT' as const,
            exportId: String(second.id),
            artefact: 'events.jsonl',
          },
        },
        'audit-suite',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(redemption.redeem(grant, 'audit-suite')).resolves.toMatchObject({
      audit: { auditExportId: first.id },
    });

    // A finding about the shared bytes is about every export that holds them — the same object —
    // and about nothing else: each bundle's own manifest is still its own, and still served.
    await owner.fileObject.update({
      where: { id: jsonlOf(first).fileObjectId },
      data: { integrityStatus: 'MISMATCH' },
    });
    await expect(redemption.redeem(grant, 'audit-suite')).rejects.toMatchObject({
      code: 'CONTENT_NOT_SCANNED',
    });
    await expect(
      asDora(() => stack.exports.download(first.id, 'events.jsonl')),
    ).rejects.toMatchObject({ code: 'CONTENT_NOT_SCANNED' });
    await expect(
      asDora(() => stack.exports.download(first.id, 'manifest.json')),
    ).resolves.toHaveLength(1);
    await owner.fileObject.update({
      where: { id: jsonlOf(first).fileObjectId },
      data: { integrityStatus: 'UNVERIFIED' },
    });
  }, 120_000);

  it('records every repeated download as its own issuance', async () => {
    const produced = await bundle();
    await asDora(() => stack.exports.download(produced.id, 'events.csv'));
    await asDora(() => stack.exports.download(produced.id, 'events.csv'));
    expect(await issuedFor(produced.id)).toBe(2);
  }, 120_000);
});

/**
 * An evidence bundle is produced in bounded memory — the export design §6 d.
 *
 * The range used to be collected whole before either artefact was written, so a long range was
 * held in the API's memory in full. Now it is read a batch at a time and written as it is read:
 * these assert that writing begins after the first batch, long before the last is read, and that
 * the two artefacts — two passes over the range — carry the same events or the export fails.
 */
describe('an evidence bundle is produced in bounded memory', () => {
  it('writes rows while it is still reading the range, and both files carry the same events', async () => {
    for (let index = 0; index < 40; index += 1) {
      await record(`STREAM_${String(index)}`);
    }
    let slicesRead = 0;
    const original = stack.repository.sliceBySequence.bind(stack.repository);
    const slices = vi
      .spyOn(stack.repository, 'sliceBySequence')
      .mockImplementation(async (after, limit) => {
        slicesRead += 1;
        return original(after, limit);
      });
    const firstRowAfter: Record<string, number> = {};
    const lastRowAfter: Record<string, number> = {};
    const store = library.storage.storeStreamed.bind(library.storage);
    const stored = vi.spyOn(library.storage, 'storeStreamed').mockImplementation((input) =>
      store({
        ...input,
        body: (async function* () {
          for await (const chunk of input.body) {
            firstRowAfter[input.name] ??= slicesRead;
            lastRowAfter[input.name] = slicesRead;
            yield chunk;
          }
        })(),
      }),
    );
    try {
      const requested = await runWithContext(contextFor({ userId: asId<UserId>(uuidv7()) }), () =>
        stack.exports.request(
          new Date('2020-01-01T00:00:00Z'),
          new Date('2030-01-01T00:00:00Z'),
          {},
        ),
      );
      await runWithContext(contextFor(), () => stack.exports.run(requested.id));
      const produced = await runWithContext(contextFor(), () => stack.exports.get(requested.id));
      expect(produced?.state).toBe(AuditExportState.COMPLETED);

      // The batch size is 5 and the trail holds far more: the first row was on its way to the
      // store after one batch, while the pass went on to read many more.
      expect(firstRowAfter['events.jsonl']).toBe(1);
      expect(lastRowAfter['events.jsonl']).toBeGreaterThan(8);
      // The second pass began again from the start and wrote as it read, too.
      expect(
        (lastRowAfter['events.csv'] ?? 0) - (firstRowAfter['events.csv'] ?? 0),
      ).toBeGreaterThan(8);

      const jsonl = produced?.artefacts.find((artefact) => artefact.name === 'events.jsonl');
      const csv = produced?.artefacts.find((artefact) => artefact.name === 'events.csv');
      const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
      try {
        const read = async (fileObjectId: string) => {
          const file = await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
          const bytes = await runWithContext(contextFor(), () =>
            library.storagePort.read(file.storageKey as never),
          );
          return bytes?.toString('utf8') ?? '';
        };
        const jsonlIds = (await read(jsonl?.fileObjectId ?? ''))
          .split('\n')
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { id: string }).id);
        const csvLines = (await read(csv?.fileObjectId ?? '')).split(/\r?\n/u).filter(Boolean);
        expect(jsonlIds.length).toBe(produced?.eventCount);
        expect(csvLines.length - 1).toBe(produced?.eventCount);
        for (const id of jsonlIds) {
          expect(csvLines.some((line) => line.includes(id))).toBe(true);
        }
      } finally {
        await owner.$disconnect();
      }
    } finally {
      slices.mockRestore();
      stored.mockRestore();
    }
  }, 120_000);

  it('fails rather than produce two files that disagree, when the passes read different events', async () => {
    await record('DISAGREE_ONE');
    const original = stack.repository.sliceBySequence.bind(stack.repository);
    let pass = 0;
    const slices = vi
      .spyOn(stack.repository, 'sliceBySequence')
      .mockImplementation(async (after, limit) => {
        const slice = await original(after, limit);
        if (after === 0n) {
          pass += 1;
        }
        // The second pass sees one event's hash differently — as if a row changed in between.
        return pass === 2 && slice.events.length > 0
          ? {
              ...slice,
              events: [{ ...slice.events[0]!, hash: 'f'.repeat(64) }, ...slice.events.slice(1)],
            }
          : slice;
      });
    try {
      const requested = await runWithContext(contextFor({ userId: asId<UserId>(uuidv7()) }), () =>
        stack.exports.request(
          new Date('2020-01-01T00:00:00Z'),
          new Date('2030-01-01T00:00:00Z'),
          {},
        ),
      );
      await expect(
        runWithContext(contextFor(), () => stack.exports.run(requested.id)),
      ).rejects.toThrow(/two passes over the range read different events/u);
      const failed = await runWithContext(contextFor(), () => stack.exports.get(requested.id));
      expect(failed?.state).toBe(AuditExportState.FAILED);
      expect(failed?.artefacts).toEqual([]);
    } finally {
      slices.mockRestore();
    }
  }, 120_000);
});
