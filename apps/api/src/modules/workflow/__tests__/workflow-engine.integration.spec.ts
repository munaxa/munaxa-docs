import 'reflect-metadata';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AclEffect,
  AclSubjectType,
  type AnyId,
  ApprovalTaskState,
  DocumentStatus,
  NumberSegmentKind,
  ParticipantKind,
  QueueName,
  Permission,
  ScanStatus,
  ScopeType,
  StageCompletionRule,
  type StageCompletionRuleKey,
  TaskDecision,
  type ApprovalTaskId,
  type DocumentId,
  type FolderId,
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
import { ValidationError } from '../../../core/errors/application-errors';
import type { Logger } from '../../../core/observability/logger';
import { RecordStamps } from '../../../core/persistence';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { decodeTransferToken } from '../../../testing/transfer-token';
import {
  type DocumentLibraryStack,
  type WorkflowEngineStack,
  realAclResolver,
  realDocumentLibrary,
  realPermissions,
  realNotifications,
  realQueue,
  realWorkflowEngine,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import { seedRoleGrant } from '../../../testing/acl-seed';
import type { WorkflowDirectory } from '../application/ports';
import { QueueRecoveryRegistry, QueueRecoveryScheduler } from '../../../core/queue-recovery';
import { WorkflowTimerConsumer } from '../infrastructure/workflow-timer.consumer';
import { WorkflowTimerRecovery } from '../infrastructure/workflow-timer.recovery';
import { PrismaWorkflowEngineRepository } from '../infrastructure/prisma-workflow-engine.repository';

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

/** A promise somebody else settles, which is how one caller is held inside its own transaction. */
function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * Waits until PostgreSQL says a backend is waiting on another to insert into `workflow_instance`.
 *
 * A condition the database answers, not a delay: `pg_blocking_pids` is non-empty exactly while a
 * transaction is stuck behind somebody else's lock — here the speculative insertion into
 * `uq_workflow_instance_live`. Polled on the macrotask queue so the awaited submissions get to run.
 */
async function waitUntilBlockedOnAnInstance(): Promise<void> {
  for (;;) {
    const [row] = await owner.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND cardinality(pg_blocking_pids(pid)) > 0
        AND query LIKE '%workflow_instance%'`;
    if ((row?.waiting ?? 0n) > 0n) {
      return;
    }
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

/**
 * A second engine over the same database whose participant resolution can be held open.
 *
 * The seam is the suite's own directory rather than a stubbed repository: `holdersOfRole` is called
 * from `advanceFrom`, which runs *after* the instance row is inserted and before the submission's
 * transaction commits, so parking there holds a real submission at exactly the moment a second one
 * has to be able to see nothing and try anyway.
 */
function anEngineParkedAtResolution(held: Promise<void>, arrived: () => void): WorkflowEngineStack {
  let first = true;
  return realWorkflowEngine({
    clock,
    unitOfWork,
    documents: library.documents,
    configuration: library.configuration,
    directory: {
      ...directory,
      holdersOfRole: async (roleKey, scope) => {
        if (first) {
          first = false;
          arrived();
          await held;
        }
        return directory.holdersOfRole(roleKey, scope);
      },
    },
  });
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
    antivirus: { icap: null, maxBytes: 134_217_728, timeoutMs: 120_000 },
    providers: { antivirus: 'NONE' },
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

  // Slice 123: the role the context claims, seeded so the resolver can find it. Document creation
  // now resolves `document:create` on the destination folder — the decision `AclGuard` cannot make
  // for a folder that arrives in the body — and until it did, the role key in the context named no
  // row and was never resolved. `acl-seed.ts` states the rule this follows: "the honest response is
  // to seed the grant rather than to keep the resolver from asking".
  await seedRoleGrant(owner, {
    tenantId: TENANT,
    roleId: uuidv7(),
    key: 'TENANT_ADMIN',
    userIds: [AUTHOR, REVIEWER, APPROVER, MANAGER],
    now: FIXED_NOW,
  });

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

  /**
   * What the loser of that race is *told* — Slice 63's rule, applied to the partial `_live` index
   * the approval engine runs on.
   *
   * The two submissions are ordered by the database rather than by the scheduler: the winner is
   * held inside its own transaction after its instance row is in, the loser is released only once
   * `pg_blocking_pids` reports it waiting on that row, and the winner is let go last. So the loser
   * always reaches the index and always loses to it, on every run.
   */
  it('refuses the submission the index beat, in the words a second submission gets', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);

    const held = deferred();
    const parked = deferred();
    const holder = anEngineParkedAtResolution(held.promise, parked.release);

    const winner = as(() => holder.engine.submit(asId<DocumentId>(documentId), null));
    await parked.promise;

    const loser = as(() => workflow.engine.submit(asId<DocumentId>(documentId), null));
    await waitUntilBlockedOnAnInstance();
    held.release();

    await expect(winner).resolves.toMatchObject({ status: DocumentStatus.UNDER_REVIEW });
    // A sentence an author can act on, not `500`. The same refusal, word for word and field for
    // field, that the service produces when it can see the live approval for itself.
    const refusal: unknown = await loser.then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ValidationError);
    expect(refusal).toMatchObject({
      message: 'This document is already in approval.',
      fieldErrors: [{ field: 'status', message: 'in approval' }],
    });
  });

  it('leaves the document exactly as the winning submission left it', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);

    const held = deferred();
    const parked = deferred();
    const holder = anEngineParkedAtResolution(held.promise, parked.release);

    const winner = as(() => holder.engine.submit(asId<DocumentId>(documentId), null));
    await parked.promise;
    const loser = as(() => workflow.engine.submit(asId<DocumentId>(documentId), null));
    await waitUntilBlockedOnAnInstance();
    held.release();

    const started = await winner;
    await expect(loser).rejects.toThrow(/already in approval/i);

    // The refusal is a refusal, not a partial submission: one instance, one stage, one pending
    // number, and a document under review rather than half-submitted.
    expect(await owner.workflowInstance.findMany({ where: { documentId } })).toHaveLength(1);
    expect(await owner.workflowStage.count({ where: { instanceId: started.instanceId } })).toBe(1);
    expect(await owner.numberReservation.count({ where: { documentId, state: 'RESERVED' } })).toBe(
      1,
    );
    expect(await owner.document.findUniqueOrThrow({ where: { id: documentId } })).toMatchObject({
      status: DocumentStatus.UNDER_REVIEW,
    });
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

describe('a deadline that escalates', () => {
  /**
   * The timer lane's own context — `WorkflowTimerConsumer`'s, field for field. The system acts
   * alone when a deadline passes, so nothing here borrows the author's or anybody else's identity.
   */
  function asTheClock<T>(work: () => Promise<T>): Promise<T> {
    return runWithContext(
      {
        tenantId: TENANT,
        userId: null,
        roles: [],
        permissions: [],
        sessionId: null,
        correlationId: 'workflow-timer',
        permissionVersion: 0,
        locale: 'en',
      },
      work,
    );
  }

  /** One reviewer, a one-day deadline, and an escalation to the approver when it passes. */
  async function anOverdueApproval(
    keepOriginal: boolean,
    completionRule: StageCompletionRuleKey = StageCompletionRule.ANY,
  ): Promise<{
    instanceId: string;
    documentId: string;
  }> {
    const typeId = await typeWithWorkflow(
      oneStage({
        completionRule,
        deadline: { duration: 'P1D', calendar: 'CALENDAR_DAYS' },
        onOverdue: {
          action: 'ESCALATE',
          to: { kind: ParticipantKind.ROLE, roleKey: 'approver', scope: 'TENANT' },
          keepOriginal,
        },
      }),
    );
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );
    const deadline = await owner.workflowTimer.findFirstOrThrow({
      where: { instanceId, kind: 'DEADLINE' },
    });
    await asTheClock(() => workflow.engine.onTimerFired(deadline.jobId));
    return { instanceId, documentId };
  }

  async function taskOf(instanceId: string, assigneeId: UserId) {
    return owner.approvalTask.findFirstOrThrow({ where: { instanceId, assigneeId } });
  }

  it('hands the stage to the escalation target when the original is not kept', async () => {
    const { instanceId, documentId } = await anOverdueApproval(false);

    // The person who missed the deadline no longer holds it — that is what `keepOriginal: false`
    // asks for — and the person it was escalated to does.
    const missed = await taskOf(instanceId, REVIEWER);
    const escalated = await taskOf(instanceId, APPROVER);
    expect(missed.state).toBe(ApprovalTaskState.WITHDRAWN);
    expect(escalated.state).toBe(ApprovalTaskState.PENDING);
    expect(escalated.resolvedBy).toMatch(/^ESCALATION:/);

    // And the escalation can actually be decided, which is the only point of creating it: the
    // approval completes rather than sitting on a stage nobody holds.
    await as(
      () =>
        workflow.engine.decide({
          taskId: asId<ApprovalTaskId>(escalated.id),
          decision: TaskDecision.APPROVED,
          comment: null,
        }),
      APPROVER,
    );
    const instance = await owner.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } });
    expect(instance.state).toBe(WorkflowInstanceStatus.COMPLETED);
    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe(DocumentStatus.APPROVED);
  });

  /**
   * The release candidate's D-5, against a real database: the same escalation under `ALL`.
   *
   * `ANY` above needs one approval whatever the task count, so it never noticed that the withdrawn
   * original was still being counted. Under `ALL` it was: the escalation target's approval was one
   * of two required, nobody was left to give the second, and the stage ended UNREACHABLE — the
   * document REJECTED and its reserved number voided.
   */
  it('completes an ALL stage when the escalation target approves in place of the withdrawn original', async () => {
    const { instanceId, documentId } = await anOverdueApproval(false, StageCompletionRule.ALL);
    const missed = await taskOf(instanceId, REVIEWER);
    const escalated = await taskOf(instanceId, APPROVER);
    expect(missed.state).toBe(ApprovalTaskState.WITHDRAWN);
    expect(escalated.state).toBe(ApprovalTaskState.PENDING);

    await as(
      () =>
        workflow.engine.decide({
          taskId: asId<ApprovalTaskId>(escalated.id),
          decision: TaskDecision.APPROVED,
          comment: null,
        }),
      APPROVER,
    );

    const instance = await owner.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } });
    expect(instance.state).toBe(WorkflowInstanceStatus.COMPLETED);
    expect(instance.endReason).toBeNull();
    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.status).toBe(DocumentStatus.APPROVED);
    expect(
      await owner.numberReservation.count({
        where: { workflowInstanceId: instanceId, state: 'VOIDED' },
      }),
    ).toBe(0);
  });

  /**
   * The release candidate's D-6: the escalation target is told the way every assignee is.
   *
   * `workflow.task-escalated` carries the task, not the document, so the notification consumer
   * cannot address anybody from it — and no `workflow.task-assigned` followed, so the person who
   * now held the approval heard nothing. The assignment event is what notifies; this pins that the
   * escalation publishes it, for the target, once — a redelivered deadline adds nothing.
   */
  it('announces the escalation target’s new task as an ordinary assignment, once', async () => {
    const { instanceId, documentId } = await anOverdueApproval(false, StageCompletionRule.ALL);
    const assigned = async () =>
      (
        await owner.outboxMessage.findMany({
          where: { tenantId: TENANT, eventType: 'workflow.task-assigned', aggregateId: instanceId },
        })
      ).map((row) => row.payload as { documentId: string; assigneeIds: string[] });

    const afterEscalation = await assigned();
    const toTarget = afterEscalation.filter((payload) => payload.assigneeIds.includes(APPROVER));
    expect(toTarget).toHaveLength(1);
    expect(toTarget[0]?.documentId).toBe(documentId);
    expect(toTarget[0]?.assigneeIds).toStrictEqual([APPROVER]);

    // The same deadline delivered again: the timer has already fired, so nothing more happens —
    // and the delivery itself completes (D-7), rather than failing on its own audit record.
    const deadline = await owner.workflowTimer.findFirstOrThrow({
      where: { instanceId, kind: 'DEADLINE' },
    });
    await expect(
      asTheClock(() => workflow.engine.onTimerFired(deadline.jobId)),
    ).resolves.toBeUndefined();
    expect(await assigned()).toHaveLength(afterEscalation.length);
    expect(await owner.approvalTask.count({ where: { instanceId } })).toBe(2);
  });

  /**
   * The release candidate's D-7: a duplicate or late delivery is a recorded no-op, not a failure.
   *
   * The no-op audit record named the job id (`wf-timer:<uuid>`) as its UUID subject, so the insert
   * threw, the transaction rolled back and the queue reported a failed job — for every redelivery,
   * and for every reminder, whose outbox event rolled back with it.
   */
  it('records a duplicate deadline delivery as a no-op against the instance, and completes', async () => {
    const { instanceId } = await anOverdueApproval(false, StageCompletionRule.ALL);
    const deadline = await owner.workflowTimer.findFirstOrThrow({
      where: { instanceId, kind: 'DEADLINE' },
    });
    const tasksBefore = await owner.approvalTask.count({ where: { instanceId } });
    const outboxBefore = await owner.outboxMessage.count({ where: { aggregateId: instanceId } });
    const firedBefore = await owner.auditEvent.count({
      where: { tenantId: TENANT, subjectId: instanceId, action: 'TIMER_FIRED' },
    });

    for (let delivery = 0; delivery < 2; delivery++) {
      await expect(
        asTheClock(() => workflow.engine.onTimerFired(deadline.jobId)),
      ).resolves.toBeUndefined();
    }

    // Nothing moved: no task, no event, the timer still fired exactly once.
    expect(await owner.approvalTask.count({ where: { instanceId } })).toBe(tasksBefore);
    expect(await owner.outboxMessage.count({ where: { aggregateId: instanceId } })).toBe(
      outboxBefore,
    );
    const timer = await owner.workflowTimer.findUniqueOrThrow({ where: { id: deadline.id } });
    expect(timer.state).toBe('FIRED');
    // And each delivery is on the trail, under the instance, naming the job it was.
    const noOps = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, subjectId: instanceId, action: 'TIMER_FIRED' },
      orderBy: { sequence: 'asc' },
    });
    expect(noOps).toHaveLength(firedBefore + 2);
    expect(noOps.at(-1)?.subjectType).toBe('WORKFLOW');
    expect(JSON.stringify(noOps.at(-1)?.payload)).toContain(deadline.jobId);
  });

  it('fires a reminder: announces it, and records the firing against the instance', async () => {
    const typeId = await typeWithWorkflow(
      oneStage({
        deadline: { duration: 'P3D', calendar: 'CALENDAR_DAYS' },
        reminders: [{ before: 'P1D' }],
      }),
    );
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );
    const reminder = await owner.workflowTimer.findFirstOrThrow({
      where: { instanceId, kind: 'REMINDER' },
    });

    await expect(
      asTheClock(() => workflow.engine.onTimerFired(reminder.jobId)),
    ).resolves.toBeUndefined();

    const due = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, eventType: 'workflow.reminder-due', aggregateId: instanceId },
    });
    expect(due).toHaveLength(1);
    expect(
      (await owner.workflowTimer.findUniqueOrThrow({ where: { id: reminder.id } })).state,
    ).toBe('FIRED');
    expect(
      await owner.auditEvent.count({
        where: { tenantId: TENANT, subjectId: instanceId, action: 'TIMER_FIRED' },
      }),
    ).toBe(1);
  });

  it('records a timer whose row is gone against the timer, and refuses a job id it did not mint', async () => {
    const gone = uuidv7();
    await expect(
      asTheClock(() => workflow.engine.onTimerFired(`wf-timer:${gone}`)),
    ).resolves.toBeUndefined();
    const recorded = await owner.auditEvent.findFirstOrThrow({
      where: { tenantId: TENANT, subjectId: gone, action: 'TIMER_FIRED' },
    });
    expect(recorded.subjectType).toBe('WORKFLOW');

    await expect(asTheClock(() => workflow.engine.onTimerFired('not-a-timer'))).rejects.toThrow();
  });

  it('refuses the person who missed the deadline once the stage has been taken from them', async () => {
    const { instanceId } = await anOverdueApproval(false);
    const missed = await taskOf(instanceId, REVIEWER);

    await expect(
      as(
        () =>
          workflow.engine.decide({
            taskId: asId<ApprovalTaskId>(missed.id),
            decision: TaskDecision.APPROVED,
            comment: null,
          }),
        REVIEWER,
      ),
    ).rejects.toThrow();
    const instance = await owner.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } });
    expect(instance.state).toBe(WorkflowInstanceStatus.RUNNING);
  });

  it('leaves both people able to decide when the original is kept', async () => {
    const { instanceId } = await anOverdueApproval(true);

    const missed = await taskOf(instanceId, REVIEWER);
    const escalated = await taskOf(instanceId, APPROVER);
    expect(missed.state).toBe(ApprovalTaskState.PENDING);
    expect(escalated.state).toBe(ApprovalTaskState.PENDING);

    // "The first person to decide still can" — the contract's own words for the flag.
    await as(
      () =>
        workflow.engine.decide({
          taskId: asId<ApprovalTaskId>(missed.id),
          decision: TaskDecision.APPROVED,
          comment: null,
        }),
      REVIEWER,
    );
    const instance = await owner.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } });
    expect(instance.state).toBe(WorkflowInstanceStatus.COMPLETED);
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

  /**
   * The other half of the translation: what it must *not* claim.
   *
   * `uq_workflow_instance_live` is raw SQL, so Prisma reports its violation with `target: null` and
   * the repository attributes it by model. The model alone is not the whole guard — a foreign key
   * this table also carries fails on the same statement, against the same model, and telling an
   * author "this document is already in approval" because a revision went missing would be a
   * confident lie. So the boundary is asked both questions here, one after the other.
   */
  it('translates the live index and leaves every other failure as it found it', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    const running = await as(() => workflow.engine.submit(asId<DocumentId>(documentId), null));
    const live = await owner.workflowInstance.findUniqueOrThrow({
      where: { id: running.instanceId },
    });
    const repository = new PrismaWorkflowEngineRepository(new RecordStamps(clock));

    await expect(
      as(() =>
        unitOfWork.run(() =>
          repository.createInstance({
            id: uuidv7(),
            documentId,
            revisionId: live.revisionId,
            definitionId: live.definitionId,
            workflowVersionId: live.workflowVersionId,
            startedAt: FIXED_NOW,
          }),
        ),
      ),
    ).rejects.toThrow(/already in approval/i);

    // A fresh document, so the live index has nothing to say, and a revision that does not exist,
    // so the foreign key does. It comes back as the constraint failure it is.
    const freeDocumentId = await aDocument(typeId);
    const failure: unknown = await as(() =>
      unitOfWork
        .run(() =>
          repository.createInstance({
            id: uuidv7(),
            documentId: freeDocumentId,
            revisionId: uuidv7(),
            definitionId: live.definitionId,
            workflowVersionId: live.workflowVersionId,
            startedAt: FIXED_NOW,
          }),
        )
        .then(
          () => null,
          (error: unknown) => error,
        ),
    );
    expect(failure).not.toBeInstanceOf(ValidationError);
    expect(failure).toMatchObject({ code: 'P2003' });
  });
});

/**
 * Suspension reaches a remark on an approval too — Slice 116.
 *
 * `comment` writes no audit row, and rightly: a remark is not a decision, and 13 §2 gives the
 * engine its actions for the decisions. That is why it went through the unit of work alone — and
 * why it was one of eleven writes exempt from the refusal `08-permission-model.md` §4 asks for
 * *everywhere*. A suspended organisation kept accumulating commentary on its approvals.
 */
describe('a read-only organisation', () => {
  it('refuses a remark on an approval, and still answers the approval itself', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(documentId), null),
    );

    await owner.tenant.update({ where: { id: TENANT }, data: { status: 'SUSPENDED' } });
    try {
      await expect(as(() => workflow.engine.comment(instanceId, 'A remark'))).rejects.toThrow(
        /read-only/i,
      );
      expect(await owner.workflowComment.count({ where: { instanceId } })).toBe(0);

      // Reads are untouched: a suspended tenant can still see what is in flight.
      await expect(
        as(() => workflow.approvals.forDocument(asId<DocumentId>(documentId))),
      ).resolves.toBeDefined();
    } finally {
      await owner.tenant.update({ where: { id: TENANT }, data: { status: 'ACTIVE' } });
    }
  });
});

/**
 * Slice 130 — a remark on an approval asks the question its route cannot.
 *
 * `POST /workflow-instances/:id/comments` requires `document:view`, and the conversation it writes
 * to is read only through `GET /documents/:id/workflow`, which resolves that permission on the
 * document. The route names an instance, not a document, so `AclGuard` has nothing to resolve and
 * only the tenant-wide half of `document:view` was ever checked: a caller cut off from a document by
 * an inheritance break could still write into its approval, and learn that it existed.
 */
describe('a remark on an approval of a document the caller cannot reach', () => {
  /** Holds `document:view` and nothing else, so a check on any other permission refuses them. */
  const VIEWER = asId<UserId>(uuidv7());

  beforeAll(async () => {
    await owner.user.create({
      data: {
        id: VIEWER,
        tenantId: TENANT,
        email: `${VIEWER}@example.test`,
        emailNormalized: `${VIEWER}@example.test`,
        displayName: 'Viewer',
        status: 'ACTIVE',
        updatedAt: FIXED_NOW,
      },
    });
    await seedRoleGrant(owner, {
      tenantId: TENANT,
      roleId: uuidv7(),
      key: 'VIEW_ONLY',
      userIds: [VIEWER],
      permissions: [Permission.DOCUMENT_VIEW],
      now: FIXED_NOW,
    });
  });

  function asViewer<T>(work: () => Promise<T>): Promise<T> {
    return runWithContext({ ...contextFor(VIEWER), roles: ['VIEW_ONLY'] }, work);
  }

  async function submittedIn(folderId: string): Promise<WorkflowInstanceId> {
    const typeId = await typeWithWorkflow(oneStage());
    const fileObjectId = await uploadClean(unique('content'));
    const document = await as(() =>
      library.documents.create({
        folderId,
        documentTypeId: typeId,
        title: unique('Procedure '),
        fileObjectId,
        filename: 'procedure.pdf',
        origin: 'UPLOAD',
        acknowledgeDuplicate: false,
      }),
    );
    const { instanceId } = await as(() =>
      workflow.engine.submit(asId<DocumentId>(document.id), null),
    );
    return instanceId;
  }

  /** An approval in a folder whose inheritance was broken after it started. */
  async function behindABreak(): Promise<{ instanceId: WorkflowInstanceId; folderId: string }> {
    const { libraryId } = await owner.folder.findUniqueOrThrow({ where: { id: rootFolderId } });
    const restricted = await as(() =>
      library.libraries.createFolder({
        libraryId,
        parentId: rootFolderId,
        name: unique('Restricted '),
        inheritAcl: true,
      }),
    );
    const instanceId = await submittedIn(restricted.id);
    // The break an administrator makes: the tenant-wide grant of `document:view` stops at it.
    await as(() =>
      realPermissions({ clock, unitOfWork }).permissions.setInheritance(
        asId<FolderId>(restricted.id),
        false,
      ),
    );
    return { instanceId, folderId: restricted.id };
  }

  it('is refused as though the approval did not exist, and writes nothing', async () => {
    const { instanceId } = await behindABreak();

    // The premise, asked of the resolver the guard uses: the reviewer does not reach it.
    const { documentId } = await owner.workflowInstance.findUniqueOrThrow({
      where: { id: instanceId },
    });
    const reach = await as(
      () =>
        realAclResolver({ clock, unitOfWork }).resolve(
          {
            userId: REVIEWER,
            roleIds: [asId('TENANT_ADMIN')],
            departmentIds: [],
            delegationIds: [],
          },
          { type: ScopeType.DOCUMENT, id: asId(documentId) },
          Permission.DOCUMENT_VIEW,
        ),
      REVIEWER,
    );
    expect(reach.allowed).toBe(false);

    await expect(
      as(() => workflow.engine.comment(instanceId, 'Seen from outside.'), REVIEWER),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await owner.workflowComment.count({ where: { instanceId } })).toBe(0);
  });

  it('is taken from somebody granted the document below the break', async () => {
    const { instanceId, folderId } = await behindABreak();
    await as(() =>
      realPermissions({ clock, unitOfWork }).permissions.replaceFor(
        { type: ScopeType.FOLDER, id: asId<AnyId>(folderId) },
        [
          {
            subjectType: AclSubjectType.USER,
            subjectId: asId<AnyId>(REVIEWER),
            permission: Permission.DOCUMENT_VIEW,
            effect: AclEffect.ALLOW,
          },
        ],
      ),
    );

    await as(() => workflow.engine.comment(instanceId, 'Granted, so heard.'), REVIEWER);

    expect(await owner.workflowComment.count({ where: { instanceId } })).toBe(1);
  });

  it('is taken from somebody who holds only `document:view` on an approval they reach', async () => {
    const instanceId = await submittedIn(rootFolderId);

    await asViewer(() => workflow.engine.comment(instanceId, 'A remark.'));

    const comments = await owner.workflowComment.findMany({ where: { instanceId } });
    expect(comments.map((row) => [row.authorId, row.body])).toEqual([[VIEWER, 'A remark.']]);
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
    await as(() =>
      library.documents.remove(manualId, doomed.version, 'superseded by a newer drawing'),
    );
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

/**
 * The two notifications 18 §4 names that nobody had ever been sent — Phase 6.4.
 *
 * `document.approved` and `document.rejected` were declared in Phase 3, routed to the notification
 * lane in Phase 12, given a catalogue entry, `en` and `ar` templates, a branch in
 * `NotificationEventService` and an assertion in `outbox-routing.spec.ts` that they reach
 * `NOTIFICATIONS_DELIVER` — and **no code path had ever published one**. Approval and rejection
 * both run through `DocumentService.transition`, which wrote an audit row and no outbox row at all.
 *
 * Nothing caught it because every test of that path asks a different question. The notification
 * suite hands `NotificationEventService.handle` a synthetic event, which proves the translation and
 * not the production. The routing spec asserts `routesFor('document.approved')`, which is a claim
 * about a table and not about a publisher. This module's own tests asserted the document's status
 * and the number it was given, both of which were correct throughout.
 *
 * So the assertion has to be made *here* — after a real decision, against the real outbox table —
 * because this is the only suite that runs the act. A test that stubs any part of it is the test
 * that already existed and already passed.
 */
describe('approving and rejecting announce themselves', () => {
  async function eventsFor(documentId: string, eventType: string) {
    const rows = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, eventType, aggregateId: documentId },
    });
    return rows;
  }

  it('publishes document.approved with the number the approval assigned', async () => {
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
          comment: null,
        }),
      REVIEWER,
    );

    const published = await eventsFor(documentId, 'document.approved');
    // Exactly one: the fact is the document's, published once from the transition that performs it
    // — not once per stage and not once per task.
    expect(published).toHaveLength(1);
    const payload = published[0]?.payload as Record<string, unknown>;
    expect(payload['documentId']).toBe(documentId);
    expect(payload['workflowInstanceId']).toBe(instanceId);
    // Read from the row inside the same transaction that assigned it, which is the reason this
    // event can carry the number at all: `assignAtApproval` runs before the engine transitions.
    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(payload['documentNumber']).toBe(document.documentNumber);
    expect(payload['revisionId']).toBe(document.latestRevisionId);

    // And it commits with the change rather than beside it: the outbox row and the status are the
    // same transaction, so a notification can never describe an approval that rolled back
    // (ADR-0011).
    expect(document.status).toBe(DocumentStatus.APPROVED);
  });

  it('publishes document.rejected carrying the comment a person will read', async () => {
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
          decision: TaskDecision.REJECTED,
          comment: 'The tolerances in section 4 are wrong.',
        }),
      REVIEWER,
    );

    const rejected = await eventsFor(documentId, 'document.rejected');
    expect(rejected).toHaveLength(1);
    const payload = rejected[0]?.payload as Record<string, unknown>;
    expect(payload['documentId']).toBe(documentId);
    // The `comment` the notification template renders. It reaches the payload as the transition's
    // `reason`, which is what the engine passes the decision's comment as.
    expect(payload['comment']).toBe('The tolerances in section 4 are wrong.');
    expect(payload['decidedBy']).toBe(REVIEWER);
    // No number was issued, so none is claimed.
    const document = await owner.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document.documentNumber).toBeNull();
    expect(document.status).toBe(DocumentStatus.REJECTED);
  });

  it('says nothing about a transition 18 §4 names no recipient for', async () => {
    const typeId = await typeWithWorkflow(oneStage());
    const documentId = await aDocument(typeId);
    await as(() => workflow.engine.submit(asId<DocumentId>(documentId), null));

    // Submission moves the document to SUBMITTED and is deliberately silent: §4 has no row for it,
    // `document.submitted` carries a `workflowVersionId` the transition does not hold, and this
    // phase's rule is that an event whose intended recipient is undefined stays unpublished rather
    // than being invented. The assertion exists so that "nothing was published" is a decision on
    // the record rather than the absence this phase just finished correcting elsewhere.
    expect(await eventsFor(documentId, 'document.submitted')).toHaveLength(0);
    expect(await eventsFor(documentId, 'document.approved')).toHaveLength(0);
  });
});

/**
 * The release candidate's D-13: a timer outlives the Redis that carried it.
 *
 * Reproduced live first. A pending deadline's row sat `SCHEDULED` in PostgreSQL while its delayed
 * job lived only in Redis; flush Redis and restart the API, and nothing re-armed it — the deadline
 * passed, the row stayed `SCHEDULED` and the escalation it stood for never happened. The cron
 * schedules went the same way until the next restart.
 *
 * Everything here runs against real PostgreSQL and a real Redis through the production BullMQ
 * adapter, on a Redis database of this block's own because the block flushes it. A timer fires
 * the way production fires it: the job is delivered to the real `WorkflowTimerConsumer`. The
 * suite's clock is frozen, so a delayed job is made due by promoting it — the broker's own
 * operation — rather than by waiting.
 */
describe('timers survive a lost Redis (D-13)', () => {
  const redisUrl = (() => {
    const url = new URL(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379');
    url.pathname = '/13';
    return url.toString();
  })();
  const recoveryConfig = {
    queue: {
      consumersEnabled: true,
      recoveryIntervalMs: 1_000,
      recoverySweepIntervalMs: 3_600_000,
    },
  } as unknown as AppConfig;
  const tenants = {
    all: () => Promise.resolve([{ id: TENANT }]),
    byId: () => Promise.resolve(null),
    bySlug: () => Promise.resolve(null),
  } as never;

  /** Two processes: each its own adapter (its own connections), engine stack and recovery. */
  let one: ReturnType<typeof realQueue>;
  let two: ReturnType<typeof realQueue>;
  let engineOne: WorkflowEngineStack;
  let engineTwo: WorkflowEngineStack;
  let recoveryOne: WorkflowTimerRecovery;
  let recoveryTwo: WorkflowTimerRecovery;
  let registryOne: QueueRecoveryRegistry;
  let broker: Redis;
  let lane: Queue;

  function asTheClock<T>(work: () => Promise<T>): Promise<T> {
    return runWithContext(
      {
        tenantId: TENANT,
        userId: null,
        roles: [],
        permissions: [],
        sessionId: null,
        correlationId: 'workflow-timer',
        permissionVersion: 0,
        locale: 'en',
      },
      work,
    );
  }

  /** What Redis holds for one timer — by the broker's own identifier for the row's `job_id`. */
  async function jobsFor(timerId: string) {
    const jobs = await lane.getJobs(['delayed', 'waiting', 'active', 'prioritized']);
    return jobs.filter((job) => (job.data as { timerId?: string }).timerId === timerId);
  }

  async function lose(): Promise<void> {
    await broker.flushdb();
  }

  async function rowOf(timerId: string) {
    return owner.workflowTimer.findUniqueOrThrow({ where: { id: timerId } });
  }

  /** Waits for the consumer to have claimed the row — a condition the database answers. */
  async function claimed(timerId: string): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if ((await rowOf(timerId)).state !== WorkflowTimerState.SCHEDULED) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timer ${timerId} was never delivered.`);
  }

  /** Makes a delayed timer due now, the broker's own way, and waits for its delivery. */
  async function fire(timerId: string): Promise<void> {
    const [job] = await jobsFor(timerId);
    if (job === undefined) {
      throw new Error(`No job for timer ${timerId}.`);
    }
    if ((await job.getState()) === 'delayed') {
      await job.promote();
    }
    await claimed(timerId);
  }

  /** Waits until the consumer has finished with every job — nothing waiting, nothing active. */
  async function drained(): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const counts = await lane.getJobCounts('waiting', 'active', 'prioritized');
      if ((counts.waiting ?? 0) + (counts.active ?? 0) + (counts.prioritized ?? 0) === 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The timer lane never drained.');
  }

  /** One reviewer, a one-day deadline and an escalation to the approver, submitted for real. */
  async function aPendingDeadline(
    stage: Record<string, unknown> = {},
  ): Promise<{ instanceId: string; deadlineId: string; reminderId: string | null }> {
    const typeId = await typeWithWorkflow(
      oneStage({
        completionRule: StageCompletionRule.ANY,
        deadline: { duration: 'P1D', calendar: 'CALENDAR_DAYS' },
        onOverdue: {
          action: 'ESCALATE',
          to: { kind: ParticipantKind.ROLE, roleKey: 'approver', scope: 'TENANT' },
          keepOriginal: false,
        },
        ...stage,
      }),
    );
    const documentId = await aDocument(typeId);
    const { instanceId } = await as(() =>
      engineOne.engine.submit(asId<DocumentId>(documentId), null),
    );
    const deadline = await owner.workflowTimer.findFirstOrThrow({
      where: { instanceId, kind: 'DEADLINE' },
    });
    const reminder = await owner.workflowTimer.findFirst({
      where: { instanceId, kind: 'REMINDER' },
    });
    return { instanceId, deadlineId: deadline.id, reminderId: reminder?.id ?? null };
  }

  function recoveryFor(stack: WorkflowEngineStack, registry: QueueRecoveryRegistry) {
    const participant = new WorkflowTimerRecovery(
      registry,
      tenants,
      unitOfWork,
      stack.repository,
      stack.timers,
    );
    participant.onModuleInit();
    return participant;
  }

  beforeAll(async () => {
    one = realQueue(redisUrl);
    two = realQueue(redisUrl);
    broker = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
    lane = new Queue(QueueName.WORKFLOW_TIMERS, {
      connection: new Redis(redisUrl, { maxRetriesPerRequest: null }),
    });
    await lose();

    const compose = (queue: ReturnType<typeof realQueue>) =>
      realWorkflowEngine({
        clock,
        unitOfWork,
        documents: library.documents,
        configuration: library.configuration,
        directory,
        queue,
      });
    engineOne = compose(one);
    engineTwo = compose(two);
    registryOne = new QueueRecoveryRegistry();
    recoveryOne = recoveryFor(engineOne, registryOne);
    recoveryTwo = recoveryFor(engineTwo, new QueueRecoveryRegistry());

    // Process one consumes the lane, exactly as the API's consumer does in production.
    await new WorkflowTimerConsumer(
      one,
      recoveryConfig,
      logger,
      engineOne.engine,
    ).onApplicationBootstrap();
  });

  afterAll(async () => {
    await one?.onModuleDestroy();
    await two?.onModuleDestroy();
    await lane?.close();
    broker?.disconnect();
  });

  it('re-arms a lost deadline from its row, and the deadline then escalates as it would have', async () => {
    const { instanceId, deadlineId } = await aPendingDeadline();
    const row = await rowOf(deadlineId);
    expect(row.state).toBe(WorkflowTimerState.SCHEDULED);
    expect(await jobsFor(deadlineId)).toHaveLength(1);

    await lose();
    expect(await jobsFor(deadlineId)).toHaveLength(0);
    expect(await one.brokerIntact()).toBe(false);

    // A process starting against the empty broker: its first pass rebuilds, without a restart of
    // anything else and without anybody asking.
    const scheduler = new QueueRecoveryScheduler(one, registryOne, recoveryConfig, logger);
    const outcome = await scheduler.pass();
    expect(outcome).toMatchObject({ ran: true, brokerWasIntact: false });
    expect(outcome.rearmed['workflow.timers']).toBeGreaterThanOrEqual(1);
    expect(await one.brokerIntact()).toBe(true);

    // The same job, under the row's own identifier, owed the time it had left.
    const [rearmed] = await jobsFor(deadlineId);
    expect(rearmed?.id).toBe(row.jobId.replaceAll(':', '~'));
    expect(await rearmed?.getState()).toBe('delayed');
    expect(rearmed?.opts.delay).toBe(row.fireAt.getTime() - FIXED_NOW.getTime());

    await fire(deadlineId);
    expect((await rowOf(deadlineId)).state).toBe(WorkflowTimerState.FIRED);
    const tasks = await owner.approvalTask.findMany({ where: { instanceId } });
    expect(tasks.find((task) => task.assigneeId === REVIEWER)?.state).toBe(
      ApprovalTaskState.WITHDRAWN,
    );
    expect(tasks.find((task) => task.assigneeId === APPROVER)?.state).toBe(
      ApprovalTaskState.PENDING,
    );
  });

  it('re-arms a lost reminder: it announces itself once, and the assignee is told once', async () => {
    const { instanceId, reminderId } = await aPendingDeadline({
      deadline: { duration: 'P3D', calendar: 'CALENDAR_DAYS' },
      reminders: [{ before: 'P1D' }],
      onOverdue: { action: 'NOTIFY_ONLY' },
    });
    expect(reminderId).not.toBeNull();
    const timerId = reminderId ?? '';

    await lose();
    expect(await recoveryOne.recoverTenant(TENANT)).toBeGreaterThanOrEqual(1);
    await fire(timerId);

    const due = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, eventType: 'workflow.reminder-due', aggregateId: instanceId },
    });
    expect(due).toHaveLength(1);

    // The assignee is told, through the real notification consumer — and told once, however many
    // times the event is delivered.
    const notifications = realNotifications({
      clock,
      unitOfWork,
      config: { mail: { webBaseUrl: 'http://docs.test' } } as unknown as AppConfig,
      documents: library.documents,
    });
    const event = due[0];
    const deliver = () =>
      asTheClock(() =>
        notifications.events.handle({
          eventId: event?.id ?? '',
          eventType: 'workflow.reminder-due',
          payload: event?.payload as Record<string, unknown>,
        }),
      );
    expect(await deliver()).toBeGreaterThan(0);
    expect(await deliver()).toBe(0);
    expect(
      await owner.notificationMessage.count({
        where: {
          tenantId: TENANT,
          recipientId: REVIEWER,
          idempotencyKey: { startsWith: event?.id ?? '-' },
        },
      }),
    ).toBeGreaterThan(0);

    // A duplicate delivery of the re-armed timer changes nothing: no second announcement.
    const row = await rowOf(timerId);
    await one.enqueue(
      QueueName.WORKFLOW_TIMERS,
      { timerId, jobId: row.jobId, tenantId: TENANT, correlationId: 'duplicate' },
      { jobId: `${row.jobId}:duplicate`, attempts: 1 },
    );
    await drained();
    expect(
      await owner.outboxMessage.count({
        where: { tenantId: TENANT, eventType: 'workflow.reminder-due', aggregateId: instanceId },
      }),
    ).toBe(1);
    // One record per delivery, as D-7 left it: the reminder's own, and the duplicate's no-op.
    const fired = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, subjectId: instanceId, action: 'TIMER_FIRED' },
    });
    expect(fired).toHaveLength(2);
    expect(
      fired.every((record) => JSON.stringify(record.payload).includes('"effect":"none"')),
    ).toBe(true);
  });

  it('processes a timer whose moment passed while it was lost, rather than abandoning it', async () => {
    const { instanceId, deadlineId } = await aPendingDeadline();
    await lose();
    // The outage outlasted the deadline.
    await owner.workflowTimer.update({
      where: { id: deadlineId },
      data: { fireAt: new Date(FIXED_NOW.getTime() - 3_600_000) },
    });

    await recoveryOne.recoverTenant(TENANT);
    // Due now: no promotion, the consumer takes it straight away.
    await claimed(deadlineId);
    expect((await rowOf(deadlineId)).state).toBe(WorkflowTimerState.FIRED);
    expect(
      (await owner.approvalTask.findMany({ where: { instanceId, assigneeId: APPROVER } })).length,
    ).toBe(1);
  });

  it('recovering from two processes at once leaves one job, one firing and one escalation', async () => {
    const { instanceId, deadlineId } = await aPendingDeadline();
    await lose();

    await Promise.all([recoveryOne.recoverTenant(TENANT), recoveryTwo.recoverTenant(TENANT)]);
    expect(await jobsFor(deadlineId)).toHaveLength(1);

    await fire(deadlineId);
    // And again, from both, after it fired: nothing is resurrected.
    await Promise.all([recoveryOne.recoverTenant(TENANT), recoveryTwo.recoverTenant(TENANT)]);
    await drained();
    expect(await jobsFor(deadlineId)).toHaveLength(0);

    expect(await owner.approvalTask.count({ where: { instanceId, assigneeId: APPROVER } })).toBe(1);
    const assigned = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, eventType: 'workflow.task-assigned', aggregateId: instanceId },
    });
    expect(
      assigned.filter((message) => JSON.stringify(message.payload).includes(APPROVER)),
    ).toHaveLength(1);
    // One escalation on the record, and no second delivery at all: the broker de-duplicated the
    // two re-arms, so there was never a duplicate for the claim to turn into a no-op.
    expect(
      await owner.auditEvent.count({
        where: { tenantId: TENANT, subjectId: instanceId, action: 'ESCALATED' },
      }),
    ).toBe(1);
    expect(
      await owner.auditEvent.count({
        where: { tenantId: TENANT, subjectId: instanceId, action: 'TIMER_FIRED' },
      }),
    ).toBe(0);
  });

  it('resurrects nothing that is not owed a firing', async () => {
    // Fired.
    const fired = await aPendingDeadline();
    await fire(fired.deadlineId);
    // Cancelled with its stage: the reviewer approves before the deadline.
    const decided = await aPendingDeadline();
    const task = await owner.approvalTask.findFirstOrThrow({
      where: { instanceId: decided.instanceId, assigneeId: REVIEWER },
    });
    await as(
      () =>
        engineOne.engine.decide({
          taskId: asId<ApprovalTaskId>(task.id),
          decision: TaskDecision.APPROVED,
          comment: null,
        }),
      REVIEWER,
    );
    // Cancelled with its instance: the author withdraws.
    const withdrawn = await aPendingDeadline();
    const withdrawnInstance = await owner.workflowInstance.findUniqueOrThrow({
      where: { id: withdrawn.instanceId },
    });
    await as(() =>
      engineOne.engine.withdraw(asId<DocumentId>(withdrawnInstance.documentId), 'Wrong file.'),
    );
    // Paused: its remainder is held, and resume — not recovery — is what re-arms it.
    const paused = await aPendingDeadline();
    await as(() =>
      engineOne.engine.pause(
        asId<WorkflowInstanceId>(paused.instanceId),
        WorkflowPauseReason.ADMINISTRATIVE,
        null,
      ),
    );
    // A row left SCHEDULED on an instance that has ended: inconsistent, and still not owed.
    const orphan = await aPendingDeadline();
    const orphanInstance = await owner.workflowInstance.findUniqueOrThrow({
      where: { id: orphan.instanceId },
    });
    await as(() =>
      engineOne.engine.withdraw(asId<DocumentId>(orphanInstance.documentId), 'Ended.'),
    );
    await owner.workflowTimer.update({
      where: { id: orphan.deadlineId },
      data: { state: WorkflowTimerState.SCHEDULED },
    });

    expect((await rowOf(fired.deadlineId)).state).toBe(WorkflowTimerState.FIRED);
    expect((await rowOf(decided.deadlineId)).state).toBe(WorkflowTimerState.CANCELLED);
    expect((await rowOf(withdrawn.deadlineId)).state).toBe(WorkflowTimerState.CANCELLED);
    expect((await rowOf(paused.deadlineId)).state).toBe(WorkflowTimerState.PAUSED);

    await lose();
    await Promise.all([recoveryOne.recoverTenant(TENANT), recoveryTwo.recoverTenant(TENANT)]);
    for (const timerId of [
      fired.deadlineId,
      decided.deadlineId,
      withdrawn.deadlineId,
      paused.deadlineId,
      orphan.deadlineId,
    ]) {
      expect(await jobsFor(timerId)).toHaveLength(0);
    }
    expect((await rowOf(paused.deadlineId)).state).toBe(WorkflowTimerState.PAUSED);
  });

  it('re-declares a lost schedule once, from either process, and never one that was withdrawn', async () => {
    const kept = `rc-d13-kept-${uuidv7()}`;
    const withdrawnSchedule = `rc-d13-withdrawn-${uuidv7()}`;
    const laneName = QueueName.AUDIT_STREAM;
    // Both processes declared the kept schedule at boot, as every instance does.
    await one.schedule(laneName, kept, '0 3 * * *', { kind: 'rc-d13' });
    await two.schedule(laneName, kept, '0 3 * * *', { kind: 'rc-d13' });
    // One schedule declared and then withdrawn — a lane that lost its handler.
    await one.schedule(laneName, withdrawnSchedule, '0 4 * * *', { kind: 'rc-d13' });
    await one.unschedule(laneName, withdrawnSchedule);

    const schedules = new Queue(laneName, {
      connection: new Redis(redisUrl, { maxRetriesPerRequest: null }),
    });
    const named = async (name: string) =>
      (await schedules.getJobSchedulers()).filter((entry) => entry.key === name);
    try {
      expect(await named(kept)).toHaveLength(1);

      await lose();
      expect(await named(kept)).toHaveLength(0);

      const [a, b] = await Promise.all([
        new QueueRecoveryScheduler(one, new QueueRecoveryRegistry(), recoveryConfig, logger).pass(),
        new QueueRecoveryScheduler(two, new QueueRecoveryRegistry(), recoveryConfig, logger).pass(),
      ]);
      expect(a.ran && b.ran).toBe(true);
      expect(await named(kept)).toHaveLength(1);
      expect(await named(withdrawnSchedule)).toHaveLength(0);

      // Again, with the broker intact: nothing added, nothing duplicated.
      const again = await new QueueRecoveryScheduler(
        one,
        new QueueRecoveryRegistry(),
        recoveryConfig,
        logger,
      ).pass({ force: true });
      expect(again.schedulesRedeclared).toBe(0);
      expect(await named(kept)).toHaveLength(1);
      expect(await named(withdrawnSchedule)).toHaveLength(0);
    } finally {
      await one.unschedule(laneName, kept);
      await two.unschedule(laneName, kept);
      await schedules.close();
    }
  });

  it('notices a loss by itself: an intact broker is left alone, a flushed one is rebuilt', async () => {
    const { deadlineId } = await aPendingDeadline();
    const scheduler = new QueueRecoveryScheduler(one, registryOne, recoveryConfig, logger);
    await scheduler.pass(); // boot
    expect(await scheduler.pass()).toMatchObject({ ran: false, brokerWasIntact: true });

    await lose();
    const noticed = await scheduler.pass();
    expect(noticed).toMatchObject({ ran: true, brokerWasIntact: false });
    expect(await jobsFor(deadlineId)).toHaveLength(1);
  });
});
