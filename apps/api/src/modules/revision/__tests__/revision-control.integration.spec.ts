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
let revisionOptions: Parameters<typeof realRevisionControl>[0];
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
/**
 * The ambient context the `retention.run` lane builds for a scheduled pass: a tenant, and no user.
 * Mirrors `RetentionLaneConsumer.systemContext` rather than approximating it.
 */
function asSystem<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext({ ...contextFor(CONTROLLER), userId: null, permissions: [] }, work);
}

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

  revisionOptions = {
    clock,
    unitOfWork,
    documents: library.documents,
    configuration: library.configuration,
    storage: library.storage,
    storagePort: library.storagePort,
    config: appConfig,
    users,
  };
  revision = realRevisionControl(revisionOptions);

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

/**
 * Archival, reinstatement and expiry — Phase 6.1, against the same real PostgreSQL.
 *
 * In this suite rather than a new one because every assertion below starts from a *published*
 * document, and this file is the one that can produce one: the upload, the type, the workflow, the
 * number and the publication are already here. A second harness would be four hundred lines of
 * duplicate setup to reach the same first line.
 *
 * What only a database can be asked, and therefore why these are integration tests rather than unit
 * tests of the service:
 *
 *  - **The audit row commits with the status change.** One transaction, one row, and no row at all
 *    when the transition is refused.
 *  - **Two concurrent archives produce one transition.** The optimistic version guard is the
 *    referee and only PostgreSQL can say which write lost.
 *  - **The sweep's candidate query is a `date` comparison.** The boundary is a property of how
 *    PostgreSQL stores and compares `effective_to`, and a stubbed repository would be asserting the
 *    stub's arithmetic.
 */
describe('archival and reinstatement', () => {
  it('archives a published document, with one ARCHIVED row carrying the reason', async () => {
    const documentId = await published();

    const before = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    await as(
      () => library.documents.archive(documentId, before.version, 'Superseded by QA-0002'),
      CONTROLLER,
    );

    const after = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after.status).toBe(DocumentStatus.ARCHIVED);

    const rows = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, subjectId: documentId, action: 'ARCHIVED' },
    });
    expect(rows).toHaveLength(1);
    // The reason is in the trail's own attested column, not in the payload — Phase 9 widened the
    // hash digest to cover it, so this is the half an auditor can prove was not edited.
    expect(rows[0]?.reason).toBe('Superseded by QA-0002');
    expect(rows[0]?.actorId).toBe(CONTROLLER);
    expect((rows[0]?.payload as { after?: { via?: string } }).after?.via).toBe('EXPLICIT');

    const events = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, aggregateId: documentId, eventType: 'document.archived' },
    });
    expect(events).toHaveLength(1);
  });

  it('refuses a blank reason before it touches anything', async () => {
    const documentId = await published();
    const before = await owner.document.findUniqueOrThrow({ where: { id: documentId } });

    await expect(
      as(() => library.documents.archive(documentId, before.version, '   '), CONTROLLER),
    ).rejects.toThrow(/reason/i);

    const after = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after.status).toBe(DocumentStatus.PUBLISHED);
  });

  it('is idempotent: archiving an archived document succeeds and adds no second transition', async () => {
    const documentId = await published();
    const first = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    await as(() => library.documents.archive(documentId, first.version, 'Retired'), CONTROLLER);

    const second = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    await as(
      () => library.documents.archive(documentId, second.version, 'Retired again'),
      CONTROLLER,
    );

    const still = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(still.status).toBe(DocumentStatus.ARCHIVED);

    // Two rows, because two people asked and the trail records what was asked — but the second is
    // marked `unchanged`, and only one `document.archived` event was ever published, because only
    // one of them was a transition.
    const rows = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, subjectId: documentId, action: 'ARCHIVED' },
      orderBy: { sequence: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect((rows[1]?.payload as { after?: { unchanged?: boolean } }).after?.unchanged).toBe(true);

    const events = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, aggregateId: documentId, eventType: 'document.archived' },
    });
    expect(events).toHaveLength(1);
  });

  it('refuses an archive from a state the table does not allow, and writes nothing', async () => {
    // A draft: the invalid-transition case, and the one that proves the refusal is atomic — a
    // rejected transition leaves neither a status change nor an audit row behind it.
    const documentId = await aDocument();
    const before = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(before.status).toBe(DocumentStatus.DRAFT);

    await expect(
      as(() => library.documents.archive(documentId, before.version, 'Too early'), CONTROLLER),
    ).rejects.toThrow(/DRAFT/);

    const after = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after.status).toBe(DocumentStatus.DRAFT);
    expect(after.version).toBe(before.version);
    const rows = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, subjectId: documentId, action: 'ARCHIVED' },
    });
    expect(rows).toHaveLength(0);
  });

  it('refuses an archive decided against a version somebody has since moved on', async () => {
    const documentId = await published();
    const before = await owner.document.findUniqueOrThrow({ where: { id: documentId } });

    await expect(
      as(() => library.documents.archive(documentId, before.version - 1, 'Stale'), CONTROLLER),
    ).rejects.toThrow();

    const after = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after.status).toBe(DocumentStatus.PUBLISHED);
  });

  it('lets two racing archives produce exactly one transition', async () => {
    const documentId = await published();
    const before = await owner.document.findUniqueOrThrow({ where: { id: documentId } });

    const both = await Promise.allSettled([
      as(() => library.documents.archive(documentId, before.version, 'First'), CONTROLLER),
      as(() => library.documents.archive(documentId, before.version, 'Second'), CONTROLLER),
    ]);

    // **Not "exactly one call succeeds"** — Phase 6.1 asserted that and it was wrong, which is why
    // it flaked. Both calls legitimately succeed when the loser arrives after the winner committed:
    // it re-reads an already-`ARCHIVED` document and takes `applyLifecycleTransition`'s idempotent
    // no-op path, which is a success by design. The loser that arrives *before* the commit gets a
    // version conflict. Which of the two happens is a scheduling detail, and asserting it made a
    // correct implementation fail intermittently.
    //
    // The invariant is what matters and it holds either way: the document transitioned once.
    expect(both.filter((outcome) => outcome.status === 'fulfilled').length).toBeGreaterThanOrEqual(
      1,
    );

    const after = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after.status).toBe(DocumentStatus.ARCHIVED);
    // One transition, so exactly one event — whatever raced, and whatever succeeded.
    const events = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, aggregateId: documentId, eventType: 'document.archived' },
    });
    expect(events).toHaveLength(1);
  });

  it('reinstates an archived document, with a REINSTATED row of its own', async () => {
    const documentId = await published();
    const archivedFrom = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    await as(
      () => library.documents.archive(documentId, archivedFrom.version, 'Retired'),
      CONTROLLER,
    );

    const archived = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    await as(
      () => library.documents.reinstate(documentId, archived.version, 'Withdrawn in error'),
      CONTROLLER,
    );

    const after = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after.status).toBe(DocumentStatus.PUBLISHED);

    const rows = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, subjectId: documentId, action: 'REINSTATED' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('Withdrawn in error');
    // Distinct from a recycle-bin restore, which is what the separate action exists to say.
    const restores = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, subjectId: documentId, action: 'RESTORED' },
    });
    expect(restores).toHaveLength(0);
  });

  it('refuses to reinstate a document whose effective window has closed', async () => {
    const documentId = await aDocument();
    await approved(documentId);
    await as(
      () =>
        revision.control.publish(documentId, {
          effectiveFrom: '2026-01-01',
          effectiveTo: '2026-01-31',
        }),
      CONTROLLER,
    );
    const published0 = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    await as(
      () => library.documents.archive(documentId, published0.version, 'Retired'),
      CONTROLLER,
    );

    const archived = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    await expect(
      as(
        () => library.documents.reinstate(documentId, archived.version, 'Bring it back'),
        CONTROLLER,
      ),
    ).rejects.toThrow(/2026-01-31/);

    // Still archived: refusing is the whole point — reinstating would publish a document the very
    // next sweep would expire again, for a decision nobody took.
    const after = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after.status).toBe(DocumentStatus.ARCHIVED);
  });

  it('refuses to archive another tenant’s document', async () => {
    const documentId = await published();
    const before = await owner.document.findUniqueOrThrow({ where: { id: documentId } });

    // Same database, a different tenant in the ambient context: the repository's own `tenant_id`
    // predicate is what must refuse, and a `404` rather than a `403` is 08 §7's rule — the
    // existence of another tenant's document is not a fact this caller may learn.
    // (Cross-*database* isolation under ADR-0015 is `tenant-isolation.integration.spec.ts`'s.)
    const otherTenant = asId<TenantId>(uuidv7());
    await expect(
      runWithContext({ ...contextFor(CONTROLLER), tenantId: otherTenant }, () =>
        library.documents.archive(documentId, before.version, 'Not mine'),
      ),
    ).rejects.toThrow(/not found|requested resource/i);

    const after = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after.status).toBe(DocumentStatus.PUBLISHED);
  });
});

describe('the effective-window sweep', () => {
  /** Publishes with an explicit window, which is what makes a document expirable. */
  async function publishedWithWindow(from: string, to: string): Promise<string> {
    const documentId = await aDocument();
    await approved(documentId);
    await as(
      () => revision.control.publish(documentId, { effectiveFrom: from, effectiveTo: to }),
      CONTROLLER,
    );
    return documentId;
  }

  it('expires a document whose window closed, and records the arithmetic', async () => {
    const documentId = await publishedWithWindow('2026-01-01', '2026-01-31');

    // Run the way the lane runs it: `RetentionLaneConsumer.systemContext` has no user, because
    // nobody made this decision — the calendar did. Asserting a null actor only means something
    // if the pass was invoked the way production invokes it.
    const pass = await asSystem(() => library.documents.expireEffective(50));
    expect(pass.expired).toBeGreaterThanOrEqual(1);

    const after = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after.status).toBe(DocumentStatus.EXPIRED);

    const rows = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, subjectId: documentId, action: 'EXPIRED' },
    });
    expect(rows).toHaveLength(1);
    const payload = rows[0]?.payload as {
      after?: { effectiveTo?: string; evaluatedOn?: string; timezone?: string };
    };
    expect(payload.after?.effectiveTo).toBe('2026-01-31');
    expect(payload.after?.evaluatedOn).toBe('2026-03-02');
    expect(payload.after?.timezone).toBe('UTC');
    // The system acted alone, which is what makes "changes nobody made" a filterable question.
    expect(rows[0]?.actorId).toBeNull();

    const events = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, aggregateId: documentId, eventType: 'document.expired' },
    });
    expect(events).toHaveLength(1);
  });

  it('does not expire a window that ends today — the boundary is inclusive', async () => {
    // The clock is frozen at 2026-03-02. A window ending today is one the document is still
    // effective for, so it must survive this pass and expire on the next day's.
    const documentId = await publishedWithWindow('2026-01-01', '2026-03-02');

    await as(() => library.documents.expireEffective(50), CONTROLLER);

    const after = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after.status).toBe(DocumentStatus.PUBLISHED);
  });

  it('expires a window that ended yesterday — the other side of the same boundary', async () => {
    const documentId = await publishedWithWindow('2026-01-01', '2026-03-01');

    await as(() => library.documents.expireEffective(50), CONTROLLER);

    const after = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after.status).toBe(DocumentStatus.EXPIRED);
  });

  it('leaves a document with no effective window alone, forever', async () => {
    const documentId = await published();

    await as(() => library.documents.expireEffective(50), CONTROLLER);

    const after = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after.status).toBe(DocumentStatus.PUBLISHED);
  });

  it('is retry-safe: a second pass expires nothing again and writes no second row', async () => {
    const documentId = await publishedWithWindow('2026-01-01', '2026-01-31');
    await as(() => library.documents.expireEffective(50), CONTROLLER);

    // The redelivery case. The candidate query names `PUBLISHED` documents, so an expired one is
    // no longer a candidate — which is what makes the job idempotent without a dedupe table.
    const second = await as(() => library.documents.expireEffective(50), CONTROLLER);
    expect(second.examined, 'an already-expired document must not be a candidate again').toBe(0);

    const rows = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, subjectId: documentId, action: 'EXPIRED' },
    });
    expect(rows).toHaveLength(1);
  });

  it('settles each document in its own transaction, so one conflict does not lose the batch', async () => {
    const first = await publishedWithWindow('2026-01-01', '2026-01-31');
    const second = await publishedWithWindow('2026-01-02', '2026-02-01');

    const pass = await as(() => library.documents.expireEffective(50), CONTROLLER);
    expect(pass.expired).toBeGreaterThanOrEqual(2);

    for (const documentId of [first, second]) {
      const row = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
      expect(row.status).toBe(DocumentStatus.EXPIRED);
    }
  });

  it('expires nothing for a tenant that owns nothing', async () => {
    await publishedWithWindow('2026-01-01', '2026-01-31');

    const otherTenant = asId<TenantId>(uuidv7());
    const pass = await runWithContext({ ...contextFor(CONTROLLER), tenantId: otherTenant }, () =>
      library.documents.expireEffective(50),
    );
    expect(pass.examined).toBe(0);
    expect(pass.expired).toBe(0);
  });
});

/**
 * Two administrators cancelling one check-out at the same moment — Slice 49.
 *
 * `endCheckOut` reads the document, reads the live lock, moves the document and then releases.
 * `applyLifecycleTransition` is idempotent when the document already holds the status asked for,
 * so the loser's transition found the document already `PUBLISHED` and returned without a version
 * check — nothing refused it, and it filed a second `CHECKOUT_CANCELLED` for a check-out that had
 * been cancelled once. The lock's own affected-row count is what says who ended it.
 */
describe('two cancels of one check-out', () => {
  async function cancellations(documentId: string, since: number): Promise<number> {
    return (
      (await owner.auditEvent.count({
        where: { tenantId: TENANT, action: 'CHECKOUT_CANCELLED', subjectId: documentId },
      })) - since
    );
  }

  function filed(documentId: string): Promise<number> {
    return owner.auditEvent.count({
      where: { tenantId: TENANT, action: 'CHECKOUT_CANCELLED', subjectId: documentId },
    });
  }

  it('cancels once when one person cancels', async () => {
    const documentId = await published();
    await as(() => revision.control.checkOut(documentId), AUTHOR);
    const before = await filed(documentId);

    await as(() => revision.control.cancelCheckOut(documentId), AUTHOR);

    expect(await cancellations(documentId, before)).toBe(1);
    expect(await owner.documentLock.count({ where: { documentId, releasedAt: null } })).toBe(0);
    expect((await owner.document.findUniqueOrThrow({ where: { id: documentId } })).status).toBe(
      'PUBLISHED',
    );
  });

  it('refuses a second cancel issued in order, and files nothing for it', async () => {
    const documentId = await published();
    await as(() => revision.control.checkOut(documentId), AUTHOR);
    await as(() => revision.control.cancelCheckOut(documentId), AUTHOR);
    const before = await filed(documentId);

    // The sequential second caller, which is the answer the concurrent one has to match.
    await expect(
      as(() => revision.control.cancelCheckOut(documentId), AUTHOR),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await cancellations(documentId, before)).toBe(0);
  });

  it('refuses a cancel whose live lock was ended underneath it, and files one cancellation', async () => {
    const documentId = await published();
    await as(() => revision.control.checkOut(documentId), AUTHOR);
    const before = await filed(documentId);

    /*
     * The seam: the *real* lock repository, wrapped for one of the two callers only.
     *
     * The stalling caller answers `liveFor` truthfully and then waits — after the answer rather
     * than before it, because the interleaving worth proving is a transaction that read a live
     * lock and then stalled, which is the only way to reach the transition's idempotent branch.
     * Wrapping one caller rather than counting arrivals is what makes it deterministic: which of
     * two identical calls reaches the port first is the scheduler's business, and nothing here
     * depends on it.
     */
    let admit: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const held = new Proxy(revision.locks, {
      get(target, property, receiver) {
        if (property === 'liveFor') {
          return async (...args: readonly unknown[]) => {
            const answer = await (
              target.liveFor as (...rest: readonly unknown[]) => Promise<unknown>
            )(...args);
            await stalled;
            return answer;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...rest: readonly unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const stalling = realRevisionControl({ ...revisionOptions, locks: held }).control;

    // The stalling cancel reads the live lock, then waits inside its own transaction.
    const loser = as(() => stalling.cancelCheckOut(documentId), AUTHOR);
    // The other cancel runs to completion while it waits, and ends the check-out.
    await as(() => revision.control.cancelCheckOut(documentId), AUTHOR);
    admit();

    await expect(loser).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    // One check-out was cancelled once; a second row would name somebody for an act the lock
    // says they did not perform.
    expect(await cancellations(documentId, before)).toBe(1);
    expect(await owner.documentLock.count({ where: { documentId, releasedAt: null } })).toBe(0);
  });

  it('still lets the holder check in, and check out again afterwards', async () => {
    const documentId = await published();
    await as(() => revision.control.checkOut(documentId), AUTHOR);

    // The claim must refuse a lost race without refusing the ordinary path that always wins.
    const fileObjectId = await uploadClean(unique('revised'));
    await as(() =>
      revision.control.checkIn({
        documentId,
        fileObjectId,
        filename: 'revised.pdf',
        changeNote: 'second draft',
        keepCheckedOut: false,
      }),
    );
    expect(await owner.documentLock.count({ where: { documentId, releasedAt: null } })).toBe(0);

    // The check-in left the document in DRAFT, which is where the next check-out starts from on
    // a document that has one; a fresh publication is what the check-out machine takes.
    const second = await published();
    await as(() => revision.control.checkOut(second), AUTHOR);
    expect(
      await owner.documentLock.count({ where: { documentId: second, releasedAt: null } }),
    ).toBe(1);
    await as(() => revision.control.cancelCheckOut(second), AUTHOR);
    expect(
      await owner.documentLock.count({ where: { documentId: second, releasedAt: null } }),
    ).toBe(0);
  });
});
