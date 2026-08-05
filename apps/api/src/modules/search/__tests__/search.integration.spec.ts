import 'reflect-metadata';

import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  NumberSegmentKind,
  Permission,
  RevisionLabelStyle,
  ScanStatus,
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
  type PreviewStack,
  type SearchStack,
  realDocumentLibrary,
  realPreviewStack,
  realSearchStack,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';

/**
 * Phase 8 against two real PostgreSQL tenant databases — the assertions only a database can be
 * trusted about:
 *
 * - **The permission predicate refuses inside the query.** A caller whose roles do not hold
 *   `document:view` gets zero hits, a zero total and zero facet counts — while the row provably
 *   sits in the index. Fetch-then-filter cannot be caught by a double, because a double is
 *   written from the same belief as the code it stands in for.
 * - **Tenant isolation is physical.** The second tenant's database holds no entries, and a
 *   subject constructed for the other tenant is overwritten by the scoping wrapper.
 * - **Projection idempotency**: at-least-once delivery projects twice and writes one row.
 * - **Arabic**: a query spelled without hamza and tashkeel finds a title spelled with them.
 * - **The rebuild** fills a shadow table while the live index keeps answering, dual-writes a
 *   change that lands mid-fill, and swaps atomically.
 * - **`search:all`** bypasses the ACL predicate, never the tenant one, and is audited.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';
const SECOND_OWNER_URL = process.env['SECOND_DATABASE_MIGRATION_URL'] ?? '';
const SECOND_APP_URL = process.env['SECOND_DATABASE_URL'] ?? '';

const FIXED_NOW = new Date('2026-08-22T09:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
const TENANT_B = asId<TenantId>(uuidv7());
const ALICE = asId<UserId>(uuidv7());
const BOB = asId<UserId>(uuidv7());
const CAROL = asId<UserId>(uuidv7());
const SIGNING_SECRET = 'an-integration-suite-secret-of-at-least-32';

const VIEWER_ROLE = uuidv7();
const CLERK_ROLE = uuidv7();

let root: string;
let transfer: Server;
let appConfig: AppConfig;
let library: DocumentLibraryStack;
let preview: PreviewStack;
let search: SearchStack;
let owner: PrismaClient;
let unitOfWork: PrismaUnitOfWork;

let rootFolderId: string;
let documentTypeId: string;
let metadataFieldId: string;

function contextFor(
  userId: UserId,
  roles: readonly string[],
  permissions: readonly string[] = [],
): RequestContext {
  return {
    tenantId: TENANT,
    userId,
    roles: [...roles],
    permissions: [...permissions] as RequestContext['permissions'],
    sessionId: null,
    correlationId: 'search-suite',
    permissionVersion: 1,
    locale: 'en',
  };
}

function asAlice<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(ALICE, [VIEWER_ROLE]), work);
}

function asBob<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(BOB, [CLERK_ROLE]), work);
}

function asCarol<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(CAROL, [CLERK_ROLE], [Permission.SEARCH_ALL]), work);
}

function asSystem<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(
    {
      tenantId: TENANT,
      userId: null,
      roles: [],
      permissions: [],
      sessionId: null,
      correlationId: 'search-suite-system',
      permissionVersion: 0,
      locale: 'en',
    },
    work,
  );
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(3, '0')}`;
}

async function realPdf(pages: readonly string[]): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    document.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 14, font });
  }
  return Buffer.from(await document.save());
}

async function upload(content: Buffer, filename: string, mimeType: string): Promise<string> {
  const target = await asAlice(() =>
    library.storage.createUploadSession({
      filename,
      mimeType,
      sizeBytes: content.length,
      magicBytes: new Uint8Array(content.subarray(0, 16)),
    }),
  );
  if (target.alreadyStored !== null) {
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
  const completed = await asAlice(() =>
    library.storage.completeUploadSession(asId<UploadSessionId>(target.uploadSessionId), []),
  );
  return completed.fileObjectId;
}

async function createDocument(
  title: string,
  content: Buffer,
  filename: string,
  mimeType: string,
): Promise<{ documentId: DocumentId; revisionId: string; fileObjectId: string }> {
  const fileObjectId = await upload(content, filename, mimeType);
  await owner.fileObject.update({
    where: { id: fileObjectId },
    data: { scanStatus: ScanStatus.CLEAN, scanner: 'integration-suite', scannedAt: FIXED_NOW },
  });
  const created = await asAlice(() =>
    library.documents.create({
      folderId: rootFolderId,
      documentTypeId,
      title,
      fileObjectId,
      filename,
      origin: 'UPLOAD',
      acknowledgeDuplicate: false,
    }),
  );
  const revision = await owner.documentRevision.findFirstOrThrow({
    where: { documentId: created.id, ordinal: 0 },
  });
  return { documentId: asId<DocumentId>(created.id), revisionId: revision.id, fileObjectId };
}

function project(documentId: DocumentId): Promise<void> {
  return asSystem(() => search.projection.project(documentId));
}

function searchAs(
  runner: <T>(work: () => Promise<T>) => Promise<T>,
  text: string | null,
  filters: Record<string, readonly string[]> = {},
) {
  return runner(() =>
    search.search.search({
      text,
      filters,
      facets: ['status', 'type', 'year'],
      sort: 'RELEVANCE',
      cursor: null,
      limit: 25,
    }),
  );
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  root = await mkdtemp(join(tmpdir(), 'munaxa-search-'));

  transfer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost:3001');
      const method = request.method === 'PUT' ? 'PUT' : 'GET';
      const decoded = decodeTransferToken(
        SIGNING_SECRET,
        url.searchParams.get('token') ?? '',
        method,
        FIXED_NOW,
      );
      if (!('grant' in decoded)) {
        response.statusCode = 403;
        response.end();
        return;
      }
      const path = join(root, decoded.grant.key);
      if (method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(chunk as Buffer);
        }
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.concat(chunks));
        response.statusCode = 200;
        response.end();
        return;
      }
      try {
        const bytes = await readFile(path);
        response.statusCode = 200;
        response.end(bytes);
      } catch {
        response.statusCode = 404;
        response.end();
      }
    })();
  });
  await new Promise<void>((resolve) => transfer.listen(3001, '127.0.0.1', resolve));

  appConfig = {
    env: 'test',
    app: { port: 3001 },
    database: { url: APP_URL, poolSize: 10 },
    auth: { accessSecret: SIGNING_SECRET },
    storage: {
      driver: 'LOCAL',
      signedUrlTtlSeconds: 300,
      maxUploadBytes: 2 * 1024 * 1024 * 1024,
      publicUrl: null,
    },
    providers: {
      search: 'POSTGRES',
      ocr: 'NONE',
      mail: 'NONE',
      antivirus: 'NONE',
      office: 'NONE',
    },
    ocr: { tesseractPath: 'tesseract', languages: 'ara+eng' },
    office: { libreofficePath: 'soffice' },
    search: { debounceMs: 1_000, rebuildBatchSize: 2, recentLimit: 3, maxBodyChars: 100_000 },
    preview: {
      timeoutMs: 60_000,
      maxSourceBytes: 128 * 1024 * 1024,
      maxOutputBytes: 64 * 1024 * 1024,
      maxPages: 100,
      maxTextBytes: 2 * 1024 * 1024,
      maxArchiveEntries: 4_096,
      maxArchiveExpansionRatio: 200,
      maxPixels: 40_000_000,
    },
  } as unknown as AppConfig;

  const prisma = sharedDatabase(appConfig, logger, APP_URL);
  unitOfWork = new PrismaUnitOfWork(prisma);
  const registry = everyTenantRegistry(APP_URL);
  const users = {
    get: (id: string) =>
      id === ALICE
        ? Promise.resolve({ id } as never)
        : Promise.reject(Object.assign(new Error('not found'), { code: 'NOT_FOUND' })),
  };

  library = realDocumentLibrary({
    clock,
    unitOfWork,
    config: appConfig,
    registry,
    storageRoot: root,
    signingSecret: SIGNING_SECRET,
    antivirus: {
      scanner: 'unconfigured',
      scan: () => Promise.reject(new Error('AV_DRIVER is NONE')),
    },
    users,
  });
  preview = realPreviewStack({
    clock,
    unitOfWork,
    storage: library.storage,
    storagePort: library.storagePort,
    config: appConfig,
  });
  search = realSearchStack({
    clock,
    unitOfWork,
    config: appConfig,
    registry,
    storage: library.storage,
    storagePort: library.storagePort,
  });

  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `srch-${String(Date.now())}-${TENANT.slice(0, 8)}`,
      name: 'Search Test',
      status: 'ACTIVE',
    },
  });
  for (const [id, name] of [
    [ALICE, 'Alice Reader'],
    [BOB, 'Bob Clerk'],
    [CAROL, 'Carol Auditor'],
  ] as const) {
    await owner.user.create({
      data: {
        id,
        tenantId: TENANT,
        email: `${id}@example.test`,
        emailNormalized: `${id}@example.test`,
        displayName: name,
        status: 'ACTIVE',
        updatedAt: FIXED_NOW,
      },
    });
  }
  // The grants the resolver resolves: viewers hold document:view (and enough to build
  // fixtures); the clerk role holds a real permission that is deliberately not view.
  await owner.role.create({
    data: {
      id: VIEWER_ROLE,
      tenantId: TENANT,
      key: unique('viewers'),
      name: 'Viewers',
      updatedAt: FIXED_NOW,
    },
  });
  await owner.role.create({
    data: {
      id: CLERK_ROLE,
      tenantId: TENANT,
      key: unique('clerks'),
      name: 'Clerks',
      updatedAt: FIXED_NOW,
    },
  });
  await owner.rolePermission.createMany({
    data: [
      { tenantId: TENANT, roleId: VIEWER_ROLE, permission: Permission.DOCUMENT_VIEW },
      { tenantId: TENANT, roleId: CLERK_ROLE, permission: Permission.WORKFLOW_MANAGE },
    ],
  });
  await owner.userRole.createMany({
    data: [
      { tenantId: TENANT, userId: ALICE, roleId: VIEWER_ROLE },
      { tenantId: TENANT, userId: BOB, roleId: CLERK_ROLE },
      { tenantId: TENANT, userId: CAROL, roleId: CLERK_ROLE },
    ],
  });

  const lib = await asAlice(() =>
    library.libraries.createLibrary({
      code: unique('LIB'),
      name: 'Quality',
      ownerScopeType: 'TENANT',
    }),
  );
  rootFolderId = lib.rootFolderId;

  const internal = await asAlice(() =>
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
  const rule = await asAlice(() =>
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
  const type = await asAlice(() =>
    library.configuration.createDocumentType({
      code: unique('T'),
      name: 'Procedure',
      numberingRuleId: rule.id,
      defaultConfidentialityId: internal.id,
      revisionLabelStyle: RevisionLabelStyle.NUMERIC,
      isActive: true,
      fields: [],
    }),
  );
  documentTypeId = type.id;

  // A searchable tenant-defined field, written directly: what is under test is the
  // projection's read of the rows, not the administration service that edits them.
  metadataFieldId = uuidv7();
  await owner.metadataField.create({
    data: {
      id: metadataFieldId,
      tenantId: TENANT,
      key: unique('field'),
      name: 'Process area',
      dataType: 'TEXT',
      isSearchable: true,
      updatedAt: FIXED_NOW,
    },
  });
}, 120_000);

afterAll(async () => {
  await owner.$disconnect();
  await new Promise<void>((resolve) => transfer.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

describe('projection and the permission predicate', () => {
  let manualId: DocumentId;

  beforeAll(async () => {
    const created = await createDocument(
      'Centrifugal pump maintenance manual',
      await realPdf(['Impeller alignment procedure.', 'Bearing lubrication schedule.']),
      'pump-manual.pdf',
      'application/pdf',
    );
    manualId = created.documentId;
    await owner.documentMetadataValue.create({
      data: {
        tenantId: TENANT,
        documentId: manualId,
        metadataFieldId,
        textValue: 'rotating equipment',
      },
    });
    await project(manualId);
  }, 60_000);

  it('projects one row carrying the ACL the resolver computed', async () => {
    const entry = await owner.searchIndexEntry.findUniqueOrThrow({
      where: { documentId: manualId },
    });
    expect(entry.tenantId).toBe(TENANT);
    expect(entry.aclSubjects).toEqual(['grant:document:view']);
    expect(entry.aclDenySubjects).toEqual([]);
    expect(entry.aclHash).toHaveLength(64);
    // The preview pipeline has not answered yet, and the entry says so instead of pretending.
    expect(entry.contentPending).toBe(true);
    expect(entry.bodySource).toBeNull();
  });

  it('finds the document by title and by metadata for a caller whose role holds document:view', async () => {
    const byTitle = await searchAs(asAlice, 'pump maintenance');
    expect(byTitle.results.hits.map((hit) => hit.documentId)).toContain(manualId);
    expect(byTitle.results.total).toBeGreaterThanOrEqual(1);
    expect(byTitle.unrestricted).toBe(false);

    const byMetadata = await searchAs(asAlice, 'rotating equipment');
    expect(byMetadata.results.hits.map((hit) => hit.documentId)).toContain(manualId);
  });

  it('refuses a caller whose roles lack document:view — zero hits, zero total, zero facet counts', async () => {
    // The row provably exists; what refuses is the predicate, not absence.
    await owner.searchIndexEntry.findUniqueOrThrow({ where: { documentId: manualId } });

    const refused = await searchAs(asBob, 'pump maintenance');
    expect(refused.results.hits).toHaveLength(0);
    expect(refused.results.total).toBe(0);
    for (const buckets of Object.values(refused.results.facets)) {
      expect(buckets).toHaveLength(0);
    }
  });

  it('projects idempotently under redelivery: twice in, one row out', async () => {
    await project(manualId);
    await project(manualId);
    const rows = await owner.searchIndexEntry.findMany({ where: { documentId: manualId } });
    expect(rows).toHaveLength(1);
  });

  it('indexes extracted text once the preview pipeline has rendered', async () => {
    const revision = await owner.documentRevision.findFirstOrThrow({
      where: { documentId: manualId, ordinal: 0 },
    });
    await asSystem(() =>
      preview.render.ensureRendered({
        revisionId: revision.id,
        fileObjectId: revision.fileObjectId,
      }),
    );
    await project(manualId);

    const entry = await owner.searchIndexEntry.findUniqueOrThrow({
      where: { documentId: manualId },
    });
    expect(entry.contentPending).toBe(false);
    expect(entry.bodySource).toBe('TEXT');
    expect(entry.body).toContain('Impeller alignment');

    const byContent = await searchAs(asAlice, 'impeller alignment');
    const hit = byContent.results.hits.find((found) => found.documentId === manualId);
    expect(hit).toBeDefined();
    expect(hit?.summary.bodySource).toBe('TEXT');
    expect(Object.keys(hit?.highlights ?? {})).toContain('body');
  }, 60_000);

  it('removes a soft-deleted document from the index entirely', async () => {
    const doomed = await createDocument(
      'Obsolete welding instruction',
      await realPdf(['To be deleted.']),
      'obsolete.pdf',
      'application/pdf',
    );
    await project(doomed.documentId);
    await owner.document.update({
      where: { id: doomed.documentId },
      data: { deletedAt: FIXED_NOW, deletedBy: ALICE },
    });
    await project(doomed.documentId);
    const rows = await owner.searchIndexEntry.findMany({
      where: { documentId: doomed.documentId },
    });
    expect(rows).toHaveLength(0);
  }, 60_000);
});

describe('Arabic', () => {
  let arabicId: DocumentId;

  beforeAll(async () => {
    const created = await createDocument(
      'إِجْرَاءُ ضَبْطِ الوَثَائِقِ المُعتَمَدَة',
      await realPdf(['Document control procedure, Arabic edition.']),
      'controlled-ar.pdf',
      'application/pdf',
    );
    arabicId = created.documentId;
    await project(arabicId);
  }, 60_000);

  it('detects the revision language as Arabic', async () => {
    const entry = await owner.searchIndexEntry.findUniqueOrThrow({
      where: { documentId: arabicId },
    });
    expect(entry.language).toBe('ar');
  });

  it('matches a query spelled without hamza or tashkeel', async () => {
    const results = await searchAs(asAlice, 'اجراء ضبط الوثايق');
    expect(results.results.hits.map((hit) => hit.documentId)).toContain(arabicId);
  });

  it('still matches the exact spelling the author used', async () => {
    const results = await searchAs(asAlice, 'إجراء ضبط');
    expect(results.results.hits.map((hit) => hit.documentId)).toContain(arabicId);
  });
});

describe('search:all', () => {
  it('bypasses the ACL predicate, never the tenant one — and is audited', async () => {
    const before = await owner.auditEvent.count({
      where: { tenantId: TENANT, action: 'SEARCH_PERFORMED' },
    });
    const results = await searchAs(asCarol, 'pump maintenance');
    // Carol's roles hold no document:view; search:all is what widened this.
    expect(results.unrestricted).toBe(true);
    expect(results.results.total).toBeGreaterThanOrEqual(1);

    const after = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, action: 'SEARCH_PERFORMED' },
      orderBy: { sequence: 'desc' },
    });
    expect(after.length).toBe(before + 1);
    expect(after[0]?.actorId).toBe(CAROL);
    expect(after[0]?.payload).toMatchObject({ query: 'pump maintenance', unrestricted: true });
  });
});

describe('saved and recent searches', () => {
  it('records a recent search with the query, deduplicates repeats and honours the cap', async () => {
    await searchAs(asAlice, 'pump maintenance');
    await searchAs(asAlice, 'pump maintenance');
    await searchAs(asAlice, 'impeller');
    await searchAs(asAlice, 'bearing');
    await searchAs(asAlice, 'lubrication');

    // The cap is 3 in this suite's configuration, enforced in the database on every write.
    const rows = await owner.recentSearch.findMany({
      where: { tenantId: TENANT, userId: ALICE },
    });
    expect(rows).toHaveLength(3);
    // The repeated identical query collapsed into one row rather than stacking. (Which three
    // survive is ordered by `searched_at`, and this suite's clock is frozen — so the cap and
    // the dedup are asserted, not the tiebreak.)
    const repeated = rows.filter((row) => row.query === 'pump maintenance');
    expect(repeated.length).toBeLessThanOrEqual(1);
    const recents = await asAlice(() => search.savedSearches.recent());
    expect(recents).toHaveLength(3);
  });

  it('creates, lists and soft-deletes a saved search, per owner', async () => {
    const saved = await asAlice(() =>
      search.savedSearches.create({
        name: 'My pumps',
        query: 'pump status:DRAFT',
        filters: { type: [documentTypeId] },
      }),
    );
    const listed = await asAlice(() => search.savedSearches.list());
    expect(listed.map((entry) => entry.id)).toContain(saved.id);

    // Another person's list does not carry it, and their reach into it answers as nonexistence.
    const bobs = await asBob(() => search.savedSearches.list());
    expect(bobs.map((entry) => entry.id)).not.toContain(saved.id);
    await expect(
      asBob(() => search.savedSearches.remove(saved.id, saved.version)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await asAlice(() => search.savedSearches.remove(saved.id, saved.version));
    const afterDelete = await asAlice(() => search.savedSearches.list());
    expect(afterDelete.map((entry) => entry.id)).not.toContain(saved.id);
    const row = await owner.savedSearch.findUniqueOrThrow({ where: { id: saved.id } });
    expect(row.deletedAt).not.toBeNull();
  });
});

describe('the rebuild', () => {
  it('fills the shadow while the live index answers, dual-writes mid-fill changes, and swaps', async () => {
    const requested = await asAlice(() => search.rebuilds.request());
    expect(requested.state).toBe('RUNNING');
    expect(search.enqueuedJobs.map((job) => job.jobId)).toContain(`search:rebuild:${requested.id}`);

    // The operator act is audited.
    const audits = await owner.auditEvent.count({
      where: { tenantId: TENANT, action: 'SEARCH_REBUILD_REQUESTED' },
    });
    expect(audits).toBeGreaterThanOrEqual(1);

    // Simulate the fill's first step, then prove a reader still answers from the live table.
    await asSystem(() => unitOfWork.run(() => search.index.beginRebuild()));
    const during = await searchAs(asAlice, 'pump maintenance');
    expect(during.results.total).toBeGreaterThanOrEqual(1);

    // A change landing mid-rebuild reaches the build target through the projection's dual-write.
    const midFlight = await createDocument(
      'Mid-rebuild calibration record',
      await realPdf(['Landed while the rebuild ran.']),
      'mid-flight.pdf',
      'application/pdf',
    );
    await project(midFlight.documentId);
    const shadowRow = await owner.searchIndexEntryShadow.findMany({
      where: { documentId: midFlight.documentId },
    });
    expect(shadowRow).toHaveLength(1);

    // Drive the run to completion — batches of two, resumable through the cursor row.
    await asSystem(() => search.rebuilds.run(requested.id));

    const state = await owner.searchRebuild.findUniqueOrThrow({ where: { id: requested.id } });
    expect(state.state).toBe('COMPLETED');
    expect(state.completedAt).not.toBeNull();

    const liveCount = await owner.searchIndexEntry.count({ where: { tenantId: TENANT } });
    const findable = await owner.document.count({
      where: { tenantId: TENANT, deletedAt: null, status: { not: 'PURGED' } },
    });
    expect(liveCount).toBe(findable);
    expect(await owner.searchIndexEntryShadow.count({ where: { tenantId: TENANT } })).toBe(0);

    // The swap is invisible to a reader: the same search still answers afterwards.
    const after = await searchAs(asAlice, 'pump maintenance');
    expect(after.results.total).toBeGreaterThanOrEqual(1);
    const outboxRow = await owner.outboxMessage.findFirst({
      where: { tenantId: TENANT, eventType: 'search.rebuild-completed' },
    });
    expect(outboxRow).not.toBeNull();
  }, 120_000);
});

describe('tenant isolation', () => {
  const secondConfigured = SECOND_APP_URL !== '' && SECOND_OWNER_URL !== '';
  const guarded = secondConfigured ? it : it.skip;

  guarded('a second tenant database holds no entries, and its searches see none', async () => {
    const ownerB = new PrismaClient({ datasources: { db: { url: SECOND_OWNER_URL } } });
    try {
      await ownerB.tenant.create({
        data: {
          id: TENANT_B,
          slug: `srch-b-${String(Date.now())}-${TENANT_B.slice(0, 8)}`,
          name: 'Search Isolation',
          status: 'ACTIVE',
        },
      });
      const prismaB = sharedDatabase(appConfig, logger, SECOND_APP_URL);
      const unitOfWorkB = new PrismaUnitOfWork(prismaB);
      const stackB = realSearchStack({
        clock,
        unitOfWork: unitOfWorkB,
        config: appConfig,
        registry: everyTenantRegistry(SECOND_APP_URL),
        storage: library.storage,
        storagePort: library.storagePort,
      });
      const results = await runWithContext(
        {
          tenantId: TENANT_B,
          userId: null,
          roles: [],
          permissions: [Permission.SEARCH_ALL] as RequestContext['permissions'],
          sessionId: null,
          correlationId: 'search-suite-b',
          permissionVersion: 0,
          locale: 'en',
        },
        () =>
          stackB.search.search({
            text: 'pump maintenance',
            filters: {},
            facets: [],
            sort: 'RELEVANCE',
            cursor: null,
            limit: 25,
          }),
      );
      // Even unrestricted: the other tenant's rows are in another database entirely.
      expect(results.results.total).toBe(0);
      expect(await ownerB.searchIndexEntry.count()).toBe(0);
    } finally {
      await ownerB.$disconnect();
    }
  });

  it('overwrites a subject built for another tenant with the ambient one', async () => {
    // The subject lies about its tenant; the wrapper answers from the ambient one anyway.
    const results = await asAlice(() =>
      unitOfWork.run(() =>
        search.engine.query(
          { tenantId: TENANT_B, subjectIds: [asId('grant:document:view')], unrestricted: false },
          {
            text: 'pump maintenance',
            filters: {},
            facets: [],
            sort: 'RELEVANCE',
            cursor: null,
            limit: 10,
          },
        ),
      ),
    );
    expect(results.hits.length).toBeGreaterThanOrEqual(1);
    // Every hit is the ambient tenant's — the lying tenant id selected nothing.
    for (const hit of results.hits) {
      const row = await owner.searchIndexEntry.findUniqueOrThrow({
        where: { documentId: hit.documentId },
      });
      expect(row.tenantId).toBe(TENANT);
    }
  });
});

describe('keyset pagination', () => {
  it('walks pages without overlap and refuses a cursor from another sort', async () => {
    const first = await asAlice(() =>
      search.search.search({
        text: null,
        filters: { status: ['DRAFT'] },
        facets: [],
        sort: 'TITLE',
        cursor: null,
        limit: 2,
      }),
    );
    expect(first.results.hits.length).toBeGreaterThanOrEqual(1);
    if (first.results.nextCursor !== null) {
      const second = await asAlice(() =>
        search.search.search({
          text: null,
          filters: { status: ['DRAFT'] },
          facets: [],
          sort: 'TITLE',
          cursor: first.results.nextCursor,
          limit: 2,
        }),
      );
      const firstIds = new Set(first.results.hits.map((hit) => hit.documentId));
      for (const hit of second.results.hits) {
        expect(firstIds.has(hit.documentId)).toBe(false);
      }
      await expect(
        asAlice(() =>
          search.search.search({
            text: null,
            filters: {},
            facets: [],
            sort: 'RECENT',
            cursor: first.results.nextCursor,
            limit: 2,
          }),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
});
