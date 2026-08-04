import 'reflect-metadata';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DocumentStatus,
  NumberSegmentKind,
  ParticipantKind,
  RevisionStatus,
  ScanStatus,
  StageCompletionRule,
  TaskDecision,
  type ApprovalTaskId,
  type DocumentId,
  type TenantId,
  type UploadSessionId,
  type UserId,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { decodeTransferToken } from '../../../testing/transfer-token';
import {
  type DocumentLibraryStack,
  type RevisionControlStack,
  type WorkflowEngineStack,
  realDocumentLibrary,
  realRevisionControl,
  realWorkflowEngine,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import type { WorkflowDirectory } from '../../workflow/application/ports';

/**
 * Revision control, against a real PostgreSQL.
 *
 * The phase named four properties that only a database can be asked about, and they are this
 * suite's reason to exist:
 *
 *  - **One lock under concurrency.** Two check-outs racing produce one lock and one refusal —
 *    decided by `uq_document_lock_live`, the same shape as the engine's one-live-instance
 *    index, and only PostgreSQL can say which insert lost.
 *  - **Exactly one published revision.** Two publishes racing produce one `PUBLISHED` row,
 *    with `uq_revision_published` as the referee behind the optimistic version check.
 *  - **The frozen-content refusal while `CHECKED_OUT`.** Phase 3's rule, reachable at last.
 *  - **Restore costs a row, not a copy.** The restored revision references the old blob —
 *    reference count up by one, no new `file_object` — which is a fact about rows.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const FIXED_NOW = new Date('2026-03-02T09:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
const AUTHOR = asId<UserId>(uuidv7());
const REVIEWER = asId<UserId>(uuidv7());
const CONTROLLER = asId<UserId>(uuidv7());

const SIGNING_SECRET = 'a-revision-integration-secret-of-32-char';
const MAGIC = new Uint8Array(Buffer.from('%PDF-1.7\n% ', 'utf8'));

let root: string;
let owner: PrismaClient;
let library: DocumentLibraryStack;
let workflow: WorkflowEngineStack;
let revision: RevisionControlStack;
let unitOfWork: PrismaUnitOfWork;

let rootFolderId: string;
let confidentialityId: string;
let numberingRuleId: string;
let typeId: string;
let unnumberedTypeId: string;

const directory: WorkflowDirectory = {
  holdersOfRole: (roleKey) => Promise.resolve(roleKey === 'reviewer' ? [REVIEWER] : []),
  membersOfDepartment: () => Promise.resolve([REVIEWER]),
  managersOf: () => Promise.resolve([REVIEWER]),
  membersOfGroup: () => Promise.resolve([REVIEWER]),
  activeAmong: (ids) => Promise.resolve([...ids]),
  displayNames: (ids) => Promise.resolve(new Map(ids.map((id) => [id, 'Test User']))),
};

function contextFor(userId: UserId): RequestContext {
  return {
    tenantId: TENANT,
    userId,
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: 'revision-control',
    permissionVersion: 1,
    locale: 'en',
  };
}

function as<T>(work: () => Promise<T>, userId: UserId = AUTHOR): Promise<T> {
  return runWithContext(contextFor(userId), work);
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(3, '0')}`;
}

function aPdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${marker}\n1 0 obj\n<<>>\nendobj\n`);
}

/** The upload handshake, exactly as the library suite performs it. Nothing short-circuited. */
async function uploadClean(marker: string, filename = 'procedure.pdf'): Promise<string> {
  const content = aPdf(marker);
  const target = await as(() =>
    library.storage.createUploadSession({
      filename,
      mimeType: 'application/pdf',
      sizeBytes: content.length,
      magicBytes: MAGIC,
    }),
  );
  if (target.alreadyStored !== null) {
    await markClean(target.alreadyStored.fileObjectId);
    return target.alreadyStored.fileObjectId;
  }
  const decoded = decodeTransferToken(
    SIGNING_SECRET,
    new URL(target.url).searchParams.get('token') ?? '',
    'PUT',
    FIXED_NOW,
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
  await markClean(completed.fileObjectId);
  return completed.fileObjectId;
}

async function markClean(fileObjectId: string): Promise<void> {
  await owner.fileObject.update({
    where: { id: fileObjectId },
    data: { scanStatus: ScanStatus.CLEAN, scanner: 'integration-suite', scannedAt: FIXED_NOW },
  });
}

/** A one-stage definition, published, and a type behind it. */
async function typeWith(options: { assignNumber: boolean }): Promise<string> {
  const definition = await as(() =>
    workflow.definitions.create({
      key: unique('wf-'),
      name: 'Approval',
      definition: {
        appliesTo: { documentTypes: [], condition: null },
        stages: [
          {
            name: 'Review',
            participants: [{ kind: ParticipantKind.ROLE, roleKey: 'reviewer', scope: 'TENANT' }],
            completionRule: StageCompletionRule.ALL,
            ordered: false,
            condition: null,
            deadline: null,
            reminders: [],
            onOverdue: { action: 'NOTIFY_ONLY' },
            onReject: 'TERMINATE',
            maxEscalations: 2,
          },
        ],
        onComplete: { assignNumber: options.assignNumber, publish: 'IMMEDIATELY' },
      } as never,
    }),
  );
  const draft = definition.versions[0];
  if (draft === undefined) {
    throw new Error('A new definition should carry its first draft version.');
  }
  await as(() => workflow.definitions.publish(definition.id, draft.id, definition.recordVersion));

  const type = await as(() =>
    library.configuration.createDocumentType({
      code: unique('T'),
      name: 'Procedure',
      numberingRuleId,
      defaultConfidentialityId: confidentialityId,
      revisionLabelStyle: 'NUMERIC',
      isActive: true,
      fields: [],
      workflowDefinitionId: definition.id,
    }),
  );
  return type.id;
}

async function aDocument(ofType: string = typeId): Promise<string> {
  const fileObjectId = await uploadClean(unique('content'));
  const document = await as(() =>
    library.documents.create({
      folderId: rootFolderId,
      documentTypeId: ofType,
      title: unique('Procedure '),
      fileObjectId,
      filename: 'procedure.pdf',
      origin: 'UPLOAD',
      acknowledgeDuplicate: false,
    }),
  );
  return document.id;
}

/** Submit and approve, through the real engine: the document lands in `APPROVED`, numbered. */
async function approved(documentId: string): Promise<void> {
  const { instanceId } = await as(() => workflow.engine.submit(asId<DocumentId>(documentId), null));
  const task = await owner.approvalTask.findFirstOrThrow({ where: { instanceId } });
  await as(
    () =>
      workflow.engine.decide({
        taskId: asId<ApprovalTaskId>(task.id),
        decision: TaskDecision.APPROVED,
        comment: null,
      }),
    REVIEWER,
  );
}

/** A document all the way to `PUBLISHED` — the state check-out starts from. */
async function published(ofType: string = typeId): Promise<string> {
  const documentId = await aDocument(ofType);
  await approved(documentId);
  await as(() => revision.control.publish(documentId, {}), CONTROLLER);
  return documentId;
}

/** Check-in with freshly uploaded content, as the holder. */
async function checkIn(
  documentId: string,
  options: { keepCheckedOut?: boolean; by?: UserId } = {},
): Promise<void> {
  const fileObjectId = await uploadClean(unique('revised'));
  await as(
    () =>
      revision.control.checkIn({
        documentId,
        fileObjectId,
        filename: 'procedure-r1.pdf',
        changeNote: 'Revised for clarity.',
        keepCheckedOut: options.keepCheckedOut ?? false,
      }),
    options.by ?? AUTHOR,
  );
}

async function refCountOf(fileObjectId: string): Promise<number> {
  const file = await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
  return file.refCount;
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  root = await mkdtemp(join(tmpdir(), 'munaxa-revision-'));
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

  const users = {
    get: (id: string) =>
      [AUTHOR, REVIEWER, CONTROLLER].includes(id as UserId)
        ? Promise.resolve({ id } as never)
        : Promise.reject(Object.assign(new Error('not found'), { code: 'NOT_FOUND' })),
  };

  library = realDocumentLibrary({
    clock,
    unitOfWork,
    config: appConfig,
    registry: everyTenantRegistry(APP_URL),
    storageRoot: root,
    signingSecret: SIGNING_SECRET,
    antivirus: {
      scanner: 'unconfigured',
      scan: () => Promise.reject(new Error('AV_DRIVER is NONE')),
    },
    users,
  });

  workflow = realWorkflowEngine({
    clock,
    unitOfWork,
    documents: library.documents,
    configuration: library.configuration,
    directory,
  });

  revision = realRevisionControl({
    clock,
    unitOfWork,
    documents: library.documents,
    configuration: library.configuration,
    storage: library.storage,
    storagePort: library.storagePort,
    config: appConfig,
    users,
  });

  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `rev-${String(Date.now())}-${TENANT.slice(0, 8)}`,
      name: 'Revision Control Test',
      status: 'ACTIVE',
    },
  });
  for (const id of [AUTHOR, REVIEWER, CONTROLLER]) {
    await owner.user.create({
      data: {
        id,
        tenantId: TENANT,
        email: `${id}@example.test`,
        emailNormalized: `${id}@example.test`,
        displayName: 'Test User',
        status: 'ACTIVE',
        updatedAt: FIXED_NOW,
      },
    });
  }

  const libraryRow = await as(() =>
    library.libraries.createLibrary({
      code: unique('LIB'),
      name: 'Quality',
      ownerScopeType: 'TENANT',
    }),
  );
  rootFolderId = libraryRow.rootFolderId;

  const level = await as(() =>
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
  confidentialityId = level.id;

  const rule = await as(() =>
    library.numbering.create({
      key: unique('rule-'),
      name: 'Procedures',
      separator: '-',
      segments: [
        { kind: NumberSegmentKind.LITERAL, value: 'QA' },
        { kind: NumberSegmentKind.SEQUENCE, padding: 4 },
      ],
      resetScope: ['NEVER'],
      reserveOnSubmit: true,
      strictGapless: false,
    }),
  );
  numberingRuleId = rule.id;

  typeId = await typeWith({ assignNumber: true });
  unnumberedTypeId = await typeWith({ assignNumber: false });
}, 60_000);

afterAll(async () => {
  await owner?.$disconnect();
  await rm(root, { recursive: true, force: true });
});

describe('publication', () => {
  it('publishes the approved revision and moves both machines', async () => {
    const documentId = await aDocument();

    // The two-machine rule on the way in: submission froze the draft into IN_APPROVAL.
    await approved(documentId);
    const beforePublish = await owner.documentRevision.findFirstOrThrow({
      where: { documentId },
    });
    expect(beforePublish.status).toBe(RevisionStatus.IN_APPROVAL);

    await as(() => revision.control.publish(documentId, {}), CONTROLLER);

    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe(DocumentStatus.PUBLISHED);
    expect(document.documentNumber).toMatch(/^QA-\d{4}$/);

    const revisionRow = await owner.documentRevision.findFirstOrThrow({ where: { documentId } });
    expect(revisionRow.status).toBe(RevisionStatus.PUBLISHED);
    expect(revisionRow.publishedAt).not.toBeNull();
    expect(revisionRow.effectiveFrom).not.toBeNull();
    expect(revisionRow.metadataSnapshot).not.toBeNull();
    expect(document.currentRevisionId).toBe(revisionRow.id);

    const events = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, aggregateId: documentId, eventType: 'document.published' },
    });
    expect(events).toHaveLength(1);
  });

  it('refuses an approved, unnumbered document with a sentence pointing at manual assignment', async () => {
    const documentId = await aDocument(unnumberedTypeId);
    await approved(documentId);

    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe(DocumentStatus.APPROVED);
    expect(document.documentNumber).toBeNull();

    await expect(as(() => revision.control.publish(documentId, {}), CONTROLLER)).rejects.toThrow(
      /no number/i,
    );
  });

  it('refuses a future effective date, because nothing would keep the promise', async () => {
    const documentId = await aDocument();
    await approved(documentId);

    await expect(
      as(() => revision.control.publish(documentId, { effectiveFrom: '2027-01-01' }), CONTROLLER),
    ).rejects.toThrow(/future/i);
  });

  it('lets exactly one of two racing publishes through', async () => {
    const documentId = await aDocument();
    await approved(documentId);

    const both = await Promise.allSettled([
      as(() => revision.control.publish(documentId, {}), CONTROLLER),
      as(() => revision.control.publish(documentId, {}), CONTROLLER),
    ]);
    expect(both.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);

    // The property itself, asked of the database: one PUBLISHED revision, whatever raced.
    expect(
      await owner.documentRevision.count({
        where: { documentId, status: RevisionStatus.PUBLISHED },
      }),
    ).toBe(1);
  });

  it('supersedes the prior revision in the same transaction, and the number never changes', async () => {
    const documentId = await published();
    const first = await owner.document.findUniqueOrThrow({ where: { id: documentId } });

    await as(() => revision.control.checkOut(documentId));
    await checkIn(documentId);
    await approved(documentId);
    await as(() => revision.control.publish(documentId, {}), CONTROLLER);

    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    // §4 of the numbering architecture: the number identifies the document, never the revision.
    expect(document.documentNumber).toBe(first.documentNumber);
    expect(document.status).toBe(DocumentStatus.PUBLISHED);

    const revisions = await owner.documentRevision.findMany({
      where: { documentId },
      orderBy: { ordinal: 'asc' },
    });
    expect(revisions.map((row) => row.status)).toEqual([
      RevisionStatus.SUPERSEDED,
      RevisionStatus.PUBLISHED,
    ]);
    expect(revisions.map((row) => row.label)).toEqual(['Original', 'R1']);
    // The superseded revision keeps the instant it was published — half of its history.
    expect(revisions[0]?.publishedAt).not.toBeNull();
    expect(document.currentRevisionId).toBe(revisions[1]?.id);

    const superseded = await owner.outboxMessage.count({
      where: { tenantId: TENANT, eventType: 'revision.superseded', aggregateId: revisions[0]?.id },
    });
    expect(superseded).toBe(1);
  });
});

describe('the check-out lock', () => {
  it('lets exactly one of two racing check-outs take the lock', async () => {
    const documentId = await published();

    const both = await Promise.allSettled([
      as(() => revision.control.checkOut(documentId), AUTHOR),
      as(() => revision.control.checkOut(documentId), REVIEWER),
    ]);
    expect(both.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);

    // One live lock — `uq_document_lock_live`'s answer, not the code's.
    expect(await owner.documentLock.count({ where: { documentId, releasedAt: null } })).toBe(1);
    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe(DocumentStatus.CHECKED_OUT);
  });

  it('refuses a second check-out naming the holder', async () => {
    const documentId = await published();
    await as(() => revision.control.checkOut(documentId), AUTHOR);

    await expect(as(() => revision.control.checkOut(documentId), REVIEWER)).rejects.toThrow(
      /checked out by somebody else/i,
    );
  });

  it('freezes content while CHECKED_OUT — Phase 3 wrote the rule, this reaches it', async () => {
    const documentId = await published();
    await as(() => revision.control.checkOut(documentId));

    await expect(
      as(() => library.documents.update(documentId, { title: 'Edited while locked' }, undefined)),
    ).rejects.toThrow(/cannot be edited/i);
  });

  it('checks in revision n+1 as a draft while the published revision stays effective', async () => {
    const documentId = await published();
    const before = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    await as(() => revision.control.checkOut(documentId));
    await checkIn(documentId);

    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    // The document machine moved CHECKED_OUT → DRAFT; the revision machine left the published
    // revision exactly where it was — two machines, as §1 says.
    expect(document.status).toBe(DocumentStatus.DRAFT);
    expect(document.currentRevisionId).toBe(before.currentRevisionId);

    const revisions = await owner.documentRevision.findMany({
      where: { documentId },
      orderBy: { ordinal: 'asc' },
    });
    expect(revisions).toHaveLength(2);
    expect(revisions[1]?.status).toBe(RevisionStatus.DRAFT);
    expect(revisions[1]?.label).toBe('R1');
    expect(document.latestRevisionId).toBe(revisions[1]?.id);

    const lock = await owner.documentLock.findFirstOrThrow({ where: { documentId } });
    expect(lock.releasedAt).not.toBeNull();
    expect(lock.releaseReason).toBe('CHECKED_IN');
  });

  it('refuses a check-in from anybody but the holder', async () => {
    const documentId = await published();
    await as(() => revision.control.checkOut(documentId), AUTHOR);
    const fileObjectId = await uploadClean(unique('intruder'));

    await expect(
      as(
        () =>
          revision.control.checkIn({
            documentId,
            fileObjectId,
            filename: 'procedure.pdf',
            changeNote: 'Not mine to check in.',
            keepCheckedOut: false,
          }),
        REVIEWER,
      ),
    ).rejects.toThrow(/somebody else/i);
  });

  it('discards the working draft on cancel and gives its blob back', async () => {
    const documentId = await published();
    await as(() => revision.control.checkOut(documentId));
    await checkIn(documentId, { keepCheckedOut: true });

    const draft = await owner.documentRevision.findFirstOrThrow({
      where: { documentId, ordinal: 1 },
    });
    const referenced = await refCountOf(draft.fileObjectId);

    await as(() => revision.control.cancelCheckOut(documentId));

    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe(DocumentStatus.PUBLISHED);
    expect(document.latestRevisionId).toBe(document.currentRevisionId);

    const discarded = await owner.documentRevision.findUniqueOrThrow({ where: { id: draft.id } });
    // Retained in history, its ordinal spent — and the row says what became of it.
    expect(discarded.status).toBe(RevisionStatus.DISCARDED);
    expect(await refCountOf(draft.fileObjectId)).toBe(referenced - 1);

    const lock = await owner.documentLock.findFirstOrThrow({ where: { documentId } });
    expect(lock.releaseReason).toBe('CANCELLED');
  });

  it('force check-in preserves the holder’s draft, with the reason recorded', async () => {
    const documentId = await published();
    await as(() => revision.control.checkOut(documentId), AUTHOR);
    await checkIn(documentId, { keepCheckedOut: true });

    await as(
      () =>
        revision.control.forceCheckIn(documentId, {
          note: 'Author is on leave; release for the audit.',
          discardDraft: false,
        }),
      CONTROLLER,
    );

    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    // The draft survives as the latest revision and the document lands in DRAFT — exactly as
    // if the holder had completed the check-in.
    expect(document.status).toBe(DocumentStatus.DRAFT);
    const draft = await owner.documentRevision.findFirstOrThrow({
      where: { documentId, ordinal: 1 },
    });
    expect(draft.status).toBe(RevisionStatus.DRAFT);
    expect(document.latestRevisionId).toBe(draft.id);

    const lock = await owner.documentLock.findFirstOrThrow({ where: { documentId } });
    expect(lock.releaseReason).toBe('FORCED');
    expect(lock.releaseNote).toContain('on leave');
  });

  it('sweeps an expired lock aside on the next check-out, audited as EXPIRED', async () => {
    const documentId = await published();
    await as(() => revision.control.checkOut(documentId), AUTHOR);

    // Age the claim past its expiry — the tenant-configured period has lapsed. Both stamps
    // move, because `ck_document_lock_expiry` (rightly) refuses a claim that lapsed before it
    // was taken.
    await owner.documentLock.updateMany({
      where: { documentId, releasedAt: null },
      data: {
        acquiredAt: new Date(FIXED_NOW.getTime() - 7_200_000),
        expiresAt: new Date(FIXED_NOW.getTime() - 60_000),
      },
    });

    await as(() => revision.control.checkOut(documentId), REVIEWER);

    // Identified by holder rather than by creation order: the suite's clock is fixed, so the
    // two rows share every timestamp.
    const locks = await owner.documentLock.findMany({ where: { documentId } });
    expect(locks).toHaveLength(2);
    const swept = locks.find((row) => row.lockedBy === AUTHOR);
    const takeover = locks.find((row) => row.lockedBy === REVIEWER);
    expect(swept?.releaseReason).toBe('EXPIRED');
    expect(takeover?.releasedAt).toBeNull();
  });

  it('checks several documents in as one batch, each with its own outcome', async () => {
    const first = await published();
    const second = await published();
    const notCheckedOut = await published();
    await as(() => revision.control.checkOut(first));
    await as(() => revision.control.checkOut(second));

    const [fileA, fileB, fileC] = await Promise.all([
      uploadClean(unique('batch-a')),
      uploadClean(unique('batch-b')),
      uploadClean(unique('batch-c')),
    ]);
    const outcomes = await as(() =>
      revision.control.checkInMany([
        {
          documentId: first,
          fileObjectId: fileA,
          filename: 'a.pdf',
          changeNote: 'Batch revision A.',
        },
        {
          documentId: second,
          fileObjectId: fileB,
          filename: 'b.pdf',
          changeNote: 'Batch revision B.',
        },
        {
          documentId: notCheckedOut,
          fileObjectId: fileC,
          filename: 'c.pdf',
          changeNote: 'Never checked out.',
        },
      ]),
    );

    // Two complete facts and one refusal — the failed item takes nothing else with it.
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true, false]);
  });
});

describe('restore', () => {
  it('creates a new revision referencing the old blob — a row, not a copy', async () => {
    const documentId = await published();
    const original = await owner.documentRevision.findFirstOrThrow({
      where: { documentId, ordinal: 0 },
    });

    // Revise and publish, so the original is superseded history.
    await as(() => revision.control.checkOut(documentId));
    await checkIn(documentId);
    await approved(documentId);
    await as(() => revision.control.publish(documentId, {}), CONTROLLER);

    const blobs = await owner.fileObject.count({ where: { tenantId: TENANT } });
    const referenced = await refCountOf(original.fileObjectId);

    await as(() => revision.control.restoreRevision(documentId, original.id, {}));

    const restored = await owner.documentRevision.findFirstOrThrow({
      where: { documentId, ordinal: 2 },
    });
    expect(restored.status).toBe(RevisionStatus.DRAFT);
    expect(restored.label).toBe('R2');
    expect(restored.fileObjectId).toBe(original.fileObjectId);
    expect(restored.restoredFromRevisionId).toBe(original.id);

    // The cost, in rows: one more reference on the same blob, and no new blob at all.
    expect(await refCountOf(original.fileObjectId)).toBe(referenced + 1);
    expect(await owner.fileObject.count({ where: { tenantId: TENANT } })).toBe(blobs);

    // The ordinal sequence stays contiguous and the old revision is untouched evidence.
    const untouched = await owner.documentRevision.findUniqueOrThrow({
      where: { id: original.id },
    });
    expect(untouched.status).toBe(RevisionStatus.SUPERSEDED);

    const events = await owner.outboxMessage.count({
      where: { tenantId: TENANT, eventType: 'revision.restored', aggregateId: restored.id },
    });
    expect(events).toBe(1);

    // Restore never rewinds: the document holds a draft that goes through approval like any
    // other change.
    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe(DocumentStatus.DRAFT);
  });

  it('refuses to restore the revision that is already published', async () => {
    const documentId = await published();
    const current = await owner.documentRevision.findFirstOrThrow({ where: { documentId } });

    await expect(
      as(() => revision.control.restoreRevision(documentId, current.id, {})),
    ).rejects.toThrow(/already the published one/i);
  });

  it('the database refuses a restore source belonging to another document', async () => {
    const documentId = await published();
    const other = await published();
    const foreign = await owner.documentRevision.findFirstOrThrow({
      where: { documentId: other },
    });
    const mine = await owner.documentRevision.findFirstOrThrow({ where: { documentId } });

    // Below the use case: the trigger holds even for a raw write by the owner role.
    await expect(
      owner.documentRevision.update({
        where: { id: mine.id },
        data: { restoredFromRevisionId: foreign.id },
      }),
    ).rejects.toThrow(/cannot restore/i);
  });
});

describe('history and compare', () => {
  it('lists every revision, discarded ones included, oldest first', async () => {
    const documentId = await published();
    await as(() => revision.control.checkOut(documentId));
    await checkIn(documentId, { keepCheckedOut: true });
    await as(() => revision.control.cancelCheckOut(documentId));

    const history = await as(() => revision.revisionQueries.history(documentId));
    expect(history.map((row) => row.ordinal)).toEqual([0, 1]);
    expect(history.map((row) => row.status)).toEqual([
      RevisionStatus.PUBLISHED,
      RevisionStatus.DISCARDED,
    ]);
    expect(history[0]?.createdByName).toBe('Test User');
  });

  it('compares by checksum, and restored content reads as identical', async () => {
    const documentId = await published();
    const original = await owner.documentRevision.findFirstOrThrow({
      where: { documentId, ordinal: 0 },
    });
    await as(() => revision.control.checkOut(documentId));
    await checkIn(documentId);
    await approved(documentId);
    await as(() => revision.control.publish(documentId, {}), CONTROLLER);
    await as(() => revision.control.restoreRevision(documentId, original.id, {}));

    const changed = await as(() => revision.revisionQueries.compare(documentId, 0, 1));
    expect(changed.content.identical).toBe(false);
    // Both sides published, so the snapshots exist and the metadata diff is answerable.
    expect(changed.metadata.available).toBe(true);

    const identical = await as(() => revision.revisionQueries.compare(documentId, 0, 2));
    expect(identical.content.identical).toBe(true);
    // One side is a draft: no approved snapshot yet, and the answer says so rather than
    // diffing live values that prove nothing.
    expect(identical.metadata.available).toBe(false);
  });
});
