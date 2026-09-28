import 'reflect-metadata';

import { createHash } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type FileObjectId,
  ScanStatus,
  type TenantId,
  type UploadSessionId,
  type UserId,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import type { AntivirusPort, ScanRequest, ScanVerdict } from '../../../ports/antivirus.port';
import type { BlobMetadata, StorageKey, StoragePort } from '../../../ports/storage.port';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { realS3TenantStorage, realWriteStack } from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import { DefaultStorageService } from '../application/storage.service';
import { StorageBlobReaper } from '../infrastructure/blob-reaper.adapter';
import { PrismaFileObjectRepository } from '../infrastructure/prisma-file-object.repository';
import { PrismaUploadSessionRepository } from '../infrastructure/prisma-upload-session.repository';

/**
 * The storage gate and the blob lifecycle, against real PostgreSQL and a real object store —
 * release-candidate validation, D-11 and D-12.
 *
 * ## D-11: a quarantined blob was still served
 *
 * `17-security-architecture.md` §8 says a blob the rolling verifier finds changed "becomes
 * unreachable through the same gate an infected one fails". The verifier recorded the finding, and
 * `isReachable` read it — but nothing called `isReachable`, and the gate `createDownloadUrl` does
 * run checked the scan and nothing else. Reproduced live: overwrite the object, run the sweep, and
 * the API signed a link that served the tampered bytes. A missing object was signed for too.
 *
 * ## D-12: bytes reclaimed once could never be stored again
 *
 * The reaper retires the row in the transaction that deletes the object, and every reader asks for
 * live rows only — but `uq_file_object_checksum` and `uq_file_object_key` were full indexes. So the
 * next upload of the same bytes found no live row, copied the bytes to the content key, had its
 * insert skipped by the retired row, found no winner, and answered 503 — leaving the bytes it had
 * copied at the content key with no row to name them. Every later attempt did the same.
 *
 * ## Why a real store
 *
 * Both defects are about bytes and rows disagreeing. The tamper is a write to the store the product
 * did not make; the reclamation is a delete the product did make; the orphan is an object with no
 * row. A fake store would assert what our code believes about the store, which is exactly the
 * belief that was wrong. Needs the MinIO from `infra/docker-compose.yml`, as the other S3 suite does.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const ACME = asId<TenantId>(uuidv7());
/** A second tenant, so "only this tenant's blob" is falsifiable. */
const OTHER = asId<TenantId>(uuidv7());
const ALICE = asId<UserId>(uuidv7());
const OLIVER = asId<UserId>(uuidv7());

const config = {
  env: 'test',
  database: { url: APP_URL, poolSize: 10 },
  storage: {
    driver: 'S3',
    signedUrlTtlSeconds: 300,
    maxUploadBytes: 50 * 1024 * 1024,
    integrityBatchSize: 200,
    integrityMaxBytes: 1024 * 1024,
  },
  antivirus: { icap: null, maxBytes: 134_217_728, timeoutMs: 120_000 },
  providers: { antivirus: 'NONE' },
} as unknown as AppConfig;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;
/** The real clock: the store signs and checks against wall time, so a fixed clock would expire. */
const clock = { now: () => new Date(), timestamp: () => 0, elapsedMs: () => 0 };

const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);
const { stamps, outbox, writer } = realWriteStack(clock, unitOfWork);
const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

/** The production scoping over the production S3 adapter: every key below is under the tenant. */
const { scoped } = realS3TenantStorage(everyTenantRegistry(APP_URL));

/**
 * The scanner. `CLEAN` unless told otherwise; `NONE` rejects, which is what a deployment with no
 * adapter does and what makes an upload `SKIPPED`. The one double in this suite — the gate under
 * test reads the verdict, it does not produce it.
 */
let scannerMode: 'CLEAN' | 'NONE' = 'CLEAN';
const antivirus: AntivirusPort = {
  scanner: 'integration-suite',
  scan: (_request: ScanRequest): Promise<ScanVerdict> =>
    scannerMode === 'NONE'
      ? Promise.reject(new Error('AV_DRIVER is NONE'))
      : Promise.resolve({
          status: ScanStatus.CLEAN,
          threat: null,
          scanner: 'integration-suite',
          scannerVersion: '1',
          scannedAt: new Date(),
        }),
};

/**
 * The store, with a place to stand inside the reaper's transaction — the same park
 * `blob-reclamation.integration.spec.ts` uses, over a real store: everything is passed through,
 * and a `delete` of the armed key waits for the test before it reaches MinIO.
 */
class ParkingStore implements StoragePort {
  readonly driver = scoped.driver;
  target: string | null = null;
  reached: (() => void) | null = null;
  admit: Promise<void> | null = null;

  createUploadTarget(...a: Parameters<StoragePort['createUploadTarget']>) {
    return scoped.createUploadTarget(...a);
  }
  completeUpload(...a: Parameters<StoragePort['completeUpload']>) {
    return scoped.completeUpload(...a);
  }
  createDownloadUrl(...a: Parameters<StoragePort['createDownloadUrl']>) {
    return scoped.createDownloadUrl(...a);
  }
  head(key: StorageKey): Promise<BlobMetadata | null> {
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
  list(prefix: string) {
    return scoped.list(prefix);
  }
  async delete(key: StorageKey): Promise<void> {
    const gate = this.admit;
    if (gate !== null && key === this.target) {
      this.admit = null;
      this.reached?.();
      await gate;
    }
    await scoped.delete(key);
  }
}
const parking = new ParkingStore();

const storage = new DefaultStorageService(
  new PrismaFileObjectRepository(stamps),
  new PrismaUploadSessionRepository(stamps),
  scoped,
  antivirus,
  clock,
  outbox,
  config,
  writer,
);
const reaper = new StorageBlobReaper(parking, unitOfWork, logger, storage, stamps);

function contextFor(tenantId: TenantId, userId: UserId): RequestContext {
  return {
    tenantId,
    userId,
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: `storage-gate-${tenantId}`,
    permissionVersion: 1,
    locale: 'en',
  };
}

function inAcme<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(ACME, ALICE), work);
}

function inOther<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(OTHER, OLIVER), work);
}

let minted = 0;

/** A real, small PDF, distinct per marker. */
function aPdf(marker: string): Buffer {
  minted += 1;
  return Buffer.from(
    `%PDF-1.7\n% ${marker} ${String(minted)} ${uuidv7()}\n1 0 obj\n<<>>\nendobj\n`,
  );
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function* once(bytes: Buffer): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  yield bytes;
}

/**
 * A browser's upload, up to the transfer: the declared session (with the digest, as the web client
 * always sends it — an S3 store records a checksum only when one is bound) and the presigned PUT.
 * Null when the tenant already holds the bytes and there is nothing to transfer.
 */
async function openAndTransfer(
  bytes: Buffer,
): Promise<
  { sessionId: string; alreadyStored: null } | { sessionId: string; alreadyStored: string }
> {
  const target = await storage.createUploadSession({
    filename: 'procedure.pdf',
    mimeType: 'application/pdf',
    sizeBytes: bytes.length,
    magicBytes: bytes.subarray(0, 16),
    checksumSha256: sha256(bytes),
  });
  if (target.alreadyStored !== undefined && target.alreadyStored !== null) {
    return { sessionId: target.uploadSessionId, alreadyStored: target.alreadyStored.fileObjectId };
  }
  const put = await fetch(target.url, {
    method: target.method,
    headers: target.headers,
    body: bytes,
  });
  expect(put.ok).toBe(true);
  return { sessionId: target.uploadSessionId, alreadyStored: null };
}

async function complete(
  sessionId: string,
): Promise<{ fileObjectId: string; deduplicated: boolean }> {
  const completed = await storage.completeUploadSession(asId<UploadSessionId>(sessionId), []);
  return { fileObjectId: completed.fileObjectId, deduplicated: completed.deduplicated };
}

/** The whole upload. `deduplicated` whether the answer came at the pre-check or at completion. */
async function upload(bytes: Buffer): Promise<{ fileObjectId: string; deduplicated: boolean }> {
  const opened = await openAndTransfer(bytes);
  if (opened.alreadyStored !== null) {
    return { fileObjectId: opened.alreadyStored, deduplicated: true };
  }
  return complete(opened.sessionId);
}

function reachable(fileObjectId: string, run: typeof inAcme = inAcme): Promise<boolean> {
  return run(() => unitOfWork.run(() => storage.isReachable(asId<FileObjectId>(fileObjectId))));
}

/** A reference, as a document's revision takes one: what puts a blob in the verifier's queue. */
async function hold(fileObjectId: string): Promise<void> {
  await inAcme(() => unitOfWork.run(() => storage.reference(asId<FileObjectId>(fileObjectId))));
}

async function rowOf(id: string) {
  return owner.fileObject.findUniqueOrThrow({ where: { id } });
}

async function liveRowsFor(tenantId: TenantId, bytes: Buffer) {
  return owner.fileObject.findMany({
    where: { tenantId, checksumSha256: sha256(bytes), deletedAt: null },
  });
}

/** Whether the object is in the store, under the tenant's own prefix. */
function stored(key: string, tenant: 'acme' | 'other' = 'acme'): Promise<boolean> {
  const run = tenant === 'acme' ? inAcme : inOther;
  return run(async () => (await scoped.head(key)) !== null);
}

async function downloadIssuedCount(fileObjectId: string): Promise<number> {
  return owner.auditEvent.count({
    where: { tenantId: ACME, action: 'FILE_DOWNLOAD_ISSUED', subjectId: fileObjectId },
  });
}

/**
 * The rolling verifier's own pass, with the blob put at the front of its queue. The sweep reads
 * referenced blobs only — an unreferenced one is the reaper's — so every blob verified here is held.
 */
async function verify(fileObjectId: string): Promise<void> {
  await owner.fileObject.update({
    where: { id: fileObjectId },
    data: { integrityCheckedAt: new Date('2000-01-01T00:00:00.000Z') },
  });
  await inAcme(() => storage.verifyIntegrity());
}

/** Past the grace period: the reaper lists by `updated_at`, so the cutoff is simply later. */
async function reclaimAll(): Promise<number> {
  const later = new Date(Date.now() + 60_000);
  const candidates = await inAcme(() => unitOfWork.run(() => reaper.listReclaimable(later, 1_000)));
  let reclaimed = 0;
  for (const blob of candidates) {
    if (await inAcme(() => reaper.reclaim(blob.id))) {
      reclaimed += 1;
    }
  }
  return reclaimed;
}

/** Referenced, then released: the lifecycle a document's revision gives a blob. */
async function referenceAndRelease(fileObjectId: string): Promise<void> {
  const id = asId<FileObjectId>(fileObjectId);
  await inAcme(() => unitOfWork.run(() => storage.reference(id)));
  await inAcme(() => unitOfWork.run(() => storage.dereference(id)));
}

async function waitUntilBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 20_000; attempt += 1) {
    const [row] = await owner.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND cardinality(pg_blocking_pids(pid)) > 0`;
    if (Number(row?.waiting ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error('Nothing ever blocked on the reclaimed row.');
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  const slug = `gate-${String(Date.now())}`;
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
  await prisma.disconnectAll();
});

// --- D-11 -------------------------------------------------------------------------------------

describe('the download gate asks whether the bytes are still the bytes (D-11)', () => {
  it('signs a link for intact, scanned content, and the link serves the stored bytes', async () => {
    const bytes = aPdf('intact');
    const { fileObjectId } = await inAcme(() => upload(bytes));
    await hold(fileObjectId);
    await verify(fileObjectId);
    expect((await rowOf(fileObjectId)).integrityStatus).toBe('VERIFIED');

    const signed = await inAcme(() =>
      storage.createDownloadUrl(asId<FileObjectId>(fileObjectId), 'procedure.pdf'),
    );
    const served = Buffer.from(await (await fetch(signed.url)).arrayBuffer());
    expect(sha256(served)).toBe(sha256(bytes));
  });

  it('refuses a blob the verifier found tampered with, and signs nothing', async () => {
    const bytes = aPdf('tamper');
    const { fileObjectId } = await inAcme(() => upload(bytes));
    await hold(fileObjectId);
    const { storageKey } = await rowOf(fileObjectId);

    // Somebody with the store's credentials rewrites the object in place.
    await inAcme(() =>
      scoped.put(storageKey, once(Buffer.from(`${bytes.toString()}% tampered\n`)), {
        contentType: 'application/pdf',
      }),
    );
    await verify(fileObjectId);
    expect((await rowOf(fileObjectId)).integrityStatus).toBe('MISMATCH');

    const before = await downloadIssuedCount(fileObjectId);
    await expect(
      inAcme(() => storage.createDownloadUrl(asId<FileObjectId>(fileObjectId), 'procedure.pdf')),
    ).rejects.toMatchObject({
      code: 'CONTENT_NOT_SCANNED',
      details: { integrityStatus: 'MISMATCH' },
    });
    // Refused before a URL existed: nothing was issued, so nothing was audited as issued.
    expect(await downloadIssuedCount(fileObjectId)).toBe(before);
    expect(await reachable(fileObjectId)).toBe(false);
    // The gate repairs nothing and re-marks nothing: the finding and the scan verdict stand.
    const after = await rowOf(fileObjectId);
    expect(after.integrityStatus).toBe('MISMATCH');
    expect(after.scanStatus).toBe('CLEAN');
  });

  it('refuses a blob whose object has gone missing from the store', async () => {
    const { fileObjectId } = await inAcme(() => upload(aPdf('lost')));
    await hold(fileObjectId);
    const { storageKey } = await rowOf(fileObjectId);
    await inAcme(() => scoped.delete(storageKey));
    await verify(fileObjectId);
    expect((await rowOf(fileObjectId)).integrityStatus).toBe('UNREADABLE');

    const before = await downloadIssuedCount(fileObjectId);
    await expect(
      inAcme(() => storage.createDownloadUrl(asId<FileObjectId>(fileObjectId), 'procedure.pdf')),
    ).rejects.toMatchObject({
      code: 'CONTENT_NOT_SCANNED',
      details: { integrityStatus: 'UNREADABLE' },
    });
    expect(await downloadIssuedCount(fileObjectId)).toBe(before);
    expect(await reachable(fileObjectId)).toBe(false);
  });

  it('serves a product-made artefact (derived, SKIPPED) while intact, and refuses it once tampered', async () => {
    const content = aPdf('export');
    const artefact = await inAcme(() =>
      storage.storeDerived({ content, mimeType: 'application/pdf' }),
    );
    expect(artefact.derived).toBe(true);
    expect(artefact.scanStatus).toBe('SKIPPED');
    await inAcme(() => unitOfWork.run(() => storage.reference(artefact.id)));
    await verify(String(artefact.id));

    const signed = await inAcme(() => storage.createDownloadUrl(artefact.id, 'export.pdf'));
    expect(sha256(Buffer.from(await (await fetch(signed.url)).arrayBuffer()))).toBe(
      sha256(content),
    );

    await inAcme(() =>
      scoped.put(artefact.storageKey, once(Buffer.from('%PDF-1.7\n% not the export\n')), {
        contentType: 'application/pdf',
      }),
    );
    await verify(String(artefact.id));
    await expect(
      inAcme(() => storage.createDownloadUrl(artefact.id, 'export.pdf')),
    ).rejects.toMatchObject({
      code: 'CONTENT_NOT_SCANNED',
      details: { integrityStatus: 'MISMATCH' },
    });
  });

  it('still refuses uploaded content the scanner never cleared, intact or not', async () => {
    scannerMode = 'NONE';
    try {
      const { fileObjectId } = await inAcme(() => upload(aPdf('unscanned')));
      const row = await rowOf(fileObjectId);
      expect(row.scanStatus).toBe('SKIPPED');
      expect(row.derived).toBe(false);
      await expect(
        inAcme(() => storage.createDownloadUrl(asId<FileObjectId>(fileObjectId), 'x.pdf')),
      ).rejects.toMatchObject({ code: 'CONTENT_NOT_SCANNED', details: { scanStatus: 'SKIPPED' } });
      expect(await reachable(fileObjectId)).toBe(false);
    } finally {
      scannerMode = 'CLEAN';
    }
  });

  it('clears the quarantine only on a successful re-read of the original bytes', async () => {
    const bytes = aPdf('repaired');
    const { fileObjectId } = await inAcme(() => upload(bytes));
    await hold(fileObjectId);
    const { storageKey } = await rowOf(fileObjectId);
    await inAcme(() =>
      scoped.put(storageKey, once(Buffer.from('%PDF-1.7\n% damaged\n')), {
        contentType: 'application/pdf',
      }),
    );
    await verify(fileObjectId);
    await expect(
      inAcme(() => storage.createDownloadUrl(asId<FileObjectId>(fileObjectId), 'p.pdf')),
    ).rejects.toMatchObject({ code: 'CONTENT_NOT_SCANNED' });

    // Restored from backup, and the verifier re-reads it: now, and only now, it is served again.
    await inAcme(() => scoped.put(storageKey, once(bytes), { contentType: 'application/pdf' }));
    await verify(fileObjectId);
    expect((await rowOf(fileObjectId)).integrityStatus).toBe('VERIFIED');
    const signed = await inAcme(() =>
      storage.createDownloadUrl(asId<FileObjectId>(fileObjectId), 'p.pdf'),
    );
    expect(sha256(Buffer.from(await (await fetch(signed.url)).arrayBuffer()))).toBe(sha256(bytes));
  });

  it('never resolves another tenant’s blob, quarantined or not', async () => {
    const { fileObjectId } = await inAcme(() => upload(aPdf('acme-only')));
    await expect(
      inOther(() => storage.createDownloadUrl(asId<FileObjectId>(fileObjectId), 'x.pdf')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await reachable(fileObjectId, inOther)).toBe(false);
  });
});

// --- D-12 -------------------------------------------------------------------------------------

describe('bytes reclaimed once can be stored again (D-12)', () => {
  it('stores, deduplicates, reclaims, and stores the same bytes again as a new live blob', async () => {
    const bytes = aPdf('standard-form');

    // 1. First upload — and a second person who opened a session for the same bytes before the
    //    first completed, so both transferred.
    const early = await inAcme(() => openAndTransfer(bytes));
    const late = await inAcme(() => openAndTransfer(bytes));
    expect(early.alreadyStored).toBeNull();
    expect(late.alreadyStored).toBeNull();
    const first = await inAcme(() => complete(early.sessionId));
    expect(first.deduplicated).toBe(false);
    const original = await rowOf(first.fileObjectId);
    expect(await stored(original.storageKey)).toBe(true);

    // 2. The same active content deduplicates: at completion for the one already in flight, and at
    //    the pre-check for anybody after — no transfer at all.
    expect(await inAcme(() => complete(late.sessionId))).toMatchObject({
      fileObjectId: first.fileObjectId,
      deduplicated: true,
    });
    const after = await inAcme(() => openAndTransfer(bytes));
    expect(after.alreadyStored).toBe(first.fileObjectId);
    expect(await liveRowsFor(ACME, bytes)).toHaveLength(1);
    expect(await stored(`staging/${late.sessionId}`)).toBe(false);

    // 3. Referenced, released, past its grace period, reclaimed by the reaper.
    await referenceAndRelease(first.fileObjectId);
    expect((await rowOf(first.fileObjectId)).refCount).toBe(0);
    expect(await reclaimAll()).toBeGreaterThanOrEqual(1);
    const retired = await rowOf(first.fileObjectId);
    expect(retired.deletedAt).not.toBeNull();
    expect(await stored(original.storageKey)).toBe(false);

    // 4. The same bytes again: stored afresh, under the same content key, as a new live row.
    const again = await inAcme(() => upload(bytes));
    expect(again.deduplicated).toBe(false);
    expect(again.fileObjectId).not.toBe(first.fileObjectId);
    const renewed = await rowOf(again.fileObjectId);
    expect(renewed).toMatchObject({
      checksumSha256: sha256(bytes),
      storageKey: original.storageKey,
      deletedAt: null,
      refCount: 0,
      scanStatus: 'CLEAN',
      integrityStatus: 'UNVERIFIED',
    });
    expect(await stored(renewed.storageKey)).toBe(true);
    expect(await liveRowsFor(ACME, bytes)).toHaveLength(1);

    // The retired row is history and stays exactly as the reaper left it.
    const history = await rowOf(first.fileObjectId);
    expect(history.deletedAt?.getTime()).toBe(retired.deletedAt?.getTime());
    expect(history.refCount).toBe(0);
    await expect(
      inAcme(() => unitOfWork.run(() => storage.reference(asId<FileObjectId>(first.fileObjectId)))),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // The renewed blob is a first-class blob: served, verified, deduplicated onto.
    await verify(again.fileObjectId);
    const signed = await inAcme(() =>
      storage.createDownloadUrl(asId<FileObjectId>(again.fileObjectId), 'form.pdf'),
    );
    expect(sha256(Buffer.from(await (await fetch(signed.url)).arrayBuffer()))).toBe(sha256(bytes));
    expect(await inAcme(() => upload(bytes))).toMatchObject({
      fileObjectId: again.fileObjectId,
      deduplicated: true,
    });
  });

  it('keeps counting references on the renewed blob, and reclaims it again in turn', async () => {
    const bytes = aPdf('twice-reclaimed');
    const first = await inAcme(() => upload(bytes));
    await referenceAndRelease(first.fileObjectId);
    await reclaimAll();

    const second = await inAcme(() => upload(bytes));
    const id = asId<FileObjectId>(second.fileObjectId);
    await inAcme(() => unitOfWork.run(() => storage.reference(id)));
    await inAcme(() => unitOfWork.run(() => storage.reference(id)));
    expect((await rowOf(second.fileObjectId)).refCount).toBe(2);

    // Referenced: the reaper passes it by.
    await reclaimAll();
    expect((await rowOf(second.fileObjectId)).deletedAt).toBeNull();
    expect(await stored((await rowOf(second.fileObjectId)).storageKey)).toBe(true);

    await inAcme(() => unitOfWork.run(() => storage.dereference(id)));
    await inAcme(() => unitOfWork.run(() => storage.dereference(id)));
    await reclaimAll();
    expect((await rowOf(second.fileObjectId)).deletedAt).not.toBeNull();
    expect(await stored((await rowOf(second.fileObjectId)).storageKey)).toBe(false);

    // A third life, and two retired rows of history behind it.
    const third = await inAcme(() => upload(bytes));
    expect(third.deduplicated).toBe(false);
    expect(await liveRowsFor(ACME, bytes)).toHaveLength(1);
    expect(
      await owner.fileObject.count({
        where: { tenantId: ACME, checksumSha256: sha256(bytes), deletedAt: { not: null } },
      }),
    ).toBe(2);
  });

  it('regenerates a product-made artefact whose earlier copy was reclaimed', async () => {
    const content = aPdf('rendition');
    const first = await inAcme(() =>
      storage.storeDerived({ content, mimeType: 'application/pdf' }),
    );
    await referenceAndRelease(String(first.id));
    await reclaimAll();
    expect((await rowOf(String(first.id))).deletedAt).not.toBeNull();

    const again = await inAcme(() =>
      storage.storeDerived({ content, mimeType: 'application/pdf' }),
    );
    expect(again.id).not.toBe(first.id);
    expect(again.storageKey).toBe(first.storageKey);
    expect(await stored(again.storageKey)).toBe(true);
  });

  it('never deduplicates across tenants, before or after a reclamation', async () => {
    const bytes = aPdf('shared-between-customers');
    const acme = await inAcme(() => upload(bytes));
    const other = await inOther(() => upload(bytes));
    expect(other.deduplicated).toBe(false);
    expect(other.fileObjectId).not.toBe(acme.fileObjectId);
    const key = (await rowOf(acme.fileObjectId)).storageKey;
    expect(await stored(key, 'other')).toBe(true);

    // ACME reclaims its copy; OTHER's is untouched, and ACME can store the bytes again.
    await referenceAndRelease(acme.fileObjectId);
    await reclaimAll();
    expect(await stored(key)).toBe(false);
    expect(await stored(key, 'other')).toBe(true);
    expect((await rowOf(other.fileObjectId)).deletedAt).toBeNull();
    const renewed = await inAcme(() => upload(bytes));
    expect(renewed.deduplicated).toBe(false);
    expect(await liveRowsFor(ACME, bytes)).toHaveLength(1);
    expect(await liveRowsFor(OTHER, bytes)).toHaveLength(1);
  });

  it('two people storing reclaimed bytes at once converge on one live blob', async () => {
    const bytes = aPdf('concurrent-renewal');
    const first = await inAcme(() => upload(bytes));
    await referenceAndRelease(first.fileObjectId);
    await reclaimAll();

    // Two sessions opened while nothing live holds the digest, so both transfer; then both
    // complete at once, and both reach completion's own dedupe and insert.
    const one = await inAcme(() => openAndTransfer(bytes));
    const two = await inAcme(() => openAndTransfer(bytes));
    expect(one.alreadyStored).toBeNull();
    expect(two.alreadyStored).toBeNull();
    const [a, b] = await Promise.all([
      inAcme(() => complete(one.sessionId)),
      inAcme(() => complete(two.sessionId)),
    ]);
    expect(a.fileObjectId).toBe(b.fileObjectId);
    expect([a.deduplicated, b.deduplicated].sort()).toEqual([false, true]);
    const live = await liveRowsFor(ACME, bytes);
    expect(live).toHaveLength(1);
    expect(await stored(live[0]?.storageKey ?? '')).toBe(true);
  });

  it('an upload racing the reaper never leaves a live row naming missing bytes, nor an orphan', async () => {
    const bytes = aPdf('raced');
    const first = await inAcme(() => upload(bytes));
    await referenceAndRelease(first.fileObjectId);
    const { storageKey } = await rowOf(first.fileObjectId);
    // Before the sweep, the pre-check still answers with the blob about to be reclaimed.
    const inFlight = await inAcme(() => openAndTransfer(bytes));
    expect(inFlight.alreadyStored).toBe(first.fileObjectId);

    // The reaper claims the row FOR UPDATE and parks just before deleting the object.
    let release: () => void = () => undefined;
    parking.admit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      parking.reached = resolve;
    });
    parking.target = storageKey;
    const reclaiming = reclaimAll();
    await reached;

    // Mid-claim, the row is still live in every other snapshot. A reference taken now waits on
    // the claim — and is refused once the reaper commits, rather than counting a blob that is gone.
    const attaching = inAcme(() =>
      unitOfWork.run(() => storage.reference(asId<FileObjectId>(first.fileObjectId))),
    ).catch((error: unknown) => error);
    await waitUntilBlocked();
    release();
    expect(await reclaiming).toBeGreaterThanOrEqual(1);
    expect(await attaching).toMatchObject({ code: 'NOT_FOUND' });

    expect((await rowOf(first.fileObjectId)).deletedAt).not.toBeNull();
    expect(await stored(storageKey)).toBe(false);
    expect(await liveRowsFor(ACME, bytes)).toHaveLength(0);

    // And the next attempt simply works: a new live row, bytes back at the content key, and
    // nothing at the key that no row names.
    const next = await inAcme(() => upload(bytes));
    expect(next.deduplicated).toBe(false);
    expect(await stored(storageKey)).toBe(true);
    const live = await liveRowsFor(ACME, bytes);
    expect(live).toHaveLength(1);
    expect(live[0]?.storageKey).toBe(storageKey);
  });
});
