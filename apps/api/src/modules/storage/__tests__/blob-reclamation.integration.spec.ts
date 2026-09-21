import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type FileObjectId, type TenantId, type UserId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import type { StoragePort } from '../../../ports/storage.port';
import type { AntivirusPort } from '../../../ports/antivirus.port';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { realWriteStack } from '../../../testing/real-collaborators';
import { sharedDatabase } from '../../../testing/tenant-database';
import { DefaultStorageService } from '../application/storage.service';
import { PrismaFileObjectRepository } from '../infrastructure/prisma-file-object.repository';
import { PrismaUploadSessionRepository } from '../infrastructure/prisma-upload-session.repository';
import { StorageBlobReaper } from '../infrastructure/blob-reaper.adapter';

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';
const ACME = asId<TenantId>(uuidv7());
/** A second tenant, so "only this tenant's blob" is falsifiable. */
const OTHER = asId<TenantId>(uuidv7());
const ADMIN = uuidv7();

const config = {
  env: 'test',
  database: { url: APP_URL, poolSize: 10 },
  storage: { integrityBatchSize: 10, maxIntegrityReadBytes: 1024 },
} as unknown as AppConfig;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const now = new Date('2026-05-01T09:00:00.000Z');
const clock = { now: () => new Date(now), timestamp: () => 0, elapsedMs: () => 0 };

const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);
const { stamps, outbox, writer } = realWriteStack(clock, unitOfWork);
const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

/**
 * The object store, with a place to stand inside the reaper's transaction.
 *
 * `reclaim` calls `delete` after it has taken the row `FOR UPDATE` and before it soft-deletes the
 * row, which is the whole of the window this suite is about. Parking there is parking mid-claim.
 */
class ParkingStorage implements Partial<StoragePort> {
  readonly deleted: string[] = [];
  target: string | null = null;
  reached: (() => void) | null = null;
  admit: Promise<void> | null = null;
  readonly driver = 'LOCAL';

  async delete(key: string): Promise<void> {
    const gate = this.admit;
    if (gate !== null && key === this.target) {
      this.admit = null;
      this.reached?.();
      await gate;
    }
    this.deleted.push(key);
  }
}

const storagePort = new ParkingStorage();
const antivirus = { scan: () => Promise.resolve(null) } as unknown as AntivirusPort;

const storage = new DefaultStorageService(
  new PrismaFileObjectRepository(stamps),
  new PrismaUploadSessionRepository(stamps),
  storagePort as unknown as StoragePort,
  antivirus,
  clock,
  outbox,
  config,
  writer,
);

const reaper = new StorageBlobReaper(
  storagePort as unknown as StoragePort,
  unitOfWork,
  logger,
  storage,
  stamps,
);

function contextFor(tenantId: TenantId): RequestContext {
  return {
    tenantId,
    userId: asId<UserId>(ADMIN),
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: `reclaim-${tenantId}`,
    permissionVersion: 1,
    locale: 'en',
  };
}

function asTenant<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(ACME), work);
}

let planted = 0;

/** An unreferenced blob, already past whatever grace period the sweep is given. */
async function anUnreferencedBlob(): Promise<{ id: string; storageKey: string }> {
  planted += 1;
  const id = uuidv7();
  const storageKey = `blobs/${id}`;
  await owner.fileObject.create({
    data: {
      id,
      tenantId: ACME,
      checksumSha256: `${String(planted).padStart(4, '0')}`.padEnd(64, 'a'),
      sizeBytes: BigInt(11),
      mimeType: 'text/plain',
      storageKey,
      storageDriver: 'LOCAL',
      scanStatus: 'CLEAN',
      refCount: 0,
      derived: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  return { id, storageKey };
}

async function rowOf(id: string): Promise<{ refCount: number; deletedAt: Date | null }> {
  const row = await owner.fileObject.findUniqueOrThrow({
    where: { id },
    select: { refCount: true, deletedAt: true },
  });
  return row;
}

/**
 * Waits until some backend is blocked behind another transaction on `file_object`.
 *
 * The database's own view of who is waiting, polled — not a delay chosen to be long enough.
 */
/** Arms the park on one object key and hands back the two ends of it. */
function parkOn(storageKey: string): { reached: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  storagePort.admit = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  storagePort.target = storageKey;
  storagePort.reached = arrive;
  return { reached, release };
}

async function waitUntilBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 20_000; attempt += 1) {
    const [row] = await owner.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND cardinality(pg_blocking_pids(pid)) > 0
        AND query LIKE '%file_object%'`;
    if (Number(row?.waiting ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error('The reference never blocked on the reclaimed row.');
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  const slug = `reclaim-${Date.now()}`;
  await owner.tenant.create({ data: { id: ACME, slug, name: slug, status: 'ACTIVE' } });
  await owner.user.create({
    data: {
      id: ADMIN,
      tenantId: ACME,
      email: `admin@${slug}.test`,
      emailNormalized: `admin@${slug}.test`,
      displayName: 'Administrator',
      status: 'ACTIVE',
    },
  });
  await owner.tenant.create({
    data: { id: OTHER, slug: `${slug}-other`, name: `${slug}-other`, status: 'ACTIVE' },
  });
});

afterAll(async () => {
  await owner.$disconnect();
  await prisma.disconnectAll();
});

/**
 * A reference taken while the blob it names is being reclaimed — Slice 113.
 *
 * ## What the code says
 *
 * `StorageBlobReaper` is "the only code in the product that removes bytes from storage", and it
 * says what makes that safe: *"the reference count is re-checked inside the deleting transaction
 * with the row taken `FOR UPDATE`, because the listing ran earlier in somebody else's snapshot. A
 * revision attaching the blob between the two would have moved the count off zero, and deleting
 * the object then is how a live document loses its content."* `DocumentService.create` states the
 * same invariant from the other side: the reference goes in the revision's own transaction because
 * *"a revision holding an uncounted blob is one retention will delete underneath"*.
 *
 * ## What it did
 *
 * The re-check only catches an attach that got there first. `adjustRefCount` matched on `id` and
 * `tenant_id` alone, and under `READ COMMITTED` an `UPDATE` held up by the reaper's claim
 * re-evaluates its `WHERE` against the row the reaper left — neither of those columns changes when
 * a blob is reclaimed. So the attach that arrived second was not refused: it incremented the count
 * of a row that was already soft-deleted and whose object had already been removed from the store.
 *
 * That state is permanent. `findById` and `isReachable` exclude deleted rows, so the content can
 * never be served; `listReclaimable` excludes them too, so no later sweep revisits the row. The
 * document, template, export or artefact points at bytes that are gone, and the count says
 * somebody is using them.
 *
 * ## What proves it
 *
 * The reaper is parked on `StoragePort.delete`, which is inside its transaction, after the claim
 * and before the soft delete — the window the whole defect lives in. The reference is then made to
 * arrive *into* that window and is held by the claim, which the database's own wait view confirms
 * rather than a delay. Both orders are covered: the one the defect needs, and the one where the
 * reference gets there first and the reclaim must stand down.
 */
describe('a reference taken while the blob it names is being reclaimed', () => {
  it('references a blob when nothing is reclaiming it', async () => {
    // The control. Without it every assertion below passes on a repository that references nothing.
    const blob = await anUnreferencedBlob();

    await asTenant(() => unitOfWork.run(() => storage.reference(asId<FileObjectId>(blob.id))));

    const after = await rowOf(blob.id);
    expect(after.refCount).toBe(1);
    expect(after.deletedAt).toBeNull();
    expect(storagePort.deleted).not.toContain(blob.storageKey);
  });

  it('refuses the reference the reclaim beat, rather than counting it', async () => {
    const blob = await anUnreferencedBlob();
    const park = parkOn(blob.storageKey);

    // The reaper claims the row `FOR UPDATE` at a reference count of zero and parks on the delete.
    const reclaiming = asTenant(() => reaper.reclaim(blob.id));
    await park.reached;

    // Somebody attaches the blob. Its row was live and its count zero when they read it; the
    // statement now blocks on the claim the reaper holds.
    const referencing = asTenant(() =>
      unitOfWork.run(() => storage.reference(asId<FileObjectId>(blob.id))),
    );
    await waitUntilBlocked();

    park.release();
    expect(await reclaiming).toBe(true);

    const outcome = await referencing.then(
      () => ({ kind: 'referenced' as const, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    // The answer the caller who arrived a moment later is given, from the same module — not a
    // fault, and not a silent success over bytes that are gone.
    expect(outcome.kind).toBe('refused');
    expect(outcome.error).toMatchObject({ code: 'NOT_FOUND' });

    // And the row never records a reference it cannot honour.
    const after = await rowOf(blob.id);
    expect(after.deletedAt).not.toBeNull();
    expect(after.refCount).toBe(0);
    expect(storagePort.deleted).toContain(blob.storageKey);
  }, 60_000);

  it('stands the reclaim down when the reference got there first', async () => {
    /*
     * The other side of the same claim, and what must *not* become a refusal.
     *
     * Here the attach commits before the reaper looks, so the reaper's own `ref_count = 0`
     * predicate finds nothing to claim and it reports that it reclaimed nothing. The blob keeps
     * its bytes. This is the case the reaper's `FOR UPDATE` re-check was written for, and it is
     * unchanged.
     */
    const blob = await anUnreferencedBlob();

    await asTenant(() => unitOfWork.run(() => storage.reference(asId<FileObjectId>(blob.id))));
    const reclaimed = await asTenant(() => reaper.reclaim(blob.id));

    expect(reclaimed).toBe(false);
    const after = await rowOf(blob.id);
    expect(after.refCount).toBe(1);
    expect(after.deletedAt).toBeNull();
    expect(storagePort.deleted).not.toContain(blob.storageKey);
  });

  it('reclaims a blob once, however many times the sweep reaches it', async () => {
    // The claim's own `deleted_at IS NULL`, which is what stops a second pass deleting an object
    // that is already gone and reporting it as freshly reclaimed.
    const blob = await anUnreferencedBlob();

    expect(await asTenant(() => reaper.reclaim(blob.id))).toBe(true);
    expect(await asTenant(() => reaper.reclaim(blob.id))).toBe(false);

    expect(storagePort.deleted.filter((key) => key === blob.storageKey)).toHaveLength(1);
  });

  it('gives a reference back on a blob that is still there', async () => {
    // The `-1` direction through the same statement, so the added condition is shown not to have
    // turned an ordinary detachment into a refusal.
    const blob = await anUnreferencedBlob();

    await asTenant(() => unitOfWork.run(() => storage.reference(asId<FileObjectId>(blob.id))));
    await asTenant(() => unitOfWork.run(() => storage.dereference(asId<FileObjectId>(blob.id))));

    const after = await rowOf(blob.id);
    expect(after.refCount).toBe(0);
    expect(after.deletedAt).toBeNull();
  });

  it('cannot reference another tenant’s blob', async () => {
    // The tenant predicate is beside the new one, and neither is a reason to relax the other.
    const blob = await anUnreferencedBlob();

    await expect(
      runWithContext(contextFor(OTHER), () =>
        unitOfWork.run(() => storage.reference(asId<FileObjectId>(blob.id))),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect((await rowOf(blob.id)).refCount).toBe(0);
  });
});
