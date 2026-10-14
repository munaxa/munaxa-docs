import 'reflect-metadata';

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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
import type { AntivirusPort, ScanVerdict } from '../../../ports/antivirus.port';
import type {
  BlobMetadata,
  StorageKey,
  StoragePort,
  StoredObjectStream,
} from '../../../ports/storage.port';

import { StorageUnavailableError } from '../../../core/errors/application-errors';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { realS3TenantStorage, realWriteStack } from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import type { VerifiedDownload } from '../application/ports';
import { DefaultStorageService } from '../application/storage.service';
import { DefaultVerifiedDownloadDelivery } from '../application/verified-download.delivery';
import { LocalDownloadStaging } from '../infrastructure/download-staging';
import { PrismaFileObjectRepository } from '../infrastructure/prisma-file-object.repository';
import { PrismaUploadSessionRepository } from '../infrastructure/prisma-upload-session.repository';

/**
 * Verify, then serve — ADR-0026 §10, `docs/reports/hetzner-download-integrity-proposal.md` §4 —
 * against real PostgreSQL and a real object store.
 *
 * The property under test is the one hashing-while-sending cannot give: **`send` is never called
 * for bytes that do not verify**, so a tampered, swapped, truncated or missing object delivers zero
 * bytes of content. Every case counts what `send` received, and what the store and the trail say.
 *
 * Faults are injected around the real store (`FaultyStore`) only where a real store cannot be made
 * to misbehave on cue: a transient "no such object", a 503, a connection cut part-way, bytes
 * corrupted in transit.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';
const SECRET = 'a-verified-download-test-secret-32ch';
const MiB = 1024 * 1024;

const ACME = asId<TenantId>(uuidv7());
const ALICE = asId<UserId>(uuidv7());

let stagingRoot = '';

function configWith(download: Partial<AppConfig['download']> = {}): AppConfig {
  return {
    env: 'test',
    app: { port: 3001 },
    auth: { accessSecret: SECRET },
    database: { url: APP_URL, poolSize: 10 },
    storage: {
      driver: 'S3',
      signedUrlTtlSeconds: 300,
      maxUploadBytes: 50 * MiB,
      integrityBatchSize: 200,
      integrityMaxBytes: 64 * MiB,
      publicUrl: 'https://docs.example.test',
    },
    download: {
      linkTtlSeconds: 60,
      stagingDir: join(stagingRoot, 'staging'),
      stagingMaxBytes: 64 * MiB,
      maxFileBytes: 32 * MiB,
      maxConcurrent: 4,
      queueTimeoutMs: 5_000,
      minFreeBytes: 0,
      ...download,
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

const errors: string[] = [];
const logger = {
  info: () => {},
  warn: () => {},
  error: (message: string) => {
    errors.push(message);
  },
  debug: () => {},
} as unknown as Logger;
const clock = { now: () => new Date(), timestamp: () => 0, elapsedMs: () => 0 };

const prisma = sharedDatabase(configWith(), logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);
const { stamps, outbox, writer } = realWriteStack(clock, unitOfWork);
const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
const { scoped } = realS3TenantStorage(everyTenantRegistry(APP_URL));

let scannerMode: 'CLEAN' | 'NONE' = 'CLEAN';
const antivirus: AntivirusPort = {
  scanner: 'integration-suite',
  scan: (): Promise<ScanVerdict> =>
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

/** The real store, with faults on cue and a count of streamed reads. */
class FaultyStore implements StoragePort {
  readonly driver = scoped.driver;
  openReads = 0;
  openFault: (() => Error) | null = null;
  absentOnce = false;
  headFault = false;
  /** Cut the body after this many bytes, as a reset would. */
  cutAfter: number | null = null;
  /** Flip one byte at this offset, as corruption in transit would. */
  corruptAt: number | null = null;
  /** Called once a body has yielded its first chunk. */
  onFirstChunk: (() => void) | null = null;

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
    return this.headFault
      ? Promise.reject(new StorageUnavailableError('HEAD answered 503.'))
      : scoped.head(key);
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
  async openRead(
    key: StorageKey,
    options?: { readonly signal?: AbortSignal },
  ): Promise<StoredObjectStream | null> {
    this.openReads += 1;
    if (this.openFault !== null) {
      throw this.openFault();
    }
    if (this.absentOnce) {
      this.absentOnce = false;
      return null;
    }
    const opened = await scoped.openRead(key, options);
    if (opened === null) {
      return null;
    }
    return { ...opened, body: this.faulted(opened.body) };
  }
  list(prefix: string) {
    return scoped.list(prefix);
  }
  delete(key: StorageKey) {
    return scoped.delete(key);
  }
  reset(): void {
    this.openReads = 0;
    this.openFault = null;
    this.absentOnce = false;
    this.headFault = false;
    this.cutAfter = null;
    this.corruptAt = null;
    this.onFirstChunk = null;
  }

  private async *faulted(body: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    let offset = 0;
    let first = true;
    for await (const chunk of body) {
      let out = chunk;
      if (this.cutAfter !== null && offset + chunk.byteLength > this.cutAfter) {
        throw new StorageUnavailableError('Object storage stopped sending the object.');
      }
      if (
        this.corruptAt !== null &&
        this.corruptAt >= offset &&
        this.corruptAt < offset + chunk.byteLength
      ) {
        out = Uint8Array.from(chunk);
        const at = this.corruptAt - offset;
        out[at] = (out[at] ?? 0) ^ 0xff;
      }
      offset += chunk.byteLength;
      yield out;
      if (first) {
        first = false;
        this.onFirstChunk?.();
      }
    }
  }
}
const faulty = new FaultyStore();

function serviceWith(config: AppConfig): DefaultStorageService {
  return new DefaultStorageService(
    new PrismaFileObjectRepository(stamps),
    new PrismaUploadSessionRepository(stamps),
    faulty,
    antivirus,
    clock,
    outbox,
    config,
    writer,
  );
}

const config = configWith();
const storage = serviceWith(config);

async function deliveryWith(
  download: Partial<AppConfig['download']> = {},
): Promise<DefaultVerifiedDownloadDelivery> {
  const local = configWith(download);
  const staging = new LocalDownloadStaging(local.download.stagingDir);
  await staging.prepare();
  return new DefaultVerifiedDownloadDelivery(
    serviceWith(local),
    faulty,
    staging,
    local,
    logger,
    clock,
  );
}

function aliceContext(): RequestContext {
  return {
    tenantId: ACME,
    userId: ALICE,
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: `verified-download-${String(ACME)}`,
    permissionVersion: 3,
    locale: 'en',
  };
}

function inAcme<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(aliceContext(), work);
}

let minted = 0;
function aPdf(marker: string, padding = 0): Buffer {
  minted += 1;
  return Buffer.concat([
    Buffer.from(`%PDF-1.7\n% ${marker} ${String(minted)} ${uuidv7()}\n1 0 obj\n<<>>\nendobj\n`),
    Buffer.alloc(padding, 0x20),
  ]);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function* once(bytes: Buffer): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  yield bytes;
}

async function upload(bytes: Buffer): Promise<{ id: string; key: string }> {
  const target = await inAcme(() =>
    storage.createUploadSession({
      filename: 'procedure.pdf',
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      magicBytes: bytes.subarray(0, 16),
      checksumSha256: sha256(bytes),
    }),
  );
  if (target.alreadyStored !== undefined && target.alreadyStored !== null) {
    throw new Error('Every test uploads distinct bytes.');
  }
  const put = await fetch(target.url, {
    method: target.method,
    headers: target.headers,
    body: bytes,
  });
  expect(put.ok).toBe(true);
  const completed = await inAcme(() =>
    storage.completeUploadSession(asId<UploadSessionId>(target.uploadSessionId), []),
  );
  const row = await owner.fileObject.findUniqueOrThrow({ where: { id: completed.fileObjectId } });
  return { id: completed.fileObjectId, key: row.storageKey };
}

/** One delivery: what `send` received (null when it was never called), or what was thrown. */
async function deliver(
  delivery: DefaultVerifiedDownloadDelivery,
  id: string,
  signal: AbortSignal = new AbortController().signal,
  hold?: Promise<void>,
): Promise<{ sent: Buffer | null; download: VerifiedDownload | null; error: unknown }> {
  let sent: Buffer | null = null;
  let download: VerifiedDownload | null = null;
  try {
    await inAcme(() =>
      delivery.deliver(
        asId<FileObjectId>(id),
        async (verified) => {
          download = verified;
          const parts: Buffer[] = [];
          for await (const part of verified.chunks) {
            parts.push(part);
          }
          sent = Buffer.concat(parts);
          await hold;
        },
        signal,
      ),
    );
    return { sent, download, error: null };
  } catch (error) {
    return { sent, download, error };
  }
}

function findings(id: string) {
  return Promise.all([
    owner.auditEvent.count({
      where: { tenantId: ACME, action: 'INTEGRITY_MISMATCH', subjectId: id },
    }),
    owner.outboxMessage.count({
      where: { tenantId: ACME, eventType: 'storage.integrity-mismatch', aggregateId: id },
    }),
  ]);
}

async function integrityOf(id: string): Promise<string> {
  return (await owner.fileObject.findUniqueOrThrow({ where: { id } })).integrityStatus;
}

/** Staging files this process still holds open — every one must be closed after each delivery. */
async function openStagingFiles(): Promise<number> {
  let count = 0;
  for (const fd of await readdir('/proc/self/fd')) {
    const target = await readlink(`/proc/self/fd/${fd}`).catch(() => '');
    if (target.startsWith(join(stagingRoot, 'staging'))) {
      count += 1;
    }
  }
  return count;
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  stagingRoot = await mkdtemp(join(tmpdir(), 'munaxa-verified-download-'));
  const slug = `verified-${String(Date.now())}`;
  await owner.tenant.create({ data: { id: ACME, slug, name: slug, status: 'ACTIVE' } });
  await owner.user.create({
    data: {
      id: ALICE,
      tenantId: ACME,
      email: `${ALICE}@${slug}.test`,
      emailNormalized: `${ALICE}@${slug}.test`,
      displayName: 'alice',
      status: 'ACTIVE',
    },
  });
});

afterEach(async () => {
  faulty.reset();
  scannerMode = 'CLEAN';
  errors.length = 0;
  expect(await openStagingFiles()).toBe(0);
});

afterAll(async () => {
  await rm(stagingRoot, { recursive: true, force: true });
  await owner.$disconnect();
  await prisma.disconnectAll();
});

describe('a verified download sends only bytes that match the record', () => {
  it('sends an intact file, byte for byte, once it has verified', async () => {
    const bytes = aPdf('intact', 3 * MiB + 17);
    const { id } = await upload(bytes);
    const delivery = await deliveryWith();

    const { sent, download, error } = await deliver(delivery, id);

    expect(error).toBeNull();
    expect(sent?.equals(bytes)).toBe(true);
    expect(download).toMatchObject({ sizeBytes: bytes.length });
    expect(await integrityOf(id)).toBe('UNVERIFIED');
    expect(await findings(id)).toEqual([0, 0]);
  });

  it('sends nothing for an object replaced by other bytes of the same size, and quarantines it', async () => {
    const bytes = aPdf('same-size');
    const { id, key } = await upload(bytes);
    const other = Buffer.from(bytes);
    other[other.length - 2] = 0x41;
    await inAcme(() => scoped.put(key, once(other), { contentType: 'application/pdf' }));

    const { sent, error } = await deliver(await deliveryWith(), id);

    expect(sent).toBeNull();
    expect(error).toMatchObject({
      code: 'CONTENT_NOT_SCANNED',
      details: { integrityStatus: 'MISMATCH' },
    });
    expect(await integrityOf(id)).toBe('MISMATCH');
    expect(await findings(id)).toEqual([1, 1]);
    const audit = await owner.auditEvent.findFirstOrThrow({
      where: { tenantId: ACME, action: 'INTEGRITY_MISMATCH', subjectId: id },
    });
    expect(audit.payload).toMatchObject({
      after: {
        integrityStatus: 'MISMATCH',
        expectedSha256: sha256(bytes),
        actualSha256: sha256(other),
      },
    });
  });

  it('sends nothing, and reads nothing, for an object whose stated size is not the recorded one', async () => {
    const bytes = aPdf('resized');
    const { id, key } = await upload(bytes);
    await inAcme(() =>
      scoped.put(key, once(Buffer.concat([bytes, Buffer.from('% appended\n')])), {
        contentType: 'application/pdf',
      }),
    );

    const { sent, error } = await deliver(await deliveryWith(), id);

    expect(sent).toBeNull();
    expect(error).toMatchObject({ details: { integrityStatus: 'MISMATCH' } });
    expect(await integrityOf(id)).toBe('MISMATCH');
    expect(await findings(id)).toEqual([1, 1]);
  });

  it('sends nothing for bytes corrupted in transit, and quarantines on the digest it read', async () => {
    const bytes = aPdf('in-transit', 2 * MiB);
    const { id } = await upload(bytes);
    faulty.corruptAt = MiB + 5;

    const { sent, error } = await deliver(await deliveryWith(), id);

    expect(sent).toBeNull();
    expect(error).toMatchObject({ details: { integrityStatus: 'MISMATCH' } });
    expect(await integrityOf(id)).toBe('MISMATCH');
  });

  it('sends nothing for a confirmed missing object, and quarantines it UNREADABLE', async () => {
    const { id, key } = await upload(aPdf('missing'));
    await inAcme(() => scoped.delete(key));

    const { sent, error } = await deliver(await deliveryWith(), id);

    expect(sent).toBeNull();
    expect(error).toMatchObject({ details: { integrityStatus: 'UNREADABLE' } });
    expect(await integrityOf(id)).toBe('UNREADABLE');
    expect(await findings(id)).toEqual([1, 1]);
  });
});

describe('a verified download treats a failure to read as transient, never as a finding', () => {
  it.each([
    ['a store error (HTTP 503)', () => new StorageUnavailableError('read answered 503.')],
    [
      'an unreachable store',
      () =>
        new StorageUnavailableError('could not be reached', {
          cause: new TypeError('fetch failed'),
        }),
    ],
  ])(
    'answers %s with a retryable 503, sends nothing, and quarantines nothing',
    async (_case, fault) => {
      const { id } = await upload(aPdf('outage'));
      faulty.openFault = fault;

      const { sent, error } = await deliver(await deliveryWith(), id);

      expect(sent).toBeNull();
      expect(error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
      expect(await integrityOf(id)).toBe('UNVERIFIED');
      expect(await findings(id)).toEqual([0, 0]);
    },
  );

  it('does not quarantine one "no such object" that the store then contradicts', async () => {
    const { id } = await upload(aPdf('flicker'));
    faulty.absentOnce = true;

    const { sent, error } = await deliver(await deliveryWith(), id);

    expect(sent).toBeNull();
    expect(error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(await integrityOf(id)).toBe('UNVERIFIED');
    expect(await findings(id)).toEqual([0, 0]);
  });

  it('does not quarantine an absence it could not confirm', async () => {
    const { id, key } = await upload(aPdf('unconfirmed'));
    await inAcme(() => scoped.delete(key));
    faulty.headFault = true;

    const { sent, error } = await deliver(await deliveryWith(), id);

    expect(sent).toBeNull();
    expect(error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(await integrityOf(id)).toBe('UNVERIFIED');
  });

  it('answers a body cut part-way with a 503, having sent nothing', async () => {
    const bytes = aPdf('cut', 2 * MiB);
    const { id } = await upload(bytes);
    faulty.cutAfter = MiB;

    const { sent, error } = await deliver(await deliveryWith(), id);

    expect(sent).toBeNull();
    expect(error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(await integrityOf(id)).toBe('UNVERIFIED');
    expect(await findings(id)).toEqual([0, 0]);

    // The next attempt, with the store well again, serves the file.
    faulty.reset();
    expect((await deliver(await deliveryWith(), id)).sent?.equals(bytes)).toBe(true);
  });

  it('stops, sends nothing and keeps nothing open when the person leaves while it verifies', async () => {
    const { id } = await upload(aPdf('abandoned', 2 * MiB));
    const abort = new AbortController();
    faulty.onFirstChunk = () => {
      abort.abort();
    };

    const { sent, error } = await deliver(await deliveryWith(), id, abort.signal);

    expect(sent).toBeNull();
    expect(error).not.toBeNull();
    expect(await integrityOf(id)).toBe('UNVERIFIED');
  });
});

describe('a verified download refuses before it reads, where the answer is already known', () => {
  it('refuses a quarantined file without touching the store', async () => {
    const { id } = await upload(aPdf('already-quarantined'));
    await owner.fileObject.update({ where: { id }, data: { integrityStatus: 'MISMATCH' } });

    const { sent, error } = await deliver(await deliveryWith(), id);

    expect(sent).toBeNull();
    expect(error).toMatchObject({ code: 'CONTENT_NOT_SCANNED' });
    expect(faulty.openReads).toBe(0);
  });

  it('refuses content no scanner cleared without touching the store', async () => {
    scannerMode = 'NONE';
    const { id } = await upload(aPdf('unscanned'));

    const { error } = await deliver(await deliveryWith(), id);

    expect(error).toMatchObject({
      code: 'CONTENT_NOT_SCANNED',
      details: { scanStatus: 'SKIPPED' },
    });
    expect(faulty.openReads).toBe(0);
  });

  it('refuses a file over the verified size limit, rather than sending it unverified', async () => {
    const { id } = await upload(aPdf('too-large', 2 * MiB));

    const { error } = await deliver(
      await deliveryWith({ maxFileBytes: MiB, stagingMaxBytes: MiB }),
      id,
    );

    expect(error).toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
    expect((error as { publicReason: unknown }).publicReason).toMatchObject({
      reason: 'DOWNLOAD_TOO_LARGE',
      values: { limit: '1.0 MB' },
    });
    expect(faulty.openReads).toBe(0);
  });

  it('answers busy, having read nothing, when every slot is taken past the wait', async () => {
    const delivery = await deliveryWith({ maxConcurrent: 1, queueTimeoutMs: 1_000 });
    const first = await upload(aPdf('holds-the-slot'));
    const second = await upload(aPdf('waits'));
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = deliver(delivery, first.id, undefined, held);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const readsBefore = faulty.openReads;
    const waited = await deliver(delivery, second.id);

    expect(waited.sent).toBeNull();
    expect(waited.error).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      publicReason: { reason: 'DOWNLOAD_BUSY' },
    });
    expect(faulty.openReads).toBe(readsBefore);
    release();
    expect((await running).error).toBeNull();
    // With the slot free again, the same request succeeds.
    expect((await deliver(delivery, second.id)).error).toBeNull();
  });

  it('answers busy when the staging disk would drop below its reserve', async () => {
    const { id } = await upload(aPdf('no-room'));

    const { sent, error } = await deliver(
      await deliveryWith({ minFreeBytes: Number.MAX_SAFE_INTEGER }),
      id,
    );

    expect(sent).toBeNull();
    expect(error).toMatchObject({ publicReason: { reason: 'DOWNLOAD_BUSY' } });
    expect(faulty.openReads).toBe(0);
  });
});

describe('issuing and recording a verified download', () => {
  it('issues an API link naming the person, the document and the file, audited before it exists', async () => {
    const { id } = await upload(aPdf('issued'));
    const delivery = await deliveryWith();

    const link = await inAcme(() =>
      storage.createVerifiedDownloadLink(asId<FileObjectId>(id), 'تقرير.pdf', {
        documentId: '0199f5a1-5a9e-7000-8000-00000000d001',
        revisionId: null,
      }),
    );

    expect(link.url.startsWith('https://docs.example.test/api/v1/downloads?token=')).toBe(true);
    const grant = delivery.decode(new URL(link.url).searchParams.get('token') ?? '');
    expect(grant).toMatchObject({
      tenantId: String(ACME),
      userId: String(ALICE),
      permissionVersion: 3,
      documentId: '0199f5a1-5a9e-7000-8000-00000000d001',
      revisionId: null,
      fileObjectId: id,
      disposition: 'attachment',
      filename: 'تقرير.pdf',
    });
    const issued = await owner.auditEvent.findFirstOrThrow({
      where: { tenantId: ACME, action: 'FILE_DOWNLOAD_ISSUED', subjectId: id },
    });
    expect(issued.actorId).toBe(String(ALICE));
    expect(issued.payload).toMatchObject({ after: { delivery: 'VERIFIED' } });
  });

  it('issues no link for the system, which has nobody to name', async () => {
    const { id } = await upload(aPdf('system'));
    await expect(
      runWithContext({ ...aliceContext(), userId: null }, () =>
        storage.createVerifiedDownloadLink(asId<FileObjectId>(id), 'p.pdf', {
          documentId: '0199f5a1-5a9e-7000-8000-00000000d001',
          revisionId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('records FILE_DOWNLOAD_SERVED with the digest of the bytes that left', async () => {
    const bytes = aPdf('served');
    const { id } = await upload(bytes);
    await inAcme(() =>
      storage.recordDownloadServed(asId<FileObjectId>(id), {
        sizeBytes: bytes.length,
        verifiedAfterMs: 12,
      }),
    );
    const served = await owner.auditEvent.findFirstOrThrow({
      where: { tenantId: ACME, action: 'FILE_DOWNLOAD_SERVED', subjectId: id },
    });
    expect(served.actorId).toBe(String(ALICE));
    expect(served.payload).toMatchObject({
      after: { checksumSha256: sha256(bytes), sizeBytes: bytes.length, verifiedAfterMs: 12 },
    });
  });
});
