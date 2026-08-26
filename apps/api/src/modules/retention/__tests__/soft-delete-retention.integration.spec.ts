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
  RetentionScheduleState,
  NumberSegmentKind,
  RetentionTrigger,
  RevisionLabelStyle,
  ScanStatus,
  Settings,
  type TenantId,
  type UploadSessionId,
  type UserId,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { RecordStamps } from '../../../core/persistence/record-stamps';
import type { LegalHoldRecord } from '../application/ports';
import { RetentionAudit } from '../domain/audit-actions';
import { DispositionOutcome } from '../domain/schedule';
import { PrismaLegalHoldRepository } from '../infrastructure/prisma-retention.repositories';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { decodeTransferToken } from '../../../testing/transfer-token';
import {
  type DocumentLibraryStack,
  type RetentionStack,
  realDisposition,
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
let library: DocumentLibraryStack;
let retention: RetentionStack;

let libraryId: string;
let rootFolderId: string;
let documentTypeId: string;
/** A type whose policy purges thirty days after a publication — short, so the suite can pass it. */
let purgingTypeId: string;
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

  // A rule, because a document type names one. Nothing in this suite draws a number through it —
  // the one purge that needs a number writes it the way a legacy import does.
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
});
