import 'reflect-metadata';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ApprovalTaskState,
  type ApprovalTaskId,
  DelegationKind,
  DelegationStatus,
  type DelegationId,
  type DocumentId,
  NumberSegmentKind,
  ParticipantKind,
  Permission,
  ScanStatus,
  Settings,
  StageCompletionRule,
  TaskDecision,
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
  type DelegationStack,
  type DocumentLibraryStack,
  type WorkflowEngineStack,
  realDelegation,
  realDocumentLibrary,
  realWorkflowEngine,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import { DelegationAudit } from '../domain/audit-actions';
import type { WorkflowDirectory } from '../../workflow/application/ports';

/**
 * Phase 11 against a real PostgreSQL — the assertions only a database can be trusted about.
 *
 * Every one of these is a question about what is in the table *at an instant*, which is precisely
 * what a repository double cannot be asked: a double answers from the same belief as the code under
 * test, and every rule §4 states is a rule about the world changing underneath a decision.
 *
 * - **A delegate decides a task that stays the delegator's**, with both identities on the row, the
 *   assignee untouched, and two audit events — the decision's own and `DELEGATION_USED` — in one
 *   transaction. This is the phase's central claim and the routing overlay made visible.
 * - **A decision is refused the moment the delegation is revoked**, mid-flight, with the task still
 *   pending and still the delegator's afterwards.
 * - **A delegate is refused when the delegator's own authority has gone**, with the delegation
 *   itself untouched — §4's "checked at decision time, not at creation" as a property rather than a
 *   sentence.
 * - **A chain is refused by default and permitted for exactly one hop** when the setting allows it,
 *   with a cycle still refused under either setting.
 * - **A delegation past its end date is decided by nothing**, before any sweep has run — because
 *   the predicate is what makes it inert, not the job.
 * - **The inbox shows a delegate exactly what they may act on and nothing more.**
 * - **An emergency delegation writes its ground to the trail's own `reason` column**, where an
 *   ordinary one leaves it null — the attested difference between the two paths.
 *
 * The sweep is asserted too, and asserted for what it *is*: it records the expiry that the
 * predicate had already enforced, and it is idempotent under redelivery.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

/** Movable, because a delegation is a period and half of these assertions are about crossing it. */
let now = new Date('2026-08-05T09:00:00.000Z');
const clock = { now: () => new Date(now), timestamp: () => 0, elapsedMs: () => 0 };
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
/** The author, who submits. Never a party to a delegation here. */
const AUTHOR = asId<UserId>(uuidv7());
/** The assignee of every task below, and the delegator in every arrangement. */
const ALICE = asId<UserId>(uuidv7());
/** The delegate. */
const BOB = asId<UserId>(uuidv7());
/** The second hop, for the chain assertions. */
const CAROL = asId<UserId>(uuidv7());
/** Alice's manager: the person who approves her requests. */
const MANAGER = asId<UserId>(uuidv7());

const SIGNING_SECRET = 'a-phase-eleven-integration-secret-32-chars';
const MAGIC = new Uint8Array(Buffer.from('%PDF-1.7\n% ', 'utf8'));

let root: string;
let owner: PrismaClient;
let unitOfWork: PrismaUnitOfWork;
let library: DocumentLibraryStack;
let workflow: WorkflowEngineStack;
let delegation: DelegationStack;
/** A second stack whose tenant setting permits chaining, for the two hop assertions. */
let chaining: DelegationStack;

let rootFolderId: string;
let confidentialityId: string;
let numberingRuleId: string;
let documentTypeId: string;
let approverRoleId: string;

/**
 * Who works here.
 *
 * `managersOf` is the *real* `PrismaUserDirectory` in the delegation stack — the approval rule
 * depends on `user_department.is_manager` and asserting it against a double would assert nothing.
 * This one is the workflow engine's, where a task's assignee is whoever this suite says it is.
 */
const directory: WorkflowDirectory = {
  holdersOfRole: (roleKey) => Promise.resolve(roleKey === 'approver' ? [ALICE] : []),
  membersOfDepartment: () => Promise.resolve([ALICE]),
  managersOf: () => Promise.resolve([MANAGER]),
  membersOfGroup: () => Promise.resolve([]),
  activeAmong: (ids) => Promise.resolve(ids),
  displayNames: (ids) => Promise.resolve(new Map(ids.map((id) => [id, 'Test User']))),
};

function contextFor(
  userId: UserId | null,
  permissions: readonly string[] = [Permission.DELEGATION_MANAGE],
): RequestContext {
  return {
    tenantId: TENANT,
    userId,
    roles: ['APPROVER'],
    permissions: permissions as never,
    sessionId: null,
    correlationId: 'delegation',
    permissionVersion: 1,
    locale: 'en',
  };
}

function as<T>(
  work: () => Promise<T>,
  userId: UserId = ALICE,
  permissions?: readonly string[],
): Promise<T> {
  return runWithContext(contextFor(userId, permissions), work);
}

/** The sweep runs as nobody — a clock carrying out a period, which is what the lane does. */
function asSystem<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(null, []), work);
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(3, '0')}`;
}

// --- Fixtures ----------------------------------------------------------------------------------

function aPdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${marker}\n1 0 obj\n<<>>\nendobj\n`);
}

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
    clock.now(),
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
    data: { scanStatus: ScanStatus.CLEAN, scanner: 'integration-suite', scannedAt: clock.now() },
  });
}

/** A document submitted into a one-stage approval whose single task is Alice's. */
async function aSubmittedDocument(): Promise<{ documentId: string; taskId: ApprovalTaskId }> {
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
  await as(() => workflow.engine.submit(asId<DocumentId>(document.id), null), AUTHOR);
  const task = await owner.approvalTask.findFirstOrThrow({
    where: { tenantId: TENANT, instance: { documentId: document.id } },
  });
  expect(task.assigneeId).toBe(ALICE);
  return { documentId: document.id, taskId: asId<ApprovalTaskId>(task.id) };
}

/**
 * A delegation from Alice to somebody, already in force.
 *
 * Created through the real service and then approved by Alice's real manager, because "who may
 * approve" is one of the phase's own decisions and seeding an `ACTIVE` row would sidestep it.
 */
async function anActiveDelegation(
  delegateId: UserId,
  overrides: {
    readonly permissions?: readonly string[];
    readonly endsAt?: Date;
    readonly stack?: DelegationStack;
    readonly delegatorId?: UserId;
  } = {},
): Promise<DelegationId> {
  const stack = overrides.stack ?? delegation;
  const delegator = overrides.delegatorId ?? ALICE;
  const id = await as(
    () =>
      stack.delegations.request({
        delegateId,
        startsAt: clock.now(),
        endsAt: overrides.endsAt ?? new Date(now.getTime() + 7 * 86_400_000),
        permissions: (overrides.permissions ?? [Permission.DOCUMENT_APPROVE]) as never,
        reason: null,
      }),
    delegator,
  );
  await as(() => stack.delegations.approve(id), MANAGER);
  return id;
}

/** Grants a role to somebody, which is how `CredentialRepository` reports what they hold. */
async function grantRole(userId: UserId, roleId: string): Promise<void> {
  await owner.userRole.create({
    data: { tenantId: TENANT, userId, roleId, assignedAt: clock.now() },
  });
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  root = await mkdtemp(join(tmpdir(), 'munaxa-delegation-'));
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
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `dg-${String(Date.now())}-${TENANT.slice(0, 8)}`,
      name: 'Delegation Test',
      status: 'ACTIVE',
    },
  });

  // The role whose permissions are what Alice "holds". Withdrawing it later is how the authority
  // assertion takes her authority away without touching the delegation.
  const role = await owner.role.create({
    data: {
      id: uuidv7(),
      tenantId: TENANT,
      key: unique('approver-'),
      name: 'Approver',
      isSystem: false,
      updatedAt: clock.now(),
      permissions: {
        create: [
          { tenantId: TENANT, permission: Permission.DOCUMENT_APPROVE },
          { tenantId: TENANT, permission: Permission.DOCUMENT_REJECT },
          { tenantId: TENANT, permission: Permission.DELEGATION_MANAGE },
        ],
      },
    },
  });
  approverRoleId = role.id;

  for (const id of [AUTHOR, ALICE, BOB, CAROL, MANAGER]) {
    await owner.user.create({
      data: {
        id,
        tenantId: TENANT,
        email: `${id}@example.test`,
        emailNormalized: `${id}@example.test`,
        displayName: `User ${id.slice(0, 8)}`,
        status: 'ACTIVE',
        updatedAt: clock.now(),
      },
    });
  }
  // Everybody who might delegate or be delegated to holds the authority. Alice's is the one that
  // gets taken away later.
  for (const id of [ALICE, BOB, CAROL]) {
    await grantRole(id, approverRoleId);
  }

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
        [AUTHOR, ALICE, BOB, CAROL, MANAGER].includes(id as UserId)
          ? Promise.resolve({ id } as never)
          : Promise.reject(Object.assign(new Error('not found'), { code: 'NOT_FOUND' })),
    },
  });

  delegation = realDelegation({ clock, unitOfWork });
  chaining = realDelegation({
    clock,
    unitOfWork,
    settings: { [Settings.DELEGATION_ALLOW_CHAINING.key]: true },
  });

  workflow = realWorkflowEngine({
    clock,
    unitOfWork,
    documents: library.documents,
    configuration: library.configuration,
    directory,
    // The gate Phase 4 left unbound, bound. Composing it is what relaxes the engine's single
    // "the task belongs to you" check, and nothing else in the engine changed.
    delegations: delegation.gate,
  });

  // Alice's manager, as a real department membership — the approval rule reads this row, and a
  // double would make the phase's own decision untestable. The scope tree is seeded directly
  // rather than provisioned: what this suite needs from it is one department to hang an
  // `is_manager` row on, and provisioning it would drag in a second tenant bootstrap.
  const company = await owner.company.create({
    data: {
      id: uuidv7(),
      tenantId: TENANT,
      code: unique('CO'),
      name: 'Munaxa',
      updatedAt: clock.now(),
    },
  });
  const entity = await owner.entity.create({
    data: {
      id: uuidv7(),
      tenantId: TENANT,
      companyId: company.id,
      code: unique('EN'),
      name: 'Munaxa Ltd',
      updatedAt: clock.now(),
    },
  });
  const department = await owner.department.create({
    data: {
      id: uuidv7(),
      tenantId: TENANT,
      entityId: entity.id,
      code: unique('D'),
      name: 'Quality',
      path: unique('quality'),
      updatedAt: clock.now(),
    },
  });
  await owner.userDepartment.createMany({
    data: [
      { tenantId: TENANT, userId: ALICE, departmentId: department.id, isPrimary: true },
      { tenantId: TENANT, userId: BOB, departmentId: department.id, isPrimary: true },
      { tenantId: TENANT, userId: CAROL, departmentId: department.id, isPrimary: true },
      {
        tenantId: TENANT,
        userId: MANAGER,
        departmentId: department.id,
        isPrimary: true,
        isManager: true,
      },
    ],
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

  const definition = await as(() =>
    workflow.definitions.create({
      key: unique('wf-'),
      name: 'Approval',
      definition: {
        appliesTo: { documentTypes: [], condition: null },
        stages: [
          {
            name: 'Review',
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
        ],
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
      numberingRuleId,
      defaultConfidentialityId: confidentialityId,
      revisionLabelStyle: 'NUMERIC',
      isActive: true,
      fields: [],
      workflowDefinitionId: definition.id,
    }),
  );
  documentTypeId = type.id;
}, 90_000);

afterAll(async () => {
  await owner?.$disconnect();
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  now = new Date('2026-08-05T09:00:00.000Z');
  // Every case arranges the cover it is about, and a delegation left in force by the previous one
  // would authorise the decision this one expects to be refused. Retired rather than deleted,
  // because `approval_task.delegation_id` restricts — which is itself one of the assertions below.
  await owner.delegation.updateMany({
    where: { tenantId: TENANT, status: DelegationStatus.ACTIVE },
    data: { status: DelegationStatus.EXPIRED },
  });
  // Alice's authority, restored — one case takes it away deliberately.
  const held = await owner.userRole.count({ where: { tenantId: TENANT, userId: ALICE } });
  if (held === 0) {
    await grantRole(ALICE, approverRoleId);
  }
});

// --- The central claim -------------------------------------------------------------------------

describe('a delegate deciding', () => {
  /**
   * The phase's central assertion, and the reason `approval_task` was given three columns rather
   * than one. Everything here is read back off the row after the fact.
   */
  it('decides a task that stays the delegator’s, with both identities recorded', async () => {
    const delegationId = await anActiveDelegation(BOB);
    const { taskId } = await aSubmittedDocument();

    await as(
      () => workflow.engine.decide({ taskId, decision: TaskDecision.APPROVED, comment: null }),
      BOB,
    );

    const task = await owner.approvalTask.findUniqueOrThrow({ where: { id: taskId } });
    // The task never moved. This is the routing overlay in one assertion: the delegate acted on a
    // task that is still, and was always, the delegator's.
    expect(task.assigneeId).toBe(ALICE);
    expect(task.decidedById).toBe(BOB);
    expect(task.onBehalfOfId).toBe(ALICE);
    expect(task.delegationId).toBe(delegationId);
    expect(task.decision).toBe(TaskDecision.APPROVED);

    // Two audit events, in one transaction: the decision's own, and the delegation's use. The
    // second is what *attests* the link — Phase 9's digest covers `on_behalf_of_id` and not the
    // foreign key this phase added, and the table refuses the `UPDATE` that would rehash it.
    const decided = await owner.auditEvent.findFirstOrThrow({
      where: { tenantId: TENANT, action: 'APPROVED', subjectId: taskId },
    });
    expect(
      decided.onBehalfOfId ??
        (decided.payload as never as { after: { onBehalfOf: string } }).after.onBehalfOf,
    ).toBeTruthy();

    const used = await owner.auditEvent.findFirstOrThrow({
      where: {
        tenantId: TENANT,
        action: DelegationAudit.DELEGATION_USED,
        subjectId: delegationId,
      },
    });
    // Filed against the *delegation*, which is what makes "everything done under this arrangement"
    // a query on one subject rather than a join through a table an investigation has to know about.
    expect(used.subjectType).toBe('DELEGATION');
    const payload = used.payload as unknown as { after: { decidedBy: string; onBehalfOf: string } };
    expect(payload.after.decidedBy).toBe(BOB);
    expect(payload.after.onBehalfOf).toBe(ALICE);

    // And the link survives the delegation's end, which is the point of the restricting key.
    const uses = await as(() => delegation.delegations.uses(delegationId));
    expect(uses.map((use) => use.taskId)).toContain(taskId);
  });

  it('refuses somebody with no delegation at all', async () => {
    const { taskId } = await aSubmittedDocument();
    await expect(
      as(
        () => workflow.engine.decide({ taskId, decision: TaskDecision.APPROVED, comment: null }),
        CAROL,
      ),
    ).rejects.toThrow(/somebody else/i);

    const task = await owner.approvalTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.state).toBe(ApprovalTaskState.PENDING);
    expect(task.decidedById).toBeNull();
  });

  /**
   * A delegation covering `document:approve` does not authorise a rejection. The catalogue and 08
   * §6's matrix treat them as two grants, and the engine names the permission the decision
   * exercises rather than assuming one.
   */
  it('refuses a decision the delegation’s permissions do not cover', async () => {
    await anActiveDelegation(BOB, { permissions: [Permission.DOCUMENT_APPROVE] });
    const { taskId } = await aSubmittedDocument();

    await expect(
      as(
        () =>
          workflow.engine.decide({
            taskId,
            decision: TaskDecision.REJECTED,
            comment: 'Not good enough.',
          }),
        BOB,
      ),
    ).rejects.toThrow(/PERMISSION_NOT_DELEGATED/);
  });
});

// --- Revocation --------------------------------------------------------------------------------

describe('revocation', () => {
  /**
   * §4: "revocation is immediate; in-flight tasks revert to the delegator". Both halves are one
   * fact, and this asserts it as one: nothing is reassigned because nothing ever moved.
   */
  it('refuses the very next decision, and leaves the task pending and the delegator’s', async () => {
    const delegationId = await anActiveDelegation(BOB);
    const { taskId } = await aSubmittedDocument();

    await as(() => delegation.delegations.revoke(delegationId, 'Back early.'), ALICE);

    await expect(
      as(
        () => workflow.engine.decide({ taskId, decision: TaskDecision.APPROVED, comment: null }),
        BOB,
      ),
    ).rejects.toThrow(/NOT_IN_FORCE|somebody else/i);

    const task = await owner.approvalTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.state).toBe(ApprovalTaskState.PENDING);
    expect(task.assigneeId).toBe(ALICE);
    expect(task.delegationId).toBeNull();

    // The delegation is not deleted — a revoked one is exactly what an investigation asks about.
    const row = await owner.delegation.findUniqueOrThrow({ where: { id: delegationId } });
    expect(row.status).toBe(DelegationStatus.REVOKED);
    expect(row.revokeReason).toBe('Back early.');
    expect(row.revokedById).toBe(ALICE);

    // And the delegator can still decide it themselves, which is what "reverts" means.
    await as(
      () => workflow.engine.decide({ taskId, decision: TaskDecision.APPROVED, comment: null }),
      ALICE,
    );
    const after = await owner.approvalTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(after.decidedById).toBe(ALICE);
    expect(after.onBehalfOfId).toBeNull();
  });

  /** A decision already taken under a revoked delegation keeps its link. The key restricts. */
  it('cannot be deleted once something was decided under it', async () => {
    const delegationId = await anActiveDelegation(BOB);
    const { taskId } = await aSubmittedDocument();
    await as(
      () => workflow.engine.decide({ taskId, decision: TaskDecision.APPROVED, comment: null }),
      BOB,
    );
    await as(() => delegation.delegations.revoke(delegationId, 'Done.'), ALICE);

    await expect(owner.delegation.delete({ where: { id: delegationId } })).rejects.toThrow();

    const task = await owner.approvalTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.delegationId).toBe(delegationId);
  });
});

// --- Authority at decision time ----------------------------------------------------------------

describe('the delegator’s own authority', () => {
  /**
   * §4's central rule, and the reason nothing about the delegator's grants is copied onto the
   * delegation. The row is untouched throughout; only the world changed.
   */
  it('refuses the delegate the moment the delegator stops holding what they delegated', async () => {
    const delegationId = await anActiveDelegation(BOB);
    const { taskId } = await aSubmittedDocument();

    // Alice's role is withdrawn. The delegation still names `document:approve`, still runs for
    // another week, and is still `ACTIVE`.
    await owner.userRole.deleteMany({ where: { tenantId: TENANT, userId: ALICE } });

    await expect(
      as(
        () => workflow.engine.decide({ taskId, decision: TaskDecision.APPROVED, comment: null }),
        BOB,
      ),
    ).rejects.toThrow(/DELEGATOR_LACKS_AUTHORITY/);

    const row = await owner.delegation.findUniqueOrThrow({ where: { id: delegationId } });
    expect(row.status).toBe(DelegationStatus.ACTIVE);
    expect(row.permissions).toContain(Permission.DOCUMENT_APPROVE);

    // Restored, and the same delegation authorises again — no new row, no re-approval.
    await grantRole(ALICE, approverRoleId);
    await as(
      () => workflow.engine.decide({ taskId, decision: TaskDecision.APPROVED, comment: null }),
      BOB,
    );
    const task = await owner.approvalTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.delegationId).toBe(delegationId);
  });
});

// --- Chains ------------------------------------------------------------------------------------

describe('chains', () => {
  it('refuses re-delegation by default', async () => {
    await anActiveDelegation(BOB);

    await expect(
      as(
        () =>
          delegation.delegations.request({
            delegateId: CAROL,
            startsAt: clock.now(),
            endsAt: new Date(now.getTime() + 86_400_000),
            permissions: [Permission.DOCUMENT_APPROVE] as never,
            reason: null,
          }),
        BOB,
      ),
    ).rejects.toThrow(/does not allow you to pass/i);
  });

  it('permits exactly one hop when the tenant setting allows it, and records the depth', async () => {
    await anActiveDelegation(BOB, { stack: chaining });

    const hop = await as(
      () =>
        chaining.delegations.request({
          delegateId: CAROL,
          startsAt: clock.now(),
          endsAt: new Date(now.getTime() + 86_400_000),
          permissions: [Permission.DOCUMENT_APPROVE] as never,
          reason: null,
        }),
      BOB,
    );

    const row = await owner.delegation.findUniqueOrThrow({ where: { id: hop } });
    // Derived from the graph rather than taken from the caller, which is the one lie the depth
    // rule exists to catch.
    expect(row.depth).toBe(1);
  });

  /**
   * The assertion a hop counter alone would wave through: Alice → Bob and Bob → Alice are two edges
   * of depth one each. It is refused under *either* setting, because a cycle is a reachability
   * problem rather than a depth one.
   */
  it('refuses a cycle whatever the setting says', async () => {
    await anActiveDelegation(BOB, { stack: chaining });

    await expect(
      as(
        () =>
          chaining.delegations.request({
            delegateId: ALICE,
            startsAt: clock.now(),
            endsAt: new Date(now.getTime() + 86_400_000),
            permissions: [Permission.DOCUMENT_APPROVE] as never,
            reason: null,
          }),
        BOB,
      ),
    ).rejects.toThrow(/back to somebody who has already passed it on/i);
  });
});

// --- The period --------------------------------------------------------------------------------

describe('a delegation that has passed its end date', () => {
  /**
   * Decided by nothing, and — this is the point — *before any sweep has run*. The predicate is what
   * makes an expired delegation inert; the job only records that it happened. A stalled queue can
   * never leave an authority in place.
   */
  it('authorises nothing, with no job having run', async () => {
    const delegationId = await anActiveDelegation(BOB, {
      endsAt: new Date(now.getTime() + 3_600_000),
    });
    const { taskId } = await aSubmittedDocument();

    now = new Date(now.getTime() + 2 * 3_600_000);

    // Still `ACTIVE` on the row. Nothing has swept.
    const before = await owner.delegation.findUniqueOrThrow({ where: { id: delegationId } });
    expect(before.status).toBe(DelegationStatus.ACTIVE);

    await expect(
      as(
        () => workflow.engine.decide({ taskId, decision: TaskDecision.APPROVED, comment: null }),
        BOB,
      ),
    ).rejects.toThrow(/somebody else/i);
  });

  /** The sweep records what the predicate had already enforced, and is idempotent under redelivery. */
  it('is recorded by the sweep, once', async () => {
    const delegationId = await anActiveDelegation(BOB, {
      endsAt: new Date(now.getTime() + 3_600_000),
    });
    now = new Date(now.getTime() + 2 * 3_600_000);

    const first = await asSystem(() => delegation.delegations.expireEnded(100));
    expect(first).toBeGreaterThanOrEqual(1);

    const row = await owner.delegation.findUniqueOrThrow({ where: { id: delegationId } });
    expect(row.status).toBe(DelegationStatus.EXPIRED);

    const events = await owner.auditEvent.count({
      where: {
        tenantId: TENANT,
        action: DelegationAudit.DELEGATION_EXPIRED,
        subjectId: delegationId,
      },
    });
    expect(events).toBe(1);

    // Redelivered. `transition` carries the expected status in its `WHERE`, so the second pass
    // matches nothing and writes nothing.
    await asSystem(() => delegation.delegations.expireEnded(100));
    const after = await owner.auditEvent.count({
      where: {
        tenantId: TENANT,
        action: DelegationAudit.DELEGATION_EXPIRED,
        subjectId: delegationId,
      },
    });
    expect(after).toBe(1);
  });
});

// --- The inbox ---------------------------------------------------------------------------------

describe('the inbox', () => {
  /**
   * "Exactly what they may act on and nothing more" — a property of the `IN` list the query is
   * built from rather than a filter applied afterwards.
   */
  it('shows a delegate the delegator’s tasks, and nothing else', async () => {
    const delegationId = await anActiveDelegation(BOB);
    const { taskId } = await aSubmittedDocument();

    const cover = await as(
      () =>
        delegation.gate.coverFor({
          actorId: BOB,
          permission: Permission.DOCUMENT_APPROVE,
          at: clock.now(),
        }),
      BOB,
    );
    expect(cover).toEqual([{ delegationId, delegatorId: ALICE }]);

    const page = await as(
      () =>
        workflow.approvals.inbox({
          page: 1,
          pageSize: 50,
          assigneeId: BOB,
          cover,
          sortDirection: 'asc',
        }),
      BOB,
    );

    const row = page.data.find((entry) => entry.task.id === taskId);
    expect(row).toBeDefined();
    // The task is in Bob's inbox and is still assigned to Alice — which is the whole distinction.
    expect(row?.task.assigneeId).toBe(ALICE);
    expect(row?.onBehalfOf).toEqual({ delegationId, delegatorId: ALICE });

    // And with the cover withdrawn it is not there at all.
    await as(() => delegation.delegations.revoke(delegationId, 'Back.'), ALICE);
    const withoutCover = await as(
      () =>
        workflow.approvals.inbox({
          page: 1,
          pageSize: 50,
          assigneeId: BOB,
          cover: [],
          sortDirection: 'asc',
        }),
      BOB,
    );
    expect(withoutCover.data.some((entry) => entry.task.id === taskId)).toBe(false);
  });
});

// --- Emergency ---------------------------------------------------------------------------------

describe('an emergency delegation', () => {
  /**
   * Whatever it bypasses, it does not bypass the audit — and the difference is visible in the
   * trail's own attested `reason` column rather than only in a payload field.
   */
  it('is active without approval, and states its ground in the trail’s attested column', async () => {
    const id = await as(() =>
      delegation.delegations.declareEmergency({
        delegateId: BOB,
        endsAt: new Date(now.getTime() + 12 * 3_600_000),
        permissions: [Permission.DOCUMENT_APPROVE] as never,
        reason: 'Alice is in hospital and three approvals are overdue.',
      }),
    );

    const row = await owner.delegation.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(DelegationStatus.ACTIVE);
    expect(row.kind).toBe(DelegationKind.EMERGENCY);
    // Nobody approved it, and the row says so rather than naming somebody who did not.
    expect(row.approvedById).toBeNull();

    const event = await owner.auditEvent.findFirstOrThrow({
      where: {
        tenantId: TENANT,
        action: DelegationAudit.DELEGATION_CREATED,
        subjectId: id,
      },
    });
    // The attested column, not a payload field. This is the record of a control being bypassed.
    expect(event.reason).toBe('Alice is in hospital and three approvals are overdue.');

    // And it works: the delegate can decide immediately.
    const { taskId } = await aSubmittedDocument();
    await as(
      () => workflow.engine.decide({ taskId, decision: TaskDecision.APPROVED, comment: null }),
      BOB,
    );
    const task = await owner.approvalTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.delegationId).toBe(id);
  });

  /** An ordinary delegation leaves the column null, which is what makes the emergency one legible. */
  it('is distinguishable from an ordinary one in the trail', async () => {
    const id = await anActiveDelegation(BOB);
    const event = await owner.auditEvent.findFirstOrThrow({
      where: {
        tenantId: TENANT,
        action: DelegationAudit.DELEGATION_CREATED,
        subjectId: id,
        payload: { path: ['operation'], equals: 'CREATED' },
      },
    });
    expect(event.reason).toBeNull();
  });

  it('is refused a period longer than the emergency maximum', async () => {
    await expect(
      as(() =>
        delegation.delegations.declareEmergency({
          delegateId: BOB,
          // Well beyond the seventy-two hour default.
          endsAt: new Date(now.getTime() + 30 * 86_400_000),
          permissions: [Permission.DOCUMENT_APPROVE] as never,
          reason: 'Indefinite cover.',
        }),
      ),
    ).rejects.toThrow(/longer than this organisation allows/i);
  });
});

// --- Approval ----------------------------------------------------------------------------------

describe('who may approve a delegation', () => {
  it('is not a party to it, however many permissions they hold', async () => {
    const id = await as(() =>
      delegation.delegations.request({
        delegateId: BOB,
        startsAt: clock.now(),
        endsAt: new Date(now.getTime() + 86_400_000),
        permissions: [Permission.DOCUMENT_APPROVE] as never,
        reason: null,
      }),
    );

    // The delegator, holding every permission there is, cannot approve their own request.
    await expect(
      as(() => delegation.delegations.approve(id), ALICE, Object.values(Permission)),
    ).rejects.toThrow(/a party to/i);
    // Nor can the delegate.
    await expect(
      as(() => delegation.delegations.approve(id), BOB, Object.values(Permission)),
    ).rejects.toThrow(/a party to/i);
    // Somebody unrelated who is neither a manager nor a user administrator cannot either.
    await expect(as(() => delegation.delegations.approve(id), CAROL)).rejects.toThrow(
      /approve this delegation/i,
    );

    // Alice's manager can, through `user_department.is_manager` and nothing else.
    await as(() => delegation.delegations.approve(id), MANAGER);
    const row = await owner.delegation.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(DelegationStatus.ACTIVE);
    expect(row.approvedById).toBe(MANAGER);
  });

  /** A pending delegation authorises nothing. It is not "active but unapproved". */
  it('authorises nothing until somebody agrees', async () => {
    await as(() =>
      delegation.delegations.request({
        delegateId: BOB,
        startsAt: clock.now(),
        endsAt: new Date(now.getTime() + 86_400_000),
        permissions: [Permission.DOCUMENT_APPROVE] as never,
        reason: null,
      }),
    );
    const { taskId } = await aSubmittedDocument();

    await expect(
      as(
        () => workflow.engine.decide({ taskId, decision: TaskDecision.APPROVED, comment: null }),
        BOB,
      ),
    ).rejects.toThrow(/somebody else/i);
  });
});
