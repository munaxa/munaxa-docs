import 'reflect-metadata';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ApprovalTaskState,
  DocumentStatus,
  NumberSegmentKind,
  ParticipantKind,
  ScanStatus,
  StageCompletionRule,
  TaskDecision,
  type ApprovalTaskId,
  type DocumentId,
  type NumberingRuleId,
  type TenantId,
  type UploadSessionId,
  type UserId,
  type WorkflowInstanceId,
  WorkflowInstanceStatus,
  WorkflowPauseReason,
  WorkflowStageStatus,
  WorkflowTimerState,
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
  type WorkflowEngineStack,
  realDocumentLibrary,
  realWorkflowEngine,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import type { WorkflowDirectory } from '../application/ports';

/**
 * The approval engine, against a real PostgreSQL.
 *
 * The phase's prompt named three properties that only a database can be asked about, and they are
 * the reason this suite exists rather than a set of service tests over doubles:
 *
 *  - **A decided-once task.** Two transactions racing to decide one task produce one decision and
 *    one conflict. A double cannot be wrong about that, because it is written from the same belief
 *    as the code it stands in for; a conditional `UPDATE … WHERE decision IS NULL` either matches a
 *    row or it does not, and only PostgreSQL can say which.
 *  - **A quorum counted under concurrency.** Three approvers, a quorum of two, two of them deciding
 *    at the same instant: the stage completes exactly once and the third task is superseded rather
 *    than left pending or decided twice.
 *  - **A rolled-back decision.** A decision whose transaction fails leaves no task decided, no
 *    audit event, no outbox row and no stage moved — which is the whole of "one transaction per
 *    decision" and is not observable anywhere but in the rows afterwards.
 *
 * Everything else here is a property of the same kind: a timer paused and resumed with the duration
 * it had left, a submission refused because nobody resolved, a document frozen the moment it is
 * handed to a workflow. The engine's *arithmetic* — completion rules, conditions, deadline walking
 * — is unit-tested where it belongs, purely, in `domain/`.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

/** A Monday, so the working-day arithmetic in the assertions reads off a wall calendar. */
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
const APPROVER = asId<UserId>(uuidv7());
const MANAGER = asId<UserId>(uuidv7());

const SIGNING_SECRET = 'a-workflow-integration-secret-of-32-chars';
const MAGIC = new Uint8Array(Buffer.from('%PDF-1.7\n% ', 'utf8'));

let root: string;
let owner: PrismaClient;
let library: DocumentLibraryStack;
let workflow: WorkflowEngineStack;
let unitOfWork: PrismaUnitOfWork;

let rootFolderId: string;
let confidentialityId: string;
let numberingRuleId: string;

/**
 * Who works here, stood in for.
 *
 * `ROLE`, `DEPARTMENT` and `MANAGER_OF` are Identity's reads and are asserted in Identity's own
 * suite; what this one needs is control over *what a resolver returns*, so that "a resolver that
 * yields nobody fails submission loudly" can be provoked. `activeAmong` is honest — it filters
 * against a set this suite controls — because that filter is what the refusal depends on.
 */
const inactive = new Set<string>();
const directory: WorkflowDirectory = {
  holdersOfRole: (roleKey) =>
    Promise.resolve(roleKey === 'reviewer' ? [REVIEWER] : roleKey === 'approver' ? [APPROVER] : []),
  membersOfDepartment: () => Promise.resolve([REVIEWER, APPROVER]),
  managersOf: () => Promise.resolve([MANAGER]),
  membersOfGroup: (groupKey) => Promise.resolve(groupKey === 'safety' ? [REVIEWER, APPROVER] : []),
  activeAmong: (ids) => Promise.resolve(ids.filter((id) => !inactive.has(id))),
  displayNames: (ids) => Promise.resolve(new Map(ids.map((id) => [id, 'Test User']))),
};

function contextFor(userId: UserId): RequestContext {
  return {
    tenantId: TENANT,
    userId,
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: 'workflow-engine',
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

/** The upload handshake, as the library suite performs it. Nothing here is short-circuited. */
async function uploadClean(marker: string): Promise<string> {
  const content = aPdf(marker);
  const target = await as(() =>
    library.storage.createUploadSession({
      filename: 'procedure.pdf',
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

/**
 * A document type with a published workflow behind it.
 *
 * Built through the real services in every case — a definition is created, a version is published,
 * and a type is created pointing at the definition — because "an instance binds to a published
 * version" is a property the database enforces with a trigger, and a seeded row would sidestep it.
 */
async function typeWithWorkflow(
  stages: readonly unknown[],
  ruleId: string = numberingRuleId,
): Promise<string> {
  const definition = await as(() =>
    workflow.definitions.create({
      key: unique('wf-'),
      name: 'Approval',
      definition: {
        appliesTo: { documentTypes: [], condition: null },
        stages: stages as never,
        onComplete: { assignNumber: true, publish: 'IMMEDIATELY' },
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
      numberingRuleId: ruleId,
      defaultConfidentialityId: confidentialityId,
      revisionLabelStyle: 'NUMERIC',
      isActive: true,
      fields: [],
      workflowDefinitionId: definition.id,
    }),
  );
  return type.id;
}

/** A one-stage definition with one `ROLE` resolver, which most of these assertions want. */
function oneStage(
  overrides: Record<string, unknown> = {},
  roleKey = 'reviewer',
): readonly unknown[] {
  return [
    {
      name: 'Review',
      participants: [{ kind: ParticipantKind.ROLE, roleKey, scope: 'TENANT' }],
      completionRule: StageCompletionRule.ALL,
      ordered: false,
      condition: null,
      deadline: null,
      reminders: [],
      onOverdue: { action: 'NOTIFY_ONLY' },
      onReject: 'TERMINATE',
      maxEscalations: 2,
      ...overrides,
    },
  ];
}

async function aDocument(documentTypeId: string): Promise<string> {
  const fileObjectId = await uploadClean(unique('content'));
  const document = await as(() =>
    library.documents.create({
      folderId: rootFolderId,
      documentTypeId,
      title: unique('Procedure '),
      fileObjectId,
      filename: 'procedure.pdf',
      origin: 'UPLOAD',
      acknowledgeDuplicate: false,
    }),
  );
  return document.id;
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  root = await mkdtemp(join(tmpdir(), 'munaxa-workflow-'));
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
      scan: () => Promise.reject(new Error('AV_DRIVER is NONE')),
    },
    users: {
      get: (id: string) =>
        [AUTHOR, REVIEWER, APPROVER, MANAGER].includes(id as UserId)
          ? Promise.resolve({ id } as never)
          : Promise.reject(Object.assign(new Error('not found'), { code: 'NOT_FOUND' })),
    },
  });

  workflow = realWorkflowEngine({
    clock,
    unitOfWork,
    documents: library.documents,
    configuration: library.configuration,
    directory,
  });
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `wf-${String(Date.now())}-${TENANT.slice(0, 8)}`,
      name: 'Workflow Engine Test',
      status: 'ACTIVE',
    },
  });
  for (const id of [AUTHOR, REVIEWER, APPROVER, MANAGER]) {
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
        { kind: NumberSegmentKind.SEQUENCE, padding: 3 },
      ],
      resetScope: ['NEVER'],
      reserveOnSubmit: true,
      strictGapless: false,
    }),
  );
  numberingRuleId = rule.id;
}, 60_000);

afterAll(async () => {
  await owner?.$disconnect();
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  inactive.clear();
  workflow.enqueued.length = 0;
  workflow.cancelled.length = 0;
});

describe('submission', () => {
  it('binds an instance to the published version and freezes the document', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);

    const result = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), 'Please review.'),
    );

    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe(DocumentStatus.UNDER_REVIEW);

    const instance = await owner.workflowInstance.findUniqueOrThrow({
      where: { id: result.instanceId },
      include: { workflowVersion: true, stages: true, tasks: true },
    });
    // Bound to a *version*, and to a published one — which the database enforces with a trigger as
    // well, because "which rules was this approved under" has to stay answerable years later.
    expect(instance.workflowVersion.state).toBe('PUBLISHED');
    expect(instance.stages).toHaveLength(1);
    expect(instance.stages[0]?.state).toBe(WorkflowStageStatus.ACTIVE);
    expect(instance.tasks.map((task) => task.assigneeId)).toEqual([REVIEWER]);

    // The frozen rule, which Phase 3 wrote and nothing could make fire until now.
    await expect(
      as(() => library.documents.update(documentId, { title: 'Edited under review' }, undefined)),
    ).rejects.toThrow(/in approval/i);
  });

  it('records why each person was asked', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    const result = await as(() => workflow.engine.submit(asId<DocumentId>(documentId), null));

    const task = await owner.approvalTask.findFirstOrThrow({
      where: { instanceId: result.instanceId },
    });
    // The resolver that produced them, so "why am I being asked to approve this" has an answer that
    // is not "somebody configured something".
    expect(task.resolvedBy).toBe('ROLE:reviewer@TENANT');
  });

  it('fails loudly when a resolver yields nobody, and starts nothing', async () => {
    const typeId = await typeWithWorkflow(oneStage({}, 'nobody-holds-this'));
    const documentId = await aDocument(typeId);

    await expect(
      as(() => workflow.engine.submit(asId<DocumentId>(documentId), null)),
    ).rejects.toThrow(/No one could be found/i);

    // §8: the engine must never skip a stage whose participants resolve empty. The whole submission
    // is refused, so there is no instance and the document is still a draft the author can fix.
    expect(await owner.workflowInstance.count({ where: { documentId } })).toBe(0);
    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe(DocumentStatus.DRAFT);
  });

  it('fails loudly when every resolved person is inactive', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    inactive.add(REVIEWER);

    await expect(
      as(() => workflow.engine.submit(asId<DocumentId>(documentId), null)),
    ).rejects.toThrow(/No one could be found/i);
    expect(await owner.workflowInstance.count({ where: { documentId } })).toBe(0);
  });

  it('refuses a second submission while one is running', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    await as(() => workflow.engine.submit(asId<DocumentId>(documentId), null));

    // The document is frozen the moment it is handed to a workflow, so the second attempt is
    // refused on its status before it ever gets as far as looking for a running instance. That is
    // the better message — an author is told their document is already under review, not that a
    // record they cannot see exists.
    await expect(
      as(() => workflow.engine.submit(asId<DocumentId>(documentId), null)),
    ).rejects.toThrow(/Only a draft can be submitted/i);
  });

  it('lets only one of two racing submissions create an approval', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);

    // Both start from `DRAFT`, so both pass the polite check. What separates them is the partial
    // unique index on `(document_id) WHERE state IN (RUNNING, PAUSED)` — which is why the index
    // exists as well as the check, and why this assertion is here rather than over a double.
    const both = await Promise.allSettled([
      as(() => workflow.engine.submit(asId<DocumentId>(documentId), null)),
      as(() => workflow.engine.submit(asId<DocumentId>(documentId), null)),
    ]);
    expect(both.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(
      await owner.workflowInstance.count({
        where: { documentId, state: { in: ['RUNNING', 'PAUSED'] } },
      }),
    ).toBe(1);
  });
});

describe('deciding', () => {
  it('decides a task exactly once, under concurrency', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );
    const task = await owner.approvalTask.findFirstOrThrow({ where: { instanceId } });

    // Two decisions on one task, started together. `decideIfPending` carries `decision IS NULL` in
    // its `WHERE`, so exactly one statement matches a row — and the other gets zero rows affected,
    // which the engine reports as a conflict rather than as an overwrite (§8).
    const both = await Promise.allSettled([
      as(
        () =>
          workflow.engine.decide({
            taskId: asId<ApprovalTaskId>(task.id),
            decision: TaskDecision.APPROVED,
            comment: null,
          }),
        REVIEWER,
      ),
      as(
        () =>
          workflow.engine.decide({
            taskId: asId<ApprovalTaskId>(task.id),
            decision: TaskDecision.APPROVED,
            comment: null,
          }),
        REVIEWER,
      ),
    ]);

    expect(both.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(both.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

    const decided = await owner.approvalTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(decided.decision).toBe(TaskDecision.APPROVED);
    // One decision, and one version bump. Two would mean the row was written twice.
    expect(decided.version).toBe(2);
  });

  it('counts a quorum correctly when two people decide at the same instant', async () => {
    const typeId = await typeWithWorkflow(
      oneStage({
        participants: [
          { kind: ParticipantKind.ROLE, roleKey: 'reviewer', scope: 'TENANT' },
          { kind: ParticipantKind.ROLE, roleKey: 'approver', scope: 'TENANT' },
          { kind: ParticipantKind.MANAGER_OF, of: 'AUTHOR' },
        ],
        completionRule: StageCompletionRule.QUORUM,
        threshold: 2,
      }),
    );
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );
    const tasks = await owner.approvalTask.findMany({
      where: { instanceId },
      orderBy: { id: 'asc' },
    });
    expect(tasks).toHaveLength(3);

    const [first, second] = tasks;
    await Promise.all([
      as(
        () =>
          workflow.engine.decide({
            taskId: asId<ApprovalTaskId>(first!.id),
            decision: TaskDecision.APPROVED,
            comment: null,
          }),
        first!.assigneeId as UserId,
      ),
      as(
        () =>
          workflow.engine.decide({
            taskId: asId<ApprovalTaskId>(second!.id),
            decision: TaskDecision.APPROVED,
            comment: null,
          }),
        second!.assigneeId as UserId,
      ),
    ]);

    const after = await owner.workflowInstance.findUniqueOrThrow({
      where: { id: instanceId },
      include: { stages: true, tasks: true },
    });
    // The quorum was met exactly once: the stage completed, the instance completed with it, and the
    // third task was superseded rather than left pending or decided by nobody.
    expect(after.state).toBe(WorkflowInstanceStatus.COMPLETED);
    expect(after.stages[0]?.state).toBe(WorkflowStageStatus.COMPLETED);
    expect(after.tasks.filter((task) => task.decision === TaskDecision.APPROVED)).toHaveLength(2);
    expect(after.tasks.filter((task) => task.state === ApprovalTaskState.SUPERSEDED)).toHaveLength(
      1,
    );

    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe(DocumentStatus.APPROVED);
  });

  it('leaves nothing behind when a decision rolls back', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );
    const task = await owner.approvalTask.findFirstOrThrow({ where: { instanceId } });

    const auditBefore = await owner.auditEvent.count({ where: { tenantId: TENANT } });
    const outboxBefore = await owner.outboxMessage.count({ where: { tenantId: TENANT } });

    // A rejection with no comment. The engine refuses it *after* the transaction has opened, which
    // is what makes this a rollback rather than a validation that never wrote anything: the check
    // sits beside the writes, and the whole unit of work is what must come back.
    await expect(
      as(
        () =>
          workflow.engine.decide({
            taskId: asId<ApprovalTaskId>(task.id),
            decision: TaskDecision.REJECTED,
            comment: null,
          }),
        REVIEWER,
      ),
    ).rejects.toThrow(/say why/i);

    const untouched = await owner.approvalTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(untouched.decision).toBeNull();
    expect(untouched.state).toBe(ApprovalTaskState.PENDING);
    expect(await owner.auditEvent.count({ where: { tenantId: TENANT } })).toBe(auditBefore);
    expect(await owner.outboxMessage.count({ where: { tenantId: TENANT } })).toBe(outboxBefore);
  });

  it('refuses a decision from somebody the task does not belong to', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );
    const task = await owner.approvalTask.findFirstOrThrow({ where: { instanceId } });

    await expect(
      as(
        () =>
          workflow.engine.decide({
            taskId: asId<ApprovalTaskId>(task.id),
            decision: TaskDecision.APPROVED,
            comment: null,
          }),
        APPROVER,
      ),
    ).rejects.toThrow(/assigned to somebody else/i);
  });

  it('sends a document back to its author when changes are requested', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );
    const task = await owner.approvalTask.findFirstOrThrow({ where: { instanceId } });

    await as(
      () =>
        workflow.engine.decide({
          taskId: asId<ApprovalTaskId>(task.id),
          decision: TaskDecision.CHANGES_REQUESTED,
          comment: 'Section 4 is out of date.',
        }),
      REVIEWER,
    );

    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe(DocumentStatus.CHANGES_REQUESTED);
    // The comment is on the task *and* in the conversation: the task's copy is the record of that
    // decision and never changes, and the timeline is what a reviewer reads.
    const comments = await owner.workflowComment.findMany({ where: { instanceId } });
    expect(comments.some((comment) => comment.decision === TaskDecision.CHANGES_REQUESTED)).toBe(
      true,
    );
    // `CHANGES_REQUESTED` is deliberately not frozen: the author has been asked to make changes.
    await as(() => library.documents.update(documentId, { title: 'Revised' }, undefined));
  });

  it('runs stages in order and holds the second until the first completes', async () => {
    const typeId = await typeWithWorkflow([
      ...oneStage(),
      {
        name: 'Approve',
        participants: [{ kind: ParticipantKind.ROLE, roleKey: 'approver', scope: 'TENANT' }],
        completionRule: StageCompletionRule.ALL,
        ordered: false,
        condition: null,
        deadline: null,
        reminders: [],
        onOverdue: { action: 'NOTIFY_ONLY' },
        onReject: 'TERMINATE',
        maxEscalations: 2,
      },
    ]);
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );

    // Only the first stage has tasks. The second exists and is pending, which is what makes the
    // whole route visible before anybody has decided anything.
    const first = await owner.workflowStage.findFirstOrThrow({ where: { instanceId, index: 0 } });
    const second = await owner.workflowStage.findFirstOrThrow({ where: { instanceId, index: 1 } });
    expect(second.state).toBe(WorkflowStageStatus.PENDING);
    expect(await owner.approvalTask.count({ where: { stageId: second.id } })).toBe(0);

    const task = await owner.approvalTask.findFirstOrThrow({ where: { stageId: first.id } });
    await as(
      () =>
        workflow.engine.decide({
          taskId: asId<ApprovalTaskId>(task.id),
          decision: TaskDecision.APPROVED,
          comment: null,
        }),
      REVIEWER,
    );

    const activated = await owner.workflowStage.findUniqueOrThrow({ where: { id: second.id } });
    expect(activated.state).toBe(WorkflowStageStatus.ACTIVE);
    // Resolved *now*, at activation, against this document — never at definition time (§2).
    const secondTasks = await owner.approvalTask.findMany({ where: { stageId: second.id } });
    expect(secondTasks.map((row) => row.assigneeId)).toEqual([APPROVER]);
  });

  it('skips a stage whose condition does not hold, and says so', async () => {
    const typeId = await typeWithWorkflow([
      {
        ...(oneStage()[0] as Record<string, unknown>),
        name: 'Only for secret documents',
        condition: { field: 'confidentiality.rank', op: '>=', value: 90 },
      },
      {
        name: 'Approve',
        participants: [{ kind: ParticipantKind.ROLE, roleKey: 'approver', scope: 'TENANT' }],
        completionRule: StageCompletionRule.ALL,
        ordered: false,
        condition: null,
        deadline: null,
        reminders: [],
        onOverdue: { action: 'NOTIFY_ONLY' },
        onReject: 'TERMINATE',
        maxEscalations: 2,
      },
    ]);
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );

    const stages = await owner.workflowStage.findMany({
      where: { instanceId },
      orderBy: { index: 'asc' },
    });
    // Skipped for a *stated* reason, and never for want of participants — the two look alike from
    // outside and are handled oppositely, which is why the reason is on the row.
    expect(stages[0]?.state).toBe(WorkflowStageStatus.SKIPPED);
    expect(stages[0]?.skipReason).toBe('CONDITION_FALSE');
    expect(stages[1]?.state).toBe(WorkflowStageStatus.ACTIVE);
  });

  it('completes with a number, drawn through the seam Phase 4 left for it', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );

    // ADR-0004's first half: submission reserved a pending value, visible and clearly not the
    // document's number yet.
    const submitted = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(submitted.documentNumber).toBeNull();
    const reservation = await owner.numberReservation.findFirstOrThrow({
      where: { workflowInstanceId: instanceId },
    });
    expect(reservation.state).toBe('RESERVED');
    expect(reservation.formatted).toMatch(/^QA-\d{3,}$/);

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

    // The second half: approval assigned exactly the value reviewers were shown, in the same
    // transaction as the approval. This assertion flipping from Phase 4's "completes without a
    // number" is the phase working — binding the allocator changed no engine code.
    const instance = await owner.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } });
    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(instance.state).toBe(WorkflowInstanceStatus.COMPLETED);
    expect(instance.numberAssigned).toBe(true);
    expect(document.status).toBe(DocumentStatus.APPROVED);
    expect(document.documentNumber).toBe(reservation.formatted);
    expect(document.numberedAt).not.toBeNull();
    const assigned = await owner.numberReservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(assigned.state).toBe('ASSIGNED');
    expect(assigned.documentId).toBe(documentId);
  });

  it('completes honestly unnumbered when the allocator is unbound, as Phase 4 shipped', async () => {
    // The same engine composed without the binding — a composition the port deliberately allows.
    const unbound = realWorkflowEngine({
      clock,
      unitOfWork,
      documents: library.documents,
      configuration: library.configuration,
      directory,
      withoutNumbering: true,
    });
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      unbound.engine.submit(asId<DocumentId>(documentId), null),
    );
    const task = await owner.approvalTask.findFirstOrThrow({ where: { instanceId } });

    await as(
      () =>
        unbound.engine.decide({
          taskId: asId<ApprovalTaskId>(task.id),
          decision: TaskDecision.APPROVED,
          comment: null,
        }),
      REVIEWER,
    );

    const instance = await owner.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } });
    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(instance.state).toBe(WorkflowInstanceStatus.COMPLETED);
    expect(instance.numberAssigned).toBe(false);
    expect(document.documentNumber).toBeNull();
  });
});

describe('timers', () => {
  it('computes a deadline against the working calendar and schedules its jobs', async () => {
    await as(() =>
      workflow.routing.createCalendar({
        code: unique('CAL'),
        name: 'Head office',
        entityId: null,
        weekendDays: [6, 7],
        isDefault: true,
        holidays: [{ day: '2026-03-04', name: 'Company day' }],
      }),
    );

    const typeId = await typeWithWorkflow(
      oneStage({
        deadline: { duration: 'P3D', calendar: 'WORKING_DAYS' },
        reminders: [{ before: 'P1D' }],
      }),
    );
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );

    const stage = await owner.workflowStage.findFirstOrThrow({ where: { instanceId, index: 0 } });
    // Monday + 3 working days, with Wednesday a holiday, is Friday. A deadline nobody can check on
    // a wall calendar is a deadline nobody can trust.
    expect(stage.dueAt?.toISOString()).toBe('2026-03-06T09:00:00.000Z');

    const timers = await owner.workflowTimer.findMany({ where: { instanceId } });
    expect(timers.filter((timer) => timer.kind === 'DEADLINE')).toHaveLength(1);
    expect(timers.filter((timer) => timer.kind === 'REMINDER')).toHaveLength(1);
    // Enqueued only after the transaction committed: the rows exist and the jobs were handed over
    // afterwards, which is the whole of what ADR-0011 asks of a publisher.
    expect(workflow.enqueued.map((job) => job.jobId).sort()).toEqual(
      timers.map((timer) => timer.jobId).sort(),
    );
  });

  it('pauses with the remaining duration and resumes with it, never restarting the clock', async () => {
    const typeId = await typeWithWorkflow(
      oneStage({ deadline: { duration: 'P3D', calendar: 'CALENDAR_DAYS' } }),
    );
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );

    const before = await owner.workflowTimer.findFirstOrThrow({
      where: { instanceId, kind: 'DEADLINE' },
    });
    const remaining = before.fireAt.getTime() - FIXED_NOW.getTime();
    expect(remaining).toBe(3 * 86_400_000);

    await as(() =>
      workflow.engine.pause(
        asId<WorkflowInstanceId>(instanceId),
        WorkflowPauseReason.LEGAL_HOLD,
        'Litigation hold.',
      ),
    );

    const held = await owner.workflowTimer.findUniqueOrThrow({ where: { id: before.id } });
    expect(held.state).toBe(WorkflowTimerState.PAUSED);
    expect(held.remainingMs).toBe(remaining);
    // The queue was asked to drop the job, which is what makes the pause real rather than notional.
    expect(workflow.cancelled).toContain(before.jobId);

    await as(() => workflow.engine.resume(asId<WorkflowInstanceId>(instanceId)));

    const resumed = await owner.workflowTimer.findUniqueOrThrow({ where: { id: before.id } });
    expect(resumed.state).toBe(WorkflowTimerState.SCHEDULED);
    expect(resumed.remainingMs).toBeNull();
    // `now + remaining`, not the original duration re-derived. The clock in this suite is frozen, so
    // the two happen to coincide — the assertion that matters is the one below it.
    expect(resumed.fireAt.getTime()).toBe(FIXED_NOW.getTime() + remaining);
  });

  it('refuses a decision while the approval is held', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );
    const task = await owner.approvalTask.findFirstOrThrow({ where: { instanceId } });

    await as(() =>
      workflow.engine.pause(
        asId<WorkflowInstanceId>(instanceId),
        WorkflowPauseReason.ADMINISTRATIVE,
        null,
      ),
    );

    await expect(
      as(
        () =>
          workflow.engine.decide({
            taskId: asId<ApprovalTaskId>(task.id),
            decision: TaskDecision.APPROVED,
            comment: null,
          }),
        REVIEWER,
      ),
    ).rejects.toThrow(/not running/i);

    // And the database refuses it too, which is what holds if something other than the use case
    // writes: the trigger reads the instance's state in the same statement.
    await expect(
      owner.approvalTask.update({
        where: { id: task.id },
        data: { decision: TaskDecision.APPROVED, decidedAt: FIXED_NOW, decidedById: REVIEWER },
      }),
    ).rejects.toThrow(/may not be decided while its instance is/i);
  });

  it('cancels a stage’s timers when the stage completes', async () => {
    const typeId = await typeWithWorkflow(
      oneStage({ deadline: { duration: 'P3D', calendar: 'CALENDAR_DAYS' } }),
    );
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );
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

    const timers = await owner.workflowTimer.findMany({ where: { instanceId } });
    expect(timers.every((timer) => timer.state === WorkflowTimerState.CANCELLED)).toBe(true);
    expect(timers.every((timer) => workflow.cancelled.includes(timer.jobId))).toBe(true);
  });
});

describe('ending an approval', () => {
  it('lets an author withdraw before anybody has decided, and refuses afterwards', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const first = await aDocument(typeId);
    await as(() => workflow.engine.submit(asId<DocumentId>(first), null));
    await as(() => workflow.engine.withdraw(asId<DocumentId>(first), 'Wrong file.'));

    const withdrawn = await owner.document.findUniqueOrThrow({ where: { id: first } });
    expect(withdrawn.status).toBe(DocumentStatus.DRAFT);

    const second = await aDocument(typeId);
    const { instanceId } = await as(() => workflow.engine.submit(asId<DocumentId>(second), null));
    const task = await owner.approvalTask.findFirstOrThrow({ where: { instanceId } });
    await as(
      () =>
        workflow.engine.decide({
          taskId: asId<ApprovalTaskId>(task.id),
          decision: TaskDecision.CHANGES_REQUESTED,
          comment: 'Not yet.',
        }),
      REVIEWER,
    );

    await expect(
      as(() => workflow.engine.withdraw(asId<DocumentId>(second), null)),
    ).rejects.toThrow(/not in approval/i);
  });

  it('keeps every attempt as history rather than deleting the rejected one', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);

    const firstAttempt = await as(() => workflow.engine.submit(asId<DocumentId>(documentId), null));
    const task = await owner.approvalTask.findFirstOrThrow({
      where: { instanceId: firstAttempt.instanceId },
    });
    await as(
      () =>
        workflow.engine.decide({
          taskId: asId<ApprovalTaskId>(task.id),
          decision: TaskDecision.REJECTED,
          comment: 'This is not the approved template.',
        }),
      REVIEWER,
    );

    const rejected = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(rejected.status).toBe(DocumentStatus.REJECTED);

    // The author revises and resubmits. The rejected attempt stays, which is what makes "how many
    // times did this fail approval" answerable.
    await as(() => library.documents.update(documentId, { title: 'Revised procedure' }, undefined));
    await owner.document.update({ where: { id: documentId }, data: { status: 'DRAFT' } });
    await as(() => workflow.engine.submit(asId<DocumentId>(documentId), null));

    const instances = await owner.workflowInstance.findMany({ where: { documentId } });
    expect(instances).toHaveLength(2);
    expect(instances.filter((row) => row.state === WorkflowInstanceStatus.REJECTED)).toHaveLength(
      1,
    );
    expect(instances.filter((row) => row.state === WorkflowInstanceStatus.RUNNING)).toHaveLength(1);
  });
});

describe('what the database refuses on its own', () => {
  it('will not bind an instance to a draft version', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );
    const instance = await owner.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } });

    const draft = await owner.workflowVersion.create({
      data: {
        id: uuidv7(),
        tenantId: TENANT,
        definitionId: instance.definitionId,
        version: 99,
        state: 'DRAFT',
        definition: {},
        updatedAt: FIXED_NOW,
      },
    });

    // Bypassing every use case, as a repair script would. An approval running under a version
    // somebody is still editing is an approval whose rules change underneath it.
    await expect(
      owner.workflowInstance.update({
        where: { id: instanceId },
        data: { workflowVersionId: draft.id },
      }),
    ).rejects.toThrow(/may not bind to draft version/i);
  });

  it('will not let a task claim another instance’s stage', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const [oneId, twoId] = [await aDocument(typeId), await aDocument(typeId)];
    const one = await as(() => workflow.engine.submit(asId<DocumentId>(oneId), null));
    const two = await as(() => workflow.engine.submit(asId<DocumentId>(twoId), null));

    const foreignStage = await owner.workflowStage.findFirstOrThrow({
      where: { instanceId: two.instanceId },
    });
    const task = await owner.approvalTask.findFirstOrThrow({
      where: { instanceId: one.instanceId },
    });

    // Two foreign keys that are individually valid and jointly nonsense: the task would count
    // toward a quorum in an approval nobody meant it to be part of.
    await expect(
      owner.approvalTask.update({ where: { id: task.id }, data: { stageId: foreignStage.id } }),
    ).rejects.toThrow(/claims stage .* of another instance/i);
  });

  it('will not allow two live approvals on one document', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    const running = await as(() => workflow.engine.submit(asId<DocumentId>(documentId), null));
    const instance = await owner.workflowInstance.findUniqueOrThrow({
      where: { id: running.instanceId },
    });

    await expect(
      owner.workflowInstance.create({
        data: {
          id: uuidv7(),
          tenantId: TENANT,
          documentId,
          revisionId: instance.revisionId,
          definitionId: instance.definitionId,
          workflowVersionId: instance.workflowVersionId,
          startedAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('the audit trail', () => {
  it('records the decision, the revision decided on, and both identities', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );
    const task = await owner.approvalTask.findFirstOrThrow({ where: { instanceId } });

    await as(
      () =>
        workflow.engine.decide({
          taskId: asId<ApprovalTaskId>(task.id),
          decision: TaskDecision.APPROVED,
          comment: 'Looks right.',
        }),
      REVIEWER,
    );

    const event = await owner.auditEvent.findFirstOrThrow({
      where: { tenantId: TENANT, action: 'APPROVED', subjectId: task.id },
    });
    const payload = event.payload as Record<string, unknown>;
    const after = payload['after'] as Record<string, unknown>;
    expect(event.actorId).toBe(REVIEWER);
    // The revision decided on, so "prove what was approved" resolves through this event without a
    // join whose answer a later revision would change (§3).
    expect(after['revisionId']).toBe(
      (await owner.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })).revisionId,
    );
    expect(after['decidedBy']).toBe(REVIEWER);
    // Delegation is Phase 11's and the field is already read, which is what keeps it from needing a
    // migration: the audit answers "who decided" and "for whom" before anybody can delegate.
    expect(after['onBehalfOf']).toBeNull();
  });

  it('records the version an approval bound to, not merely the definition', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );

    const event = await owner.auditEvent.findFirstOrThrow({
      where: { tenantId: TENANT, action: 'SUBMITTED', subjectId: documentId },
    });
    const after = (event.payload as Record<string, unknown>)['after'] as Record<string, unknown>;
    const instance = await owner.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } });
    expect(after['workflowVersionId']).toBe(instance.workflowVersionId);
    expect(after['workflowVersion']).toBe(1);
  });
});

// --- Phase 5: numbering through the engine ----------------------------------------------------
//
// The guarantees of `09-numbering-architecture.md` §5, asked of the real database through the real
// engine: distinct numbers under parallel approvals, a voided value never returning to the pool,
// gapless mode drawing only at approval, and the manual path fast-forwarding the series while the
// unique constraints refuse every collision — including a deleted document's number, forever.

describe('numbering', () => {
  async function aRule(overrides: Record<string, unknown> = {}): Promise<{
    readonly id: string;
    readonly prefix: string;
  }> {
    const prefix = unique('N').replace(/-/g, '');
    const rule = await as(() =>
      library.numbering.create({
        key: unique('issue-'),
        name: `Series ${prefix}`,
        separator: '-',
        segments: [
          { kind: NumberSegmentKind.LITERAL, value: prefix },
          { kind: NumberSegmentKind.SEQUENCE, padding: 4 },
        ] as never,
        resetScope: ['NEVER'],
        reserveOnSubmit: true,
        strictGapless: false,
        ...overrides,
      }),
    );
    return { id: rule.id, prefix };
  }

  async function approve(instanceId: string): Promise<void> {
    const task = await owner.approvalTask.findFirstOrThrow({
      where: { instanceId, state: 'PENDING' },
    });
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

  function numbersService() {
    const numbers = workflow.numbers;
    if (numbers === null) {
      throw new Error('The stack was composed with numbering; this cannot be null.');
    }
    return numbers;
  }

  function issuanceService() {
    const issuance = workflow.issuance;
    if (issuance === null) {
      throw new Error('The stack was composed with numbering; this cannot be null.');
    }
    return issuance;
  }

  it('gives parallel approvals in one series distinct, consecutive numbers', async () => {
    // The phase's own risk, exercised where the engine meets the counter: five decisions in five
    // transactions, each holding its own instance lock, all contending on one sequence row. The
    // rule draws at approval, so the draw itself is what races (§2, §5).
    const rule = await aRule({ reserveOnSubmit: false });
    const typeId = await typeWithWorkflow(oneStage(), rule.id);
    const submissions: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const documentId = await aDocument(typeId);
      const { instanceId } = await as(() =>
        workflow.engine.submit(asId<DocumentId>(documentId), null),
      );
      submissions.push(instanceId);
    }

    await Promise.all(submissions.map((instanceId) => approve(instanceId)));

    const documents = await owner.document.findMany({
      where: { documentTypeId: typeId },
      select: { documentNumber: true },
    });
    const values = documents.map((row) => row.documentNumber).sort();
    expect(values).toEqual([
      `${rule.prefix}-0001`,
      `${rule.prefix}-0002`,
      `${rule.prefix}-0003`,
      `${rule.prefix}-0004`,
      `${rule.prefix}-0005`,
    ]);
  });

  it('voids the reservation on rejection and never returns the value to the pool', async () => {
    const rule = await aRule();
    const typeId = await typeWithWorkflow(oneStage(), rule.id);

    const rejectedId = await aDocument(typeId);
    const first = await as(() => workflow.engine.submit(asId<DocumentId>(rejectedId), null));
    const task = await owner.approvalTask.findFirstOrThrow({
      where: { instanceId: first.instanceId },
    });
    await as(
      () =>
        workflow.engine.decide({
          taskId: asId<ApprovalTaskId>(task.id),
          decision: TaskDecision.REJECTED,
          comment: 'Not this one.',
        }),
      REVIEWER,
    );

    const voided = await owner.numberReservation.findFirstOrThrow({
      where: { workflowInstanceId: first.instanceId },
    });
    expect(voided.state).toBe('VOIDED');
    expect(voided.formatted).toBe(`${rule.prefix}-0001`);
    const rejected = await owner.document.findUniqueOrThrow({ where: { id: rejectedId } });
    expect(rejected.documentNumber).toBeNull();

    // The next document draws the *next* value. `0001` is a gap in the visible series, which
    // ADR-0004 accepts; reusing it is what it forbids.
    const approvedId = await aDocument(typeId);
    const second = await as(() => workflow.engine.submit(asId<DocumentId>(approvedId), null));
    await approve(second.instanceId);
    const approved = await owner.document.findUniqueOrThrow({ where: { id: approvedId } });
    expect(approved.documentNumber).toBe(`${rule.prefix}-0002`);
  });

  it('voids the reservation on withdrawal', async () => {
    const rule = await aRule();
    const typeId = await typeWithWorkflow(oneStage(), rule.id);
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );

    await as(() => workflow.engine.withdraw(asId<DocumentId>(documentId), 'Not ready.'));

    const reservation = await owner.numberReservation.findFirstOrThrow({
      where: { workflowInstanceId: instanceId },
    });
    expect(reservation.state).toBe('VOIDED');
    expect(reservation.voidReason).toBe('WITHDRAWN');
  });

  it('draws only at approval in gapless mode, so nothing can ever be voided', async () => {
    const rule = await aRule({ reserveOnSubmit: false, strictGapless: true });
    const typeId = await typeWithWorkflow(oneStage(), rule.id);
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );

    // No pending value exists during review — the trade-off the regime demands (§2).
    expect(await owner.numberReservation.count({ where: { workflowInstanceId: instanceId } })).toBe(
      0,
    );

    await approve(instanceId);
    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.documentNumber).toBe(`${rule.prefix}-0001`);
    const reservation = await owner.numberReservation.findFirstOrThrow({
      where: { workflowInstanceId: instanceId },
    });
    // Reserved and assigned in the one transaction: the same code path, with no time between.
    expect(reservation.state).toBe('ASSIGNED');
  });

  it('records a manual number, fast-forwards the series, and refuses every collision', async () => {
    const rule = await aRule();
    const typeId = await typeWithWorkflow(oneStage(), rule.id);
    const manualId = await aDocument(typeId);

    // §3: the supplied number is validated against the rule's shape for this document.
    await expect(
      as(() => numbersService().assignManually(asId<DocumentId>(manualId), 'WRONG-1')),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await as(() =>
      numbersService().assignManually(asId<DocumentId>(manualId), `${rule.prefix}-0007`),
    );
    const manual = await owner.document.findUniqueOrThrow({ where: { id: manualId } });
    expect(manual.documentNumber).toBe(`${rule.prefix}-0007`);
    expect(manual.numberedAt).not.toBeNull();

    // The series fast-forwarded past the supplied value: the next automatic draw is 0008, so the
    // manual number can never collide with a later automatic one.
    const nextId = await aDocument(typeId);
    const next = await as(() => workflow.engine.submit(asId<DocumentId>(nextId), null));
    await approve(next.instanceId);
    expect((await owner.document.findUniqueOrThrow({ where: { id: nextId } })).documentNumber).toBe(
      `${rule.prefix}-0008`,
    );

    // A spent value is refused however it is asked for again.
    const otherId = await aDocument(typeId);
    await expect(
      as(() => numbersService().assignManually(asId<DocumentId>(otherId), `${rule.prefix}-0007`)),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });

    // Delete and recreate: the number stays spent forever. Uniqueness deliberately ignores
    // `deleted_at`, so a deleted document holds its number for good (§5).
    const doomed = await owner.document.findUniqueOrThrow({ where: { id: manualId } });
    await as(() => library.documents.remove(manualId, doomed.version));
    await expect(
      as(() => numbersService().assignManually(asId<DocumentId>(otherId), `${rule.prefix}-0007`)),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('holds a block for offline work, which the automatic path can never draw', async () => {
    const rule = await aRule();
    const typeId = await typeWithWorkflow(oneStage(), rule.id);

    const held = await as(() =>
      issuanceService().holdBlock({
        numberingRuleId: asId<NumberingRuleId>(rule.id),
        codes: {},
        count: 2,
        note: 'Paper forms for the field office.',
      }),
    );
    expect(held.map((value) => value.formatted)).toEqual([
      `${rule.prefix}-0001`,
      `${rule.prefix}-0002`,
    ]);

    // The counter has moved past the block, so an approval draws 0003 — a held value cannot be
    // drawn automatically because it has already been drawn (§3).
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );
    await approve(instanceId);
    expect(
      (await owner.document.findUniqueOrThrow({ where: { id: documentId } })).documentNumber,
    ).toBe(`${rule.prefix}-0003`);

    // The offline process comes back: a manual assignment of a held value claims the held row.
    const claimedId = await aDocument(typeId);
    await as(() =>
      numbersService().assignManually(asId<DocumentId>(claimedId), `${rule.prefix}-0001`),
    );
    const claimed = await owner.numberReservation.findFirstOrThrow({
      // The tenant filter matters here: `formatted` is unique per tenant, and this database has
      // hosted other runs' tenants.
      where: { tenantId: TENANT, formatted: `${rule.prefix}-0001` },
    });
    expect(claimed.state).toBe('ASSIGNED');
    expect(claimed.documentId).toBe(claimedId);

    // The other held value is released — voided, retained, and never re-issued.
    const remaining = held[1];
    if (remaining === undefined) {
      throw new Error('The block held two values.');
    }
    await as(() => issuanceService().releaseHeld(remaining.reservationId, 'Forms cancelled.'));
    expect(
      (
        await owner.numberReservation.findFirstOrThrow({
          where: { tenantId: TENANT, formatted: `${rule.prefix}-0002` },
        })
      ).state,
    ).toBe('VOIDED');
  });
});
