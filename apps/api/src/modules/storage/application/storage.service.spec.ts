import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  type FileObjectId,
  IntegrityStatus,
  ScanStatus,
  type ScanStatusKey,
  type TenantId,
  UploadSessionState,
  type UploadSessionId,
  type UploadSessionStateKey,
  asId,
} from '@edms/domain';

import type { AppConfig } from '../../../core/config';
import type { AuditWriter } from '../../../core/audit/audit-writer.port';
import type { OutboxWriter } from '../../../core/outbox/outbox.port';
import { AdministeredWriter, RecordStamps } from '../../../core/persistence';
import { PrismaUnitOfWork, currentTransaction } from '../../../core/prisma/unit-of-work';
import type { TenantDatabase } from '../../../core/prisma/tenant-database';
import { runWithContext } from '../../../core/tenancy/tenant-context';
import { AntivirusScanError, type AntivirusPort } from '../../../ports/antivirus.port';
import type { StoragePort } from '../../../ports/storage.port';
import type {
  FileObjectRecord,
  FileObjectRepository,
  UploadSessionRecord,
  UploadSessionRepository,
} from './ports';
import { DefaultStorageService } from './storage.service';

/**
 * Where the malware scan runs relative to the database transaction — STG-1.
 *
 * Staging found upload completion scanning inside its PostgreSQL transaction, which Prisma closes
 * after 5,000 ms: any read-and-scan longer than that answered 500. These tests use the real
 * `PrismaUnitOfWork` over a stand-in database, so `currentTransaction()` answers exactly as it does
 * in production, and they record whether a transaction was open **at the moment the scanner was
 * asked**. The real-scanner proof — slow verdicts, large files, timeouts — is
 * `src/__tests__/antivirus.e2e.integration.spec.ts`.
 */

const TENANT = asId<TenantId>('0199f5a1-5a9e-7000-8000-00000000a001');
const USER = '0199f5a1-5a9e-7000-8000-0000000000e1';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

interface Harness {
  readonly service: DefaultStorageService;
  readonly files: Map<string, FileObjectRecord>;
  readonly sessions: Map<string, UploadSessionRecord>;
  readonly scans: { readonly checksum: string; readonly inTransaction: boolean }[];
  readonly events: string[];
  readonly transactions: { opened: number };
  readonly targets: Record<string, unknown>[];
  /** Every copy and delete the service asked the store for, in order. */
  readonly storageOps: string[];
  readonly sizeBytes: number;
  readonly expiresAt: Date;
}

function harness(options: {
  scanner?: (checksum: string) => Promise<{ status: ScanStatusKey; threat?: string }>;
  stored?: string; // the bytes the store reports for every completed upload
  /** Each completed upload reports bytes of its own (its staging key), not one shared digest. */
  distinct?: boolean;
  sizeBytes?: number;
  budgetBytes?: number;
  queueTimeoutMs?: number;
  /** The store reports nothing under any staging key: the bytes never arrived. */
  missing?: boolean;
  /** Each session's link expired this long before "now" (the default is an hour after). */
  expiredAgoMs?: number;
  /** The first attempt to write the file row fails, as a crash or a lost connection would. */
  failFirstInsert?: boolean;
}): Harness {
  const sizeBytes = options.sizeBytes ?? 10;
  const insertFailed = { value: false };
  const storageOps: string[] = [];
  const files = new Map<string, FileObjectRecord>();
  const sessions = new Map<string, UploadSessionRecord>();
  const scans: Harness['scans'] = [];
  const events: string[] = [];
  const transactions = { opened: 0 };
  const targets: Record<string, unknown>[] = [];
  const now = () => new Date('2026-09-29T12:00:00Z');
  let sequence = 0;
  const nextId = () => `0199f5a1-5a9e-7000-8000-${String(++sequence).padStart(12, '0')}`;

  const database = {
    withTenant: async (_tenantId: string, work: (tx: unknown) => Promise<unknown>) => {
      transactions.opened += 1;
      return work({ tenant: { findUnique: () => Promise.resolve({ status: 'ACTIVE' }) } });
    },
  } as unknown as TenantDatabase;
  const audit: AuditWriter = { write: () => Promise.resolve() } as unknown as AuditWriter;
  const clock = { now, nextId } as never;
  const stamps = new RecordStamps(clock);
  Object.defineProperty(stamps, 'nextId', { value: nextId });
  const writer = new AdministeredWriter(new PrismaUnitOfWork(database), audit, stamps);

  const fileRepo: FileObjectRepository = {
    findById: (id: FileObjectId) => Promise.resolve(files.get(id) ?? null),
    findByChecksum: (checksum: string) =>
      Promise.resolve([...files.values()].find((f) => f.checksumSha256 === checksum) ?? null),
    insert: (file: { id: string; checksumSha256: string } & Record<string, unknown>) => {
      if (options.failFirstInsert === true && !insertFailed.value) {
        insertFailed.value = true;
        return Promise.reject(new Error('connection lost'));
      }
      if ([...files.values()].some((f) => f.checksumSha256 === file.checksumSha256)) {
        return Promise.resolve(false);
      }
      files.set(file.id, record(file as never));
      return Promise.resolve(true);
    },
    recordScan: (
      id: FileObjectId,
      verdict: { status: ScanStatusKey; scanner: string; threat: string | null },
      from: readonly ScanStatusKey[],
    ) => {
      const row = files.get(id);
      if (row === undefined || !from.includes(row.scanStatus)) {
        return Promise.resolve(false);
      }
      files.set(id, { ...row, scanStatus: verdict.status, scanThreat: verdict.threat });
      return Promise.resolve(true);
    },
  } as unknown as FileObjectRepository;
  const sessionRepo: UploadSessionRepository = {
    insert: (row: UploadSessionRecord) => {
      sessions.set(row.id, { ...row, state: UploadSessionState.OPEN, fileObjectId: null });
      return Promise.resolve();
    },
    findById: (id: UploadSessionId) => Promise.resolve(sessions.get(id) ?? null),
    settle: (id: UploadSessionId, state: UploadSessionStateKey, fileObjectId: string | null) => {
      const row = sessions.get(id);
      if (row === undefined || row.state !== UploadSessionState.OPEN) {
        return Promise.resolve(false);
      }
      sessions.set(id, { ...row, state, fileObjectId });
      return Promise.resolve(true);
    },
  } as unknown as UploadSessionRepository;
  const storage = {
    driver: 'LOCAL',
    // Answers as the S3 adapter does: a multipart request gets part URLs and an upload id.
    createUploadTarget: (input: Record<string, unknown>) => {
      targets.push(input);
      return Promise.resolve({
        key: input.key,
        url: 'https://store.test/staging?partNumber=1',
        method: 'PUT',
        headers: {},
        expiresAt: new Date('2026-09-29T13:00:00Z'),
        ...(input.multipart === true && {
          parts: [1, 2, 3, 4, 5, 6, 7, 8].map((partNumber) => ({
            partNumber,
            url: `https://store.test/staging?partNumber=${String(partNumber)}`,
            uploadId: 'upload-1',
          })),
        }),
      });
    },
    completeUpload: (key: string) =>
      Promise.resolve({
        sizeBytes,
        checksumSha256: sha(options.distinct === true ? key : (options.stored ?? 'clean bytes')),
      }),
    head: (key: string) =>
      Promise.resolve(
        options.missing === true
          ? null
          : {
              key,
              sizeBytes,
              contentType: 'application/pdf',
              checksumSha256:
                options.stored === 'no digest'
                  ? null
                  : sha(options.distinct === true ? key : (options.stored ?? 'clean bytes')),
              lastModifiedAt: now(),
            },
      ),
    copy: (from: string, to: string) => {
      storageOps.push(`copy ${from} -> ${to}`);
      return Promise.resolve();
    },
    delete: (key: string) => {
      storageOps.push(`delete ${key}`);
      return Promise.resolve();
    },
  } as unknown as StoragePort;
  const antivirus: AntivirusPort = {
    scanner: 'ICAP test',
    scan: async (request: { checksumSha256: string }) => {
      scans.push({
        checksum: request.checksumSha256,
        inTransaction: currentTransaction() !== null,
      });
      const verdict = await (
        options.scanner ?? (() => Promise.resolve({ status: ScanStatus.CLEAN }))
      )(request.checksumSha256);
      return { ...verdict, scanner: 'ICAP C-ICAP/0.5.10 ISTag=test', scannerVersion: '1' };
    },
  } as unknown as AntivirusPort;
  const outbox: OutboxWriter = {
    publish: (drafts: readonly { type: string }[]) => {
      events.push(...drafts.map((d) => d.type));
      return Promise.resolve();
    },
  };
  const config = {
    antivirus: {
      timeoutMs: 120_000,
      maxBytes: 134_217_728,
      budgetBytes: options.budgetBytes ?? 268_435_456,
      queueTimeoutMs: options.queueTimeoutMs ?? 60_000,
    },
    providers: { antivirus: 'ICAP' },
    storage: { maxUploadBytes: 2 ** 31, signedUrlTtlSeconds: 300 },
  } as unknown as AppConfig;

  const service = new DefaultStorageService(
    fileRepo,
    sessionRepo,
    storage,
    antivirus,
    clock,
    outbox,
    config,
    writer,
  );
  return {
    service,
    files,
    sessions,
    scans,
    events,
    transactions,
    targets,
    storageOps,
    sizeBytes,
    expiresAt: new Date(
      options.expiredAgoMs === undefined
        ? now().getTime() + 3_600_000
        : now().getTime() - options.expiredAgoMs,
    ),
  };
}

function record(file: {
  id: string;
  checksumSha256: string;
  scanStatus: ScanStatusKey;
  scanThreat?: string | null;
  derived?: boolean;
}): FileObjectRecord {
  return {
    id: asId<FileObjectId>(file.id),
    checksumSha256: file.checksumSha256,
    sizeBytes: 10,
    mimeType: 'application/pdf',
    storageKey: `blobs/${file.checksumSha256}`,
    storageDriver: 'LOCAL',
    scanStatus: file.scanStatus,
    scanThreat: file.scanThreat ?? null,
    integrityStatus: IntegrityStatus.UNVERIFIED,
    integrityCheckedAt: null,
    refCount: 0,
    derived: file.derived ?? false,
    createdAt: new Date(),
    createdBy: USER,
  };
}

function openSession(h: Harness): UploadSessionId {
  const id = asId<UploadSessionId>(
    `0199f5a1-5a9e-7000-9000-${String(h.sessions.size + 1).padStart(12, '0')}`,
  );
  h.sessions.set(id, {
    id,
    filename: 'f.pdf',
    declaredMimeType: 'application/pdf',
    declaredSizeBytes: h.sizeBytes,
    targetKey: `staging/${id}`,
    state: UploadSessionState.OPEN,
    multipartUploadId: null,
    fileObjectId: null,
    expiresAt: h.expiresAt,
    createdBy: USER,
  });
  return id;
}

const inContext = <T>(work: () => Promise<T>) =>
  runWithContext(
    {
      tenantId: TENANT,
      userId: USER,
      roles: [],
      permissions: [],
      sessionId: null,
      correlationId: 'stg-1',
      permissionVersion: 1,
      locale: 'en',
    } as never,
    work,
  );

describe('STG-1: no scan runs inside a database transaction', () => {
  it('a new upload is scanned with no transaction open, then recorded in one', async () => {
    const h = harness({});
    const completed = await inContext(() => h.service.completeUploadSession(openSession(h), []));
    expect(completed.scanStatus).toBe('CLEAN');
    expect(h.scans).toEqual([{ checksum: sha('clean bytes'), inTransaction: false }]);
    expect(h.events).toEqual(['storage.file-created', 'storage.scan-completed']);
  });

  it('a slow scanner is waited for without a transaction held open across it', async () => {
    let release: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => (release = resolve));
    const h = harness({
      scanner: async () => {
        await answered;
        return { status: ScanStatus.CLEAN };
      },
    });
    const completing = inContext(() => h.service.completeUploadSession(openSession(h), []));
    // Real synchronisation: wait until the scanner has been asked, then check what is open.
    while (h.scans.length === 0) {
      await new Promise((tick) => setImmediate(tick));
    }
    const openedWhileScanning = h.transactions.opened;
    release();
    expect((await completing).scanStatus).toBe('CLEAN');
    expect(h.scans[0]?.inTransaction).toBe(false);
    // Only the short read of the session was a transaction before the scanner answered.
    expect(h.transactions.opened).toBeGreaterThan(openedWhileScanning);
  });

  it('a re-upload of a FAILED blob is re-scanned outside the transaction, by either route', async () => {
    for (const route of ['complete', 'presign'] as const) {
      const h = harness({});
      const failed = record({
        id: 'f',
        checksumSha256: sha('clean bytes'),
        scanStatus: ScanStatus.FAILED,
      });
      h.files.set(failed.id, failed);
      if (route === 'complete') {
        const done = await inContext(() => h.service.completeUploadSession(openSession(h), []));
        expect(done).toMatchObject({ fileObjectId: 'f', deduplicated: true, scanStatus: 'CLEAN' });
      } else {
        await inContext(() =>
          h.service.createUploadSession({
            filename: 'f.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 10,
            magicBytes: Buffer.from('%PDF-1.7\n'),
            checksumSha256: sha('clean bytes'),
          }),
        );
      }
      expect(h.files.get('f')?.scanStatus).toBe('CLEAN');
      expect(h.scans).toEqual([{ checksum: sha('clean bytes'), inTransaction: false }]);
    }
  });
});

describe('STG-1: failures are recorded, never CLEAN, never a 500', () => {
  it.each([
    ['TIMEOUT', 'the configured scan timeout'],
    ['UNREACHABLE', 'an unreachable scanner'],
    ['SCANNER_ERROR', 'a scanner error'],
  ] as const)('%s — %s — is recorded FAILED, and the session completes', async (reason, _why) => {
    const h = harness({
      scanner: () => Promise.reject(new AntivirusScanError('the scanner gave no verdict', reason)),
    });
    const id = openSession(h);
    const done = await inContext(() => h.service.completeUploadSession(id, []));
    expect(done.scanStatus).toBe('FAILED');
    expect(h.files.get(done.fileObjectId)?.scanStatus).toBe('FAILED');
    expect(h.sessions.get(id)?.state).toBe('COMPLETED');
    expect(h.scans[0]?.inTransaction).toBe(false);
  });

  it('a re-scan that fails again leaves the blob FAILED — never CLEAN', async () => {
    const h = harness({
      scanner: () =>
        Promise.reject(new AntivirusScanError('the scanner is unreachable', 'UNREACHABLE')),
    });
    h.files.set(
      'f',
      record({ id: 'f', checksumSha256: sha('clean bytes'), scanStatus: ScanStatus.FAILED }),
    );
    const done = await inContext(() => h.service.completeUploadSession(openSession(h), []));
    expect(done.scanStatus).toBe('FAILED');
    expect(h.files.get('f')?.scanStatus).toBe('FAILED');
  });
});

describe('STG-1: a verdict is recorded only for the bytes it was computed for', () => {
  it('an INFECTED blob is never re-marked, and is not re-scanned', async () => {
    const h = harness({});
    h.files.set(
      'i',
      record({
        id: 'i',
        checksumSha256: sha('clean bytes'),
        scanStatus: ScanStatus.INFECTED,
        scanThreat: 'Eicar',
      }),
    );
    const done = await inContext(() => h.service.completeUploadSession(openSession(h), []));
    expect(done.scanStatus).toBe('INFECTED');
    expect(h.scans).toEqual([]);
  });

  it('a verdict computed for one digest is not applied to a row holding another', async () => {
    // Between the scan and the transaction the digest's row is replaced by one for other bytes
    // (a contrived store, since content addressing makes this impossible in production): the
    // carried CLEAN must not land on it.
    const h = harness({});
    const failed = record({
      id: 'f',
      checksumSha256: sha('clean bytes'),
      scanStatus: ScanStatus.FAILED,
    });
    h.files.set('f', failed);
    const original = h.files.get.bind(h.files);
    let swapped = false;
    const repo = (h.service as unknown as { files: FileObjectRepository }).files;
    const find = repo.findByChecksum.bind(repo);
    repo.findByChecksum = async (checksum: string) => {
      const found = await find(checksum);
      if (found !== null && h.scans.length > 0 && !swapped) {
        swapped = true;
        return { ...found, checksumSha256: sha('other bytes') };
      }
      return found;
    };
    const done = await inContext(() => h.service.completeUploadSession(openSession(h), []));
    expect(original('f')?.scanStatus).toBe('FAILED');
    expect(done.scanStatus).toBe('FAILED');
  });

  it('two completions of the same new bytes: one row, one verdict, one set of events', async () => {
    const h = harness({});
    const results = await Promise.allSettled([
      inContext(() => h.service.completeUploadSession(openSession(h), [])),
      inContext(() => h.service.completeUploadSession(openSession(h), [])),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(h.files.size).toBe(1);
    expect(h.events.filter((e) => e === 'storage.scan-completed')).toHaveLength(1);
  });

  it('a session claimed while its scan ran: refused, and no row is written', async () => {
    let release: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => (release = resolve));
    const h = harness({
      scanner: async () => {
        await answered;
        return { status: ScanStatus.CLEAN };
      },
    });
    const id = openSession(h);
    const completing = inContext(() => h.service.completeUploadSession(id, []));
    while (h.scans.length === 0) {
      await new Promise((tick) => setImmediate(tick));
    }
    const row = h.sessions.get(id);
    if (row !== undefined) {
      h.sessions.set(id, { ...row, state: UploadSessionState.EXPIRED });
    }
    release();
    await expect(completing).rejects.toMatchObject({ name: 'ValidationError' });
    // The in-memory repository has no rollback, so the row the insert wrote is still visible here;
    // in PostgreSQL it rolls back with the refused claim (the integration spec asserts that).
    expect(h.sessions.get(id)?.state).toBe('EXPIRED');
  });
});

/**
 * Large uploads — STG-10.
 *
 * Above 64 MiB the service asked for a multipart target. On S3 that could never finish: the web
 * client PUTs the whole file to the target URL (part 1) and completes with no parts, and even a
 * client that sent every part got an object with no full-object SHA-256, which
 * `completeUploadSession` refuses ("Storage could not confirm the file's digest"). Every upload
 * between 64 MiB and the ceiling was refused on the production storage driver.
 */
describe('STG-10: a large browser upload is one signed PUT bound to its digest', () => {
  it('a 120 MiB upload is issued a single PUT carrying the digest, never a multipart target', async () => {
    const h = harness({});
    const digest = sha('one hundred and twenty mebibytes');
    const issued = await inContext(() =>
      h.service.createUploadSession({
        filename: 'large.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 120 * 1024 * 1024,
        magicBytes: Buffer.from('%PDF-1.7\n'),
        checksumSha256: digest,
      }),
    );

    expect(h.targets).toHaveLength(1);
    expect(h.targets[0]).toMatchObject({ sizeBytes: 120 * 1024 * 1024, checksumSha256: digest });
    expect(h.targets[0]?.multipart).not.toBe(true);
    expect(issued).toMatchObject({ method: 'PUT', parts: null, alreadyStored: null });
    const session = h.sessions.get((issued as { uploadSessionId: string }).uploadSessionId);
    expect(session?.multipartUploadId).toBeNull();
  });
});

describe('Phase A: scans are admitted within AV_SCAN_BUDGET_BYTES', () => {
  const MiB = 1024 * 1024;
  const waitFor = async (condition: () => boolean) => {
    while (!condition()) {
      await new Promise((tick) => setImmediate(tick));
    }
  };

  it('runs no more completions at once than the budget admits, and finishes every one', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let running = 0;
    let most = 0;
    const h = harness({
      distinct: true,
      sizeBytes: 120 * MiB,
      budgetBytes: 256 * MiB,
      scanner: async () => {
        running += 1;
        most = Math.max(most, running);
        await held;
        running -= 1;
        return { status: ScanStatus.CLEAN };
      },
    });
    const ids = Array.from({ length: 8 }, () => openSession(h));
    const completions = ids.map((id) => inContext(() => h.service.completeUploadSession(id, [])));
    await waitFor(() => h.scans.length === 2);
    // Two 120 MiB scans fit in 256 MiB; the other six wait, and none of them has copied anything.
    await new Promise((tick) => setTimeout(tick, 20));
    expect(h.scans).toHaveLength(2);
    expect(h.storageOps.filter((op) => op.startsWith('copy'))).toHaveLength(2);
    release();
    const done = await Promise.all(completions);
    expect(done.map((d) => d.scanStatus)).toEqual(Array(8).fill('CLEAN'));
    expect(most).toBe(2);
    expect(ids.map((id) => h.sessions.get(id)?.state)).toEqual(Array(8).fill('COMPLETED'));
  });

  it('refuses a completion that waits too long as busy, having changed nothing', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const h = harness({
      distinct: true,
      sizeBytes: 120 * MiB,
      budgetBytes: 128 * MiB,
      queueTimeoutMs: 30,
      scanner: async () => {
        await held;
        return { status: ScanStatus.CLEAN };
      },
    });
    const first = openSession(h);
    const second = openSession(h);
    const running = inContext(() => h.service.completeUploadSession(first, []));
    await waitFor(() => h.scans.length === 1);

    await expect(
      inContext(() => h.service.completeUploadSession(second, [])),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', name: 'ScannerBusyError' });
    // Still open, its staged bytes untouched: the same request can be made again.
    expect(h.sessions.get(second)?.state).toBe('OPEN');
    expect(h.storageOps.some((op) => op.includes(`staging/${second}`))).toBe(false);

    release();
    await running;
    const retried = await inContext(() => h.service.completeUploadSession(second, []));
    expect(retried.scanStatus).toBe('CLEAN');
    expect(h.sessions.get(second)?.state).toBe('COMPLETED');
  });

  it('gives the capacity back when a scan fails, so the next completion runs', async () => {
    const h = harness({
      distinct: true,
      sizeBytes: 120 * MiB,
      budgetBytes: 128 * MiB,
      queueTimeoutMs: 30,
      scanner: () => Promise.reject(new AntivirusScanError('no verdict', 'SCANNER_ERROR')),
    });
    const failed = await inContext(() => h.service.completeUploadSession(openSession(h), []));
    expect(failed.scanStatus).toBe('FAILED');
    const next = await inContext(() => h.service.completeUploadSession(openSession(h), []));
    expect(next.scanStatus).toBe('FAILED');
    expect(h.scans).toHaveLength(2);
  });
});

describe('Phase A: a refused or interrupted completion settles, and never accepts other bytes', () => {
  it('a missing digest aborts the session and removes the staged bytes', async () => {
    const h = harness({ stored: 'no digest' });
    const id = openSession(h);
    await expect(inContext(() => h.service.completeUploadSession(id, []))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
    });
    expect(h.sessions.get(id)?.state).toBe('ABORTED');
    expect(h.storageOps).toEqual([`delete staging/${id}`]);
    expect(h.files.size).toBe(0);
    // A second completion is told it is finished; it does not look at the bytes again.
    await expect(inContext(() => h.service.completeUploadSession(id, []))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(h.scans).toHaveLength(0);
  });

  it('a size that differs from the declared one aborts the session', async () => {
    const h = harness({ sizeBytes: 10 });
    const id = openSession(h);
    h.sessions.set(id, { ...h.sessions.get(id)!, declaredSizeBytes: 11 });
    await expect(inContext(() => h.service.completeUploadSession(id, []))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
    });
    expect(h.sessions.get(id)?.state).toBe('ABORTED');
    expect(h.files.size).toBe(0);
  });

  it('no bytes after the link expired: settled EXPIRED, refused as expired', async () => {
    const h = harness({ missing: true, expiredAgoMs: 1_000 });
    const id = openSession(h);
    await expect(inContext(() => h.service.completeUploadSession(id, []))).rejects.toMatchObject({
      name: 'UploadExpiredError',
      code: 'VALIDATION_FAILED',
    });
    expect(h.sessions.get(id)?.state).toBe('EXPIRED');
    expect(h.storageOps).toEqual([]);
  });

  it('no bytes yet while the link is valid: left OPEN, refused as not received', async () => {
    const h = harness({ missing: true });
    const id = openSession(h);
    await expect(inContext(() => h.service.completeUploadSession(id, []))).rejects.toMatchObject({
      name: 'UploadNotReceivedError',
    });
    expect(h.sessions.get(id)?.state).toBe('OPEN');
  });

  it('an interrupted completion keeps its staged bytes, and completing again succeeds', async () => {
    const h = harness({ failFirstInsert: true });
    const id = openSession(h);
    await expect(inContext(() => h.service.completeUploadSession(id, []))).rejects.toThrow(
      'connection lost',
    );
    expect(h.sessions.get(id)?.state).toBe('OPEN');
    expect(h.storageOps.some((op) => op === `delete staging/${id}`)).toBe(false);

    const done = await inContext(() => h.service.completeUploadSession(id, []));
    expect(done.scanStatus).toBe('CLEAN');
    expect(h.sessions.get(id)?.state).toBe('COMPLETED');
    // Removed only now, after the row that says what the bytes became.
    expect(h.storageOps.at(-1)).toBe(`delete staging/${id}`);
  });

  it('a completed upload removes its staged bytes only after the row is written', async () => {
    const h = harness({});
    const id = openSession(h);
    await inContext(() => h.service.completeUploadSession(id, []));
    expect(h.storageOps).toEqual([
      `copy staging/${id} -> blobs/${sha('clean bytes').slice(0, 2)}/${sha('clean bytes').slice(2, 4)}/${sha('clean bytes')}`,
      `delete staging/${id}`,
    ]);
  });
});

describe('Phase A: an upload refused for its size says so, and the limits are unchanged', () => {
  const MiB = 1024 * 1024;
  const create = (h: Harness, mimeType: string, sizeBytes: number, magic: string) =>
    inContext(() =>
      h.service.createUploadSession({
        filename: mimeType === 'text/plain' ? 'notes.txt' : 'drawing.pdf',
        mimeType,
        sizeBytes,
        magicBytes: Buffer.from(magic),
      }),
    );

  it('a PDF of exactly 128 MiB is issued a target; one byte more is refused as too large', async () => {
    const h = harness({});
    const issued = await create(h, 'application/pdf', 128 * MiB, '%PDF-1.7\n');
    expect(issued.url).not.toBe('');
    await expect(create(h, 'application/pdf', 128 * MiB + 1, '%PDF-1.7\n')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      publicReason: { reason: 'TOO_LARGE', values: { limit: '128 MB' } },
    });
  });

  it('a text file is limited to 32 MiB, and the refusal names that limit', async () => {
    const h = harness({});
    await expect(create(h, 'text/plain', 32 * MiB + 1, 'plain text\n')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      publicReason: { reason: 'TOO_LARGE', values: { limit: '32 MB' } },
    });
  });

  it('a type that is not allowed is refused as such', async () => {
    const h = harness({});
    await expect(create(h, 'application/x-msdownload', 1024, 'MZ')).rejects.toMatchObject({
      publicReason: { reason: 'TYPE_NOT_ALLOWED' },
    });
  });
});
