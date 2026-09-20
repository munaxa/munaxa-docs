import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ManagerOfSubject,
  ParticipantKind,
  StageCompletionRule,
  type TenantId,
  type UserId,
  WorkflowVersionState,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { realWriteStack } from '../../../testing/real-collaborators';
import { WorkflowAdminService } from '../application/workflow-admin.service';
import type { DefinitionShape } from '../domain/version-validator';
import { PrismaWorkflowAdminRepository } from '../infrastructure/prisma-workflow-admin.repository';
import { sharedDatabase } from '../../../testing/tenant-database';

/**
 * Workflow definitions, against a real PostgreSQL.
 *
 * One property is worth a database to assert: **a published version is immutable**. The service checks
 * it, and the repository's statements carry `state = DRAFT` in their `WHERE` so that a check which ran a
 * moment earlier is not the only thing standing between an approval and rules that changed underneath
 * it. Only a real database can show that the second guard holds when the first is bypassed.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const config = { env: 'test', database: { url: APP_URL, poolSize: 10 } } as unknown as AppConfig;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const FIXED_NOW = new Date('2026-10-01T09:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };

const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);
const { stamps, writer } = realWriteStack(clock, unitOfWork);
const repository = new PrismaWorkflowAdminRepository(stamps);
const workflows = new WorkflowAdminService(repository, writer);

const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

const TENANT = asId<TenantId>(uuidv7());
const ADMIN = asId<UserId>(uuidv7());

function asAdmin<T>(work: () => Promise<T>): Promise<T> {
  const context: RequestContext = {
    tenantId: TENANT,
    userId: ADMIN,
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: 'workflow-admin',
    permissionVersion: 1,
    locale: 'en',
  };
  return runWithContext(context, work);
}

let counter = 0;
function uniqueKey(): string {
  counter += 1;
  return `workflow-${String(counter).padStart(3, '0')}`;
}

function definitionWith(stageName = 'Department review'): DefinitionShape {
  return {
    appliesTo: { documentTypes: [] },
    stages: [
      {
        name: stageName,
        participants: [{ kind: ParticipantKind.MANAGER_OF, of: ManagerOfSubject.AUTHOR }],
        completionRule: StageCompletionRule.ALL,
        ordered: false,
        condition: null,
        deadline: null,
        reminders: [],
        onOverdue: { action: 'NOTIFY_ONLY' },
        maxEscalations: 2,
      },
    ],
  };
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  await owner.tenant.create({
    data: { id: TENANT, slug: `wf-${Date.now()}`, name: 'Workflow Test', status: 'ACTIVE' },
  });
});

afterAll(async () => {
  await owner.$disconnect();
  await prisma.disconnectAll();
});

async function aDefinition(): Promise<{ id: string; recordVersion: number; versionId: string }> {
  const created = await asAdmin(() =>
    workflows.create({ key: uniqueKey(), name: 'Quality approval', definition: definitionWith() }),
  );
  return {
    id: created.id,
    recordVersion: created.recordVersion,
    versionId: created.versions[0]?.id ?? '',
  };
}

describe('creating a definition', () => {
  it('creates a first draft version with it', async () => {
    const definition = await aDefinition();
    const read = await asAdmin(() => workflows.get(definition.id));

    // A definition with no version is a name with no behaviour — nothing can be attached to it and
    // nothing can run.
    expect(read.versions).toHaveLength(1);
    expect(read.versions[0]).toMatchObject({ version: 1, state: WorkflowVersionState.DRAFT });
    expect(read.publishedVersion).toBeNull();
    expect(read.latestVersion).toBe(1);
  });

  it('refuses a definition nothing could approve', async () => {
    await expect(
      asAdmin(() =>
        workflows.create({
          key: uniqueKey(),
          name: 'Empty',
          definition: { appliesTo: { documentTypes: [] }, stages: [] },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [{ field: 'definition', message: 'NO_STAGES' }],
    });
  });

  it('refuses a key another definition holds', async () => {
    const key = uniqueKey();
    await asAdmin(() => workflows.create({ key, name: 'First', definition: definitionWith() }));
    await expect(
      asAdmin(() => workflows.create({ key, name: 'Second', definition: definitionWith() })),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });
});

describe('a published version is immutable', () => {
  it('refuses an edit through the service', async () => {
    const definition = await aDefinition();
    await asAdmin(() =>
      workflows.publish(definition.id, definition.versionId, definition.recordVersion),
    );

    // Editing a live workflow means publishing a new version. Silently copying the edit into a new draft
    // would leave the caller believing they had changed the one they were looking at.
    await expect(
      asAdmin(() =>
        workflows.updateDraft(definition.id, definition.versionId, definitionWith('Changed')),
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [{ field: 'state', message: WorkflowVersionState.PUBLISHED }],
    });
  });

  it('refuses it in the database too, when the service check is bypassed', async () => {
    const definition = await aDefinition();
    await asAdmin(() =>
      workflows.publish(definition.id, definition.versionId, definition.recordVersion),
    );

    // Straight at the repository, skipping the service entirely. This is what the `state = DRAFT` in the
    // statement's `WHERE` is for: the immutability of a published version is the engine's most important
    // property, so it may not rest on a check that ran a moment earlier.
    await expect(
      asAdmin(() =>
        unitOfWork.run(() =>
          repository.updateDraft(definition.versionId, definitionWith('Sneaky')),
        ),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const stored = await owner.workflowVersion.findUnique({
      where: { id: definition.versionId },
      select: { definition: true },
    });
    expect(JSON.stringify(stored?.definition)).toContain('Department review');
  });

  it('stamps who published it and when', async () => {
    const definition = await aDefinition();
    await asAdmin(() =>
      workflows.publish(definition.id, definition.versionId, definition.recordVersion),
    );

    const version = await owner.workflowVersion.findUnique({
      where: { id: definition.versionId },
      select: { state: true, publishedAt: true, publishedBy: true },
    });
    // The check constraint requires both for any state other than DRAFT, so a half-published version is
    // unrepresentable.
    expect(version?.state).toBe(WorkflowVersionState.PUBLISHED);
    expect(version?.publishedAt).not.toBeNull();
  });

  it('records the publication under the action a compliance question asks for', async () => {
    const definition = await aDefinition();
    await asAdmin(() =>
      workflows.publish(definition.id, definition.versionId, definition.recordVersion),
    );

    const events = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, subjectId: definition.id },
      orderBy: { sequence: 'desc' },
      take: 1,
      select: { action: true, payload: true },
    });
    // "Which rules was this approved under, and when did they take effect" is asked on its own, which is
    // why the catalogue gives publishing its own action.
    expect(events[0]?.action).toBe('WORKFLOW_PUBLISHED');
    expect(events[0]?.payload).toMatchObject({ after: { publishedVersion: 1 } });
  });

  it('refuses a blind publish', async () => {
    const definition = await aDefinition();
    // Publishing is irreversible — the draft becomes immutable — so it may not be done against a state
    // the caller has not seen.
    await expect(
      asAdmin(() => workflows.publish(definition.id, definition.versionId, undefined)),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});

describe('editing a live workflow', () => {
  it('is a new draft, and publishing it deprecates the old one', async () => {
    const definition = await aDefinition();
    await asAdmin(() =>
      workflows.publish(definition.id, definition.versionId, definition.recordVersion),
    );

    const withDraft = await asAdmin(() =>
      workflows.addDraft(definition.id, definitionWith('Revised review')),
    );
    expect(withDraft.latestVersion).toBe(2);
    // The live version is untouched while the draft is being built.
    expect(withDraft.publishedVersion).toBe(1);

    const draft = withDraft.versions.find((version) => version.version === 2);
    await asAdmin(() => workflows.publish(definition.id, draft?.id ?? '', withDraft.recordVersion));

    const after = await asAdmin(() => workflows.get(definition.id));
    // Exactly one live version, so "which rules apply to a new submission" has one answer.
    expect(after.publishedVersion).toBe(2);
    expect(after.versions.find((version) => version.version === 1)?.state).toBe(
      WorkflowVersionState.DEPRECATED,
    );
    // And the old version is still readable, because approvals bound to it keep reading it.
    expect(after.versions.find((version) => version.version === 1)).toBeDefined();
  });

  it('numbers versions as max + 1, with no gaps from failed attempts', async () => {
    const definition = await aDefinition();

    // A rejected draft must not consume a number: a gap reads as a version somebody removed.
    await expect(
      asAdmin(() =>
        workflows.addDraft(definition.id, { appliesTo: { documentTypes: [] }, stages: [] }),
      ),
    ).rejects.toThrow();

    const withDraft = await asAdmin(() =>
      workflows.addDraft(definition.id, definitionWith('Second')),
    );
    expect(withDraft.versions.map((version) => version.version)).toEqual([1, 2]);
  });
});

describe('retiring rather than removing', () => {
  it('refuses to delete a definition that has ever been published', async () => {
    const definition = await aDefinition();
    await asAdmin(() =>
      workflows.publish(definition.id, definition.versionId, definition.recordVersion),
    );

    // Approvals may be bound to it, and they keep their version forever. §7: a definition in use cannot
    // be deleted, only deprecated.
    const current = await asAdmin(() => workflows.get(definition.id));
    await expect(
      asAdmin(() => workflows.delete(definition.id, current.recordVersion)),
    ).rejects.toMatchObject({ fieldErrors: [{ field: 'versions', message: 'published' }] });
  });

  it('deletes a definition that never left draft', async () => {
    const definition = await aDefinition();
    await expect(
      asAdmin(() => workflows.delete(definition.id, definition.recordVersion)),
    ).resolves.toBeUndefined();
  });

  it('refuses to delete one a document type still uses', async () => {
    const definition = await aDefinition();

    // A type pointing at it, written directly: building a whole document type here would be testing the
    // administration module rather than this one.
    const rule = uuidv7();
    const level = uuidv7();
    await owner.numberingRule.create({
      data: {
        id: rule,
        tenantId: TENANT,
        key: `rule-${counter}`,
        name: 'Rule',
        segments: [{ kind: 'SEQUENCE', padding: 4 }],
        resetScope: ['NEVER'],
      },
    });
    await owner.confidentialityLevel.create({
      data: { id: level, tenantId: TENANT, code: `CL${counter}`, name: 'Internal', rank: counter },
    });
    await owner.documentType.create({
      data: {
        id: uuidv7(),
        tenantId: TENANT,
        code: `DT${counter}`,
        name: 'Procedure',
        numberingRuleId: rule,
        workflowDefinitionId: definition.id,
        defaultConfidentialityId: level,
      },
    });

    await expect(
      asAdmin(() => workflows.delete(definition.id, definition.recordVersion)),
    ).rejects.toMatchObject({ fieldErrors: [{ field: 'documentTypeCount', message: '1' }] });
  });

  it('retires a version, leaving it readable', async () => {
    const definition = await aDefinition();
    await asAdmin(() =>
      workflows.publish(definition.id, definition.versionId, definition.recordVersion),
    );
    const current = await asAdmin(() => workflows.get(definition.id));

    const after = await asAdmin(() =>
      workflows.deprecate(definition.id, definition.versionId, current.recordVersion),
    );

    expect(after.versions[0]?.state).toBe(WorkflowVersionState.DEPRECATED);
    // No published version now, which is correct: nothing new should use a retired workflow.
    expect(after.publishedVersion).toBeNull();
  });

  it('retires a draft too, without inventing a publication it never had', async () => {
    // The check constraint requires a publication stamp for any state other than DRAFT. The instant it
    // was retired is the honest value — it is when the version stopped being a candidate.
    const definition = await aDefinition();
    const after = await asAdmin(() =>
      workflows.deprecate(definition.id, definition.versionId, definition.recordVersion),
    );

    expect(after.versions[0]?.state).toBe(WorkflowVersionState.DEPRECATED);
    expect(after.publishedVersion).toBeNull();
  });
});

describe('reaching across definitions', () => {
  it('does not find a version by naming another definition', async () => {
    const first = await aDefinition();
    const second = await aDefinition();

    // Both identifiers are in the `WHERE`, so a version of one definition cannot be reached through
    // another's path — which would otherwise let a caller publish into a workflow they were not editing.
    await expect(
      asAdmin(() => workflows.publish(second.id, first.versionId, second.recordVersion)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

/**
 * Two administrators publishing two drafts of one definition — Slice 108.
 *
 * ## What the product says
 *
 * "Exactly one live version" is written down four times. The port: *"Marks the previously published
 * version deprecated, so exactly one is live at a time."* The service: *"Exactly one live version,
 * so 'which rules apply to a new submission' has one answer."* `PrismaWorkflowVersionReader`, on the
 * query that chooses the rules an approval runs by: *"Publishing deprecates the previous one in the
 * same transaction, so there is only ever one — the ordering is what makes that true rather than
 * assumed."* And the admin projection, taking a maximum instead of the first row *"because reading
 * `[0]` would quietly pick a wrong answer if that invariant ever broke."*
 *
 * ## What it did
 *
 * The invariant is a statement about a *set*, and it was made by two statements with nothing holding
 * the rows between them: `publish` claims one draft `DRAFT → PUBLISHED`, and `deprecateOthers`
 * retires whatever else is `PUBLISHED`. Two administrators publishing two different drafts claim
 * different rows, so neither blocks the other, and each then retires "the others" from a
 * `READ COMMITTED` snapshot in which the other draft is *still a draft*. Both retire nothing. Both
 * succeed. The definition is left with two published versions.
 *
 * Nothing detects it afterwards, and the defensive reads are what hide it: `publishedVersionFor`
 * orders by version descending, so the newer publication answers for both and the older one simply
 * waits. It surfaces when somebody retires the live version — an ordinary administrative act, which
 * should leave the definition with no published version and new submissions refused with "this
 * workflow has no published version". Instead the stale version silently becomes the rules every new
 * approval runs by, without anybody having published it.
 *
 * ## What proves it
 *
 * The fix is mutual exclusion, so no barrier can hold two publications open at once after it — the
 * interleaving the defect needs is exactly the one the fix forbids, and a two-caller turnstile
 * downstream of the lock would hang rather than reproduce. The evidence is therefore in two parts,
 * the shape Slices 104 and 107 settled on: the **outcome**, from genuinely concurrent publications,
 * and the **mechanism**, from a second database session probing with `FOR UPDATE NOWAIT` while a
 * publication is parked mid-transaction.
 *
 * The probe names a draft the publication never writes — `publish` touches only its own row and
 * `deprecateOthers` only published ones — so before the fix that row was free and after it is held.
 */
describe('two versions of one definition published at the same moment', () => {
  /**
   * The real repository, subclassed: a place to stand inside a publication's transaction, after it
   * has taken its lock, made its claim and retired the others.
   *
   * `deprecateOthers` is the last statement of the unit of work, so parking there holds the whole
   * decision open — which is the moment the probe below asks what it is holding. One caller only:
   * a second would be blocked by the very lock under test and could never arrive.
   */
  class ParkedPublish extends PrismaWorkflowAdminRepository {
    reached: (() => void) | null = null;
    admit: Promise<void> | null = null;

    override async deprecateOthers(definitionId: string, exceptVersionId: string): Promise<void> {
      await super.deprecateOthers(definitionId, exceptVersionId);
      const gate = this.admit;
      if (gate !== null) {
        this.admit = null;
        this.reached?.();
        await gate;
      }
    }
  }

  /** A definition with three drafts: one to publish, one to race it, one for the probe to name. */
  async function threeDrafts(): Promise<{
    id: string;
    recordVersion: number;
    v1: string;
    v2: string;
    v3: string;
  }> {
    const definition = await aDefinition();
    await asAdmin(() => workflows.addDraft(definition.id, definitionWith('Second')));
    const read = await asAdmin(() => workflows.addDraft(definition.id, definitionWith('Third')));
    const at = (n: number): string =>
      read.versions.find((version) => version.version === n)?.id ?? '';
    return {
      id: definition.id,
      recordVersion: read.recordVersion,
      v1: at(1),
      v2: at(2),
      v3: at(3),
    };
  }

  async function statesOf(definitionId: string): Promise<Record<number, string>> {
    const rows = await owner.workflowVersion.findMany({
      where: { definitionId },
      orderBy: { version: 'asc' },
      select: { version: true, state: true },
    });
    return Object.fromEntries(rows.map((row) => [row.version, row.state]));
  }

  async function publishedCount(definitionId: string): Promise<number> {
    return owner.workflowVersion.count({
      where: { definitionId, state: WorkflowVersionState.PUBLISHED },
    });
  }

  /**
   * Whether a second session can take a lock of its own on a version row.
   *
   * `owner` is a separate `PrismaClient` and therefore a separate backend, which is the only way to
   * ask whether a lock is held: a probe on the same connection would be inside the transaction
   * holding it and would always succeed. `NOWAIT` rather than a wait with a deadline — the question
   * is whether the row is held *now*, and a probe that waited would be one somebody has to choose a
   * duration for. `55P03` is PostgreSQL's "could not obtain lock", and here it is the answer.
   *
   * Both strengths are asked. Two publications that could each take a *shared* lock would read the
   * same set and reach the same wrong conclusion, so "held" has to mean held exclusively.
   */
  async function probeVersion(
    mode: 'UPDATE' | 'SHARE',
    versionId: string,
  ): Promise<'LOCKED' | 'FREE'> {
    try {
      await owner.$queryRawUnsafe(
        `SELECT id FROM workflow_version WHERE id = $1::uuid FOR ${mode} NOWAIT`,
        versionId,
      );
      return 'FREE';
    } catch (error) {
      if (/55P03|could not obtain lock/i.test(String(error))) {
        return 'LOCKED';
      }
      throw error;
    }
  }

  it('retires the previous one when the two are published one after the other', async () => {
    // The serial answer the concurrent one has to match. Without it every assertion below could
    // pass against a product that never published anything at all.
    const definition = await threeDrafts();

    await asAdmin(() => workflows.publish(definition.id, definition.v2, definition.recordVersion));
    expect(await statesOf(definition.id)).toMatchObject({ 2: WorkflowVersionState.PUBLISHED });

    await asAdmin(() => workflows.publish(definition.id, definition.v3, definition.recordVersion));
    expect(await statesOf(definition.id)).toMatchObject({
      1: WorkflowVersionState.DRAFT,
      2: WorkflowVersionState.DEPRECATED,
      3: WorkflowVersionState.PUBLISHED,
    });
    expect(await publishedCount(definition.id)).toBe(1);
  });

  it('leaves exactly one published when the two are published at the same moment', async () => {
    const definition = await threeDrafts();

    // Two requests, two scopes, two transactions — two administrators pressing publish at once. No
    // barrier: the lock decides the order, and either order gives the same answer.
    await Promise.all([
      asAdmin(() => workflows.publish(definition.id, definition.v2, definition.recordVersion)),
      asAdmin(() => workflows.publish(definition.id, definition.v3, definition.recordVersion)),
    ]);

    expect(await publishedCount(definition.id)).toBe(1);
  });

  it('refuses new approvals once the live version is retired, rather than promoting a stale one', async () => {
    // The cost of the defect, asserted where it is actually paid. With two versions left published,
    // retiring the live one does not retire the definition — it silently hands every new approval
    // to rules nobody published.
    const definition = await threeDrafts();

    await Promise.all([
      asAdmin(() => workflows.publish(definition.id, definition.v2, definition.recordVersion)),
      asAdmin(() => workflows.publish(definition.id, definition.v3, definition.recordVersion)),
    ]);

    const live = await asAdmin(() => workflows.get(definition.id));
    const liveVersionId =
      live.versions.find((version) => version.state === WorkflowVersionState.PUBLISHED)?.id ?? '';
    await asAdmin(() => workflows.deprecate(definition.id, liveVersionId, live.recordVersion));

    const after = await asAdmin(() => workflows.get(definition.id));
    expect(after.publishedVersion).toBeNull();
    expect(await publishedCount(definition.id)).toBe(0);
  });

  it('holds the definition’s versions from before its first read until it commits', async () => {
    // The mechanism, observed rather than inferred. The probe names version 1 — a draft this
    // publication never writes, since `publish` touches only its own row and `deprecateOthers` only
    // published ones — so before the fix this row was free while the publication was in flight.
    const definition = await threeDrafts();

    const parking = new ParkedPublish(stamps);
    const racing = new WorkflowAdminService(parking, writer);

    let reached: () => void = () => undefined;
    const atDecision = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let admit: () => void = () => undefined;
    parking.admit = new Promise<void>((resolve) => {
      admit = resolve;
    });
    parking.reached = reached;

    const publishing = asAdmin(() =>
      racing.publish(definition.id, definition.v3, definition.recordVersion),
    );
    await atDecision;

    expect(await probeVersion('UPDATE', definition.v1)).toBe('LOCKED');
    expect(await probeVersion('SHARE', definition.v1)).toBe('LOCKED');

    admit();
    await publishing;

    // And released with the transaction, not held past it.
    expect(await probeVersion('UPDATE', definition.v1)).toBe('FREE');
  });

  it('holds only its own definition’s versions', async () => {
    // A lock that took the tenant's versions would pass the probe above and stall every unrelated
    // publication in the tenant behind one. The scope is asserted, not assumed.
    const definition = await threeDrafts();
    const bystander = await threeDrafts();

    const parking = new ParkedPublish(stamps);
    const racing = new WorkflowAdminService(parking, writer);

    let reached: () => void = () => undefined;
    const atDecision = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let admit: () => void = () => undefined;
    parking.admit = new Promise<void>((resolve) => {
      admit = resolve;
    });
    parking.reached = reached;

    const publishing = asAdmin(() =>
      racing.publish(definition.id, definition.v3, definition.recordVersion),
    );
    await atDecision;

    expect(await probeVersion('UPDATE', definition.v1)).toBe('LOCKED');
    expect(await probeVersion('UPDATE', bystander.v1)).toBe('FREE');

    admit();
    await publishing;
  });
});
