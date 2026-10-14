import 'reflect-metadata';

import { createHash } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ScanStatus, type TenantId, type UploadSessionId, type UserId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import type { AntivirusPort, ScanVerdict } from '../../../ports/antivirus.port';
import type { BlobMetadata, StorageKey, StoragePort } from '../../../ports/storage.port';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { realS3TenantStorage, realWriteStack } from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import { DefaultStorageService } from '../application/storage.service';
import { blobKeyFor } from '../domain/content-key';
import { PrismaFileObjectRepository } from '../infrastructure/prisma-file-object.repository';
import { PrismaUploadSessionRepository } from '../infrastructure/prisma-upload-session.repository';

/**
 * The orphan sweep — ADR-0026 §10, Phase A — against real PostgreSQL and a real object store.
 *
 * Phase A left two kinds of object nothing referred to: content keys an interrupted completion had
 * copied before it could write a row (eight, when the API was killed under load), and staged bytes
 * a transfer finished after the expiry sweep had already settled its session. The sweep must remove
 * exactly those and nothing else, so every case here is judged by what is left in the store.
 *
 * Uploads run against the real clock (the store signs with it). The sweep runs through a second
 * service whose clock is two days ahead, which is how "older than the grace period" is reached
 * without waiting a day; the store's own timestamps are untouched.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const ACME = asId<TenantId>(uuidv7());
const OTHER = asId<TenantId>(uuidv7());
const ALICE = asId<UserId>(uuidv7());
const OLIVER = asId<UserId>(uuidv7());
const GRACE_SECONDS = 3_600;

function configWith(storage: Record<string, unknown>): AppConfig {
  return {
    env: 'test',
    database: { url: APP_URL, poolSize: 10 },
    storage: {
      driver: 'S3',
      signedUrlTtlSeconds: 300,
      maxUploadBytes: 50 * 1024 * 1024,
      integrityBatchSize: 200,
      integrityMaxBytes: 1024 * 1024,
      orphanGraceSeconds: GRACE_SECONDS,
      orphanSweepDryRun: false,
      ...storage,
    },
    antivirus: {
      icap: null,
      maxBytes: 134_217_728,
      timeoutMs: 120_000,
      budgetBytes: 268_435_456,
      queueTimeoutMs: 60_000,
    },
    providers: { antivirus: 'NONE' },
  } as unknown as AppConfig;
}

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;
const realClock = { now: () => new Date(), timestamp: () => 0, elapsedMs: () => 0 };
const twoDaysOn = {
  now: () => new Date(Date.now() + 2 * 24 * 3_600_000),
  timestamp: () => 0,
  elapsedMs: () => 0,
};

const config = configWith({});
const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);
const { stamps, outbox, writer } = realWriteStack(realClock, unitOfWork);
const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
const { scoped } = realS3TenantStorage(everyTenantRegistry(APP_URL));

const antivirus: AntivirusPort = {
  scanner: 'integration-suite',
  scan: (): Promise<ScanVerdict> =>
    Promise.resolve({
      status: ScanStatus.CLEAN,
      threat: null,
      scanner: 'integration-suite',
      scannerVersion: '1',
      scannedAt: new Date(),
    }),
};

/**
 * The real store, with one hook: when armed, the sweep's *second* look at a key (its last check
 * before deleting) first runs `beforeSecondLook` — the window a completion arriving mid-pass hits.
 */
class WatchedStore implements StoragePort {
  readonly driver = scoped.driver;
  armed: { key: string; looks: number; beforeSecondLook: () => Promise<void> } | null = null;
  createUploadTarget(...a: Parameters<StoragePort['createUploadTarget']>) {
    return scoped.createUploadTarget(...a);
  }
  completeUpload(...a: Parameters<StoragePort['completeUpload']>) {
    return scoped.completeUpload(...a);
  }
  createDownloadUrl(...a: Parameters<StoragePort['createDownloadUrl']>) {
    return scoped.createDownloadUrl(...a);
  }
  async head(key: StorageKey): Promise<BlobMetadata | null> {
    if (this.armed !== null && key === this.armed.key) {
      this.armed.looks += 1;
      if (this.armed.looks === 2) {
        await this.armed.beforeSecondLook();
      }
    }
    return scoped.head(key);
  }
  copy(...a: Parameters<StoragePort['copy']>) {
    return scoped.copy(...a);
  }
  put(...a: Parameters<StoragePort['put']>) {
    return scoped.put(...a);
  }
  read(key: StorageKey) {
    return scoped.read(key);
  }
  openRead(...a: Parameters<StoragePort['openRead']>) {
    return scoped.openRead(...a);
  }
  list(prefix: string) {
    return scoped.list(prefix);
  }
  delete(key: StorageKey) {
    return scoped.delete(key);
  }
}
const watched = new WatchedStore();

function serviceWith(clock: typeof realClock, sweepConfig: AppConfig = config) {
  return new DefaultStorageService(
    new PrismaFileObjectRepository(stamps),
    new PrismaUploadSessionRepository(stamps),
    watched,
    antivirus,
    clock,
    outbox,
    sweepConfig,
    writer,
  );
}
const storage = serviceWith(realClock);
const sweeper = serviceWith(twoDaysOn);
const drySweeper = serviceWith(twoDaysOn, configWith({ orphanSweepDryRun: true }));
const youngSweeper = serviceWith(realClock);

function contextFor(tenantId: TenantId, userId: UserId): RequestContext {
  return {
    tenantId,
    userId,
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: `orphan-sweep-${tenantId}`,
    permissionVersion: 1,
    locale: 'en',
  };
}
const inAcme = <T>(work: () => Promise<T>) => runWithContext(contextFor(ACME, ALICE), work);
const inOther = <T>(work: () => Promise<T>) => runWithContext(contextFor(OTHER, OLIVER), work);

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const aPdf = (marker: string) =>
  Buffer.from(`%PDF-1.7\n% ${marker} ${uuidv7()}\n1 0 obj\n<<>>\nendobj\n`);
const present = (key: string, run = inAcme) => run(async () => (await scoped.head(key)) !== null);

/** A browser's upload up to the transfer: the session, then the PUT. */
async function openAndTransfer(bytes: Buffer, run = inAcme): Promise<string> {
  return run(async () => {
    const target = await storage.createUploadSession({
      filename: 'procedure.pdf',
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      magicBytes: bytes.subarray(0, 16),
      checksumSha256: sha256(bytes),
    });
    const put = await fetch(target.url, {
      method: target.method,
      headers: target.headers,
      body: bytes,
    });
    expect(put.ok).toBe(true);
    return target.uploadSessionId;
  });
}

/** What a completion interrupted after its copy leaves: the content key, and no row. */
async function interruptedAfterCopy(bytes: Buffer, run = inAcme): Promise<{ session: string }> {
  const session = await openAndTransfer(bytes, run);
  await run(() => scoped.copy(`staging/${session}`, blobKeyFor(sha256(bytes))));
  return { session };
}

async function settle(session: string, state: 'EXPIRED' | 'ABORTED' | 'COMPLETED') {
  await owner.uploadSession.update({ where: { id: session }, data: { state } });
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  const slug = `orphans-${String(Date.now())}`;
  for (const [tenantId, userId, suffix] of [
    [ACME, ALICE, 'acme'],
    [OTHER, OLIVER, 'other'],
  ] as const) {
    await owner.tenant.create({
      data: { id: tenantId, slug: `${slug}-${suffix}`, name: slug, status: 'ACTIVE' },
    });
    await owner.user.create({
      data: {
        id: userId,
        tenantId,
        email: `${userId}@${slug}.test`,
        emailNormalized: `${userId}@${slug}.test`,
        displayName: suffix,
        status: 'ACTIVE',
      },
    });
  }
});

afterAll(async () => {
  await owner.$disconnect();
});

describe('the orphan sweep removes what nothing refers to, and only that', () => {
  it('removes a content key an interrupted completion left without a row', async () => {
    const bytes = aPdf('interrupted');
    const { session } = await interruptedAfterCopy(bytes);
    await settle(session, 'EXPIRED');
    const key = blobKeyFor(sha256(bytes));

    const pass = await inAcme(() => sweeper.sweepOrphanedObjects());

    expect(pass.orphanedKeys).toContain(key);
    expect(await present(key)).toBe(false);
    // Its staged bytes went too: the session is no longer open.
    expect(pass.orphanedKeys).toContain(`staging/${session}`);
    expect(await present(`staging/${session}`)).toBe(false);
  });

  it('removes staged bytes a transfer finished after the expiry sweep settled its session', async () => {
    const session = await openAndTransfer(aPdf('outlived'));
    await settle(session, 'EXPIRED');
    await inAcme(() => sweeper.sweepOrphanedObjects());
    expect(await present(`staging/${session}`)).toBe(false);
  });

  it('removes staged bytes a failed or completed session no longer needs', async () => {
    const aborted = await openAndTransfer(aPdf('aborted'));
    const completed = await openAndTransfer(aPdf('completed-leftover'));
    await settle(aborted, 'ABORTED');
    await settle(completed, 'COMPLETED');
    await inAcme(() => sweeper.sweepOrphanedObjects());
    expect(await present(`staging/${aborted}`)).toBe(false);
    expect(await present(`staging/${completed}`)).toBe(false);
  });

  it('keeps the staged bytes of an upload that is still open, however old', async () => {
    const session = await openAndTransfer(aPdf('active'));
    const pass = await inAcme(() => sweeper.sweepOrphanedObjects());
    expect(pass.orphanedKeys).not.toContain(`staging/${session}`);
    expect(await present(`staging/${session}`)).toBe(true);
    // And completing it afterwards still works.
    const done = await inAcme(() =>
      storage.completeUploadSession(asId<UploadSessionId>(session), []),
    );
    expect(done.scanStatus).toBe('CLEAN');
  });

  it('keeps every object a row names: a completed upload, and a deleted row too', async () => {
    const live = aPdf('live');
    const liveSession = await openAndTransfer(live);
    const done = await inAcme(() =>
      storage.completeUploadSession(asId<UploadSessionId>(liveSession), []),
    );
    const retired = aPdf('retired');
    const { session } = await interruptedAfterCopy(retired);
    await settle(session, 'EXPIRED');
    await owner.fileObject.create({
      data: {
        id: uuidv7(),
        tenantId: ACME,
        checksumSha256: sha256(retired),
        sizeBytes: retired.length,
        mimeType: 'application/pdf',
        storageKey: blobKeyFor(sha256(retired)),
        storageDriver: 'S3',
        scanStatus: 'CLEAN',
        deletedAt: new Date(),
      },
    });

    const pass = await inAcme(() => sweeper.sweepOrphanedObjects());

    expect(done.scanStatus).toBe('CLEAN');
    expect(await present(blobKeyFor(sha256(live)))).toBe(true);
    expect(await present(blobKeyFor(sha256(retired)))).toBe(true);
    expect(pass.orphanedKeys).not.toContain(blobKeyFor(sha256(retired)));
  });

  it('leaves an unreferenced object younger than the grace period for a later pass', async () => {
    const bytes = aPdf('young');
    const { session } = await interruptedAfterCopy(bytes);
    await settle(session, 'EXPIRED');
    const pass = await inAcme(() => youngSweeper.sweepOrphanedObjects());
    expect(pass.blobs.recent).toBeGreaterThan(0);
    expect(await present(blobKeyFor(sha256(bytes)))).toBe(true);
  });

  it('never touches a key it would not have written, nor derived or evidence objects', async () => {
    const strays = ['staging/not-a-session', 'blobs/zz/zz/not-a-digest'];
    const elsewhere = [
      `derived/ab/cd/${'ab'.padEnd(64, 'c')}`,
      `evidence/${uuidv7()}/manifest.json`,
    ];
    for (const key of [...strays, ...elsewhere]) {
      await inAcme(() =>
        scoped.put(key, oneChunk(Buffer.from(key)), { contentType: 'text/plain' }),
      );
    }
    const pass = await inAcme(() => sweeper.sweepOrphanedObjects());
    expect(pass.staging.unrecognised + pass.blobs.unrecognised).toBeGreaterThanOrEqual(2);
    for (const key of [...strays, ...elsewhere]) {
      expect(await present(key)).toBe(true);
    }
  });

  it('keeps an object a row came to name between its two looks at it', async () => {
    const bytes = aPdf('arrived-mid-pass');
    const { session } = await interruptedAfterCopy(bytes);
    await settle(session, 'EXPIRED');
    const key = blobKeyFor(sha256(bytes));
    watched.armed = {
      key,
      looks: 0,
      // As if the completion that copied these bytes wrote its row while the sweep was deciding.
      beforeSecondLook: async () => {
        await owner.fileObject.create({
          data: {
            id: uuidv7(),
            tenantId: ACME,
            checksumSha256: sha256(bytes),
            sizeBytes: bytes.length,
            mimeType: 'application/pdf',
            storageKey: key,
            storageDriver: 'S3',
            scanStatus: 'CLEAN',
          },
        });
      },
    };
    try {
      const pass = await inAcme(() => sweeper.sweepOrphanedObjects());
      expect(pass.orphanedKeys).not.toContain(key);
    } finally {
      watched.armed = null;
    }
    expect(await present(key)).toBe(true);
  });

  it('in a dry run reports what it would remove and removes nothing', async () => {
    const bytes = aPdf('dry');
    const { session } = await interruptedAfterCopy(bytes);
    await settle(session, 'EXPIRED');
    const pass = await inAcme(() => drySweeper.sweepOrphanedObjects());
    expect(pass.dryRun).toBe(true);
    expect(pass.orphanedKeys).toContain(blobKeyFor(sha256(bytes)));
    expect(await present(blobKeyFor(sha256(bytes)))).toBe(true);
    expect(await present(`staging/${session}`)).toBe(true);
  });

  it('is idempotent: a second pass finds nothing the first removed', async () => {
    const { session } = await interruptedAfterCopy(aPdf('twice'));
    await settle(session, 'EXPIRED');
    const first = await inAcme(() => sweeper.sweepOrphanedObjects());
    const second = await inAcme(() => sweeper.sweepOrphanedObjects());
    expect(first.staging.orphaned + first.blobs.orphaned).toBeGreaterThan(0);
    expect(second.staging.orphaned + second.blobs.orphaned).toBe(0);
    expect(second.orphanedKeys).toEqual([]);
  });

  it('sweeps one tenant at a time: another tenant’s orphan is not this pass’s to remove', async () => {
    const bytes = aPdf('other-tenant');
    const { session } = await interruptedAfterCopy(bytes, inOther);
    await settle(session, 'EXPIRED');
    await inAcme(() => sweeper.sweepOrphanedObjects());
    expect(await present(blobKeyFor(sha256(bytes)), inOther)).toBe(true);
    await inOther(() => sweeper.sweepOrphanedObjects());
    expect(await present(blobKeyFor(sha256(bytes)), inOther)).toBe(false);
  });
});

async function* oneChunk(bytes: Buffer): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  yield bytes;
}
