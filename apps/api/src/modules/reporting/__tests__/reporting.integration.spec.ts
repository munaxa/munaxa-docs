import 'reflect-metadata';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AclEffect,
  AclSubjectType,
  NumberSegmentKind,
  Permission,
  QueueName,
  RevisionLabelStyle,
  ScopeType,
  type AnyId,
  type ScopeRef,
  type TenantId,
  type UserId,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { seedRoleGrant } from '../../../testing/acl-seed';
import {
  type DocumentLibraryStack,
  type ReportingStack,
  realDocumentLibrary,
  realPermissions,
  realReporting,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import { ExportFormat } from '../domain/report-catalogue';
import { ReportExportState } from '../application/ports';

/**
 * Phase 15 against a real PostgreSQL — the disclosure questions, which are the only ones that
 * matter here and are all database questions.
 *
 * A report is the first thing in this product designed to aggregate across everything. Every phase
 * before it narrowed: Phase 8 pushed a predicate into the search query, Phase 13 made a tenant-wide
 * tile absent rather than zero, Phase 14 made a document absent from a list *and from its total*.
 * So what this suite asserts is that a report did not undo any of it:
 *
 * - **The same report answers different rows for two callers with different reach**, through the
 *   real `PrismaAclResolver` over real `acl_entry` rows — not a stub, which would be asserting the
 *   suite's own belief about permissions.
 * - **A total does not leak what a page omits.** Fetch-then-filter passes the first assertion and
 *   fails this one, which is exactly why 08 §7 forbids it by name.
 * - **A report over deleted documents respects `document:restore`, and one over expired documents
 *   respects `retention:manage`** — the permissions Phase 10 put on those surfaces. A refusal, not
 *   an empty page: "you may not ask" and "there are none" are different answers.
 * - **An export is queued rather than streamed from the request**, and it runs under the
 *   *requester's* reach rather than the consumer's absent one.
 * - **`REPORT_EXPORTED` is in the trail, with the parameters that produced it.**
 *
 * ## The ACL entries are written as a request writes them
 *
 * CI's `edms_owner` is the cluster superuser, so a suite seeding `acl_entry` with the owner client
 * writes past row-level security and is not testing what a request would see — Phase 14's
 * `acl.integration.spec.ts` records this and this suite follows it. Every entry here goes through
 * `PermissionService` in a request context. The owner client creates only what a request could not:
 * the tenant, the people, and the role grants an administrator would have made first.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const FIXED_NOW = new Date('2026-08-06T09:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
/** Holds `report:view` and `document:view` tenant-wide, and reaches both folders. */
const ADA = asId<UserId>(uuidv7());
/** The same role, and an explicit `DENY` on one folder — the second reach. */
const BEN = asId<UserId>(uuidv7());
/** Holds everything, including `document:restore` and `retention:manage`. */
const ADMIN = asId<UserId>(uuidv7());

const ANALYST_ROLE = uuidv7();
const ADMIN_ROLE = uuidv7();

let root: string;
let appConfig: AppConfig;
let owner: PrismaClient;
let unitOfWork: PrismaUnitOfWork;
let library: DocumentLibraryStack;
let permissions: ReturnType<typeof realPermissions>;
let reporting: ReportingStack;

let libraryId: string;
let openFolderId: string;
let closedFolderId: string;

function contextFor(userId: UserId, roles: readonly string[]): RequestContext {
  return {
    tenantId: TENANT,
    userId,
    roles: [...roles],
    // Deliberately empty: every gate in this phase is resolved through the ACL resolver over real
    // role grants, never from the token's snapshot. A suite that filled this in would be asserting
    // that the service reads the field 08 §3 says it must not.
    permissions: [],
    sessionId: null,
    correlationId: 'reporting-suite',
    permissionVersion: 1,
    locale: 'en',
  };
}

const asAda = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(contextFor(ADA, [ANALYST_ROLE]), work);
const asBen = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(contextFor(BEN, [ANALYST_ROLE]), work);
const asAdmin = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(contextFor(ADMIN, [ADMIN_ROLE]), work);
/** What the lane runs as before the export service reconstitutes the requester. */
const asConsumer = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext({ ...contextFor(ADA, []), userId: null, correlationId: 'reporting-lane' }, work);

const page = { page: 1, pageSize: 50 };
const folderScope = (id: string): ScopeRef => ({ type: ScopeType.FOLDER, id: asId<AnyId>(id) });

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  root = await mkdtemp(join(tmpdir(), 'edms-reporting-'));

  appConfig = {
    env: 'test',
    database: { url: APP_URL, poolSize: 10 },
    storage: { driver: 'LOCAL', signedUrlTtlSeconds: 300 },
    // No cache: every assertion below asks the database twice and expects the same answer, and a
    // cached decision between the two would make the second a recollection.
    acl: { cacheTtlSeconds: 0, maxSubjectEntries: 5_000 },
    reporting: { exportBatchSize: 2, exportMaxRows: 250_000, pdfMaxRows: 5_000 },
  } as unknown as AppConfig;

  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `rep-${TENANT.replaceAll('-', '').slice(-16)}`,
      name: 'Reporting Test',
      status: 'ACTIVE',
    },
  });
  for (const [id, name] of [
    [ADA, 'ada'],
    [BEN, 'ben'],
    [ADMIN, 'admin'],
  ] as const) {
    await owner.user.create({
      data: {
        id,
        tenantId: TENANT,
        email: `${id}@reporting.test`,
        emailNormalized: `${id}@reporting.test`,
        displayName: name,
        status: 'ACTIVE',
        updatedAt: FIXED_NOW,
      },
    });
  }
  // `report:view` and `document:view` and nothing else — so the deleted and expired reports are
  // refused for a reason a test can name, rather than because the role is thin by accident.
  await seedRoleGrant(owner, {
    tenantId: TENANT,
    roleId: ANALYST_ROLE,
    key: 'ANALYST',
    userIds: [ADA, BEN],
    permissions: [Permission.REPORT_VIEW, Permission.DOCUMENT_VIEW, Permission.DOCUMENT_CREATE],
    now: FIXED_NOW,
  });
  await seedRoleGrant(owner, {
    tenantId: TENANT,
    roleId: ADMIN_ROLE,
    key: 'TENANT_ADMIN',
    userIds: [ADMIN],
    now: FIXED_NOW,
  });

  unitOfWork = new PrismaUnitOfWork(sharedDatabase(appConfig, logger, APP_URL));
  library = realDocumentLibrary({
    clock,
    unitOfWork,
    config: appConfig,
    registry: everyTenantRegistry(APP_URL),
    storageRoot: root,
    signingSecret: 'an-integration-suite-secret-of-at-least-32',
    antivirus: {
      scanner: 'unconfigured',
      scan: () => Promise.reject(new Error('AV_DRIVER is NONE')),
    },
    users: { get: () => Promise.resolve(null) } as never,
  });
  permissions = realPermissions({ clock, unitOfWork, config: appConfig });
  reporting = realReporting({
    clock,
    unitOfWork,
    config: appConfig,
    storage: library.storage,
  });

  await seedTree();
}, 180_000);

afterAll(async () => {
  await owner?.$disconnect();
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('the same report, two callers, two answers', () => {
  it('lists every document for a caller who reaches both folders', async () => {
    const report = await asAda(() => reporting.reports.run('documents', {}, page));
    const titles = report.data.map((row) => row['title']);
    expect(titles).toContain('Open procedure');
    expect(titles).toContain('Restricted procedure');
    expect(report.meta.total).toBe(2);
  });

  it('omits the denied document from the rows AND from the total', async () => {
    // Ben is denied `document:view` on the restricted folder, through the service a request uses.
    await asAdmin(() =>
      permissions.permissions.replaceFor(folderScope(closedFolderId), [
        {
          subjectType: AclSubjectType.USER,
          subjectId: asId<AnyId>(BEN),
          permission: Permission.DOCUMENT_VIEW,
          effect: AclEffect.DENY,
        },
      ]),
    );

    const forAda = await asAda(() => reporting.reports.run('documents', {}, page));
    const forBen = await asBen(() => reporting.reports.run('documents', {}, page));

    expect(forBen.data.map((row) => row['title'])).not.toContain('Restricted procedure');
    // **The total, and this is the assertion that matters.** A report that fetched every row and
    // filtered the page would pass the line above and fail this one — and its `total` would tell
    // Ben exactly how many documents exist that he may not see, which is what 08 §7 forbids.
    expect(forBen.meta.total).toBe(forAda.meta.total - 1);
  });

  it('scopes the breakdown by the same reach, so a chart cannot leak what a list hides', async () => {
    const forAda = await asAda(() =>
      reporting.reports.run('documents-by-dimension', { dimension: 'STATUS' }, page),
    );
    const forBen = await asBen(() =>
      reporting.reports.run('documents-by-dimension', { dimension: 'STATUS' }, page),
    );
    const sum = (rows: readonly Readonly<Record<string, unknown>>[]): number =>
      rows.reduce((total, row) => total + Number(row['count']), 0);

    // A count is a disclosure — Phase 13's rule — and an aggregate is the shape where it is easiest
    // to forget, because no individual row is visible in the answer.
    expect(sum(forAda.data)).toBe(2);
    expect(sum(forBen.data)).toBe(1);
  });

  it('scopes the approvals report through the document rather than the assignee', async () => {
    const forAda = await asAda(() => reporting.reports.run('approvals', {}, page));
    const forBen = await asBen(() => reporting.reports.run('approvals', {}, page));
    // No approvals are seeded, so both are empty — what is asserted is that both *ran*, which is
    // what proves the reach predicate composes with `approvalTaskWhere` rather than conflicting
    // with it. The disclosure property is the document one, asserted above.
    expect(forAda.meta.total).toBe(0);
    expect(forBen.meta.total).toBe(0);
  });
});

describe('a report never widens the audience of the surface it summarises', () => {
  /**
   * ADR-0010 §2 puts the recycle bin behind `document:restore`. A report listing deleted documents
   * to a `report:view` holder would be that bin without the permission on it.
   */
  it('refuses the deleted-documents report to a caller without document:restore', async () => {
    await expect(asAda(() => reporting.reports.run('deleted-documents', {}, page))).rejects.toThrow(
      /document:restore/,
    );
  });

  it('refuses the expired-documents report without retention:manage', async () => {
    await expect(asAda(() => reporting.reports.run('expired-documents', {}, page))).rejects.toThrow(
      /retention:manage/,
    );
  });

  /**
   * 08 §10 records that the audit search is deliberately not ACL-filtered because `audit:view` is
   * the filter. So a report over the trail must not be reachable by `report:view` alone — otherwise
   * the report is a second door into a surface whose whole gate is that permission.
   */
  it('refuses the audit report without audit:view', async () => {
    await expect(asAda(() => reporting.reports.run('audit', {}, page))).rejects.toThrow(
      /audit:view/,
    );
  });

  it('refuses the users report without user:manage and departments without org:manage', async () => {
    await expect(asAda(() => reporting.reports.run('users', {}, page))).rejects.toThrow(
      /user:manage/,
    );
    await expect(asAda(() => reporting.reports.run('departments', {}, page))).rejects.toThrow(
      /org:manage/,
    );
  });

  it('serves all four to somebody who holds the second permission', async () => {
    for (const key of ['deleted-documents', 'expired-documents', 'audit', 'users'] as const) {
      const report = await asAdmin(() => reporting.reports.run(key, {}, page));
      expect(report.meta.pageSize).toBe(page.pageSize);
    }
  });

  /**
   * A refused report is **absent** from the menu, not disabled. Phase 13's rule for tiles applied
   * to a list: a greyed-out row named "Deleted documents" tells somebody the product keeps one.
   */
  it('lists only the reports the caller may run, and omits the rest entirely', async () => {
    const forAda = (await asAda(() => reporting.reports.available())).map((entry) => entry.key);
    const forAdmin = (await asAdmin(() => reporting.reports.available())).map((entry) => entry.key);

    expect(forAda).toContain('documents');
    expect(forAda).not.toContain('deleted-documents');
    expect(forAda).not.toContain('audit');
    expect(forAdmin).toContain('deleted-documents');
    expect(forAdmin).toContain('audit');
  });
});

describe('an export is queued, audited, and run under the requester’s own reach', () => {
  it('queues rather than producing, and returns before anything is written', async () => {
    const { jobId } = await asAda(() =>
      reporting.reports.requestExport('documents', { format: ExportFormat.CSV }),
    );

    const queued = reporting.queue.enqueued.filter(
      (job) => job.queue === QueueName.REPORTING_EXPORT,
    );
    expect(queued).toHaveLength(1);
    // Deterministic, so at-least-once delivery is harmless.
    expect(queued[0]?.options.jobId).toBe(`reporting:export:${jobId}`);

    const record = await asAda(() => reporting.reports.export(asId<AnyId>(jobId)));
    // Requested and empty. Nothing was streamed from the request, which is the property
    // `REPORTING_SERVICE`'s own contract has stated since Phase 0.5.
    expect(record?.state).toBe(ReportExportState.REQUESTED);
    expect(record?.rowCount).toBe(0);
    expect(record?.storageKey).toBeNull();
  });

  it('writes REPORT_EXPORTED with the parameters that produced it', async () => {
    await asAda(() =>
      reporting.reports.requestExport('documents', {
        format: ExportFormat.CSV,
        status: 'DRAFT',
      }),
    );

    const events = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, action: 'REPORT_EXPORTED' },
      orderBy: { sequence: 'desc' },
      take: 1,
    });
    const payload = events[0]?.payload as Record<string, unknown> | undefined;
    const after = payload?.['after'] as Record<string, unknown> | undefined;

    expect(events[0]?.actorId).toBe(ADA);
    expect(after?.['reportKey']).toBe('documents');
    // **The parameters.** Without them the trail records that somebody exported "the documents
    // report" and nothing about *which* documents, which is the only part an investigation six
    // months later is asking about.
    expect(after?.['parameters']).toMatchObject({ status: 'DRAFT' });
    // And not the reserved format parameter, which is a property of the file rather than of the
    // query — it is recorded in its own field beside it.
    expect(after?.['parameters']).not.toHaveProperty('format');
    expect(after?.['format']).toBe(ExportFormat.CSV);
  });

  /**
   * The property this whole phase turns on, and the one that is one missing line away in the
   * obvious implementation.
   *
   * A lane consumer's context has no user in it, and `visibilityCondition` returns an **empty**
   * predicate for a caller with no user — so an export produced under the consumer's own context
   * would be an export of every row in the tenant, written to a file and handed to whoever asked.
   * Ben is denied one of the two documents, so his export must contain one row and Ada's two.
   */
  it('produces Ben’s export with Ben’s reach, not the consumer’s absent one', async () => {
    const forBen = await runExport(BEN, 'documents');
    const forAda = await runExport(ADA, 'documents');

    expect(forBen?.rowCount).toBe(1);
    expect(forAda?.rowCount).toBe(2);
    expect(forBen?.state).toBe(ReportExportState.COMPLETED);
    // The digest of the bytes actually written, accumulated as they streamed past — so a downloaded
    // file can be checked against the record rather than trusted.
    expect(forBen?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(forBen?.truncated).toBe(false);
  });

  it('records the completion in the trail beside the request', async () => {
    const rows = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, action: 'REPORT_EXPORTED' },
      orderBy: { sequence: 'asc' },
    });
    const outcomes = rows.map(
      (row) => (row.payload as Record<string, Record<string, unknown>>)['after']?.['state'],
    );
    // Two facts, two rows: the request is somebody's act and the completion is the system's, and a
    // single row written at the end would leave a window in which a report was being assembled for
    // somebody and nothing said so.
    expect(outcomes).toContain(ReportExportState.REQUESTED);
    expect(outcomes).toContain(ReportExportState.COMPLETED);
  });

  /**
   * Phase 11's rule applied to a queue: authority is read at the instant it is used, never
   * snapshotted at request time. An account disabled while its export waits does not get the file.
   */
  it('refuses to produce an export for an account that is no longer active', async () => {
    const { jobId } = await asBen(() =>
      reporting.reports.requestExport('documents', { format: ExportFormat.CSV }),
    );
    await owner.user.update({ where: { id: BEN }, data: { status: 'DISABLED' } });

    await expect(asConsumer(() => reporting.exports.run(asId<AnyId>(jobId)))).rejects.toThrow(
      /no longer exists/,
    );
    const record = await asAdmin(() => reporting.reports.export(asId<AnyId>(jobId)));
    expect(record?.state).toBe(ReportExportState.FAILED);

    await owner.user.update({ where: { id: BEN }, data: { status: 'ACTIVE' } });
  });

  /** A redelivered job finds the row already claimed and does nothing, rather than a second file. */
  it('is idempotent under redelivery', async () => {
    const { jobId } = await asAda(() =>
      reporting.reports.requestExport('documents', { format: ExportFormat.CSV }),
    );
    await asConsumer(() => reporting.exports.run(asId<AnyId>(jobId)));
    const first = await asAda(() => reporting.reports.export(asId<AnyId>(jobId)));

    await asConsumer(() => reporting.exports.run(asId<AnyId>(jobId)));
    const second = await asAda(() => reporting.reports.export(asId<AnyId>(jobId)));

    expect(second?.storageKey).toBe(first?.storageKey);
    expect(second?.sha256).toBe(first?.sha256);
  });

  it('produces the spreadsheet and the PDF as well as the CSV', async () => {
    for (const format of [ExportFormat.SPREADSHEET_XML, ExportFormat.PDF] as const) {
      const record = await runExport(ADA, 'documents', format);
      expect(record?.state).toBe(ReportExportState.COMPLETED);
      expect(record?.sizeBytes).toBeGreaterThan(0);
      expect(record?.format).toBe(format);
    }
  });
});

describe('saved definitions hold parameters and never a query', () => {
  it('validates against the catalogue on the way in', async () => {
    await expect(
      asAda(() => reporting.definitions.save('documents', 'Bad', { nonsense: 'x' })),
    ).rejects.toThrow(/parameters/);
  });

  it('saves, lists and removes the caller’s own', async () => {
    const saved = await asAda(() =>
      reporting.definitions.save('documents', 'My drafts', { status: 'DRAFT' }),
    );
    const mine = await asAda(() => reporting.definitions.listForCaller(page));
    expect(mine.data.map((row) => row.name)).toContain('My drafts');

    // Somebody else's definition is a `404`, not a `403`: the existence of a saved report is itself
    // a fact about what that person has been looking at.
    await expect(asBen(() => reporting.definitions.remove(saved.id))).rejects.toThrow(
      /requested resource/,
    );
    await asAda(() => reporting.definitions.remove(saved.id));
    expect((await asAda(() => reporting.definitions.listForCaller(page))).meta.total).toBe(0);
  });
});

describe('an unknown parameter is refused rather than ignored', () => {
  it('refuses rather than reporting over more rows than were asked about', async () => {
    await expect(
      asAda(() => reporting.reports.run('documents', { departmentId: 'x' }, page)),
    ).rejects.toThrow(/parameters/);
  });

  it('answers 404 for a report key that does not exist', async () => {
    await expect(asAda(() => reporting.reports.run('everything', {}, page))).rejects.toThrow(
      /requested resource/,
    );
  });
});

// --- Fixtures ---------------------------------------------------------------------------------

async function runExport(
  userId: UserId,
  key: string,
  format: (typeof ExportFormat)[keyof typeof ExportFormat] = ExportFormat.CSV,
): Promise<Awaited<ReturnType<ReportingStack['reports']['export']>>> {
  const context = contextFor(userId, userId === ADMIN ? [ADMIN_ROLE] : [ANALYST_ROLE]);
  const { jobId } = await runWithContext(context, () =>
    reporting.reports.requestExport(key, { format }),
  );
  // Through the consumer's own context, exactly as the lane calls it — which is the whole point:
  // the reach comes from the export row, not from whoever happens to be running.
  await asConsumer(() => reporting.exports.run(asId<AnyId>(jobId)));
  return runWithContext(context, () => reporting.reports.export(asId<AnyId>(jobId)));
}

async function seedTree(): Promise<void> {
  const created = await asAdmin(() =>
    library.libraries.createLibrary({
      code: 'REP',
      name: 'Controlled',
      ownerScopeType: ScopeType.TENANT,
    }),
  );
  libraryId = created.id;

  const open = await asAdmin(() =>
    library.libraries.createFolder({
      libraryId,
      parentId: created.rootFolderId,
      name: 'Open',
      inheritAcl: true,
    }),
  );
  openFolderId = open.id;
  const closed = await asAdmin(() =>
    library.libraries.createFolder({
      libraryId,
      parentId: created.rootFolderId,
      name: 'Restricted',
      inheritAcl: true,
    }),
  );
  closedFolderId = closed.id;

  const confidentiality = await asAdmin(() =>
    library.configuration.createConfidentiality({
      code: 'INTERNAL',
      name: 'Internal',
      rank: 1,
      allowDownload: true,
      allowPrint: true,
      watermark: false,
      requireReason: false,
    }),
  );
  const rule = await asAdmin(() =>
    library.numbering.create({
      key: 'rep',
      name: 'Reporting',
      separator: '-',
      segments: [
        { kind: NumberSegmentKind.LITERAL, value: 'REP' },
        { kind: NumberSegmentKind.SEQUENCE, padding: 3 },
      ],
      resetScope: ['NEVER'],
      reserveOnSubmit: false,
      strictGapless: false,
    }),
  );
  const type = await asAdmin(() =>
    library.configuration.createDocumentType({
      code: 'PROC',
      name: 'Procedure',
      numberingRuleId: rule.id,
      defaultConfidentialityId: confidentiality.id,
      revisionLabelStyle: RevisionLabelStyle.NUMERIC,
      isActive: true,
      fields: [],
    }),
  );

  // Two documents in two folders, and the assertions are about which of them each caller sees —
  // never about their identifiers, so they are not held.
  await seedDocument(openFolderId, type.id, 'Open procedure');
  await seedDocument(closedFolderId, type.id, 'Restricted procedure');
}

/**
 * A document row, written with the owner client.
 *
 * The owner is the cluster superuser, so this writes past row-level security — and that is correct
 * here for the same reason `acl-seed.ts` gives for a role grant: these are *fixtures*, written
 * before the code under test runs, standing for records an author would have created beforehand.
 * What it would be exactly wrong for is an `acl_entry`, and this suite writes none that way: every
 * entry goes through `PermissionService` in a request context, as a request does.
 */
async function seedDocument(
  folderId: string,
  documentTypeId: string,
  title: string,
): Promise<string> {
  const id = uuidv7();
  const level = await owner.confidentialityLevel.findFirst({ where: { tenantId: TENANT } });
  await owner.document.create({
    data: {
      id,
      tenantId: TENANT,
      folderId,
      documentTypeId,
      confidentialityId: level?.id ?? '',
      title,
      status: 'DRAFT',
      ownerUserId: ADMIN,
      updatedAt: FIXED_NOW,
    },
  });
  return id;
}
