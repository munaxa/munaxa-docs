import 'reflect-metadata';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DOCUMENT_DELETION_RULES,
  DeletionEffect,
  Disposition,
  type DocumentId,
  type FileObjectId,
  NumberReservationState,
  type NumberReservationId,
  RetentionScheduleState,
  NumberSegmentKind,
  RetentionTrigger,
  RevisionLabelStyle,
  ScanStatus,
  Settings,
  type TenantId,
  type UploadSessionId,
  type UserId,
  type WorkflowInstanceId,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { RecordStamps } from '../../../core/persistence/record-stamps';
import type { LegalHoldRecord } from '../application/ports';
import { RetentionAudit } from '../domain/audit-actions';
import { DispositionOutcome } from '../domain/schedule';
import {
  PrismaLegalHoldRepository,
  PrismaRetentionScheduleRepository,
} from '../infrastructure/prisma-retention.repositories';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { decodeTransferToken } from '../../../testing/transfer-token';
import {
  type DocumentLibraryStack,
  type RetentionStack,
  realDisposition,
  ParkingDocumentRepository,
  realAclResolver,
  realDocumentLibrary,
  realRetention,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';

/**
 * Phase 10 against a real PostgreSQL and a real filesystem store — the assertions only a database
 * can be trusted about.
 *
 * Every one of these is a question a repository double would answer from the same belief as the
 * code under test:
 *
 * - **A soft-deleted document is absent from every list and present in the recycle bin**, and its
 *   revisions went with it — the cascade Phase 3 did not have.
 * - **A restore returns exactly what its delete took**, and not what was already deleted before it.
 * - **A purge removes the row and leaves the audit trail intact** — proved by reading the trail
 *   back and finding the document number still in it, not merely by nothing throwing. The table
 *   refuses `DELETE` to the owner, so the purge *could not* remove it even by mistake, and that
 *   refusal is asserted directly.
 * - **A blob dereferenced to zero is actually removed from storage**, read back off the disk.
 * - **A legal hold refuses a purge that would otherwise proceed**, and the same sweep purges the
 *   unheld document beside it.
 * - **The sweep is idempotent under redelivery**: the second pass finds nothing and destroys
 *   nothing.
 *
 * The `DOCUMENT_DELETION_RULES` table is read by the suite rather than restated in it: the row
 * counts after a delete and after a purge are asserted *from* the table, so a relation added to
 * the product without a decision recorded there fails here.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

/** Movable, because a retention period is months and a sweep only acts on what is due. */
let now = new Date('2026-08-20T09:00:00.000Z');
const clock = { now: () => new Date(now), timestamp: () => 0, elapsedMs: () => 0 };
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
const ALICE = asId<UserId>(uuidv7());
const SIGNING_SECRET = 'a-phase-ten-integration-secret-of-at-least-32';
const RECYCLE_BIN_DAYS = 30;

let root: string;
let owner: PrismaClient;
let unitOfWork: PrismaUnitOfWork;
/** The config `beforeAll` built, so a test can compose a second stack on the same terms. */
let libraryConfig: AppConfig;
let library: DocumentLibraryStack;
let retention: RetentionStack;

let libraryId: string;
let rootFolderId: string;
let documentTypeId: string;
/** A type whose policy purges thirty days after a publication — short, so the suite can pass it. */
let purgingTypeId: string;
/** The rule the purging type numbers under — Slice 105A draws real numbers from it. */
let numberingRuleId: string;
let purgePolicyId: string;
let archivingTypeId: string;

function contextFor(userId: UserId | null): RequestContext {
  return {
    tenantId: TENANT,
    userId,
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: 'soft-delete-retention',
    permissionVersion: 1,
    locale: 'en',
  };
}

function as<T>(work: () => Promise<T>, userId: UserId | null = ALICE): Promise<T> {
  return runWithContext(contextFor(userId), work);
}

/** The sweep runs as nobody — the system carrying out a policy, which is what the lane does. */
function asSystem<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(null), work);
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(3, '0')}`;
}

function aPdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${marker}\n1 0 obj\n<<>>\nendobj\n`);
}

const MAGIC = new Uint8Array(Buffer.from('%PDF-1.7\n% ', 'utf8'));

/** Held open by a case that needs a completion paused mid-flight; null everywhere else. */
let scanGate: (() => Promise<void>) | null = null;

function scopedPath(key: string): string {
  return `${TENANT}/${key}`;
}

async function uploadClean(content: Buffer): Promise<string> {
  const target = await as(() =>
    library.storage.createUploadSession({
      filename: 'procedure.pdf',
      mimeType: 'application/pdf',
      sizeBytes: content.length,
      magicBytes: MAGIC,
    }),
  );
  if (target.alreadyStored !== null) {
    return target.alreadyStored.fileObjectId;
  }
  const decoded = decodeTransferToken(
    SIGNING_SECRET,
    new URL(target.url).searchParams.get('token') ?? '',
    'PUT',
    now,
  );
  if (!('grant' in decoded)) {
    throw new Error('The upload target did not carry a usable transfer capability.');
  }
  await library.localStorage.beginWrite(decoded.grant.key);
  await writeFile(library.localStorage.partialPathFor(decoded.grant.key), content);
  await library.localStorage.finishWrite(decoded.grant.key);

  const completed = await as(() =>
    library.storage.completeUploadSession(asId<UploadSessionId>(target.uploadSessionId), []),
  );
  // `AV_DRIVER` is NONE here, so the gate records SKIPPED — correctly. A verdict is written the
  // way the scan worker will write one, because content that is not CLEAN cannot be attached.
  await owner.fileObject.update({
    where: { id: completed.fileObjectId },
    data: { scanStatus: ScanStatus.CLEAN, scanner: 'integration-suite', scannedAt: now },
  });
  return completed.fileObjectId;
}

async function createDocument(
  overrides: { folderId?: string; documentTypeId?: string; title?: string } = {},
) {
  const fileObjectId = await uploadClean(aPdf(unique('doc')));
  return as(() =>
    library.documents.create({
      folderId: overrides.folderId ?? rootFolderId,
      documentTypeId: overrides.documentTypeId ?? documentTypeId,
      title: overrides.title ?? unique('Procedure '),
      fileObjectId,
      filename: 'procedure.pdf',
      origin: 'UPLOAD',
      acknowledgeDuplicate: false,
    }),
  );
}

/**
 * A further revision on a document, with its reference taken the way a check-in takes one.
 *
 * The row is seeded because reaching the real check-in path needs a published document, and
 * publication needs an approval — neither of which the cascade assertions are about. What is
 * *not* seeded is the reference count: that goes through the real storage service, because the
 * count is precisely what the cascade has to move.
 */
async function addRevision(
  documentId: string,
  fileObjectId: string,
  ordinal: number,
): Promise<string> {
  const id = uuidv7(now.getTime());
  await owner.documentRevision.create({
    data: {
      id,
      tenantId: TENANT,
      documentId,
      ordinal,
      label: String(ordinal + 1),
      status: 'DRAFT',
      fileObjectId,
      filename: `procedure-${String(ordinal + 1)}.pdf`,
      createdBy: ALICE,
      updatedAt: now,
    },
  });
  await as(() => unitOfWork.run(() => library.storage.reference(asId<FileObjectId>(fileObjectId))));
  return id;
}

/**
 * Moves the clock to just past this document's own disposition date.
 *
 * Absolute dates would be brittle here for a reason worth stating: every delete in this suite
 * happens at *the current* clock, so a schedule's due date is always a month ahead of whatever the
 * previous test left behind. Reading the row and stepping past it is what makes each assertion
 * about its own schedule rather than about the order the file happens to run in.
 */
async function advanceToDue(documentId: string): Promise<void> {
  const schedule = await owner.retentionSchedule.findFirstOrThrow({
    where: { documentId, state: RetentionScheduleState.PENDING },
  });
  now = new Date(schedule.dueAt.getTime() + 86_400_000);
}

/** Approves the disposition the policy scheduled — ADR-0010's only manual step. */
async function approve(documentId: string, note = 'Reviewed and approved'): Promise<void> {
  const schedule = await owner.retentionSchedule.findFirstOrThrow({
    where: { documentId, state: RetentionScheduleState.PENDING },
  });
  await as(() => retention.retention.approveDisposition(schedule.id, note));
}

/** The trail, as an auditor reads it: every event about this document, in order. */
async function trailFor(documentId: string) {
  return owner.auditEvent.findMany({
    where: { tenantId: TENANT, subjectId: documentId },
    orderBy: { sequence: 'asc' },
    select: { action: true, outcome: true, payload: true, reason: true },
  });
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  root = await mkdtemp(join(tmpdir(), 'munaxa-retention-'));
  const appConfig = {
    env: 'test',
    database: { url: APP_URL, poolSize: 10 },
    storage: {
      driver: 'LOCAL',
      signedUrlTtlSeconds: 300,
      maxUploadBytes: 2 * 1024 * 1024 * 1024,
    },
  } as unknown as AppConfig;

  libraryConfig = appConfig;
  const prisma = sharedDatabase(appConfig, logger, APP_URL);
  unitOfWork = new PrismaUnitOfWork(prisma);

  library = realDocumentLibrary({
    clock,
    unitOfWork,
    config: appConfig,
    registry: everyTenantRegistry(APP_URL),
    storageRoot: root,
    signingSecret: SIGNING_SECRET,
    antivirus: {
      scanner: 'unconfigured',
      scan: async () => {
        if (scanGate !== null) {
          await scanGate();
        }
        return Promise.reject(new Error('AV_DRIVER is NONE'));
      },
    },
    users: {
      get: (id: string) =>
        id === ALICE
          ? Promise.resolve({ id } as never)
          : Promise.reject(Object.assign(new Error('not found'), { code: 'NOT_FOUND' })),
    },
    retentionSettings: {
      [Settings.RETENTION_RECYCLE_BIN_DAYS.key]: RECYCLE_BIN_DAYS,
      // Zero, so a blob that reached zero references is reclaimable in the same pass. The grace
      // period's *existence* is asserted separately, with the default.
      [Settings.RETENTION_BLOB_GRACE_DAYS.key]: 0,
    },
  });

  retention = realRetention({
    clock,
    unitOfWork,
    storage: library.storagePort,
    storageService: library.storage,
    disposition: realDisposition(clock, library.storage, library.writer),
    settings: {
      [Settings.RETENTION_RECYCLE_BIN_DAYS.key]: RECYCLE_BIN_DAYS,
      [Settings.RETENTION_BLOB_GRACE_DAYS.key]: 0,
    },
  });

  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `ret-${String(Date.now())}`,
      name: 'Retention Test',
      status: 'ACTIVE',
    },
  });
  await owner.user.create({
    data: {
      id: ALICE,
      tenantId: TENANT,
      email: `${ALICE}@example.test`,
      emailNormalized: `${ALICE}@example.test`,
      displayName: 'Alice Auditor',
      status: 'ACTIVE',
      updatedAt: now,
    },
  });

  const created = await as(() =>
    library.libraries.createLibrary({
      code: unique('LIB'),
      name: 'Quality',
      ownerScopeType: 'TENANT',
    }),
  );
  libraryId = created.id;
  rootFolderId = created.rootFolderId;

  const confidentiality = await as(() =>
    library.configuration.createConfidentiality({
      code: unique('C'),
      name: 'Internal',
      rank: 10,
      allowDownload: true,
      allowPrint: true,
      watermark: false,
      requireReason: false,
    }),
  );

  // A rule, because a document type names one. The purge test below writes its number the way a
  // legacy import does; the Slice 105A cases draw theirs through the real numbering service.
  const rule = await as(() =>
    library.numbering.create({
      key: unique('rule-'),
      name: 'Retention',
      separator: '-',
      segments: [
        { kind: NumberSegmentKind.LITERAL, value: 'QA' },
        { kind: NumberSegmentKind.SEQUENCE, padding: 3 },
      ],
      resetScope: ['NEVER'],
      reserveOnSubmit: false,
      strictGapless: false,
    }),
  );

  const purgePolicy = await as(() =>
    library.configuration.createRetention({
      code: unique('RP'),
      name: 'Purge one month after deletion',
      trigger: RetentionTrigger.ON_DELETE,
      periodMonths: 1,
      disposition: Disposition.PURGE,
      reviewRequired: false,
    }),
  );
  purgePolicyId = purgePolicy.id;
  numberingRuleId = rule.id;

  const archivePolicy = await as(() =>
    library.configuration.createRetention({
      code: unique('RP'),
      name: 'Archive one month after deletion',
      trigger: RetentionTrigger.ON_DELETE,
      periodMonths: 1,
      disposition: Disposition.ARCHIVE,
      reviewRequired: false,
    }),
  );

  const plainType = await as(() =>
    library.configuration.createDocumentType({
      code: unique('T'),
      name: 'Procedure',
      numberingRuleId: rule.id,
      defaultConfidentialityId: confidentiality.id,
      revisionLabelStyle: RevisionLabelStyle.NUMERIC,
      isActive: true,
      fields: [],
    }),
  );
  documentTypeId = plainType.id;

  const purging = await as(() =>
    library.configuration.createDocumentType({
      code: unique('T'),
      name: 'Purged record',
      numberingRuleId: rule.id,
      defaultConfidentialityId: confidentiality.id,
      retentionPolicyId: purgePolicy.id,
      revisionLabelStyle: RevisionLabelStyle.NUMERIC,
      isActive: true,
      fields: [],
    }),
  );
  purgingTypeId = purging.id;

  const archiving = await as(() =>
    library.configuration.createDocumentType({
      code: unique('T'),
      name: 'Archived record',
      numberingRuleId: rule.id,
      defaultConfidentialityId: confidentiality.id,
      retentionPolicyId: archivePolicy.id,
      revisionLabelStyle: RevisionLabelStyle.NUMERIC,
      isActive: true,
      fields: [],
    }),
  );
  archivingTypeId = archiving.id;
});

afterAll(async () => {
  await owner.$disconnect();
  await rm(root, { recursive: true, force: true });
});

// --- Soft delete ------------------------------------------------------------------------------

describe('soft delete', () => {
  it('refuses a delete with no stated reason', async () => {
    const document = await createDocument();
    await expect(
      as(() => library.documents.remove(document.id, document.version, '   ')),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // And nothing happened: a refused delete is not a partial one.
    const row = await owner.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(row.deletedAt).toBeNull();
  });

  it('records the reason on the row and in the trail’s own reason column', async () => {
    const document = await createDocument();
    await as(() => library.documents.remove(document.id, document.version, 'Filed in error'));

    const row = await owner.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(row.deleteReason).toBe('Filed in error');
    expect(row.deleteCascadeId).not.toBeNull();

    // `reason` rather than a payload field, which is what Phase 9's widened digest attests.
    const trail = await trailFor(document.id);
    const deleted = trail.filter((event) => event.reason === 'Filed in error');
    expect(deleted).not.toHaveLength(0);
  });

  it('takes every revision with it, and gives back every reference — not just the latest', async () => {
    const document = await createDocument();
    const first = await owner.documentRevision.findFirstOrThrow({
      where: { documentId: document.id },
    });

    // A second revision on the same document, referencing different content. Seeded rather than
    // checked in, because check-out needs a published document and publication needs an approval
    // — none of which this assertion is about. The *reference* is taken through the real storage
    // service, which is exactly what a check-in does, so the counts under test are genuine.
    const secondFile = await uploadClean(aPdf(unique('rev')));
    await addRevision(document.id, secondFile, 1);

    expect(
      (await owner.fileObject.findUniqueOrThrow({ where: { id: first.fileObjectId } })).refCount,
    ).toBe(1);
    expect((await owner.fileObject.findUniqueOrThrow({ where: { id: secondFile } })).refCount).toBe(
      1,
    );

    const current = await as(() => library.documents.get(document.id));
    await as(() => library.documents.remove(document.id, current.version, 'Both revisions'));

    for (const fileObjectId of [first.fileObjectId, secondFile]) {
      expect(
        (await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } })).refCount,
      ).toBe(0);
    }
    const revisions = await owner.documentRevision.findMany({
      where: { documentId: document.id },
    });
    expect(revisions).toHaveLength(2);
    expect(revisions.every((revision) => revision.deletedAt !== null)).toBe(true);
    // One cascade identifier across the document and both revisions — that is what makes the
    // restore exact rather than approximate.
    const row = await owner.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(new Set(revisions.map((revision) => revision.deleteCascadeId))).toEqual(
      new Set([row.deleteCascadeId]),
    );
  });

  it('is absent from every list and present in the recycle bin', async () => {
    const document = await createDocument({ title: unique('Bin candidate ') });
    await as(() => library.documents.remove(document.id, document.version, 'For the bin'));

    const live = await as(() =>
      library.documents.list({ page: 1, pageSize: 200, sortDirection: 'desc', deleted: 'live' }),
    );
    expect(live.data.map((row) => row.id)).not.toContain(document.id);

    const bin = await as(() =>
      retention.bin.list({ page: 1, pageSize: 200, sortDirection: 'desc' }),
    );
    const entry = bin.data.find((item) => item.id === document.id);
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('DOCUMENT');
    expect(entry?.deleteReason).toBe('For the bin');
    // The bin shows who, which is the second half of what makes it usable.
    expect(entry?.deletedByName).toBe('Alice Auditor');
  });

  it('leaves the relations DOCUMENT_DELETION_RULES says a delete does not reach', async () => {
    const document = await createDocument();
    await as(() => library.documents.setFavorite(document.id, true));
    await as(() => library.documents.remove(document.id, document.version, 'Untouched relations'));

    // Read from the table rather than restated: a relation added without a decision fails here.
    for (const rule of DOCUMENT_DELETION_RULES) {
      if (rule.relation === 'document_favorite') {
        expect(rule.onDelete).toBe(DeletionEffect.RETAINED);
        expect(await owner.documentFavorite.count({ where: { documentId: document.id } })).toBe(1);
      }
      if (rule.relation === 'audit_event') {
        expect(rule.onDelete).toBe(DeletionEffect.RETAINED);
        expect((await trailFor(document.id)).length).toBeGreaterThan(0);
      }
    }
  });
});

// --- Restore ---------------------------------------------------------------------------------

describe('restore', () => {
  it('returns the document’s children without returning what was deleted before it', async () => {
    const document = await createDocument();
    const first = await owner.documentRevision.findFirstOrThrow({
      where: { documentId: document.id },
    });

    // A second revision, then a *third* that is discarded on its own beforehand. The discard is
    // the "already deleted before it" case: restoring the document must not resurrect it.
    // A second revision, then discarded on its own beforehand — the "already deleted before it"
    // case. A DISCARDED revision has already given its reference back, so restoring the document
    // must bring the *row* back without re-taking the reference.
    const secondFile = await uploadClean(aPdf(unique('rev')));
    const discardedId = await addRevision(document.id, secondFile, 1);
    await as(() =>
      unitOfWork.run(() => library.storage.dereference(asId<FileObjectId>(secondFile))),
    );
    await owner.documentRevision.update({
      where: { id: discardedId },
      data: { status: 'DISCARDED' },
    });
    const discarded = await owner.documentRevision.findUniqueOrThrow({
      where: { id: discardedId },
    });
    expect((await owner.fileObject.findUniqueOrThrow({ where: { id: secondFile } })).refCount).toBe(
      0,
    );

    const beforeDelete = await as(() => library.documents.get(document.id));
    await as(() =>
      library.documents.remove(document.id, beforeDelete.version, 'Delete then restore'),
    );
    const afterDelete = await as(() => library.documents.get(document.id));
    await as(() => library.documents.restore(document.id, afterDelete.version));

    const restored = await owner.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(restored.deletedAt).toBeNull();
    expect(restored.deleteReason).toBeNull();
    expect(restored.deleteCascadeId).toBeNull();

    // The live revision is back and holds its reference again.
    expect(
      (await owner.documentRevision.findUniqueOrThrow({ where: { id: first.id } })).deletedAt,
    ).toBeNull();
    expect(
      (await owner.fileObject.findUniqueOrThrow({ where: { id: first.fileObjectId } })).refCount,
    ).toBe(1);

    // The discarded one came back as a row — it was taken by the same cascade — but its reference
    // did *not*, because a DISCARDED revision holds none. A restore that re-took it would leave
    // the blob permanently un-reclaimable.
    expect(
      (await owner.documentRevision.findUniqueOrThrow({ where: { id: discarded.id } })).status,
    ).toBe('DISCARDED');
    expect((await owner.fileObject.findUniqueOrThrow({ where: { id: secondFile } })).refCount).toBe(
      0,
    );
  });

  /**
   * The cascade is the *subtree*, not the folder — Slice 117.
   *
   * `cascadeDeleteUnderFolder`'s predicate is the folder's own path **or** anything beneath it, and
   * a cascade that took only the named folder's own documents would leave every document in a
   * subfolder live inside a deleted branch: reachable by search, absent from the recycle bin that
   * holds the branch, and restored by nothing.
   */
  it('takes the documents in a subfolder with the folder above them', async () => {
    const parent = await as(() =>
      library.libraries.createFolder({
        libraryId,
        parentId: rootFolderId,
        name: unique('Parent '),
        inheritAcl: true,
      }),
    );
    const child = await as(() =>
      library.libraries.createFolder({
        libraryId,
        parentId: parent.id,
        name: unique('Child '),
        inheritAcl: true,
      }),
    );
    const atTheTop = await createDocument({ folderId: parent.id });
    const underneath = await createDocument({ folderId: child.id });

    const parentRow = await as(() => library.libraries.getFolder(parent.id));
    await as(() => library.libraries.deleteFolder(parent.id, parentRow.version));

    const top = await owner.document.findUniqueOrThrow({ where: { id: atTheTop.id } });
    const nested = await owner.document.findUniqueOrThrow({ where: { id: underneath.id } });
    expect(nested.deletedAt).not.toBeNull();
    // One cascade over the whole subtree, so one restore returns all of it.
    expect(nested.deleteCascadeId).toBe(top.deleteCascadeId);
    expect(
      await owner.documentRevision.count({ where: { documentId: underneath.id, deletedAt: null } }),
    ).toBe(0);

    const deleted = await as(() => library.libraries.getFolder(parent.id));
    await as(() => library.libraries.restoreFolder(parent.id, deleted.version));
    expect(
      (await owner.document.findUniqueOrThrow({ where: { id: underneath.id } })).deletedAt,
    ).toBeNull();
  });

  /**
   * The same two deletes, overlapping — Slice 117.
   *
   * The test below is the sequential pair and states the invariant: *"a document deleted on its
   * own beforehand carries its own cascade identifier and stays deleted"*. The folder cascade used
   * to read the documents under the path and then stamp them, and the stamp carried no
   * `deleted_at` predicate — so a delete that committed in the interval was taken anyway. The row
   * ended up carrying the folder's cascade identifier and the individual delete's reason, the
   * folder's restore brought it back, and it came back with every revision still deleted, because
   * those were stamped with the cascade the document no longer carried.
   *
   * The park is on the individual delete's own `setDeleted`, which is upstream of the claim in
   * every build, so the ordering this asserts is the same one before and after the fix: the
   * cascade meets a row somebody else is in the middle of deleting.
   */
  it('leaves a document deleted under it out of the cascade it is claiming', async () => {
    /** A condition PostgreSQL answers: the cascade is waiting on the row being deleted under it. */
    async function untilBlockedOnADocument(): Promise<void> {
      for (;;) {
        const [row] = await owner.$queryRaw<{ waiting: bigint }[]>`
          SELECT count(*) AS waiting
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND cardinality(pg_blocking_pids(pid)) > 0
            AND query LIKE '%document%'`;
        if ((row?.waiting ?? 0n) > 0n) {
          return;
        }
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }
    }

    const folder = await as(() =>
      library.libraries.createFolder({
        libraryId,
        parentId: rootFolderId,
        name: unique('Race '),
        inheritAcl: true,
      }),
    );
    const own = await createDocument({ folderId: folder.id });
    const inside = await createDocument({ folderId: folder.id });

    const parking = new ParkingDocumentRepository(
      new RecordStamps(clock),
      realAclResolver({ clock, unitOfWork }),
    );
    parking.target = own.id;
    const racing = realDocumentLibrary({
      documentRepository: parking,
      clock,
      unitOfWork,
      config: libraryConfig,
      registry: everyTenantRegistry(APP_URL),
      storageRoot: root,
      signingSecret: SIGNING_SECRET,
      antivirus: {
        scanner: 'unconfigured',
        scan: () => Promise.reject(new Error('AV_DRIVER is NONE')),
      },
      users: { get: (id: string) => Promise.resolve({ id } as never) },
      retentionSettings: { [Settings.RETENTION_RECYCLE_BIN_DAYS.key]: RECYCLE_BIN_DAYS },
    });

    let reached: () => void = () => undefined;
    const atDelete = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let admit: () => void = () => undefined;
    parking.admit = new Promise<void>((resolve) => {
      admit = resolve;
    });
    parking.reached = reached;

    // One document deleted on its own, parked with its row taken and its transaction open.
    const individually = as(() =>
      racing.documents.remove(own.id, own.version, 'Deleted on its own'),
    );
    await atDelete;

    // The folder above both, from its own scope. Not awaited: it waits on the row above.
    const folderRow = await as(() => library.libraries.getFolder(folder.id));
    const cascading = as(() => library.libraries.deleteFolder(folder.id, folderRow.version));
    await untilBlockedOnADocument();

    admit();
    await individually;
    await cascading;

    const ownRow = await owner.document.findUniqueOrThrow({ where: { id: own.id } });
    const insideRow = await owner.document.findUniqueOrThrow({ where: { id: inside.id } });
    // Two acts, two cascades. One identifier over both would make the row say it was deleted by
    // the folder while its own reason names the other act.
    expect(ownRow.deleteCascadeId).not.toBe(insideRow.deleteCascadeId);
    expect(ownRow.deleteReason).toBe('Deleted on its own');
    expect(insideRow.deletedAt).not.toBeNull();

    const deletedFolder = await as(() => library.libraries.getFolder(folder.id));
    await as(() => library.libraries.restoreFolder(folder.id, deletedFolder.version));

    // The restore returns exactly what the folder's delete took.
    expect(
      (await owner.document.findUniqueOrThrow({ where: { id: inside.id } })).deletedAt,
    ).toBeNull();
    expect(
      await owner.documentRevision.count({ where: { documentId: inside.id, deletedAt: null } }),
    ).toBeGreaterThan(0);

    // And leaves the other one where its own delete put it — rather than bringing back a document
    // nobody restored, with no live revision behind it.
    const after = await owner.document.findUniqueOrThrow({ where: { id: own.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(
      await owner.documentRevision.count({ where: { documentId: own.id, deletedAt: null } }),
    ).toBe(0);
  });

  it('restores exactly one folder cascade, and leaves an earlier delete deleted', async () => {
    const folder = await as(() =>
      library.libraries.createFolder({
        libraryId,
        parentId: rootFolderId,
        name: unique('Cascade '),
        inheritAcl: true,
      }),
    );
    const monday = await createDocument({ folderId: folder.id });
    const tuesday = await createDocument({ folderId: folder.id });

    // Monday: one document deleted deliberately, on its own.
    await as(() => library.documents.remove(monday.id, monday.version, 'Deleted on Monday'));

    // Tuesday: the folder above both.
    const folderRow = await as(() => library.libraries.getFolder(folder.id));
    await as(() => library.libraries.deleteFolder(folder.id, folderRow.version));

    const cascaded = await owner.document.findUniqueOrThrow({ where: { id: tuesday.id } });
    expect(cascaded.deletedAt).not.toBeNull();
    // The folder delete reaching the documents inside it is what Phase 2 did not do: before this
    // phase they stayed live in a deleted folder, reachable by search and by nothing else.
    expect(cascaded.deleteCascadeId).not.toBe(
      (await owner.document.findUniqueOrThrow({ where: { id: monday.id } })).deleteCascadeId,
    );

    const deletedFolder = await as(() => library.libraries.getFolder(folder.id));
    await as(() => library.libraries.restoreFolder(folder.id, deletedFolder.version));

    expect(
      (await owner.document.findUniqueOrThrow({ where: { id: tuesday.id } })).deletedAt,
    ).toBeNull();
    // Monday's stays deleted. Restoring "everything currently deleted underneath" would have
    // resurrected it, which is the whole reason the cascade is identified rather than inferred.
    expect(
      (await owner.document.findUniqueOrThrow({ where: { id: monday.id } })).deletedAt,
    ).not.toBeNull();
  });
});

// --- Schedules -------------------------------------------------------------------------------

describe('the retention schedule', () => {
  it('gives an unnumbered draft the recycle-bin window and no policy', async () => {
    const document = await createDocument();
    await as(() =>
      library.documents.remove(document.id, document.version, 'Draft, never numbered'),
    );

    const schedule = await owner.retentionSchedule.findFirstOrThrow({
      where: { documentId: document.id },
    });
    expect(schedule.policyId).toBeNull();
    expect(schedule.disposition).toBe(Disposition.PURGE);
    expect(schedule.reviewRequired).toBe(false);
    expect(schedule.dueAt.getTime()).toBe(now.getTime() + RECYCLE_BIN_DAYS * 86_400_000);
  });

  it('uses the policy the document froze, and forces review before a purge', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Under policy'));

    const schedule = await owner.retentionSchedule.findFirstOrThrow({
      where: { documentId: document.id },
    });
    expect(schedule.policyId).toBe(purgePolicyId);
    // The policy said `reviewRequired: false`; ADR-0010 makes review required for the
    // irreversible disposition whatever the policy ticked.
    expect(schedule.reviewRequired).toBe(true);
    expect(schedule.dueAt.toISOString()).toBe('2026-09-20T09:00:00.000Z');
  });

  it('withdraws the delete’s schedule on a restore, and says so in the trail', async () => {
    const document = await createDocument();
    await as(() => library.documents.remove(document.id, document.version, 'Then restored'));
    const deleted = await as(() => library.documents.get(document.id));
    await as(() => library.documents.restore(document.id, deleted.version));

    const schedule = await owner.retentionSchedule.findFirstOrThrow({
      where: { documentId: document.id },
    });
    expect(schedule.state).toBe(RetentionScheduleState.CANCELLED);

    const trail = await trailFor(document.id);
    expect(trail.filter((event) => event.action === 'SCHEDULE_SET').length).toBeGreaterThanOrEqual(
      2,
    );
  });
});

// --- The purge -------------------------------------------------------------------------------

describe('the purge', () => {
  it('removes the row and leaves the audit trail intact, with the number still in it', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });
    const revision = await owner.documentRevision.findFirstOrThrow({
      where: { documentId: document.id },
    });
    // A number, assigned the way an import does, so the trail has one to preserve.
    await owner.document.update({
      where: { id: document.id },
      data: { documentNumber: unique('QA-PURGE-'), numberedAt: now },
    });
    const numbered = await owner.document.findUniqueOrThrow({ where: { id: document.id } });

    await as(() => library.documents.remove(document.id, numbered.version, 'Due for disposition'));

    // The policy's month has passed, and the disposition is approved by a person — ADR-0010's
    // only manual step.
    await advanceToDue(document.id);
    await approve(document.id);

    // At least one, because a sweep settles everything the tenant has due rather than one
    // document — which is what a nightly pass is. The assertions below are about *this* one.
    const outcome = await asSystem(() => retention.retention.executeDue(100));
    expect(outcome.purged).toBeGreaterThanOrEqual(1);

    // The row is gone.
    expect(await owner.document.findUnique({ where: { id: document.id } })).toBeNull();
    expect(await owner.documentRevision.findUnique({ where: { id: revision.id } })).toBeNull();

    // The trail is not, and it is still meaningful: the number is in it. This is the assertion the
    // whole phase turns on — proving the trail *survives*, not merely that nothing threw.
    const trail = await trailFor(document.id);
    expect(trail.length).toBeGreaterThan(0);
    const purged = trail.find((event) => event.action === 'PURGED');
    expect(purged).toBeDefined();
    expect(
      (purged?.payload as { before?: { documentNumber?: string } }).before?.documentNumber,
    ).toBe(numbered.documentNumber);
    const executed = trail.find((event) => event.action === 'PURGE_EXECUTED');
    expect(executed).toBeDefined();

    // And the tombstone holds the number where the purge cannot reach — which is what makes the
    // *older* events, written before this phase with no number in their payloads, still legible.
    const tombstone = await owner.documentTombstone.findUniqueOrThrow({
      where: { documentId: document.id },
    });
    expect(tombstone.documentNumber).toBe(numbered.documentNumber);
    expect(tombstone.approvedById).toBe(ALICE);
    expect(tombstone.revisionsRemoved).toBe(1);

    // The number is never re-issued: the reservation outlives the document, pointing at nothing.
    const reservations = await owner.numberReservation.findMany({
      where: { tenantId: TENANT, documentId: document.id },
    });
    expect(reservations).toHaveLength(0);
  });

  it('cannot remove the trail even if it tried: the table refuses the owner', async () => {
    const document = await createDocument();
    await as(() => library.documents.remove(document.id, document.version, 'Refusal check'));

    // Not through the purge — directly, as the owner role, which is the strongest statement
    // available: the refusal that makes `PURGED` unable to purge its own evidence is the
    // database's, not the application's.
    await expect(
      owner.$executeRaw`DELETE FROM audit_event WHERE subject_id = ${document.id}::uuid`,
    ).rejects.toThrow(/append-only/i);
  });

  it('reclaims a blob that reached zero, and the bytes really leave the disk', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });
    const revision = await owner.documentRevision.findFirstOrThrow({
      where: { documentId: document.id },
    });
    const blob = await owner.fileObject.findUniqueOrThrow({
      where: { id: revision.fileObjectId },
    });
    expect(await library.localStorage.head(scopedPath(blob.storageKey))).not.toBeNull();

    await as(() => library.documents.remove(document.id, document.version, 'Reclaim the bytes'));
    // The delete gave the reference back; the bytes stay, because a restore must find them.
    expect((await owner.fileObject.findUniqueOrThrow({ where: { id: blob.id } })).refCount).toBe(0);
    expect(await library.localStorage.head(scopedPath(blob.storageKey))).not.toBeNull();

    await advanceToDue(document.id);
    await approve(document.id);
    await asSystem(() => retention.retention.executeDue(100));

    // Now the sweep has purged the document *and* reclaimed the blob: soft-deleted in the
    // database and absent from the store.
    const reclaimed = await owner.fileObject.findUniqueOrThrow({ where: { id: blob.id } });
    expect(reclaimed.deletedAt).not.toBeNull();
    expect(await library.localStorage.head(scopedPath(blob.storageKey))).toBeNull();
  });

  it('is idempotent under redelivery: a second sweep destroys nothing', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Redelivery'));

    await advanceToDue(document.id);
    await approve(document.id);

    const first = await asSystem(() => retention.retention.executeDue(100));
    expect(first.purged).toBeGreaterThanOrEqual(1);
    const trailAfterFirst = (await trailFor(document.id)).length;

    // The same nightly job, delivered twice. `retention.run` is concurrency 1, but at-least-once
    // delivery still means this happens.
    const second = await asSystem(() => retention.retention.executeDue(100));
    expect(second.purged).toBe(0);
    // And no second tombstone, no second pair of audit rows for a destruction that happened once.
    expect(await trailFor(document.id)).toHaveLength(trailAfterFirst);
    expect(await owner.documentTombstone.count({ where: { documentId: document.id } })).toBe(1);
  });

  it('archives rather than destroys when the policy says so', async () => {
    const document = await createDocument({ documentTypeId: archivingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Archive me'));

    await advanceToDue(document.id);
    const outcome = await asSystem(() => retention.retention.executeDue(100));
    expect(outcome.archived).toBeGreaterThanOrEqual(1);

    const row = await owner.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(row.status).toBe('ARCHIVED');
    // Still there, and still deleted. `ARCHIVE` is the non-destructive disposition: it decides
    // what happens to the record, not whether somebody's delete was right — un-deleting as a side
    // effect of a retention period would put a document back that nobody asked to restore.
    expect(row.deletedAt).not.toBeNull();
    const schedule = await owner.retentionSchedule.findFirstOrThrow({
      where: { documentId: document.id },
    });
    expect(schedule.state).toBe(RetentionScheduleState.EXECUTED);
  });
});

// --- Legal hold ------------------------------------------------------------------------------

describe('the legal hold', () => {
  it('refuses a delete that would otherwise succeed', async () => {
    const document = await createDocument();
    await as(() => retention.holds.place(document.id, 'Matter 2026-114'));

    await expect(
      as(() => library.documents.remove(document.id, document.version, 'Should be refused')),
    ).rejects.toMatchObject({ code: 'LEGAL_HOLD' });

    // Nothing moved. A refusal that half-deleted would be worse than no refusal at all.
    expect(
      (await owner.document.findUniqueOrThrow({ where: { id: document.id } })).deletedAt,
    ).toBeNull();
  });

  it('refuses a purge that would otherwise proceed, and suspends the schedule rather than skipping it', async () => {
    const held = await createDocument({ documentTypeId: purgingTypeId });
    const unheld = await createDocument({ documentTypeId: purgingTypeId });
    await as(() => library.documents.remove(held.id, held.version, 'Held later'));
    await as(() => library.documents.remove(unheld.id, unheld.version, 'Not held'));

    // The hold arrives *after* the delete — the ordinary shape of a matter that starts once
    // somebody notices the record is gone.
    const hold = await as(() => retention.holds.place(held.id, 'Matter 2026-115'));

    await advanceToDue(unheld.id);
    // Only the unheld one can be approved: the held one's schedule is already `SUSPENDED`, and
    // approving a disposition that cannot run would produce a queue of approvals the sweep
    // refuses.
    await approve(unheld.id);

    const outcome = await asSystem(() => retention.retention.executeDue(100));

    // The held one survives; the unheld one beside it does not. Both were due, both were
    // approved — the hold is the only difference.
    expect(await owner.document.findUnique({ where: { id: held.id } })).not.toBeNull();
    expect(await owner.document.findUnique({ where: { id: unheld.id } })).toBeNull();
    expect(outcome.purged).toBeGreaterThanOrEqual(1);

    // Suspended rather than skipped: a skipped schedule would be refused again every night and
    // the queue would show it as due for years.
    const suspended = await owner.retentionSchedule.findFirstOrThrow({
      where: { documentId: held.id },
    });
    expect(suspended.state).toBe(RetentionScheduleState.SUSPENDED);

    // Releasing the last hold resumes it — at PENDING, so the disposition is re-confirmed rather
    // than executed on an approval given before the matter began.
    await as(() => retention.holds.release(hold.id, 'Matter closed'));
    const resumed = await owner.retentionSchedule.findFirstOrThrow({
      where: { documentId: held.id },
    });
    expect(resumed.state).toBe(RetentionScheduleState.PENDING);
    expect(resumed.reviewedById).toBeNull();
  });

  it('resumes only when the last of several holds is released', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Two matters'));

    const first = await as(() => retention.holds.place(document.id, 'Matter A'));
    const second = await as(() => retention.holds.place(document.id, 'Matter B'));

    await as(() => retention.holds.release(first.id, 'A closed'));
    expect(
      (await owner.retentionSchedule.findFirstOrThrow({ where: { documentId: document.id } }))
        .state,
    ).toBe(RetentionScheduleState.SUSPENDED);

    await as(() => retention.holds.release(second.id, 'B closed'));
    expect(
      (await owner.retentionSchedule.findFirstOrThrow({ where: { documentId: document.id } }))
        .state,
    ).toBe(RetentionScheduleState.PENDING);
  });

  it('refuses a hold with no stated matter, at the database as well as the use case', async () => {
    const document = await createDocument();
    await expect(as(() => retention.holds.place(document.id, '  '))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      owner.$executeRaw`
        INSERT INTO legal_hold (id, tenant_id, document_id, reason, placed_by_id, placed_at, updated_at)
        VALUES (gen_random_uuid(), ${TENANT}::uuid, ${document.id}::uuid, '   ', ${ALICE}::uuid, now(), now())
      `,
    ).rejects.toThrow(/ck_legal_hold_reason/);
  });
});

// --- The upload sweep -------------------------------------------------------------------------

describe('the upload-session sweep', () => {
  it('expires an abandoned session and removes its partial object', async () => {
    const content = aPdf(unique('abandoned'));
    const target = await as(() =>
      library.storage.createUploadSession({
        filename: 'abandoned.pdf',
        mimeType: 'application/pdf',
        sizeBytes: content.length,
        magicBytes: MAGIC,
      }),
    );
    const decoded = decodeTransferToken(
      SIGNING_SECRET,
      new URL(target.url).searchParams.get('token') ?? '',
      'PUT',
      now,
    );
    if (!('grant' in decoded)) {
      throw new Error('The upload target did not carry a usable transfer capability.');
    }
    await library.localStorage.beginWrite(decoded.grant.key);
    await writeFile(library.localStorage.partialPathFor(decoded.grant.key), content);
    await library.localStorage.finishWrite(decoded.grant.key);
    expect(await library.localStorage.head(decoded.grant.key)).not.toBeNull();

    // Past the session's expiry — `storage.sweep-upload-sessions` runs every fifteen minutes and
    // has had no consumer since Phase 0.5 declared it.
    now = new Date(now.getTime() + 86_400_000);
    const expired = await asSystem(() => retention.retention.expireUploadSessions());
    expect(expired).toBeGreaterThanOrEqual(1);

    const session = await owner.uploadSession.findUniqueOrThrow({
      where: { id: target.uploadSessionId },
    });
    expect(session.state).toBe('EXPIRED');
    expect(await library.localStorage.head(decoded.grant.key)).toBeNull();
  });
});

/**
 * Slice 44 — a completion that the reaper finished underneath it.
 *
 * `UploadSessionRepository.settle` carries `state: OPEN` in its predicate, which is what makes it a
 * claim rather than an assignment, and its port says why the answer matters: *"completion is the
 * step that creates a blob and bumps a reference count, and a client retrying a request whose
 * response it never saw must not do either of those twice."*
 *
 * `completeUploadSession` reads the session's state once, at the top, and then does the whole
 * promotion — `completeUpload`, the size and digest checks, the copy to the content key, the scan,
 * the `file_object` insert — before settling. Slice 43 called ignoring the answer harmless because
 * of that opening check. It is not: the check runs *before* the work, and the row can move
 * underneath it. `storage.sweep-upload-sessions` runs every fifteen minutes and expires anything
 * still `OPEN` past its deadline, which is exactly a session whose completion is in flight.
 *
 * Observed before it was fixed: the reaper stamped `EXPIRED`, the completion went on to commit a
 * durable `file_object` and answered the caller with its identifier, and the session row was left
 * saying `EXPIRED` with `file_object_id` null — a blob the caller can attach to a document, and a
 * record denying the upload ever finished.
 *
 * The interleaving is forced at the antivirus port rather than by hoping two promises land in the
 * right order: the scan is the real seam between the digest read and the insert, and holding it is
 * what a slow scanner does anyway.
 */
describe('a completion the reaper finished underneath it', () => {
  async function staged(marker: string): Promise<UploadSessionId> {
    const content = Buffer.from(`%PDF-1.7\n% ${marker}\n1 0 obj\n<<>>\nendobj\n`);
    const target = await as(() =>
      library.storage.createUploadSession({
        filename: `${marker}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: content.length,
        magicBytes: MAGIC,
      }),
    );
    const decoded = decodeTransferToken(
      SIGNING_SECRET,
      new URL(target.url).searchParams.get('token') ?? '',
      'PUT',
      now,
    );
    if (!('grant' in decoded)) {
      throw new Error('The upload target did not carry a usable transfer capability.');
    }
    await library.localStorage.beginWrite(decoded.grant.key);
    await writeFile(library.localStorage.partialPathFor(decoded.grant.key), content);
    await library.localStorage.finishWrite(decoded.grant.key);
    return asId<UploadSessionId>(target.uploadSessionId);
  }

  it('completes normally when nothing takes the session away', async () => {
    // The positive control. Without it the case below could pass because completion refuses
    // everything, and the assertion about the blob would hold for the wrong reason.
    const sessionId = await staged(`quiet-${String(Date.now())}`);
    const completed = await as(() => library.storage.completeUploadSession(sessionId, []));

    const row = await owner.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.state).toBe('COMPLETED');
    expect(row.fileObjectId).toBe(completed.fileObjectId);
  }, 60_000);

  it('refuses, and leaves no blob behind, when the reaper expired it mid-flight', async () => {
    const sessionId = await staged(`reaped-${String(Date.now())}`);
    const before = await owner.fileObject.count({ where: { tenantId: TENANT } });

    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    scanGate = async () => {
      arrived();
      await gate;
    };

    const completing = as(() => library.storage.completeUploadSession(sessionId, []));
    await reached;
    // Released for everything else the suite does; only this completion is held.
    scanGate = null;

    now = new Date(now.getTime() + 86_400_000);
    expect(await asSystem(() => retention.retention.expireUploadSessions())).toBeGreaterThanOrEqual(
      1,
    );
    release();

    // The session is gone from under it, so the answer is the one the method already gives for a
    // session it cannot claim — and the same one `abandonUploadSession` gives.
    await expect(completing).rejects.toThrow(/already been finished/);

    const row = await owner.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.state).toBe('EXPIRED');
    expect(row.fileObjectId).toBeNull();

    // The refusal rolled the whole promotion back. Without it the caller holds the identifier of a
    // durable blob whose own session says it never finished.
    expect(await owner.fileObject.count({ where: { tenantId: TENANT } })).toBe(before);
  }, 60_000);
});

/**
 * Slice 45 — the reaper only expires what is still open.
 *
 * `expireUploadSessions` selects `state: OPEN, expiresAt < now`, deletes each staged object, and
 * then stamps the rows it selected. That final `updateMany` carried only `id IN (…)` and the
 * tenant, so it was an assignment rather than a claim — and the two statements are separated by
 * the object-store deletes, which are not database work and hold no lock. The select takes no
 * `FOR UPDATE`; under `READ COMMITTED` an `UPDATE` re-checks its `WHERE` against the *updated* row
 * after waiting on a concurrent writer, and neither `id` nor `tenant_id` changes when a session is
 * completed or abandoned. So a session that reached a terminal state during the sweep was stamped
 * `EXPIRED` over it, and counted as expired.
 *
 * `UploadSessionRepository.settle` has expressed the right shape since Phase 3: claim by predicate,
 * then read the affected-row count as the truth. This is that shape applied to the sweep.
 *
 * The interleaving is forced at the storage port — the reaper's own seam between selecting and
 * stamping — rather than by hoping two promises land in the right order. Each competing mutation
 * runs from the test's own scope, because `PrismaUnitOfWork.run` joins an ambient transaction and a
 * completion invoked from inside the reaper's hook would silently become part of the reaper's own.
 */
describe('the reaper only expires what is still open', () => {
  async function staged(marker: string): Promise<UploadSessionId> {
    const content = Buffer.from(`%PDF-1.7\n% ${marker}\n1 0 obj\n<<>>\nendobj\n`);
    const target = await as(() =>
      library.storage.createUploadSession({
        filename: `${marker}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: content.length,
        magicBytes: MAGIC,
      }),
    );
    const decoded = decodeTransferToken(
      SIGNING_SECRET,
      new URL(target.url).searchParams.get('token') ?? '',
      'PUT',
      now,
    );
    if (!('grant' in decoded)) {
      throw new Error('The upload target did not carry a usable transfer capability.');
    }
    await library.localStorage.beginWrite(decoded.grant.key);
    await writeFile(library.localStorage.partialPathFor(decoded.grant.key), content);
    await library.localStorage.finishWrite(decoded.grant.key);
    return asId<UploadSessionId>(target.uploadSessionId);
  }

  /** A reaper that stops at its first object delete — after the select, before the stamp. */
  function heldReaper() {
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let held = false;
    const port = new Proxy(library.storagePort, {
      get(target, prop, receiver) {
        if (prop === 'delete') {
          return async (key: string) => {
            if (!held) {
              held = true;
              arrived();
              await gate;
            }
            return (target as { delete: (k: string) => Promise<void> }).delete(key);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        // Bound through a stated signature: `Function.bind` answers `any`, and every other member
        // of the port has to keep working for the reaper to reach its stamp at all.
        return typeof value === 'function'
          ? (value as (...args: readonly unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const racing = realRetention({
      clock,
      unitOfWork,
      storage: port,
      storageService: library.storage,
      disposition: realDisposition(clock, library.storage, library.writer),
      settings: {
        [Settings.RETENTION_RECYCLE_BIN_DAYS.key]: RECYCLE_BIN_DAYS,
        [Settings.RETENTION_BLOB_GRACE_DAYS.key]: 0,
      },
    });
    return { racing, reached, release };
  }

  const stateOf = async (id: UploadSessionId): Promise<string> =>
    (await owner.uploadSession.findUniqueOrThrow({ where: { id } })).state;

  it('expires a session nobody finished', async () => {
    // The positive control, and it is mandatory: a predicate that filtered the whole batch out
    // would satisfy every case below and expire nothing at all.
    const sessionId = await staged(`quiet-${String(Date.now())}`);
    now = new Date(now.getTime() + 86_400_000);

    expect(await asSystem(() => retention.retention.expireUploadSessions())).toBeGreaterThanOrEqual(
      1,
    );
    expect(await stateOf(sessionId)).toBe('EXPIRED');
  }, 60_000);

  it('leaves a session that was completed under it alone', async () => {
    const sessionId = await staged(`completed-${String(Date.now())}`);
    now = new Date(now.getTime() + 86_400_000);

    const { racing, reached, release } = heldReaper();
    const reaping = asSystem(() => racing.retention.expireUploadSessions());
    await reached;

    // Committed on its own connection while the reaper holds its transaction open. The select took
    // no lock, so this does not wait for it.
    const completed = await as(() => library.storage.completeUploadSession(sessionId, []));
    expect(await stateOf(sessionId)).toBe('COMPLETED');

    release();
    // The count is the assertion, not just the state: it is the affected-row result of the stamp,
    // so zero is the claim failing rather than the row happening to look right.
    expect(await reaping).toBe(0);
    expect(await stateOf(sessionId)).toBe('COMPLETED');

    const row = await owner.uploadSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.fileObjectId).toBe(completed.fileObjectId);
  }, 60_000);

  it('leaves a session that was abandoned under it alone', async () => {
    const sessionId = await staged(`abandoned-${String(Date.now())}`);
    now = new Date(now.getTime() + 86_400_000);

    const { racing, reached, release } = heldReaper();
    const reaping = asSystem(() => racing.retention.expireUploadSessions());
    await reached;

    await as(() => library.storage.abandonUploadSession(sessionId));
    expect(await stateOf(sessionId)).toBe('ABORTED');

    release();
    expect(await reaping).toBe(0);
    expect(await stateOf(sessionId)).toBe('ABORTED');
  }, 60_000);

  it('expires only the open one when a batch holds all three', async () => {
    // The case a fix that assumed "every selected id is still open" would pass, and a fix that
    // dropped the whole batch on one terminal row would fail.
    const stamp = String(Date.now());
    const stillOpen = await staged(`batch-open-${stamp}`);
    const willComplete = await staged(`batch-complete-${stamp}`);
    const willAbandon = await staged(`batch-abandon-${stamp}`);
    now = new Date(now.getTime() + 86_400_000);

    const { racing, reached, release } = heldReaper();
    const reaping = asSystem(() => racing.retention.expireUploadSessions());
    await reached;

    await as(() => library.storage.completeUploadSession(willComplete, []));
    await as(() => library.storage.abandonUploadSession(willAbandon));

    release();
    expect(await reaping).toBe(1);
    expect(await stateOf(stillOpen)).toBe('EXPIRED');
    expect(await stateOf(willComplete)).toBe('COMPLETED');
    expect(await stateOf(willAbandon)).toBe('ABORTED');
  }, 60_000);
});

// --- The rolling integrity verifier -----------------------------------------------------------

/**
 * Phase 18. `17-security-architecture.md` §8 has promised a rolling verifier since Phase 0 and
 * `13-audit-architecture.md` §2 has carried `INTEGRITY_MISMATCH` with nothing writing it.
 *
 * Only a real store can be asked these questions, because the whole point is what happens when the
 * bytes on disk stop being the bytes that were uploaded — which is not a state any in-memory
 * double can enter without being told to.
 */
describe('the integrity sweep', () => {
  /** A document's stored blob, through the revision that references it. */
  async function blobOf(documentId: string) {
    const revision = await owner.documentRevision.findFirstOrThrow({ where: { documentId } });
    return owner.fileObject.findUniqueOrThrow({ where: { id: revision.fileObjectId } });
  }

  it('verifies a blob whose bytes are still what was recorded', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });

    const pass = await asSystem(() => retention.retention.verifyStoredIntegrity());

    expect(pass.checked).toBeGreaterThanOrEqual(1);
    expect(pass.verified).toBeGreaterThanOrEqual(1);
    expect(pass.mismatched).toBe(0);
    const file = await blobOf(document.id);
    expect(file.integrityStatus).toBe('VERIFIED');
    expect(file.integrityCheckedAt).not.toBeNull();
  });

  it('writes no audit row for a blob that verified', async () => {
    // One chained, retention-governed row per blob per pass to say that nothing happened would be
    // millions of them — 13 §2's argument against auditing favourites, at a far larger scale.
    const before = await owner.auditEvent.count({
      where: { tenantId: TENANT, action: 'INTEGRITY_MISMATCH' },
    });

    await asSystem(() => retention.retention.verifyStoredIntegrity());

    expect(
      await owner.auditEvent.count({
        where: { tenantId: TENANT, action: 'INTEGRITY_MISMATCH' },
      }),
    ).toBe(before);
  });

  it('quarantines a blob whose bytes changed under it, and says so in the trail', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });
    const stored = await blobOf(document.id);

    // The corruption. Written underneath the application, which is exactly the incident this
    // sweep exists to detect: a storage fault, a restore of the wrong object, or somebody with
    // access to the bucket and not to the database.
    const path = scopedPath(stored.storageKey);
    await library.localStorage.beginWrite(path);
    await writeFile(library.localStorage.partialPathFor(path), aPdf(unique('substituted')));
    await library.localStorage.finishWrite(path);

    const pass = await asSystem(() => retention.retention.verifyStoredIntegrity());

    expect(pass.mismatched).toBeGreaterThanOrEqual(1);
    expect((await blobOf(document.id)).integrityStatus).toBe('MISMATCH');

    // The evidence: an audit row whose outcome is a failure, carrying both digests.
    const row = await owner.auditEvent.findFirstOrThrow({
      where: { tenantId: TENANT, action: 'INTEGRITY_MISMATCH', subjectId: stored.id },
      orderBy: { sequence: 'desc' },
    });
    expect(row.outcome).toBe('FAILED');
    const payload = row.payload as { after?: { expectedSha256?: string; actualSha256?: string } };
    expect(payload.after?.expectedSha256).toBe(stored.checksumSha256);
    expect(payload.after?.actualSha256).not.toBe(stored.checksumSha256);
  });

  it('makes the quarantined blob unreachable, exactly as an infected one is', async () => {
    // The half of 17 §8's sentence that is not the detection: "mismatch quarantines". A document
    // whose bytes we cannot vouch for must not be served, and the gate is the same one the
    // antivirus verdict passes through.
    const mismatched = await owner.fileObject.findFirstOrThrow({
      where: { tenantId: TENANT, integrityStatus: 'MISMATCH' },
      select: { id: true },
    });

    // Through the unit of work, because `isReachable` reads a row and every repository in this
    // product joins the ambient transaction rather than opening one.
    const reachable = await asSystem(() =>
      unitOfWork.run(() => library.storage.isReachable(asId(mismatched.id))),
    );

    expect(reachable).toBe(false);
  });
});

// --- The deletion table ------------------------------------------------------------------------

describe('DOCUMENT_DELETION_RULES', () => {
  it('describes what a purge actually leaves behind', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });
    await as(() => library.documents.setFavorite(document.id, true));
    await as(() => library.documents.remove(document.id, document.version, 'Table check'));

    await advanceToDue(document.id);
    await approve(document.id);
    await asSystem(() => retention.retention.executeDue(100));

    const documentId = asId<DocumentId>(document.id);
    const counts: Record<string, number> = {
      document: await owner.document.count({ where: { id: documentId } }),
      document_revision: await owner.documentRevision.count({ where: { documentId } }),
      document_metadata_value: await owner.documentMetadataValue.count({ where: { documentId } }),
      document_favorite: await owner.documentFavorite.count({ where: { documentId } }),
      document_view: await owner.documentView.count({ where: { documentId } }),
      document_lock: await owner.documentLock.count({ where: { documentId } }),
      workflow_instance: await owner.workflowInstance.count({ where: { documentId } }),
      retention_schedule: await owner.retentionSchedule.count({ where: { documentId } }),
      legal_hold: await owner.legalHold.count({ where: { documentId } }),
      audit_event: (await trailFor(document.id)).length,
    };

    for (const rule of DOCUMENT_DELETION_RULES) {
      const count = counts[rule.relation];
      if (count === undefined) {
        continue;
      }
      if (rule.onPurge === DeletionEffect.REMOVED_ON_PURGE) {
        expect(`${rule.relation}=${String(count)}`).toBe(`${rule.relation}=0`);
      } else {
        expect(count).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * A legal hold placed while the sweep is settling one — Slice 55.
 *
 * `settle` reads the live holds in its own transaction and then dispatches; `archive` opens a
 * second transaction and archives. A hold placed between the two is committed before the archive
 * runs and invisible to it, because — unlike `purge`, which re-reads the holds inside the
 * transaction that would destroy — `archive` asks nobody. `RetentionDispositionAdapter.archive`
 * consults the document's lifecycle and nothing else.
 *
 * `SUSPENDED` is one of `LIVE_STATES`, so the disposition's own `moveState` then writes `EXECUTED`
 * over the suspension the hold had just written, and the release that would resume the schedule
 * finds nothing suspended to resume.
 */
describe('a legal hold that arrives while the sweep is deciding', () => {
  /**
   * The real repository, subclassed: every statement is the production one, and the override adds
   * a place to stand at the moment the sweep's belief about the holds is formed.
   *
   * The park is *after* the query, holding its answer. That is the whole point: the sweep must go
   * on to decide from what it read before the matter opened, which is what a decision taken in one
   * transaction and acted on in the next always does. Parking before the query would let the
   * re-read see the hold and there would be no race left to examine.
   *
   * Only the first call is parked — the sweep's own, in `settle`. The second, inside the archiving
   * transaction, is the one under test and must run freely.
   */
  class ParkingHolds extends PrismaLegalHoldRepository {
    reached: (() => void) | null = null;
    admit: Promise<void> | null = null;
    /**
     * Whose decision to park on.
     *
     * The sweep settles every schedule the tenant has due, and this file leaves plenty behind, so
     * parking "the first caller" parks whichever document happened to sort first. The park belongs
     * to one document by name or it is not the interleaving under examination at all — which is
     * how the first version of this test came to pass against the unfixed sweep.
     */
    target: string | null = null;

    override async listLiveFor(documentId: DocumentId): Promise<readonly LegalHoldRecord[]> {
      const live = await super.listLiveFor(documentId);
      const gate = this.admit;
      if (gate !== null && String(documentId) === this.target) {
        this.admit = null;
        this.reached?.();
        await gate;
      }
      return live;
    }
  }

  async function scheduleOf(documentId: string): Promise<{ state: string }> {
    return owner.retentionSchedule.findFirstOrThrow({ where: { documentId } });
  }

  async function statusOf(documentId: string): Promise<string> {
    return (await owner.document.findUniqueOrThrow({ where: { id: documentId } })).status;
  }

  it('archives when nothing holds the record', async () => {
    // The control. Without it every assertion below passes on a sweep that archives nothing.
    const document = await createDocument({ documentTypeId: archivingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Archive me'));
    await advanceToDue(document.id);

    expect(
      (await asSystem(() => retention.retention.executeDue(100))).archived,
    ).toBeGreaterThanOrEqual(1);
    expect(await statusOf(document.id)).toBe('ARCHIVED');
    expect((await scheduleOf(document.id)).state).toBe(RetentionScheduleState.EXECUTED);
  });

  it('refuses to archive when the hold was placed before the sweep began', async () => {
    // The serial answer the concurrent one has to match: the sweep's own hold read sees it.
    const document = await createDocument({ documentTypeId: archivingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Held before'));
    await as(() => retention.holds.place(document.id, 'Matter 2026-201'));

    await asSystem(() => retention.retention.executeDue(100));

    expect(await statusOf(document.id)).not.toBe('ARCHIVED');
    expect((await scheduleOf(document.id)).state).toBe(RetentionScheduleState.SUSPENDED);
  });

  /**
   * The same read, one statement later — Slice 115.
   *
   * The test above parks the sweep's *first* hold read and lets the matter open before the
   * disposition's own transaction begins, so the second read sees it and stands down. Nothing
   * covered the interleaving one statement further on: the disposition's second read runs, answers
   * "nothing holds this", and only then does the matter commit — into a transaction that holds
   * none of the rows its answer depends on.
   *
   * What followed was the worst outcome this module has. `deleteForDocument` carries no state
   * predicate, so the `SUSPENDED` the placement had just written was deleted rather than noticed;
   * `holds.deleteForDocument` removes every hold the document has rather than the ones the
   * transaction saw, so the live hold went with it; and the record was destroyed. A matter was
   * open, a hold was accepted, and afterwards there was no record, no hold and nothing in the
   * trail to say either had existed.
   *
   * The invariant is stated as the implication rather than as "the record survives", because both
   * orderings are legitimate: a placement that loses the race outright never happens, and a record
   * destroyed before any hold was accepted was destroyed correctly. What may never happen is a
   * hold that is *accepted* and then destroyed with the record it was placed to preserve.
   */
  class ParkingHoldRead extends PrismaLegalHoldRepository {
    reached: (() => void) | null = null;
    admit: Promise<void> | null = null;
    target: string | null = null;
    /** Reads of the target so far. The first is `settle`'s; the second is the disposition's. */
    seen = 0;

    override async listLiveFor(documentId: DocumentId): Promise<readonly LegalHoldRecord[]> {
      const live = await super.listLiveFor(documentId);
      if (String(documentId) !== this.target) {
        return live;
      }
      this.seen += 1;
      const gate = this.admit;
      if (this.seen === 2 && gate !== null) {
        this.admit = null;
        this.reached?.();
        await gate;
      }
      return live;
    }
  }

  /** Parks on the hold row's own insert, which in a fixed build is under the schedules' lock. */
  class ParkingPlacement extends PrismaLegalHoldRepository {
    reached: (() => void) | null = null;
    admit: Promise<void> | null = null;
    target: string | null = null;

    override async place(input: Parameters<PrismaLegalHoldRepository['place']>[0]): Promise<void> {
      const gate = this.admit;
      if (gate !== null && input.documentId === this.target) {
        this.admit = null;
        this.reached?.();
        await gate;
      }
      await super.place(input);
    }
  }

  /**
   * Waits until PostgreSQL says somebody is waiting on somebody else over `retention_schedule`.
   *
   * A condition the database answers rather than a delay. Raced against a promise that settles
   * when the other side has finished instead, so an unfixed build — where nothing blocks at all —
   * reaches its assertions rather than hanging on a wait that can never end.
   */
  async function blockedOnASchedule(): Promise<boolean> {
    const [row] = await owner.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND cardinality(pg_blocking_pids(pid)) > 0
        AND query LIKE '%retention_schedule%'`;
    return (row?.waiting ?? 0n) > 0n;
  }

  async function untilBlockedOr(settled: Promise<unknown>): Promise<boolean> {
    let done = false;
    void settled.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    for (;;) {
      if (await blockedOnASchedule()) {
        return true;
      }
      if (done) {
        return false;
      }
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  /**
   * Settles everything else this file has left due, so the sweep under test reaches its own
   * document quickly. `listDue` orders by `dueAt`, and the document created here is the newest, so
   * without this it would be settled last — behind however many schedules the file has
   * accumulated, while a transaction is parked.
   */
  async function drainOtherDue(): Promise<void> {
    await asSystem(() => retention.retention.executeDue(500));
  }

  it('never destroys a hold it accepted, whichever of the two arrives first', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Held mid-purge'));
    await advanceToDue(document.id);
    // Before the approval, so this document's own schedule is raised for review and left
    // `PENDING` rather than settled.
    await drainOtherDue();
    await approve(document.id);

    const parking = new ParkingHoldRead(new RecordStamps(clock));
    parking.target = document.id;
    const racing = realRetention({
      clock,
      unitOfWork,
      storage: library.storagePort,
      storageService: library.storage,
      disposition: realDisposition(clock, library.storage, library.writer),
      holds: parking,
      settings: {
        [Settings.RETENTION_RECYCLE_BIN_DAYS.key]: RECYCLE_BIN_DAYS,
        [Settings.RETENTION_BLOB_GRACE_DAYS.key]: 0,
      },
    });

    let reached: () => void = () => undefined;
    const atDecision = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let admit: () => void = () => undefined;
    parking.admit = new Promise<void>((resolve) => {
      admit = resolve;
    });
    parking.reached = reached;

    // Parked *after* the disposition's own hold read, holding the answer "nothing holds this".
    const sweep = asSystem(() => racing.retention.executeDue(100));
    await atDecision;

    // The matter opens, in its own transaction. Not awaited: in a fixed build it waits on the
    // rows the disposition is holding, and awaiting it here would be this test deadlocking rather
    // than the product being asked a question.
    const placing = as(() => retention.holds.place(document.id, 'Matter 2026-303'));
    await untilBlockedOr(placing);

    admit();
    await sweep;
    const placed = await placing.then(
      (hold) => hold,
      () => null,
    );

    const survives = await owner.document.findUnique({ where: { id: document.id } });
    if (placed !== null) {
      // The hold was accepted. Then it holds — the record is still there, the hold is still live,
      // and the schedule is suspended rather than executed.
      expect(survives).not.toBeNull();
      expect(await owner.legalHold.findUnique({ where: { id: placed.id } })).not.toBeNull();
      expect(
        (await owner.retentionSchedule.findFirstOrThrow({ where: { documentId: document.id } }))
          .state,
      ).toBe(RetentionScheduleState.SUSPENDED);
    } else {
      // The placement lost the race outright and never happened, which is the other legitimate
      // ordering. Nothing was accepted, so nothing was destroyed that had been.
      expect(await owner.legalHold.count({ where: { documentId: document.id } })).toBe(0);
    }
  });

  it('lets a placement already under way finish before the sweep decides', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Held first'));
    await advanceToDue(document.id);
    await drainOtherDue();
    await approve(document.id);

    const parking = new ParkingPlacement(new RecordStamps(clock));
    parking.target = document.id;
    const placer = realRetention({
      clock,
      unitOfWork,
      storage: library.storagePort,
      storageService: library.storage,
      disposition: realDisposition(clock, library.storage, library.writer),
      holds: parking,
      settings: {
        [Settings.RETENTION_RECYCLE_BIN_DAYS.key]: RECYCLE_BIN_DAYS,
        [Settings.RETENTION_BLOB_GRACE_DAYS.key]: 0,
      },
    });

    let reached: () => void = () => undefined;
    const atPlacement = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let admit: () => void = () => undefined;
    parking.admit = new Promise<void>((resolve) => {
      admit = resolve;
    });
    parking.reached = reached;

    // The matter opens first and parks on the hold row's own insert — in a fixed build, holding
    // the document's schedules while it does.
    const placing = as(() => placer.holds.place(document.id, 'Matter 2026-304'));
    await atPlacement;

    const sweep = asSystem(() => retention.retention.executeDue(100));
    // The database, not the scheduler, says the sweep is waiting on the placement.
    expect(await untilBlockedOr(sweep)).toBe(true);

    admit();
    const hold = await placing;
    await sweep;

    expect(await owner.document.findUnique({ where: { id: document.id } })).not.toBeNull();
    expect(await owner.legalHold.findUniqueOrThrow({ where: { id: hold.id } })).toMatchObject({
      releasedAt: null,
    });
    expect(
      (await owner.retentionSchedule.findFirstOrThrow({ where: { documentId: document.id } }))
        .state,
    ).toBe(RetentionScheduleState.SUSPENDED);

    // And the trail says the sweep stood down rather than silently doing nothing. It is the
    // *schedule* re-read that refuses here rather than the hold re-read, and that ordering is the
    // point: the placement suspends the schedule in the same transaction as the hold, so by the
    // time the disposition holds the rows the schedule is already one it may not execute. Slice
    // 73's guard and this lock are the same refusal reached one statement apart.
    const stoodDown = (await trailFor(document.id)).filter(
      (event) =>
        event.action === RetentionAudit.PURGE_EXECUTED &&
        JSON.stringify(event.payload).includes(RetentionScheduleState.SUSPENDED),
    );
    expect(stoodDown).toHaveLength(1);
  });

  /**
   * The archive half of the same interleaving.
   *
   * Less final than a purge and not less wrong. `SUSPENDED` is one of `LIVE_STATES`, so an archive
   * that decided before the matter committed writes `EXECUTED` straight over the suspension the
   * placement had just recorded — and a release then finds nothing suspended to resume, leaving
   * the schedule terminal, the record archived, and the hold with nothing left to hold.
   */
  it('lets a placement already under way finish before the archive decides', async () => {
    const document = await createDocument({ documentTypeId: archivingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Archive held first'));
    await advanceToDue(document.id);
    // An archiving schedule needs no approval, so the drain would settle this one too. Held
    // across it and released afterwards — both production paths — which leaves it `PENDING` and
    // every other due schedule settled.
    const shield = await as(() => retention.holds.place(document.id, 'Held across the drain'));
    await drainOtherDue();
    await as(() => retention.holds.release(shield.id, 'Drain finished'));

    const parking = new ParkingPlacement(new RecordStamps(clock));
    parking.target = document.id;
    const placer = realRetention({
      clock,
      unitOfWork,
      storage: library.storagePort,
      storageService: library.storage,
      disposition: realDisposition(clock, library.storage, library.writer),
      holds: parking,
      settings: {
        [Settings.RETENTION_RECYCLE_BIN_DAYS.key]: RECYCLE_BIN_DAYS,
        [Settings.RETENTION_BLOB_GRACE_DAYS.key]: 0,
      },
    });

    let reached: () => void = () => undefined;
    const atPlacement = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let admit: () => void = () => undefined;
    parking.admit = new Promise<void>((resolve) => {
      admit = resolve;
    });
    parking.reached = reached;

    const placing = as(() => placer.holds.place(document.id, 'Matter 2026-305'));
    await atPlacement;

    const sweep = asSystem(() => retention.retention.executeDue(100));
    expect(await untilBlockedOr(sweep)).toBe(true);

    admit();
    const hold = await placing;
    await sweep;

    // Not archived, and the schedule is still the release's to resume. An `EXECUTED` here would
    // be terminal: nothing revisits it, and the matter would hold a record nothing can dispose of
    // and nothing can put back.
    expect(await statusOf(document.id)).not.toBe('ARCHIVED');
    expect((await scheduleOf(document.id)).state).toBe(RetentionScheduleState.SUSPENDED);
    await as(() => retention.holds.release(hold.id, 'Matter closed'));
    expect((await scheduleOf(document.id)).state).toBe(RetentionScheduleState.PENDING);
  });

  it('refuses to archive a record a hold reached while the sweep was deciding', async () => {
    const document = await createDocument({ documentTypeId: archivingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Held during'));
    await advanceToDue(document.id);

    const parking = new ParkingHolds(new RecordStamps(clock));
    parking.target = document.id;
    const racing = realRetention({
      clock,
      unitOfWork,
      storage: library.storagePort,
      storageService: library.storage,
      disposition: realDisposition(clock, library.storage, library.writer),
      holds: parking,
      settings: {
        [Settings.RETENTION_RECYCLE_BIN_DAYS.key]: RECYCLE_BIN_DAYS,
        [Settings.RETENTION_BLOB_GRACE_DAYS.key]: 0,
      },
    });

    let reached: () => void = () => undefined;
    const atDecision = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let admit: () => void = () => undefined;
    parking.admit = new Promise<void>((resolve) => {
      admit = resolve;
    });
    parking.reached = reached;

    // The sweep, from its own scope. It parks holding the answer "no holds", which is the belief
    // it will carry into the archiving transaction.
    const sweep = asSystem(() => racing.retention.executeDue(100));
    await atDecision;

    // The matter opens. Its own scope and its own transaction — not nested in the sweep's, which
    // would make this one transaction racing itself.
    const hold = await as(() => retention.holds.place(document.id, 'Matter 2026-202'));
    expect((await scheduleOf(document.id)).state).toBe(RetentionScheduleState.SUSPENDED);

    admit();
    await sweep;

    // The hold is live and was live before the archive ran. A disposition that proceeds anyway is
    // a hold that does not hold.
    expect(await statusOf(document.id)).not.toBe('ARCHIVED');
    expect((await scheduleOf(document.id)).state).toBe(RetentionScheduleState.SUSPENDED);

    // And the trail says the sweep met the hold and stood down, rather than silently doing
    // nothing — the same record `purge` writes when its own second check refuses.
    const blocked = (await trailFor(document.id)).filter(
      (event) =>
        event.action === RetentionAudit.PURGE_EXECUTED &&
        JSON.stringify(event.payload).includes(DispositionOutcome.BLOCKED),
    );
    expect(blocked).toHaveLength(1);

    // And the release resumes it, which it cannot do from a terminal state.
    await as(() => retention.holds.release(hold.id, 'Matter closed'));
    expect((await scheduleOf(document.id)).state).toBe(RetentionScheduleState.PENDING);
  });

  /**
   * The same interleaving, with a **restore** instead of a hold — Slice 73.
   *
   * `executeDue` reads its batch in one transaction and settles each schedule in another, so any
   * restore committing between the two leaves the sweep holding a schedule that has since been
   * cancelled and a document that is no longer deleted. `purge` re-reads the *holds* inside the
   * destroying transaction — that is the check the test above proves — but re-reads neither the
   * schedule's state nor the document's `deleted_at`: `describe` selects the row without a
   * `deleted_at` predicate, and `deleteForDocument` discards its affected-row count.
   *
   * A restore is the one act the recycle bin exists to make possible, and this is destruction that
   * cannot be undone: the tombstone is the only thing left.
   */
  it('destroys nothing when the record was restored while the sweep was deciding', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Restored during'));
    await advanceToDue(document.id);
    await approve(document.id);

    const parking = new ParkingHolds(new RecordStamps(clock));
    parking.target = document.id;
    const racing = realRetention({
      clock,
      unitOfWork,
      storage: library.storagePort,
      storageService: library.storage,
      disposition: realDisposition(clock, library.storage, library.writer),
      holds: parking,
      settings: {
        [Settings.RETENTION_RECYCLE_BIN_DAYS.key]: RECYCLE_BIN_DAYS,
        [Settings.RETENTION_BLOB_GRACE_DAYS.key]: 0,
      },
    });

    let reached: () => void = () => undefined;
    const atDecision = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let admit: () => void = () => undefined;
    parking.admit = new Promise<void>((resolve) => {
      admit = resolve;
    });
    parking.reached = reached;

    // The sweep, from its own scope. It parks holding a schedule it read as due and a document it
    // read as deleted — the belief it will carry into the destroying transaction.
    const sweep = asSystem(() => racing.retention.executeDue(100));
    await atDecision;

    // Somebody takes it back out of the bin. Its own scope and its own transaction, and it commits
    // before the sweep is admitted — so the sweep's belief is demonstrably stale, not merely racy.
    const deleted = await as(() => library.documents.get(document.id));
    await as(() => library.documents.restore(document.id, deleted.version));
    const restored = await owner.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { deletedAt: true },
    });
    expect(restored.deletedAt).toBeNull();
    expect((await scheduleOf(document.id)).state).toBe(RetentionScheduleState.CANCELLED);

    admit();
    await sweep;

    // The document is live and was live before the purge ran. Destroying it anyway is a restore
    // that did not restore.
    const after = await owner.document.findUnique({
      where: { id: document.id },
      select: { id: true, deletedAt: true },
    });
    expect(after).not.toBeNull();
    expect(after?.deletedAt).toBeNull();
    // And nothing was tombstoned, because nothing was destroyed.
    expect(await owner.documentTombstone.count({ where: { documentId: document.id } })).toBe(0);
  });

  /**
   * The same withdrawal, with the document deleted again before the sweep is admitted.
   *
   * This is what makes the *schedule's state* the predicate rather than the document's
   * `deleted_at`. Here the document is in the recycle bin at the moment of the purge, so a guard
   * asking "is it still deleted?" would answer yes and destroy it — but the schedule the sweep is
   * holding was cancelled by the restore, and the second delete started a fresh retention clock
   * with a due date a month away. Executing the old schedule would destroy a record whose period
   * has barely begun.
   *
   * The distinction matters in the other direction too, which is why the predicate cannot be
   * `deleted_at`: only `ON_DELETE` is `cancelledByRestore`, so a published record keeps the
   * schedule its publication started and is destroyed at its disposition date while perfectly
   * live. A `deleted_at` guard would refuse that legitimate purge.
   */
  it('destroys nothing when the schedule it read was withdrawn, even if the record is deleted again', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Deleted once'));
    await advanceToDue(document.id);
    await approve(document.id);
    const withdrawnScheduleId = (
      await owner.retentionSchedule.findFirstOrThrow({ where: { documentId: document.id } })
    ).id;

    const parking = new ParkingHolds(new RecordStamps(clock));
    parking.target = document.id;
    const racing = realRetention({
      clock,
      unitOfWork,
      storage: library.storagePort,
      storageService: library.storage,
      disposition: realDisposition(clock, library.storage, library.writer),
      holds: parking,
      settings: {
        [Settings.RETENTION_RECYCLE_BIN_DAYS.key]: RECYCLE_BIN_DAYS,
        [Settings.RETENTION_BLOB_GRACE_DAYS.key]: 0,
      },
    });

    let reached: () => void = () => undefined;
    const atDecision = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let admit: () => void = () => undefined;
    parking.admit = new Promise<void>((resolve) => {
      admit = resolve;
    });
    parking.reached = reached;

    const sweep = asSystem(() => racing.retention.executeDue(100));
    await atDecision;

    // Out of the bin and back into it, both committed before the sweep is admitted. The restore
    // cancelled the schedule the sweep is holding; the second delete wrote a new one.
    const deleted = await as(() => library.documents.get(document.id));
    await as(() => library.documents.restore(document.id, deleted.version));
    const live = await as(() => library.documents.get(document.id));
    await as(() => library.documents.remove(document.id, live.version, 'Deleted again'));

    const state = await owner.retentionSchedule.findUniqueOrThrow({
      where: { id: withdrawnScheduleId },
      select: { state: true },
    });
    expect(state.state).toBe(RetentionScheduleState.CANCELLED);
    const row = await owner.document.findUniqueOrThrow({
      where: { id: document.id },
      select: { deletedAt: true },
    });
    // Deleted again — so a guard reading the document's state rather than the schedule's would
    // find nothing wrong and destroy it.
    expect(row.deletedAt).not.toBeNull();

    admit();
    await sweep;

    expect(
      await owner.document.findUnique({ where: { id: document.id }, select: { id: true } }),
    ).not.toBeNull();
    expect(await owner.documentTombstone.count({ where: { documentId: document.id } })).toBe(0);
  });

  /**
   * Two sweeps holding the same schedule — Slice 90.
   *
   * `executeDue` reads its batch with `listDue`, which is a select and not a claim, and settles
   * each schedule in its own transaction. The tests above prove `purge` re-reads the schedule's
   * state and the holds inside the destroying transaction, which closes every ordering where the
   * withdrawal *commits* before the purge begins. It does not close the one where two purges run
   * at once: both re-read a schedule neither has touched, both see `PENDING`, and both go on.
   *
   * Reachable because nothing stops a tenant having two sweeps in flight. `retention.run` declares
   * no `perTenantConcurrency` — only `documents.bulk`, `webhooks.deliver` and `audit.stream` do —
   * the fan-out's job id is keyed by the firing (`${kind}:${tenantId}:${jobId}`) so a later firing
   * is a different job, and a handler that outruns the lane's fifteen-minute budget is re-delivered
   * while the original keeps running rather than being killed.
   *
   * What the loser writes is the point. It destroys nothing — its deletes match no rows — and then
   * records that it did: a second `PURGED` on the document's own trail, a second `PURGE_EXECUTED`
   * in the disposition register contradicting the first about how many revisions went, and a
   * second `retention.document-purged` for every webhook subscribed to destruction. The tombstone
   * is the one thing that survives a purge, and the trail beside it is the only evidence of what
   * happened; two irreconcilable accounts of one destruction is not a duplicate log line.
   */
  it('records one destruction when two sweeps settle the same schedule', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Two sweeps'));
    await advanceToDue(document.id);
    await approve(document.id);

    const sweeps = [0, 1].map(() => {
      const parking = new ParkingSchedules(new RecordStamps(clock));
      parking.target = document.id;
      return {
        parking,
        stack: realRetention({
          clock,
          unitOfWork,
          storage: library.storagePort,
          storageService: library.storage,
          disposition: realDisposition(clock, library.storage, library.writer),
          schedules: parking,
          settings: {
            [Settings.RETENTION_RECYCLE_BIN_DAYS.key]: RECYCLE_BIN_DAYS,
            [Settings.RETENTION_BLOB_GRACE_DAYS.key]: 0,
          },
        }),
      };
    });

    const started = sweeps.map((sweep) => {
      let reached: () => void = () => undefined;
      const atClaim = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let admit: () => void = () => undefined;
      sweep.parking.admit = new Promise<void>((resolve) => {
        admit = resolve;
      });
      sweep.parking.reached = reached;
      return { ...sweep, atClaim, admit };
    });

    // Both parked on the way into the lock, holding nothing, so both are inside a transaction that
    // has re-read the schedule as live and neither has ordered the other yet. Started one at a
    // time and awaited to its park, because which of two concurrent passes reaches the seam first
    // is the scheduler's business and a test that depends on the answer reports whichever answer
    // it got.
    const first = asSystem(() => started[0]!.stack.retention.executeDue(100));
    await started[0]!.atClaim;
    const second = asSystem(() => started[1]!.stack.retention.executeDue(100));
    await started[1]!.atClaim;

    // Released together. From here PostgreSQL decides which of them takes the rows, and the loser
    // arrives at its claim against a schedule the winner has already removed.
    started[0]!.admit();
    started[1]!.admit();
    await first;
    await second;

    // One sweep claimed the schedule; the other's delete matched nothing. Which of them won is
    // PostgreSQL's to decide now that both are released together, so the assertion is over the
    // pair rather than over a named sweep — the property is that exactly one claim landed.
    const counts = [
      ...started[0]!.parking.deleteCounts,
      ...started[1]!.parking.deleteCounts,
    ].sort();
    expect(counts).toEqual([0, 1]);

    // The document went once, and the tombstone says so once — that half already held, because
    // `documentId` is the tombstone's primary key and its write is an upsert that updates nothing.
    expect(
      await owner.document.findUnique({ where: { id: document.id }, select: { id: true } }),
    ).toBeNull();
    expect(await owner.documentTombstone.count({ where: { documentId: document.id } })).toBe(1);

    const trail = await trailFor(document.id);
    // One destruction, one `PURGED`. The document's own timeline says it was destroyed once.
    expect(trail.filter((row) => row.action === RetentionAudit.PURGED)).toHaveLength(1);

    // And exactly one disposition record claims to have carried it out. A sweep that met the
    // schedule and found it gone may say so — the `alreadyPurged` branch does — but it must not
    // file a second execution reporting a different number of revisions than the first.
    const executed = trail.filter((row) => row.action === RetentionAudit.PURGE_EXECUTED);
    const claiming = executed.filter(
      (row) =>
        (row.payload as { after?: { revisionsRemoved?: number } } | null)?.after
          ?.revisionsRemoved !== undefined,
    );
    expect(claiming).toHaveLength(1);

    // One destruction, one event. A webhook subscriber is told once that the record is gone.
    const purgedEvents = await owner.outboxMessage.count({
      where: { aggregateId: document.id, eventType: 'retention.document-purged' },
    });
    expect(purgedEvents).toBe(1);
  });

  /**
   * The other side of the same predicate: a claim of *more* than one is still a claim.
   *
   * `uq_retention_schedule_live` is unique on `(document_id, trigger)`, not on the document, so a
   * record whose publication and whose deletion both started a clock has two live schedules — and
   * `deleteForDocument` removes them together, so the winning sweep's claim counts two. A guard
   * asking for exactly one would refuse a purge nobody is racing for, which is why the predicate
   * is "did I claim anything" rather than "did I claim the one I was holding".
   */
  it('purges a record whose claim removes more than one schedule', async () => {
    const publishPurge = await as(() =>
      library.configuration.createRetention({
        code: unique('RP'),
        name: 'Purge one month after publication',
        trigger: RetentionTrigger.ON_PUBLISH,
        periodMonths: 1,
        disposition: Disposition.PURGE,
        reviewRequired: false,
      }),
    );

    const document = await createDocument({ documentTypeId: purgingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Two clocks'));
    // A second live schedule on the same record, through the seam Document itself writes one by.
    await as(() =>
      unitOfWork.run(() =>
        retention.scheduler.onTrigger({
          documentId: document.id,
          trigger: RetentionTrigger.ON_PUBLISH,
          at: now,
          policyId: publishPurge.id,
          documentNumber: null,
        }),
      ),
    );
    const live = await owner.retentionSchedule.count({
      where: {
        documentId: document.id,
        state: { in: [RetentionScheduleState.PENDING, RetentionScheduleState.IN_REVIEW] },
      },
    });
    expect(live).toBe(2);

    // Both are due, and both are approved, so the sweep settles rather than raising for review.
    const schedules = await owner.retentionSchedule.findMany({
      where: { documentId: document.id, state: RetentionScheduleState.PENDING },
      select: { id: true, dueAt: true },
    });
    now = new Date(Math.max(...schedules.map((row) => row.dueAt.getTime())) + 86_400_000);
    for (const schedule of schedules) {
      await as(() => retention.retention.approveDisposition(schedule.id, 'Reviewed and approved'));
    }

    await asSystem(() => retention.retention.executeDue(100));

    expect(
      await owner.document.findUnique({ where: { id: document.id }, select: { id: true } }),
    ).toBeNull();
    expect(await owner.documentTombstone.count({ where: { documentId: document.id } })).toBe(1);
    const trail = await trailFor(document.id);
    expect(trail.filter((row) => row.action === RetentionAudit.PURGED)).toHaveLength(1);
  });

  /** The real schedule repository, held between `purge`'s last guard read and its first write. */
  class ParkingSchedules extends PrismaRetentionScheduleRepository {
    reached: (() => void) | null = null;
    admit: Promise<void> | null = null;
    /** Whose disposition to park on — this file leaves plenty of other schedules due. */
    target: string | null = null;
    /** What each claim actually removed, which is the whole of what the fix reads. */
    readonly deleteCounts: number[] = [];

    /**
     * Parked on the way *into* the lock rather than on the claim — Slice 115.
     *
     * The park used to sit between the last guard and the first row removed, which was the only
     * seam there was while `purge` took no lock. It cannot sit there any more: the second sweep
     * now waits in PostgreSQL for the first one's `FOR UPDATE`, so it never reaches a park beyond
     * it and a barrier of two would hold both transactions until they expired.
     *
     * Before the lock is the stronger place in any case. Both passes are admitted holding
     * nothing, so both are genuinely in flight and it is the *database* that orders them — which
     * is what the claim count below is being asked about.
     */
    override async lockForDocument(documentId: DocumentId): Promise<void> {
      const gate = this.admit;
      if (gate !== null && String(documentId) === this.target) {
        this.admit = null;
        this.reached?.();
        await gate;
      }
      await super.lockForDocument(documentId);
    }

    override async deleteForDocument(documentId: DocumentId): Promise<number> {
      const count = await super.deleteForDocument(documentId);
      if (String(documentId) === this.target) {
        this.deleteCounts.push(count);
      }
      return count;
    }
  }
});

/**
 * An assigned number outliving the document it named — Slice 105A.
 *
 * ## The contradiction this resolves
 *
 * `DOCUMENT_DELETION_RULES` has always said of `number_reservation`: *"A number is never re-issued,
 * even after a purge (ADR-0004) … The purge sets its document pointer to null — the row outlives
 * its parent."* `ck_number_reservation_state` has always said an `ASSIGNED` row must name a
 * document. Both are written down, and they could not both hold.
 *
 * Nothing caught it because nothing ever drew a number. The purge case above writes
 * `document.document_number` directly, "the way a legacy import does", so no `number_reservation`
 * row exists and its closing assertion — no reservations for this document — passes vacuously.
 * `realDocumentLibrary` had no numbering composed at all until this slice.
 *
 * Through the real issuance path the disposition raised `23514` on the statement that nulls the
 * pointer. Because `executeDue` has no per-document `catch` and `listDue` orders `due_at ASC`, the
 * stuck schedule sat at the head of the queue and stalled every later disposition in the tenant.
 *
 * ## What it is now
 *
 * `PURGED`: assigned once, its document destroyed, the value consumed forever. Distinct from
 * `VOIDED`, which means a use that was *refused* — the two answer different questions and the
 * cases below keep them apart.
 */
describe('a number whose document was purged', () => {
  /**
   * The suite's own numbering rule, driven through the service an administrator drives.
   *
   * The value asked for is one past the highest the rule has drawn, which is what a controller
   * typing "the next free number" does — and what keeps these cases independent of the reservations
   * the other tests in this block draw through the automatic path.
   */
  async function assignManually(documentId: string): Promise<string> {
    const top = await owner.numberReservation.aggregate({
      where: { tenantId: TENANT, numberingRuleId },
      _max: { sequenceValue: true },
    });
    const requested = `QA-${String(Number(top._max.sequenceValue ?? 0n) + 1).padStart(3, '0')}`;
    await as(() => library.numbers.assignManually(asId<DocumentId>(documentId), requested));
    return requested;
  }

  async function reservationFor(formatted: string) {
    return owner.numberReservation.findFirstOrThrow({ where: { tenantId: TENANT, formatted } });
  }

  /** Delete, wait out the policy, approve the disposition, sweep. The whole real road to a purge. */
  async function purgeThrough(documentId: string): Promise<{ purged: number }> {
    const fresh = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    await as(() => library.documents.remove(documentId, fresh.version, 'Due for disposition'));
    await advanceToDue(documentId);
    await approve(documentId);
    const outcome = await asSystem(() => retention.retention.executeDue(100));
    return { purged: outcome.purged };
  }

  it('purges the document and keeps the number as PURGED', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });
    const formatted = await assignManually(document.id);

    // Assigned, for real: the state, the instant and the document pointer the constraint requires.
    const assigned = await reservationFor(formatted);
    expect(assigned.state).toBe(NumberReservationState.ASSIGNED);
    expect(assigned.documentId).toBe(document.id);
    expect(assigned.assignedAt).not.toBeNull();

    // The whole point: this used to raise `23514` and leave the document standing.
    expect((await purgeThrough(document.id)).purged).toBeGreaterThanOrEqual(1);
    expect(await owner.document.findUnique({ where: { id: document.id } })).toBeNull();

    const after = await reservationFor(formatted);
    expect(after.state).toBe(NumberReservationState.PURGED);
    expect(after.documentId).toBeNull();
    expect(after.workflowInstanceId).toBeNull();
    // The instant of assignment survives: it is the fact that makes `PURGED` different from a
    // value that was never anybody's number, and the constraint requires it to.
    expect(after.assignedAt).not.toBeNull();
    expect(after.assignedAt).toEqual(assigned.assignedAt);
    expect(after.formatted).toBe(formatted);
    expect(after.voidedAt).toBeNull();
    expect(after.id).toBe(assigned.id);
  }, 120_000);

  it('refuses the same number to a new document, through the product rather than the constraint', async () => {
    const first = await createDocument({ documentTypeId: purgingTypeId });
    const formatted = await assignManually(first.id);
    await purgeThrough(first.id);
    expect((await reservationFor(formatted)).state).toBe(NumberReservationState.PURGED);

    // The application's own refusal, from the application's own path. A direct insert would only
    // prove `uq_number_reservation_formatted` works, which was never in doubt; what has to be true
    // is that `assignManual` reads the purged row and declines before the index has to.
    const second = await createDocument({ documentTypeId: purgingTypeId });
    await expect(
      as(() => library.numbers.assignManually(asId<DocumentId>(second.id), formatted)),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });

    // And the loser is untouched: no second document holds the number, and the purged row did not
    // move. A refusal that had side effects would be the worse failure.
    const still = await reservationFor(formatted);
    expect(still.state).toBe(NumberReservationState.PURGED);
    expect(still.documentId).toBeNull();
    expect(
      await owner.document.findUnique({
        where: { id: second.id },
        select: { documentNumber: true },
      }),
    ).toMatchObject({ documentNumber: null });
  }, 120_000);

  it('keeps VOIDED meaning refused, and PURGED meaning assigned-then-destroyed', async () => {
    /*
     * One document carrying both histories, which is the arrangement that keeps the two states
     * honest: a first approval drew a number and was refused, so that value is `VOIDED`; the
     * document was then numbered by hand and eventually purged, so *that* value is `PURGED`.
     *
     * Both rows point at the same document when the disposition runs, so the purge has to treat
     * them differently — and a transition that forgot to ask which state it was looking at would
     * either stamp the voided value `PURGED` (losing "this use was refused") or trip the
     * constraint, which requires a `PURGED` row to carry the instant it was assigned.
     */
    const document = await createDocument({ documentTypeId: purgingTypeId });
    const instanceId = await seedWorkflowInstance(document.id);
    const reserved = await as(() =>
      library.issuance.reserve({
        numberingRuleId: asId(numberingRuleId),
        codes: {},
        documentId: asId<DocumentId>(document.id),
        workflowInstanceId: asId<WorkflowInstanceId>(instanceId),
      }),
    );
    await as(() =>
      library.issuance.release(
        asId<NumberReservationId>(reserved.reservationId),
        'Approval refused',
      ),
    );
    const purgedNumber = await assignManually(document.id);

    expect((await purgeThrough(document.id)).purged).toBeGreaterThanOrEqual(1);

    const voided = await reservationFor(reserved.formatted);
    const purged = await reservationFor(purgedNumber);

    // Two histories, told apart by their own columns — not by a reader's guesswork.
    expect(voided.state).toBe(NumberReservationState.VOIDED);
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.assignedAt).toBeNull();
    expect(voided.voidReason).toBe('Approval refused');
    // Its pointers go with the record, exactly as they did before this slice — the purge changes
    // what an *assigned* value becomes and nothing about the others.
    expect(voided.documentId).toBeNull();
    expect(voided.workflowInstanceId).toBeNull();

    expect(purged.state).toBe(NumberReservationState.PURGED);
    expect(purged.voidedAt).toBeNull();
    expect(purged.assignedAt).not.toBeNull();
    expect(purged.voidReason).toBeNull();
    expect(purged.documentId).toBeNull();
  }, 120_000);

  it('will not hand a purged number back even to the path that claims a held one', async () => {
    /*
     * The reuse refusal, asked of the statement that actually writes an assignment.
     *
     * `assignManual` has two doors: a held block becomes the assignment, and everything else is
     * refused. The refusal above is the first door being shut; this is the second — `markAssigned`
     * names the states it may claim from and `PURGED` is not among them, so a value that reached
     * the claim anyway still moves nothing. Two statements of one rule, and the invariant is that
     * neither alone is what stops a number being issued twice.
     */
    const document = await createDocument({ documentTypeId: purgingTypeId });
    const formatted = await assignManually(document.id);
    await purgeThrough(document.id);
    const purged = await reservationFor(formatted);
    expect(purged.state).toBe(NumberReservationState.PURGED);

    const second = await createDocument({ documentTypeId: purgingTypeId });
    await expect(
      as(() =>
        unitOfWork.run(() =>
          library.issuance.commit(
            asId<NumberReservationId>(purged.id),
            asId<DocumentId>(second.id),
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const still = await reservationFor(formatted);
    expect(still.state).toBe(NumberReservationState.PURGED);
    expect(still.documentId).toBeNull();
  }, 120_000);

  it('is idempotent: a second purge transition leaves the purged row exactly as it was', async () => {
    const document = await createDocument({ documentTypeId: purgingTypeId });
    const formatted = await assignManually(document.id);
    await purgeThrough(document.id);
    const once = await reservationFor(formatted);
    expect(once.state).toBe(NumberReservationState.PURGED);

    // The disposition's own statements, run again against the identifier of a document that is
    // already gone — which is what a redelivered or retried purge does. Through the real adapter,
    // in a real transaction, so the predicates are the ones production uses.
    await asSystem(() =>
      unitOfWork.run(() =>
        realDisposition(clock, library.storage, library.writer).purge(
          asId<DocumentId>(document.id),
        ),
      ),
    );

    const twice = await reservationFor(formatted);
    // Not transitioned twice, not voided, not freed, and no duplicate row invented.
    expect(twice).toMatchObject({
      id: once.id,
      state: NumberReservationState.PURGED,
      documentId: null,
      workflowInstanceId: null,
      formatted,
      voidedAt: null,
    });
    expect(twice.assignedAt).toEqual(once.assignedAt);
    expect(await owner.numberReservation.count({ where: { tenantId: TENANT, formatted } })).toBe(1);
  }, 120_000);

  it('purges a number assigned through the approval path, clearing both pointers', async () => {
    // The other production road to `ASSIGNED`, and the one that matters for the constraint's
    // second half: a reservation drawn at submission carries the *workflow instance* as well as
    // the document, and `PURGED` requires both pointers gone.
    const document = await createDocument({ documentTypeId: purgingTypeId });
    const instanceId = await seedWorkflowInstance(document.id);
    // Wrapped in a unit of work because that is how the engine calls it: `assignAtApproval` runs
    // inside the approval's own transaction rather than opening one, which is what makes the
    // number and the approval commit together.
    const { documentNumber } = await as(() =>
      unitOfWork.run(() =>
        library.numbers.assignAtApproval(asId<DocumentId>(document.id), instanceId),
      ),
    );

    const assigned = await reservationFor(documentNumber);
    expect(assigned.state).toBe(NumberReservationState.ASSIGNED);
    expect(assigned.documentId).toBe(document.id);
    expect(assigned.workflowInstanceId).toBe(instanceId);

    expect((await purgeThrough(document.id)).purged).toBeGreaterThanOrEqual(1);

    const after = await reservationFor(documentNumber);
    expect(after.state).toBe(NumberReservationState.PURGED);
    expect(after.documentId).toBeNull();
    expect(after.workflowInstanceId).toBeNull();
    expect(after.assignedAt).not.toBeNull();
    // The instance row itself went with the record; the number did not.
    expect(await owner.workflowInstance.findUnique({ where: { id: instanceId } })).toBeNull();
  }, 120_000);

  it('does not stall the sweep: a numbered document and the schedules queued behind it', async () => {
    /*
     * The operational consequence, which is worse than one document surviving.
     *
     * `executeDue` has no per-document `catch`, so the exception aborted the whole pass — and
     * `listDue` orders `due_at ASC`, so the stuck schedule sat at the head of the queue and every
     * later disposition in the tenant went unprocessed, every night, for good.
     *
     * The numbered document is deleted *first*, so its schedule is the earlier one and is reached
     * first by the sweep. A fix that merely stopped this document throwing, without the later one
     * also purging, would pass a test that only looked at the first.
     */
    const numbered = await createDocument({ documentTypeId: purgingTypeId });
    const formatted = await assignManually(numbered.id);
    const numberedRow = await owner.document.findUniqueOrThrow({ where: { id: numbered.id } });
    await as(() =>
      library.documents.remove(numbered.id, numberedRow.version, 'First in the queue'),
    );

    const behind = await createDocument({ documentTypeId: purgingTypeId });
    const behindRow = await owner.document.findUniqueOrThrow({ where: { id: behind.id } });
    await as(() => library.documents.remove(behind.id, behindRow.version, 'Queued behind it'));

    await advanceToDue(behind.id);
    await approve(numbered.id);
    await approve(behind.id);

    const outcome = await asSystem(() => retention.retention.executeDue(100));
    expect(outcome.purged).toBeGreaterThanOrEqual(2);

    // Both gone, which is the assertion: the second one is the one that used to be collateral.
    expect(await owner.document.findUnique({ where: { id: numbered.id } })).toBeNull();
    expect(await owner.document.findUnique({ where: { id: behind.id } })).toBeNull();
    expect((await reservationFor(formatted)).state).toBe(NumberReservationState.PURGED);
  }, 120_000);

  /**
   * A workflow instance for a document, seeded.
   *
   * Reaching a real one needs a published definition, a submission and an approval — none of which
   * these assertions are about, and all of which the workflow suite already proves. What is *not*
   * seeded is the reservation: that is drawn through the real issuance path, because the
   * reservation is precisely what the purge has to get right.
   */
  async function seedWorkflowInstance(documentId: string): Promise<string> {
    const revision = await owner.documentRevision.findFirstOrThrow({ where: { documentId } });
    const definitionId = uuidv7(now.getTime());
    const versionId = uuidv7(now.getTime());
    await owner.workflowDefinition.create({
      data: {
        id: definitionId,
        tenantId: TENANT,
        key: `purge-${definitionId.slice(0, 8)}`,
        name: 'Purge numbering',
        updatedAt: now,
      },
    });
    await owner.workflowVersion.create({
      data: {
        id: versionId,
        tenantId: TENANT,
        definitionId,
        version: 1,
        state: 'PUBLISHED',
        definition: {},
        publishedAt: now,
        updatedAt: now,
      },
    });
    const id = uuidv7(now.getTime());
    await owner.workflowInstance.create({
      data: {
        id,
        tenantId: TENANT,
        documentId,
        revisionId: revision.id,
        definitionId,
        workflowVersionId: versionId,
        state: 'RUNNING',
        currentStageIndex: 0,
        startedBy: ALICE,
        startedAt: now,
        updatedAt: now,
      },
    });
    return id;
  }
});

/**
 * Two matters closed at the same moment, and the record left suspended for ever — Slice 107.
 *
 * ## What the product says
 *
 * `RetentionScheduleState.SUSPENDED` is documented in `@edms/domain` as *"A legal hold blocks it.
 * Resumes at `PENDING` when the last hold is released."* `dueScheduleWhere` leaves `SUSPENDED` out
 * of the sweep on the strength of that sentence — *"a held schedule is not due, it is waiting, and
 * the release is what puts it back"* — and nothing else in the product ever looks at a suspended
 * schedule again. No sweep, no timer, no reconciliation. The release is the only thing standing
 * between a suspended record and a disposition that never runs.
 *
 * ## What it did
 *
 * `DefaultLegalHoldService.release` decided whether it was the last one out by *reading*:
 *
 * ```
 * const remaining = await this.holds.listLiveFor(hold.documentId);
 * const resumed = remaining.length === 0 ? await this.schedules.setSuspended(...) : 0;
 * ```
 *
 * Two matters holding one record is ordinary — the method's own comment says so — and counsel
 * closing both at once is two `POST /v1/documents/:documentId/holds/:holdId/release` requests in
 * flight together. The two claims are different rows, so neither blocks the other; each read then
 * saw the *other* hold still live, because the other release had not committed. Both concluded
 * somebody else was still holding the record. Neither resumed. Both committed, and the document
 * was left with zero live holds and a `SUSPENDED` schedule — a state the domain says cannot exist
 * and nothing will ever correct.
 *
 * ## What proves it
 *
 * The fix is mutual exclusion, so no barrier can hold both releases open at once after it: the
 * interleaving the defect needs is exactly the one the fix forbids, and a two-caller turnstile
 * placed downstream of the lock would simply hang. The evidence is therefore in two parts, the
 * shape Slice 104 settled on:
 *
 * - **The outcome**, from two genuinely concurrent releases with no barrier at all. After the fix
 *   the result is the same whichever wins the lock, so the assertion is deterministic; before it
 *   the two run in lock-step and the record is stranded.
 * - **The mechanism**, from a second database session probing with `FOR UPDATE NOWAIT` while a
 *   release is parked mid-transaction. `55P03` is the lock, observed directly rather than inferred
 *   from an outcome — and the same probe against another document's schedules must *succeed*, or
 *   the lock is not the one that was asked for.
 */
describe('two legal holds released at the same moment', () => {
  /**
   * The real repository, subclassed: a place to stand inside a release's transaction, after it has
   * taken its lock and made its claim.
   *
   * `listLiveFor` is the statement the decision is read from, so parking there holds the release
   * open at precisely the moment it is deciding — which is when the probe below asks what it is
   * holding. Only the named document is parked: this file leaves plenty of other holds about.
   */
  class ParkedRelease extends PrismaLegalHoldRepository {
    reached: (() => void) | null = null;
    admit: Promise<void> | null = null;
    target: string | null = null;

    override async listLiveFor(documentId: DocumentId): Promise<readonly LegalHoldRecord[]> {
      const gate = this.admit;
      if (gate !== null && String(documentId) === this.target) {
        this.admit = null;
        this.reached?.();
        await gate;
      }
      return super.listLiveFor(documentId);
    }
  }

  function stackWith(holds: PrismaLegalHoldRepository): RetentionStack {
    return realRetention({
      clock,
      unitOfWork,
      storage: library.storagePort,
      storageService: library.storage,
      disposition: realDisposition(clock, library.storage, library.writer),
      holds,
      settings: {
        [Settings.RETENTION_RECYCLE_BIN_DAYS.key]: RECYCLE_BIN_DAYS,
        [Settings.RETENTION_BLOB_GRACE_DAYS.key]: 0,
      },
    });
  }

  /** A deleted, due document with two matters on it, its schedule suspended by them. */
  async function suspendedUnderTwoHolds(): Promise<{
    documentId: string;
    first: string;
    second: string;
  }> {
    const document = await createDocument({ documentTypeId: archivingTypeId });
    await as(() => library.documents.remove(document.id, document.version, 'Two matters'));
    await advanceToDue(document.id);

    const first = await as(() => retention.holds.place(document.id, 'Matter 2026-301'));
    const second = await as(() => retention.holds.place(document.id, 'Matter 2026-302'));
    expect(await scheduleStateOf(document.id)).toBe(RetentionScheduleState.SUSPENDED);

    return { documentId: document.id, first: first.id, second: second.id };
  }

  async function scheduleStateOf(documentId: string): Promise<string> {
    return (await owner.retentionSchedule.findFirstOrThrow({ where: { documentId } })).state;
  }

  async function liveHoldsOf(documentId: string): Promise<number> {
    return owner.legalHold.count({ where: { documentId, releasedAt: null } });
  }

  /**
   * What a second session finds when it asks for a document's schedules without waiting.
   *
   * `owner` is a separate `PrismaClient` and therefore a separate backend, which is the only way
   * to ask whether a lock is held: a probe on the same connection would be inside the transaction
   * holding it and would always succeed. `NOWAIT` rather than a wait with a deadline, for the
   * reason `lockableElsewhere` states in the library suite — the question is whether the rows are
   * held *now*, and a probe that waited would be a probe somebody has to choose a duration for.
   * `55P03` is PostgreSQL's "could not obtain lock", and here it is the answer rather than a fault.
   *
   * Both strengths are asked, because both matter. Releases that could each take a *shared* lock
   * on the same schedules would read the same live set and reach the same wrong conclusion, so
   * "held" has to mean held exclusively.
   */
  async function probeSchedulesOf(
    mode: 'UPDATE' | 'SHARE',
    documentId: string,
  ): Promise<'LOCKED' | 'FREE'> {
    try {
      await owner.$queryRawUnsafe(
        `SELECT id FROM retention_schedule WHERE document_id = $1::uuid ORDER BY id FOR ${mode} NOWAIT`,
        documentId,
      );
      return 'FREE';
    } catch (error) {
      if (/55P03|could not obtain lock/i.test(String(error))) {
        return 'LOCKED';
      }
      throw error;
    }
  }

  it('resumes the schedule when the two are released one after the other', async () => {
    // The serial answer the concurrent one has to match. Without it every assertion below would
    // pass against a product that never resumed a schedule at all.
    const { documentId, first, second } = await suspendedUnderTwoHolds();

    await as(() => retention.holds.release(first, 'Matter 2026-301 closed'));
    expect(await liveHoldsOf(documentId)).toBe(1);
    expect(await scheduleStateOf(documentId)).toBe(RetentionScheduleState.SUSPENDED);

    await as(() => retention.holds.release(second, 'Matter 2026-302 closed'));
    expect(await liveHoldsOf(documentId)).toBe(0);
    expect(await scheduleStateOf(documentId)).toBe(RetentionScheduleState.PENDING);
  });

  it('resumes the schedule when the two are released at the same moment', async () => {
    const { documentId, first, second } = await suspendedUnderTwoHolds();

    // Two requests, two scopes, two transactions — counsel closing two matters at once. No
    // barrier: the lock is what decides the order, and either order gives the same answer.
    await Promise.all([
      as(() => retention.holds.release(first, 'Matter 2026-301 closed')),
      as(() => retention.holds.release(second, 'Matter 2026-302 closed')),
    ]);

    expect(await liveHoldsOf(documentId)).toBe(0);
    expect(await scheduleStateOf(documentId)).toBe(RetentionScheduleState.PENDING);
  });

  it('leaves the schedule suspended while a third matter is still open', async () => {
    // The other side of the claim. Serialising the releases must not resume a record somebody is
    // still holding, which is the failure a fix that simply always resumed would produce.
    const { documentId, first, second } = await suspendedUnderTwoHolds();
    await as(() => retention.holds.place(documentId, 'Matter 2026-303'));

    await Promise.all([
      as(() => retention.holds.release(first, 'Matter 2026-301 closed')),
      as(() => retention.holds.release(second, 'Matter 2026-302 closed')),
    ]);

    expect(await liveHoldsOf(documentId)).toBe(1);
    expect(await scheduleStateOf(documentId)).toBe(RetentionScheduleState.SUSPENDED);
  });

  it('holds the document’s schedules from before its claim until it commits', async () => {
    // The mechanism, observed rather than inferred. The parked release is *not* the last one out —
    // it has another matter beside it — so before the fix it never touched `retention_schedule` at
    // all and this probe found the rows free.
    const { documentId, first } = await suspendedUnderTwoHolds();

    const parking = new ParkedRelease(new RecordStamps(clock));
    parking.target = documentId;
    const racing = stackWith(parking);

    let reached: () => void = () => undefined;
    const atDecision = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let admit: () => void = () => undefined;
    parking.admit = new Promise<void>((resolve) => {
      admit = resolve;
    });
    parking.reached = reached;

    const release = as(() => racing.holds.release(first, 'Matter 2026-301 closed'));
    await atDecision;

    expect(await probeSchedulesOf('UPDATE', documentId)).toBe('LOCKED');
    expect(await probeSchedulesOf('SHARE', documentId)).toBe('LOCKED');

    admit();
    await release;

    // And released with the transaction, not held past it.
    expect(await probeSchedulesOf('UPDATE', documentId)).toBe('FREE');
  });

  it('holds only its own document’s schedules', async () => {
    // A lock that took the tenant's schedules would pass the probe above and stall every unrelated
    // release in the tenant behind one matter. The scope is asserted, not assumed.
    const held = await suspendedUnderTwoHolds();
    const bystander = await suspendedUnderTwoHolds();

    const parking = new ParkedRelease(new RecordStamps(clock));
    parking.target = held.documentId;
    const racing = stackWith(parking);

    let reached: () => void = () => undefined;
    const atDecision = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let admit: () => void = () => undefined;
    parking.admit = new Promise<void>((resolve) => {
      admit = resolve;
    });
    parking.reached = reached;

    const release = as(() => racing.holds.release(held.first, 'Matter 2026-301 closed'));
    await atDecision;

    expect(await probeSchedulesOf('UPDATE', held.documentId)).toBe('LOCKED');
    expect(await probeSchedulesOf('UPDATE', bystander.documentId)).toBe('FREE');

    admit();
    await release;
  });

  it('puts the resumed schedule back in front of the sweep', async () => {
    // What the state is *for*. A schedule left `SUSPENDED` is absent from `dueScheduleWhere`, so
    // the cost of the defect is a disposition that never runs — asserted against the sweep rather
    // than inferred from the column.
    const { documentId, first, second } = await suspendedUnderTwoHolds();

    await Promise.all([
      as(() => retention.holds.release(first, 'Matter 2026-301 closed')),
      as(() => retention.holds.release(second, 'Matter 2026-302 closed')),
    ]);

    const due = await as(() => retention.retention.listDue(100));
    expect(due.map((schedule) => String(schedule.documentId))).toContain(documentId);

    await asSystem(() => retention.retention.executeDue(100));
    expect((await owner.document.findUniqueOrThrow({ where: { id: documentId } })).status).toBe(
      'ARCHIVED',
    );
    expect(await scheduleStateOf(documentId)).toBe(RetentionScheduleState.EXECUTED);
  });
});
