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
import { requireTransaction } from '../../../core/prisma';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { PrismaFacetLabelReader } from '../infrastructure/prisma-facet-label.reader';
import { PrismaSearchSourceReader } from '../infrastructure/prisma-search-source.reader';
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

let registry: ReturnType<typeof everyTenantRegistry>;
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
  registry = everyTenantRegistry(APP_URL);
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

/**
 * Slice 40 — a folder's delete cascade, and the index it never told.
 *
 * `PrismaSearchSourceReader.factsFor` states the invariant: "Soft-deleted and purged documents are
 * not findable: the entry is removed, never filtered at query time — an unfindable row in the index
 * is a leak waiting for a predicate bug." The query really does not filter — `aclClauses` is
 * tenant, then the subject overlap, then the caller's own filters — so the removal is the whole of
 * it, and the removal only happens when something asks for a projection.
 *
 * `DocumentService.delete` asks, by publishing `document.deleted`. The folder cascade did not.
 * `DocumentFolderContentsParticipant` opens by saying it is "a document delete with a different
 * trigger", and it was — the hold, the revisions, the references and the retention schedule are all
 * there — but it ended at the retention call and published nothing.
 *
 * It looked covered, because usually it was. `RetentionScheduler.onTrigger` publishes
 * `retention.scheduled`, which routes to the search lane and resolves to the same document. But
 * `proposeSchedule` returns null, and publishes nothing at all, for a numbered document with no
 * `ON_DELETE` policy — the ordinary controlled record. So the incidental cover was inverted: the
 * documents most worth hiding were the ones that missed it.
 *
 * Asserted through search itself, with the events the lane consumes driven through the projection
 * exactly as the consumer drives them — not by calling `project` on an identifier the test already
 * knows, which would assert the mechanism and skip the trigger that was missing.
 */
describe('deleting a folder takes its documents out of the index', () => {
  let folderId: string;
  let libraryId: string;
  let insideId: DocumentId;
  let outsideId: DocumentId;
  const TITLE = `Cascaded welding instruction ${uuidv7().slice(-8)}`;

  beforeAll(async () => {
    const root = await owner.folder.findUniqueOrThrow({ where: { id: rootFolderId } });
    libraryId = root.libraryId;
    const folder = await asAlice(() =>
      library.libraries.createFolder({
        libraryId,
        parentId: rootFolderId,
        name: `Cascade ${uuidv7().slice(-8)}`,
        inheritAcl: true,
      }),
    );
    folderId = folder.id;

    insideId = await documentIn(folderId, TITLE);
    // A second document outside the folder, so "not found" cannot mean the index was emptied.
    outsideId = await documentIn(
      rootFolderId,
      `Untouched welding instruction ${uuidv7().slice(-8)}`,
    );

    /*
     * Numbered, and with no retention policy — which is what makes `proposeSchedule` return null
     * and publish nothing. A draft would have taken the recycle-bin branch, published
     * `retention.scheduled`, and been re-projected by accident.
     */
    for (const id of [insideId, outsideId]) {
      await owner.document.update({
        where: { id },
        // `ck_document_numbered` requires the two to travel together, which is the database saying
        // the same thing `proposeSchedule` does: a number is what stops it being a draft.
        data: {
          documentNumber: `CASCADE-${uuidv7().slice(-8)}`,
          numberedAt: FIXED_NOW,
          retentionPolicyId: null,
        },
      });
    }

    await project(insideId);
    await project(outsideId);
  }, 120_000);

  async function documentIn(parentId: string, title: string): Promise<DocumentId> {
    // Distinct bytes per document: identical content is refused as a duplicate, which is its own
    // correct behaviour and not what this case is about.
    const created = await createDocument(
      title,
      await realPdf([`Welding instruction body for ${title}.`]),
      'welding.pdf',
      'application/pdf',
    );
    await owner.document.update({
      where: { id: created.documentId },
      data: { folderId: parentId },
    });
    return created.documentId;
  }

  /** Every outbox row that exists right now, by identifier. */
  async function outboxIds(): Promise<Set<string>> {
    const rows = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  /**
   * The search lane, over the rows one mutation added — and only those.
   *
   * Scoped by identifier rather than by timestamp because this suite's clock is frozen, and scoped
   * at all because draining *every* `document.*` row would project the `document.created` row this
   * fixture already wrote. That would remove the entry whether or not the delete published
   * anything, which is a case that passes for the wrong reason.
   */
  async function drainSearchLane(before: Set<string>): Promise<void> {
    const rows = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, id: { notIn: [...before] } },
      select: { eventType: true, payload: true },
    });
    for (const row of rows) {
      if (!row.eventType.startsWith('document.')) {
        continue;
      }
      const payload = row.payload as { documentId?: string };
      if (payload.documentId !== undefined) {
        await project(asId<DocumentId>(payload.documentId));
      }
    }
  }

  const finds = async (id: DocumentId): Promise<boolean> => {
    const found = await searchAs(asAlice, 'welding instruction');
    return found.results.hits.some((hit) => hit.documentId === id);
  };

  it('finds both documents while they are live', async () => {
    // The positive control, both halves: the one that will be deleted and the one that will not.
    expect(await finds(insideId)).toBe(true);
    expect(await finds(outsideId)).toBe(true);
  }, 60_000);

  it('stops finding the one whose folder was deleted, and keeps the other', async () => {
    const before = await outboxIds();
    const row = await owner.folder.findUniqueOrThrow({ where: { id: folderId } });
    await asAlice(() => library.libraries.deleteFolder(folderId, row.version));

    // The document is in the recycle bin, which is gated on `document:restore`.
    const deleted = await owner.document.findUniqueOrThrow({ where: { id: insideId } });
    expect(deleted.deletedAt).not.toBeNull();

    // Nothing here names the document: the lane is driven from whatever the transaction published,
    // which is the step that was missing. Without it there is no `document.deleted` row to find and
    // the entry survives — title, body and highlights — for anyone who could read it before.
    await drainSearchLane(before);

    expect(await finds(insideId)).toBe(false);
    expect(await finds(outsideId)).toBe(true);
  }, 60_000);

  it('puts it back when the folder is restored', async () => {
    // The precondition, asserted rather than assumed. Without this the case passes whenever the
    // delete published nothing — it would be reading a document that was never removed and calling
    // it a restoration. That is the shape Slice 40's own mutation run exposed: suppressing the
    // delete publish left this case green.
    expect(await finds(insideId)).toBe(false);

    const before = await outboxIds();
    const row = await owner.folder.findUniqueOrThrow({ where: { id: folderId } });
    await asAlice(() => library.libraries.restoreFolder(folderId, row.version));

    await drainSearchLane(before);

    // The other direction: a restored document nothing re-projected would stay out of the index it
    // was removed from, unfindable until some later edit happened to put it back.
    expect(await finds(insideId)).toBe(true);
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

describe('facet labels', () => {
  /**
   * Names for the values a caller has already been shown, and for nothing else — Slice 11.
   *
   * `/search` used to caption its facets from four administrative lists the page fetched itself:
   * every document type, every category, every department, every entity in the tenant. Those need
   * `settings:manage` and `org:manage`, so the workspace was the route error boundary for the two
   * seeded roles that hold neither. The names were never the problem; asking for the *catalogue* to
   * find four of them was.
   *
   * The server answers it now, and what makes that safe is arithmetic rather than intention:
   * `countFacet` runs the same `WHERE` the hits run — tenant first, then the ACL overlap — so an
   * identifier reaching the label reader is one the caller has already been given a count for.
   * These tests are about that boundary.
   */

  const labelReader = new PrismaFacetLabelReader();

  /** A type nothing is filed under: present in the tenant, absent from anybody's facets. */
  const unusedTypeId = uuidv7();
  const UNUSED_NAME = 'Nobody files anything as this';

  beforeAll(async () => {
    // Written directly, for the reason the metadata field above is: what is under test is the
    // reader's view of the rows, not the administration service that edits them.
    const existing = await owner.documentType.findUniqueOrThrow({ where: { id: documentTypeId } });
    await owner.documentType.create({
      data: {
        id: unusedTypeId,
        tenantId: TENANT,
        code: unique('T'),
        name: UNUSED_NAME,
        numberingRuleId: existing.numberingRuleId,
        defaultConfidentialityId: existing.defaultConfidentialityId,
        revisionLabelStyle: existing.revisionLabelStyle,
        isActive: true,
        updatedAt: FIXED_NOW,
      },
    });
  }, 60_000);

  const resolve = (
    request: Parameters<PrismaFacetLabelReader['labelsFor']>[0],
    runner: <T>(work: () => Promise<T>) => Promise<T> = asAlice,
  ) => runner(() => unitOfWork.run(() => labelReader.labelsFor(request)));

  it('names the values in the caller’s own facets', async () => {
    const found = await searchAs(asAlice, 'pump maintenance');

    expect(found.results.facets['type']?.map((entry) => entry.value)).toContain(documentTypeId);
    expect(found.facetLabels.type?.[documentTypeId]).toBe('Procedure');
  });

  it('never names a row the caller has no bucket for', async () => {
    /*
     * The disclosure question, made concrete. The tenant holds two document types; one is filed
     * against and one is not. A caller searching sees a bucket for the first and none for the
     * second — so the label map carries the first name and must not carry the second, though both
     * rows sit in the same table one query away.
     */
    const found = await searchAs(asAlice, 'pump maintenance');

    expect(found.facetLabels.type?.[unusedTypeId]).toBeUndefined();
    expect(Object.values(found.facetLabels.type ?? {})).not.toContain(UNUSED_NAME);
    // The map is the facet, not the catalogue.
    expect(Object.keys(found.facetLabels.type ?? {})).toStrictEqual([documentTypeId]);
  });

  it('gives a caller the ACL refuses no labels, because it gives them no buckets', async () => {
    // Bob's roles do not hold `document:view`. The predicate empties the facets, and an empty facet
    // has nothing to resolve — the reader is never handed an identifier at all.
    const refused = await searchAs(asBob, 'pump maintenance');

    expect(refused.results.facets['type']).toHaveLength(0);
    expect(refused.facetLabels.type).toBeUndefined();
  });

  it('labels a `search:all` caller’s wider facets, and still only those', async () => {
    // `search:all` drops the ACL clause and nothing else, so the rule is unchanged: whatever the
    // facets contain gets named, and what is not in them does not.
    const wide = await searchAs(asCarol, 'pump maintenance');

    expect(wide.unrestricted).toBe(true);
    expect(wide.facetLabels.type?.[documentTypeId]).toBe('Procedure');
    expect(wide.facetLabels.type?.[unusedTypeId]).toBeUndefined();
  });

  it('leaves the values and the counts exactly as the engine computed them', async () => {
    const found = await searchAs(asAlice, 'pump maintenance');
    const buckets = found.results.facets['type'] ?? [];

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.value).toBe(documentTypeId);
    expect(buckets[0]?.count).toBeGreaterThanOrEqual(1);
    // The engine's own bucket carries no label; labelling happens beside it, in the application.
    expect('label' in (buckets[0] ?? {})).toBe(false);
  });

  it('says nothing about a type that has since been deleted', async () => {
    /*
     * A soft-deleted type still has documents filed under it, so its identifier can legitimately
     * reach a facet. The reader returns no name and the client renders the value — the honest
     * answer to "what is this called" when the answer has been withdrawn.
     */
    expect((await resolve({ type: [documentTypeId] })).type?.[documentTypeId]).toBe('Procedure');

    await owner.documentType.update({
      where: { id: documentTypeId },
      data: { deletedAt: FIXED_NOW },
    });
    try {
      expect((await resolve({ type: [documentTypeId] })).type?.[documentTypeId]).toBeUndefined();
    } finally {
      await owner.documentType.update({ where: { id: documentTypeId }, data: { deletedAt: null } });
    }
  });

  it('says nothing about an identifier that never existed, rather than failing', async () => {
    const missing = uuidv7();
    const labels = await resolve({ type: [documentTypeId, missing] });

    expect(labels.type?.[documentTypeId]).toBe('Procedure');
    expect(labels.type?.[missing]).toBeUndefined();
  });

  it('cannot resolve an identifier belonging to another tenant', async () => {
    /*
     * The tenant clause is in the query rather than left to row-level security, and this is why: an
     * identifier from tenant A must resolve to nothing under tenant B because the `WHERE` says so.
     */
    const underTenantB = await runWithContext(
      { ...contextFor(ALICE, [VIEWER_ROLE]), tenantId: TENANT_B },
      () => unitOfWork.run(() => labelReader.labelsFor({ type: [documentTypeId] })),
    );

    expect(underTenantB.type).toBeUndefined();
  });

  it('asks once per facet, never once per value', async () => {
    /*
     * A facet is capped at twenty buckets and four facets carry identifiers, so the difference
     * between batching and not is eighty round trips against four. Counted on the transactional
     * client the reader actually uses, rather than asserted about the shape of the code.
     */
    const ids = [documentTypeId, unusedTypeId, uuidv7(), uuidv7(), uuidv7()];
    let calls = 0;

    const labels = await asAlice(() =>
      unitOfWork.run(async () => {
        const tx = requireTransaction();
        const findMany = tx.documentType.findMany.bind(tx.documentType);
        (tx.documentType as { findMany: typeof findMany }).findMany = ((
          ...args: Parameters<typeof findMany>
        ) => {
          calls += 1;
          return findMany(...args);
        }) as typeof findMany;
        try {
          return await labelReader.labelsFor({ type: ids });
        } finally {
          (tx.documentType as { findMany: typeof findMany }).findMany = findMany;
        }
      }),
    );

    expect(Object.keys(labels.type ?? {}).sort()).toStrictEqual(
      [documentTypeId, unusedTypeId].sort(),
    );
    // Five identifiers, one query.
    expect(calls).toBe(1);
  });

  it('puts the tenant in the query itself, not only in the policy around it', async () => {
    /*
     * Row-level security is on these tables and would very likely catch a missing clause on its
     * own — and under ADR-0015 each tenant has its own database besides, so a cross-tenant
     * identifier has two reasons to resolve to nothing before this one. That is exactly why a
     * black-box test cannot prove this clause exists: remove it and every behavioural assertion
     * still passes.
     *
     * So this reads the argument the reader hands Prisma. It is a white-box assertion on purpose:
     * the requirement is that the boundary is *written down here*, where somebody reading the
     * query can see it, rather than inherited from configuration two layers away.
     */
    const seen: unknown[] = [];

    await asAlice(() =>
      unitOfWork.run(async () => {
        const tx = requireTransaction();
        const findMany = tx.documentType.findMany.bind(tx.documentType);
        (tx.documentType as { findMany: typeof findMany }).findMany = ((
          ...args: Parameters<typeof findMany>
        ) => {
          seen.push(args[0]?.where);
          return findMany(...args);
        }) as typeof findMany;
        try {
          return await labelReader.labelsFor({ type: [documentTypeId] });
        } finally {
          (tx.documentType as { findMany: typeof findMany }).findMany = findMany;
        }
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tenantId: TENANT, deletedAt: null });
  });

  it('asks for nothing at all when no facet produced a bucket', async () => {
    expect(await resolve({})).toStrictEqual({});
  });
});

/**
 * The entity facet, which nothing had ever produced — Slice 14.
 *
 * ## Why this block exists
 *
 * Slice 11 resolves names for four facets, and three of them are proved above through `type`. The
 * fourth is `entity`, and it was proved by nothing at all: `entity_id` is written by the projection
 * only when a library is owned by an `ENTITY` scope, or by a `DEPARTMENT` that belongs to one, and
 * every library in every fixture in this repository is owned by `TENANT`. So no search has ever
 * produced an entity bucket, no entity label has ever been resolved, and the end-to-end assertion
 * that the facet rail carries "no bare identifier" was vacuously true for this facet.
 *
 * That matters more for `entity` than for the other three. Slice 10 recorded the entity name as the
 * one caption it could not obtain — *"entity labels remain unavailable below `org:manage`"* — and an
 * entity is the organisation's own structure rather than filing vocabulary. The claim that a caller
 * holding **no tenant-wide permission at all** now reads an entity's name, without `org:manage` and
 * without `/admin/entities`, is the sharpest claim this design makes. It should not rest on a test
 * that never ran.
 *
 * `asAlice` holds `permissions: []`. Every reach she has comes from an ACL role grant, which is
 * precisely the caller the claim is about.
 */
describe('the entity facet', () => {
  const labelReader = new PrismaFacetLabelReader();
  const ENTITY_NAME = 'Acme Manufacturing UK';
  const OTHER_ENTITY_NAME = 'Acme Manufacturing IE';
  const UNFILED_ENTITY_NAME = 'An entity nothing is filed under';

  let entityId: string;
  /** A second entity with its own library and its own document — Slice 15. */
  let otherEntityId: string;
  /** Exists, in this tenant, with nothing filed under it — so it must never be named. */
  let unfiledEntityId: string;

  const searchWithEntity = (runner: <T>(work: () => Promise<T>) => Promise<T>, text: string) =>
    runner(() =>
      search.search.search({
        text,
        filters: {},
        facets: ['type', 'entity'],
        sort: 'RELEVANCE',
        cursor: null,
        limit: 25,
      }),
    );

  beforeAll(async () => {
    const companyId = uuidv7();
    entityId = uuidv7();
    otherEntityId = uuidv7();
    unfiledEntityId = uuidv7();

    await owner.company.create({
      data: {
        id: companyId,
        tenantId: TENANT,
        code: unique('CO'),
        name: 'Acme',
        updatedAt: FIXED_NOW,
      },
    });
    for (const [id, name] of [
      [entityId, ENTITY_NAME],
      [otherEntityId, OTHER_ENTITY_NAME],
      [unfiledEntityId, UNFILED_ENTITY_NAME],
    ] as const) {
      await owner.entity.create({
        data: {
          id,
          tenantId: TENANT,
          companyId,
          code: unique('E'),
          name,
          updatedAt: FIXED_NOW,
        },
      });
    }

    // A library the *entity* owns — the placement that makes `entity_id` non-null at all.
    const owned = await asAlice(() =>
      library.libraries.createLibrary({
        code: unique('ENT'),
        name: 'Manufacturing',
        ownerScopeType: 'ENTITY',
        ownerScopeId: entityId,
      }),
    );

    // Two documents, so the "one query however many share it" claim has something to be about.
    for (const title of ['Entity filed casting report', 'Entity filed welding report']) {
      const fileObjectId = await upload(Buffer.from(`${title} body`), 'report.txt', 'text/plain');
      await owner.fileObject.update({
        where: { id: fileObjectId },
        data: { scanStatus: ScanStatus.CLEAN, scanner: 'integration-suite', scannedAt: FIXED_NOW },
      });
      const created = await asAlice(() =>
        library.documents.create({
          folderId: owned.rootFolderId,
          documentTypeId,
          title,
          fileObjectId,
          filename: 'report.txt',
          origin: 'UPLOAD',
          acknowledgeDuplicate: false,
        }),
      );
      await project(asId<DocumentId>(created.id));
    }

    // A second entity-owned library with a single document, so the two entities can be told apart
    // by their counts as well as by their identifiers.
    const otherOwned = await asAlice(() =>
      library.libraries.createLibrary({
        code: unique('ENT'),
        name: 'Assembly',
        ownerScopeType: 'ENTITY',
        ownerScopeId: otherEntityId,
      }),
    );
    const otherFileId = await upload(
      Buffer.from('Entity filed assembly report body'),
      'report.txt',
      'text/plain',
    );
    await owner.fileObject.update({
      where: { id: otherFileId },
      data: { scanStatus: ScanStatus.CLEAN, scanner: 'integration-suite', scannedAt: FIXED_NOW },
    });
    const otherDocument = await asAlice(() =>
      library.documents.create({
        folderId: otherOwned.rootFolderId,
        documentTypeId,
        title: 'Entity filed assembly report',
        fileObjectId: otherFileId,
        filename: 'report.txt',
        origin: 'UPLOAD',
        acknowledgeDuplicate: false,
      }),
    );
    await project(asId<DocumentId>(otherDocument.id));
  }, 120_000);

  it('produces an entity bucket at all, which nothing had done before', async () => {
    // The precondition, asserted rather than assumed: every other fixture owns its libraries at
    // `TENANT`, where the projection writes `entity_id` as null and this facet is always empty.
    const found = await searchWithEntity(asAlice, 'entity filed');

    expect(found.results.facets['entity']?.map((bucket) => bucket.value)).toContain(entityId);
  });

  it('names the entity for a caller holding no tenant-wide permission at all', async () => {
    /*
     * The claim Slice 10 could not make. Alice holds `permissions: []` — no `org:manage`, no
     * `settings:manage`, nothing. Her reach is an ACL role grant, and the name arrives anyway,
     * because it is resolved for a bucket the predicate already gave her.
     */
    const found = await searchWithEntity(asAlice, 'entity filed');

    expect(found.facetLabels.entity?.[entityId]).toBe(ENTITY_NAME);
  });

  it('never names an entity the caller has no bucket for', async () => {
    // Two entities in this tenant, one filed against. The label map is the facet, not the chart.
    const found = await searchWithEntity(asAlice, 'entity filed');

    expect(found.facetLabels.entity?.[unfiledEntityId]).toBeUndefined();
    expect(Object.values(found.facetLabels.entity ?? {})).not.toContain(UNFILED_ENTITY_NAME);
    expect(Object.keys(found.facetLabels.entity ?? {}).sort()).toStrictEqual(
      [entityId, otherEntityId].sort(),
    );
  });

  it('counts two documents into one entity bucket', async () => {
    // One bucket, not two. A projection writing the library id or the folder id instead of the
    // placement would produce two buckets of one and pass every label assertion above.
    const found = await searchWithEntity(asAlice, 'entity filed');
    const mine = (found.results.facets['entity'] ?? []).filter(
      (bucket) => bucket.value === entityId,
    );

    expect(mine).toHaveLength(1);
    expect(mine[0]?.count).toBe(2);
  });

  it('keeps a second entity in its own bucket, named separately', async () => {
    /*
     * Two entities, three documents, two buckets — and the smaller one is not folded into the
     * larger. Worth asserting because every failure mode that merges placements (writing the
     * company, writing the tenant, writing null) still yields *a* bucket with *a* name.
     */
    const found = await searchWithEntity(asAlice, 'entity filed');
    const buckets = new Map(
      (found.results.facets['entity'] ?? []).map((bucket) => [bucket.value, bucket.count]),
    );

    expect(buckets.get(entityId)).toBe(2);
    expect(buckets.get(otherEntityId)).toBe(1);
    expect(found.facetLabels.entity?.[entityId]).toBe(ENTITY_NAME);
    expect(found.facetLabels.entity?.[otherEntityId]).toBe(OTHER_ENTITY_NAME);
  });

  it('gives a caller the ACL refuses no entity label, because it gives them no bucket', async () => {
    const refused = await searchWithEntity(asBob, 'entity filed');

    expect(refused.results.facets['entity']).toHaveLength(0);
    expect(refused.facetLabels.entity).toBeUndefined();
  });

  it('cannot resolve this entity from another tenant', async () => {
    /*
     * Asked the way the `type` facet asks it above, and for the same reason: tenants live in
     * separate databases, so a "foreign" row cannot be seeded here at all — `company_tenant_id_fkey`
     * refuses it. What can be proved in one database is the clause itself: a real entity of this
     * tenant, looked up under a different ambient tenant, resolves to nothing because the `WHERE`
     * says so rather than because the row was somewhere else.
     */
    const underTenantB = await runWithContext(
      { ...contextFor(ALICE, [VIEWER_ROLE]), tenantId: TENANT_B },
      () => unitOfWork.run(() => labelReader.labelsFor({ entity: [entityId] })),
    );

    expect(underTenantB.entity).toBeUndefined();
    expect(JSON.stringify(underTenantB)).not.toContain(ENTITY_NAME);
  });

  it('says nothing about an entity that has since been deleted', async () => {
    /*
     * An entity can be retired while documents remain filed under it, so its identifier keeps
     * appearing in facets. The caller sees the value it already had rather than a withdrawn name.
     */
    await owner.entity.update({
      where: { id: unfiledEntityId },
      data: { deletedAt: FIXED_NOW },
    });

    const named = await asAlice(() =>
      unitOfWork.run(() => labelReader.labelsFor({ entity: [unfiledEntityId] })),
    );

    expect(named.entity).toBeUndefined();
  });

  it('asks once for the entity facet, however many documents share it', async () => {
    // Two indexed documents, one entity, one query — and the identifier de-duplicated before it
    // reaches the `IN`.
    let calls = 0;
    const seen: unknown[] = [];
    await asAlice(() =>
      unitOfWork.run(async () => {
        const tx = requireTransaction();
        const model = tx.entity as unknown as {
          findMany: (args: { where: unknown }) => Promise<unknown>;
        };
        const original = model.findMany.bind(model);
        model.findMany = (args: { where: unknown }) => {
          calls += 1;
          seen.push(args.where);
          return original(args);
        };
        return labelReader.labelsFor({ entity: [entityId, entityId, entityId] });
      }),
    );

    expect(calls).toBe(1);
    // And the tenant is in the query itself, not only in the policy around it — the same white-box
    // assertion the other facets carry, for the same reason: RLS would hide its removal.
    expect(seen[0]).toMatchObject({ tenantId: TENANT, deletedAt: null });
  });
});

/**
 * The department placement, and the two facets one library produces — Slice 15.
 *
 * ## What was unexercised
 *
 * Slice 14 proved the entity facet by giving one library an `ENTITY` owner. It left the other
 * placement untested and said so: every other library in the repository is owned by `TENANT`, where
 * `placementOf` writes `entity_id`, `department_id` and `branch_id` as null and all three paths stay
 * dark. A `DEPARTMENT`-owned library is the only thing that writes the last two.
 *
 * ## The behaviour that is worth a test rather than a glance
 *
 * A department-owned library contributes to **two** facets, not one. `placementOf` reads the
 * department row and returns its `entityId` and `branchId` alongside its own id, so a document filed
 * in a departmental library is findable by the department *and* by the entity that department
 * belongs to, without anybody having filed it against the entity. That is a real inference the
 * projection makes on the tenant's behalf, and it is the kind of thing that quietly stops working.
 *
 * `branch_id` is written by the same read. It is a **filter** (`SEARCH_FILTER_KEYS` includes
 * `branch`, and the adapter matches it) and deliberately **not a facet** — there is no
 * `FACET_COLUMNS` entry for it — so it is proved here by filtering rather than by counting buckets.
 */
describe('the department placement', () => {
  const labelReader = new PrismaFacetLabelReader();
  const DEPARTMENT_NAME = 'Quality Assurance';
  const PARENT_ENTITY_NAME = 'Acme Manufacturing DE';
  const UNFILED_DEPARTMENT_NAME = 'A unit nothing is filed under';

  let departmentId: string;
  let parentEntityId: string;
  let branchId: string;
  /** Exists in this tenant with nothing filed under it — so it must never be named. */
  let unfiledDepartmentId: string;

  const searchPlacement = (
    runner: <T>(work: () => Promise<T>) => Promise<T>,
    text: string,
    filters: Record<string, readonly string[]> = {},
  ) =>
    runner(() =>
      search.search.search({
        text,
        filters,
        facets: ['department', 'entity'],
        sort: 'RELEVANCE',
        cursor: null,
        limit: 25,
      }),
    );

  beforeAll(async () => {
    const companyId = uuidv7();
    parentEntityId = uuidv7();
    branchId = uuidv7();
    departmentId = uuidv7();
    unfiledDepartmentId = uuidv7();

    await owner.company.create({
      data: {
        id: companyId,
        tenantId: TENANT,
        code: unique('CO'),
        name: 'Acme Group',
        updatedAt: FIXED_NOW,
      },
    });
    await owner.entity.create({
      data: {
        id: parentEntityId,
        tenantId: TENANT,
        companyId,
        code: unique('E'),
        name: PARENT_ENTITY_NAME,
        updatedAt: FIXED_NOW,
      },
    });
    await owner.branch.create({
      data: {
        id: branchId,
        tenantId: TENANT,
        entityId: parentEntityId,
        code: unique('B'),
        name: 'Stuttgart',
        updatedAt: FIXED_NOW,
      },
    });
    for (const [id, name, withBranch] of [
      [departmentId, DEPARTMENT_NAME, true],
      [unfiledDepartmentId, UNFILED_DEPARTMENT_NAME, false],
    ] as const) {
      await owner.department.create({
        data: {
          id,
          tenantId: TENANT,
          entityId: parentEntityId,
          ...(withBranch ? { branchId } : {}),
          code: unique('D'),
          name,
          path: id,
          updatedAt: FIXED_NOW,
        },
      });
    }

    const owned = await asAlice(() =>
      library.libraries.createLibrary({
        code: unique('DEP'),
        name: 'Departmental',
        ownerScopeType: 'DEPARTMENT',
        ownerScopeId: departmentId,
      }),
    );

    for (const title of ['Departmental calibration record', 'Departmental cleaning record']) {
      const fileObjectId = await upload(Buffer.from(`${title} body`), 'record.txt', 'text/plain');
      await owner.fileObject.update({
        where: { id: fileObjectId },
        data: { scanStatus: ScanStatus.CLEAN, scanner: 'integration-suite', scannedAt: FIXED_NOW },
      });
      const created = await asAlice(() =>
        library.documents.create({
          folderId: owned.rootFolderId,
          documentTypeId,
          title,
          fileObjectId,
          filename: 'record.txt',
          origin: 'UPLOAD',
          acknowledgeDuplicate: false,
        }),
      );
      await project(asId<DocumentId>(created.id));
    }
  }, 120_000);

  it('writes the department the library belongs to', async () => {
    const found = await searchPlacement(asAlice, 'departmental record');

    expect(found.results.facets['department']?.map((bucket) => bucket.value)).toContain(
      departmentId,
    );
  });

  it('names it, for a caller holding no tenant-wide permission at all', async () => {
    // Alice holds `permissions: []`; her whole reach is an ACL role grant. The name arrives because
    // the bucket did.
    const found = await searchPlacement(asAlice, 'departmental record');

    expect(found.facetLabels.department?.[departmentId]).toBe(DEPARTMENT_NAME);
  });

  it('also attributes the document to the entity that department belongs to', async () => {
    /*
     * The inference worth pinning down. Nobody filed these documents against an entity — they were
     * filed in a departmental library, and `placementOf` read the department's `entityId` and wrote
     * it too. So a search by entity finds departmental documents, which is the behaviour an
     * organisation would expect and the one nothing was checking.
     */
    const found = await searchPlacement(asAlice, 'departmental record');

    expect(found.results.facets['entity']?.map((bucket) => bucket.value)).toContain(parentEntityId);
    expect(found.facetLabels.entity?.[parentEntityId]).toBe(PARENT_ENTITY_NAME);
  });

  it('counts two documents into one department bucket', async () => {
    // One bucket, not two — and the count is the arithmetic, so a projection that wrote the
    // library id or the folder id instead would produce two buckets of one.
    const found = await searchPlacement(asAlice, 'departmental record');
    const buckets = (found.results.facets['department'] ?? []).filter(
      (bucket) => bucket.value === departmentId,
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.count).toBe(2);
  });

  it('writes the branch the department sits in, which is a filter rather than a facet', async () => {
    /*
     * `branch` is in `SEARCH_FILTER_KEYS` and the adapter matches `"branch_id" = ANY(...)`, but
     * there is no `FACET_COLUMNS` entry for it — so it is proved by narrowing rather than by
     * counting. Filtering to the branch returns the departmental documents; filtering to a branch
     * identifier that names nothing returns none of them.
     */
    const inBranch = await searchPlacement(asAlice, 'departmental record', { branch: [branchId] });
    const elsewhere = await searchPlacement(asAlice, 'departmental record', { branch: [uuidv7()] });

    expect(inBranch.results.total).toBe(2);
    expect(elsewhere.results.total).toBe(0);
  });

  it('never names a department the caller has no bucket for', async () => {
    const found = await searchPlacement(asAlice, 'departmental record');

    expect(found.facetLabels.department?.[unfiledDepartmentId]).toBeUndefined();
    expect(Object.values(found.facetLabels.department ?? {})).not.toContain(
      UNFILED_DEPARTMENT_NAME,
    );
    expect(Object.keys(found.facetLabels.department ?? {})).toStrictEqual([departmentId]);
  });

  it('gives a caller the ACL refuses no placement facet at all', async () => {
    // Bob's roles do not hold `document:view`. The predicate empties the facets before they are
    // counted, so neither placement survives to be named.
    const refused = await searchPlacement(asBob, 'departmental record');

    expect(refused.results.facets['department']).toHaveLength(0);
    expect(refused.results.facets['entity']).toHaveLength(0);
    expect(refused.facetLabels.department).toBeUndefined();
  });

  it('cannot resolve this department from another tenant', async () => {
    // Tenants live in separate databases, so what one database proves is the clause: a real
    // department of this tenant, looked up under a different ambient tenant, resolves to nothing.
    const underTenantB = await runWithContext(
      { ...contextFor(ALICE, [VIEWER_ROLE]), tenantId: TENANT_B },
      () => unitOfWork.run(() => labelReader.labelsFor({ department: [departmentId] })),
    );

    expect(underTenantB.department).toBeUndefined();
    expect(JSON.stringify(underTenantB)).not.toContain(DEPARTMENT_NAME);
  });

  it('keeps the bucket but drops the name when the department is retired', async () => {
    /*
     * The honest half of a soft delete. `placementOf` does not filter `deletedAt` — the library
     * still belongs to that unit, so the identifier keeps being written and the documents stay
     * findable. The *label* reader does filter it, so the facet shows the value rather than a name
     * that has been withdrawn. Both halves are asserted, because a change to either would be a
     * change in what a retired unit still says about itself.
     */
    await owner.department.update({
      where: { id: unfiledDepartmentId },
      data: { deletedAt: FIXED_NOW },
    });

    const named = await asAlice(() =>
      unitOfWork.run(() => labelReader.labelsFor({ department: [unfiledDepartmentId] })),
    );
    const stillFound = await searchPlacement(asAlice, 'departmental record');

    expect(named.department).toBeUndefined();
    expect(stillFound.results.facets['department']?.map((bucket) => bucket.value)).toContain(
      departmentId,
    );
  });

  it('asks once for the department facet, with the tenant in the query', async () => {
    let calls = 0;
    const seen: unknown[] = [];
    await asAlice(() =>
      unitOfWork.run(async () => {
        const tx = requireTransaction();
        const model = tx.department as unknown as {
          findMany: (args: { where: unknown }) => Promise<unknown>;
        };
        const original = model.findMany.bind(model);
        model.findMany = (args: { where: unknown }) => {
          calls += 1;
          seen.push(args.where);
          return original(args);
        };
        return labelReader.labelsFor({ department: [departmentId, departmentId] });
      }),
    );

    expect(calls).toBe(1);
    expect(seen[0]).toMatchObject({ tenantId: TENANT, deletedAt: null });
  });
});

/**
 * The company placement, and the branch filter — Slice 16.
 *
 * ## Company: an absence, asserted
 *
 * `LIBRARY_OWNER_SCOPES` permits four owners and `placementOf` handles them in three ways: `ENTITY`
 * writes the scope id, `DEPARTMENT` reads the row and writes all three columns, and everything else
 * falls through to `none`. `COMPANY` is in that last group, deliberately — *"TENANT and COMPANY
 * owners place a library above the entity level"* — because a library a company owns spans that
 * company's entities and is not attributable to one of them.
 *
 * It was the only row of the placement matrix with no test, and an absence is exactly the kind of
 * claim that rots quietly: nothing fails when a null starts being written, it just starts appearing
 * in somebody's facet rail. So the projection row is read directly rather than inferred from the
 * facets, and the facets are checked as well — because those are two different ways to be wrong.
 *
 * **Company is not a facet and not a filter.** It appears nowhere in `FACET_COLUMNS`,
 * `SEARCH_FILTER_KEYS` or the index. Company ownership is represented *only* by the absence of the
 * three placement columns, which is not the same as the documents being invisible: they are found by
 * text, type, category, status, year, folder and everything else the engine offers.
 *
 * ## Branch: a filter that no control offers
 *
 * `branch` is in `SEARCH_FILTER_KEYS`, so `?branch=<uuid>` on `/search` is accepted and the web page
 * forwards it — but nothing in the product renders a branch to choose, and there is no
 * `FACET_COLUMNS` entry, so it never comes back as a bucket. Slice 15 proved the clause narrows;
 * what it did not prove is that it narrows to the *right* branch, which needs two of them.
 *
 * The security question has a structural answer rather than an ordering one. `whereClauses` builds
 * the tenant clause, then the ACL clauses, then every filter, and `AND`-joins the lot into a single
 * predicate that the hits query, the total query and every `countFacet` all share. A branch filter
 * is a conjunct: there is no path on which it is evaluated without the ACL clauses beside it, so it
 * can only ever narrow what the caller could already see. That is asserted below from Bob's seat.
 */
describe('the company placement and the branch filter', () => {
  const labelReader = new PrismaFacetLabelReader();

  let companyId: string;
  let companyDocumentId: string;
  /** Two real branches under one entity, so "the right branch" is a question with an answer. */
  let branchA: string;
  let branchB: string;
  let departmentB: string;

  const searchPlaced = (
    runner: <T>(work: () => Promise<T>) => Promise<T>,
    text: string,
    filters: Record<string, readonly string[]> = {},
  ) =>
    runner(() =>
      search.search.search({
        text,
        filters,
        facets: ['department', 'entity', 'type'],
        sort: 'RELEVANCE',
        cursor: null,
        limit: 25,
      }),
    );

  async function fileUnder(rootFolderId: string, title: string): Promise<string> {
    const fileObjectId = await upload(Buffer.from(`${title} body`), 'doc.txt', 'text/plain');
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
        filename: 'doc.txt',
        origin: 'UPLOAD',
        acknowledgeDuplicate: false,
      }),
    );
    await project(asId<DocumentId>(created.id));
    return created.id;
  }

  beforeAll(async () => {
    companyId = uuidv7();
    const entityId = uuidv7();
    branchA = uuidv7();
    branchB = uuidv7();
    const departmentA = uuidv7();
    departmentB = uuidv7();

    await owner.company.create({
      data: {
        id: companyId,
        tenantId: TENANT,
        code: unique('CO'),
        name: 'Acme Holdings',
        updatedAt: FIXED_NOW,
      },
    });
    await owner.entity.create({
      data: {
        id: entityId,
        tenantId: TENANT,
        companyId,
        code: unique('E'),
        name: 'Acme Holdings NL',
        updatedAt: FIXED_NOW,
      },
    });
    for (const [id, name] of [
      [branchA, 'Rotterdam'],
      [branchB, 'Eindhoven'],
    ] as const) {
      await owner.branch.create({
        data: {
          id,
          tenantId: TENANT,
          entityId,
          code: unique('B'),
          name,
          updatedAt: FIXED_NOW,
        },
      });
    }
    for (const [id, branchId] of [
      [departmentA, branchA],
      [departmentB, branchB],
    ] as const) {
      await owner.department.create({
        data: {
          id,
          tenantId: TENANT,
          entityId,
          branchId,
          code: unique('D'),
          name: `Unit ${id.slice(0, 6)}`,
          path: id,
          updatedAt: FIXED_NOW,
        },
      });
    }

    // The company-owned library: the untested row of the placement matrix.
    const companyOwned = await asAlice(() =>
      library.libraries.createLibrary({
        code: unique('COM'),
        name: 'Group',
        ownerScopeType: 'COMPANY',
        ownerScopeId: companyId,
      }),
    );
    companyDocumentId = await fileUnder(companyOwned.rootFolderId, 'Placement group policy');

    // One department-owned library per branch, so a branch filter has two candidates to choose
    // between rather than one to find.
    for (const [department, title] of [
      [departmentA, 'Placement rotterdam procedure'],
      [departmentB, 'Placement eindhoven procedure'],
    ] as const) {
      const owned = await asAlice(() =>
        library.libraries.createLibrary({
          code: unique('DEP'),
          name: `Site ${department.slice(0, 6)}`,
          ownerScopeType: 'DEPARTMENT',
          ownerScopeId: department,
        }),
      );
      await fileUnder(owned.rootFolderId, title);
    }
  }, 180_000);

  it('writes no placement at all for a company-owned library', async () => {
    /*
     * Read off the projection row rather than inferred from the facets, because the two can
     * disagree: a written `entity_id` that no requested facet happens to count would pass every
     * bucket assertion below while being exactly the regression this test exists to catch.
     */
    const row = await owner.searchIndexEntry.findUniqueOrThrow({
      where: { documentId: companyDocumentId },
      select: { entityId: true, departmentId: true, branchId: true },
    });

    expect(row).toStrictEqual({ entityId: null, departmentId: null, branchId: null });
  });

  it('contributes nothing to the entity or department facets', async () => {
    // The same claim from the other side. A company-owned document is above the entity level, so it
    // belongs in neither rail — and `HAVING ... IS NOT NULL` in `countFacet` is what keeps a null
    // out of a bucket of its own.
    const found = await searchPlaced(asAlice, 'placement group policy');

    expect(found.results.total).toBe(1);
    expect(found.results.facets['entity']).toStrictEqual([]);
    expect(found.results.facets['department']).toStrictEqual([]);
  });

  it('leaves the document findable by everything that is not a placement', async () => {
    // "No placement" is not "not indexed". The document answers to text and to its type exactly as
    // any other, which is the half a reader would otherwise have to take on trust.
    const byType = await searchPlaced(asAlice, 'placement group policy', {
      type: [documentTypeId],
    });

    expect(byType.results.hits.map((hit) => hit.documentId)).toContain(companyDocumentId);
    expect(byType.results.facets['type']?.map((bucket) => bucket.value)).toContain(documentTypeId);
  });

  it('narrows to the branch asked for, and not to the other one', async () => {
    /*
     * Two branches under one entity, one document each. Slice 15 proved the clause narrows by
     * pairing a real branch against a random identifier, which a filter that matched *any*
     * non-empty branch would also survive. This does not.
     */
    const inA = await searchPlaced(asAlice, 'placement procedure', { branch: [branchA] });
    const inB = await searchPlaced(asAlice, 'placement procedure', { branch: [branchB] });

    expect(inA.results.hits.map((hit) => hit.summary.title)).toStrictEqual([
      'Placement rotterdam procedure',
    ]);
    expect(inB.results.hits.map((hit) => hit.summary.title)).toStrictEqual([
      'Placement eindhoven procedure',
    ]);
  });

  it('leaves both reachable when no branch is named', async () => {
    const unfiltered = await searchPlaced(asAlice, 'placement procedure');

    expect(unfiltered.results.total).toBe(2);
  });

  it('cannot be used to reach a document the ACL refuses', async () => {
    /*
     * The invariant, from the seat of somebody who holds no `document:view`. `whereClauses` puts the
     * tenant clause, the ACL clauses and every filter into one `AND`-joined predicate shared by the
     * hits, the total and every facet count — so a branch filter is a conjunct and cannot widen.
     * Naming the branch precisely returns nothing, and the total agrees, which is the half that
     * would betray a fetch-then-filter.
     */
    const refused = await searchPlaced(asBob, 'placement procedure', { branch: [branchA] });

    expect(refused.results.hits).toStrictEqual([]);
    expect(refused.results.total).toBe(0);
  });

  it('returns nothing for a branch belonging to another tenant', async () => {
    /*
     * The tenant clause is the first conjunct in the same predicate, so a real branch of this
     * tenant returns nothing once the ambient tenant is somebody else's.
     *
     * Run the way the `tenant isolation` block above runs its search, and for two reasons.
     * `userId: null` because a *successful* search records a recent-search row for the ambient
     * tenant, and `TENANT_B` has no `tenant` row in this database to hang one off —
     * `recordAftermath` skips the write when there is no user. And `search:all` because it drops
     * the ACL conjunct, which leaves the tenant clause as the only thing that can exclude these
     * rows: the assertion then isolates exactly the boundary it claims to be about.
     */
    const elsewhere = await runWithContext(
      {
        ...contextFor(ALICE, [VIEWER_ROLE], [Permission.SEARCH_ALL]),
        tenantId: TENANT_B,
        userId: null,
      },
      () =>
        search.search.search({
          text: 'placement procedure',
          filters: { branch: [branchA] },
          facets: [],
          sort: 'RELEVANCE',
          cursor: null,
          limit: 25,
        }),
    );

    expect(elsewhere.results.hits).toStrictEqual([]);
    expect(elsewhere.results.total).toBe(0);
  });

  it('keeps filtering by a branch that has since been retired', async () => {
    /*
     * The same rule the department follows, and worth stating because it is the opposite of what a
     * reader might guess. `branch_id` is a column on the index, not a join, so retiring the branch
     * row changes nothing about which documents carry it: they stay findable, which is what an
     * auditor asking "what was filed at Eindhoven" needs. There is no branch facet and no branch
     * label, so nothing announces the retired name either way.
     */
    await owner.branch.update({ where: { id: branchB }, data: { deletedAt: FIXED_NOW } });

    const stillThere = await searchPlaced(asAlice, 'placement procedure', { branch: [branchB] });

    expect(stillThere.results.total).toBe(1);
  });

  it('has no branch label to resolve, because branch is not a labelled facet', async () => {
    // `LABELLED_FACETS` is type, category, department and entity. Branch is a filter, so the reader
    // has no branch key at all — asserted so that adding one becomes a deliberate act rather than a
    // side effect of extending the map.
    const named = await asAlice(() =>
      unitOfWork.run(() => labelReader.labelsFor({ department: [departmentB] })),
    );

    expect(Object.keys(named)).toStrictEqual(['department']);
  });
});

/**
 * One caller parked where the rebuild reads, so the two writers of the build target interleave
 * in a fixed order. `arm` must be called before the run: an unarmed turnstile never parks, so a
 * setup read cannot consume the slot the proof needs.
 */
class Turnstile<TMarker> {
  readonly arrivals: TMarker[] = [];
  readonly reached: Promise<void>[] = [];
  private readonly announce: (() => void)[] = [];
  private readonly admissions: Promise<void>[] = [];
  private readonly admits: (() => void)[] = [];
  private armed = false;

  arm(callers: number): void {
    for (let index = 0; index < callers; index += 1) {
      let arrive: () => void = () => undefined;
      this.reached.push(
        new Promise<void>((resolve) => {
          arrive = resolve;
        }),
      );
      this.announce.push(arrive);
      let admit: () => void = () => undefined;
      this.admissions.push(
        new Promise<void>((resolve) => {
          admit = resolve;
        }),
      );
      this.admits.push(admit);
    }
    this.armed = true;
  }

  async park(marker: TMarker): Promise<void> {
    if (!this.armed) {
      return;
    }
    const ordinal = this.arrivals.length;
    this.arrivals.push(marker);
    this.announce[ordinal]?.();
    await this.admissions[ordinal];
  }

  release(ordinal: number): void {
    this.admits[ordinal]?.();
  }
}

/**
 * The real source reader, held at the second of two named documents.
 *
 * The seam is a subclass rather than a double precisely because the property under test is what
 * PostgreSQL does with two concurrent writers: `super.factsFor` runs the real query inside the
 * rebuild's real transaction, and the park merely decides *when* the rest of the batch follows.
 *
 * Which of the two is held is decided from the batch itself rather than from creation order.
 * `findableIdsAfter` orders by `id`, and the ids a document gets are not ordered by the moment it
 * was created — measured, after a first attempt that assumed they were and passed two runs in
 * three for that reason. Whichever candidate the batch reads first becomes the subject; the other
 * becomes the park. The subject's facts and ACL are therefore always captured before the park,
 * which is the whole ordering the proof needs.
 */
class ParkedSourceReader extends PrismaSearchSourceReader {
  /** The candidate the batch read first — the document the race is run against. */
  subject: DocumentId | null = null;
  private parkAt: DocumentId | null = null;
  readonly readOrder: string[] = [];
  readonly batchSizes: number[] = [];

  constructor(
    unitOfWork: PrismaUnitOfWork,
    private readonly candidates: readonly DocumentId[],
    private readonly turnstile: Turnstile<string>,
  ) {
    super(unitOfWork);
  }

  override async findableIdsAfter(cursor: DocumentId | null, limit: number) {
    const ids = await super.findableIdsAfter(cursor, limit);
    this.batchSizes.push(ids.length);
    const mine = ids.filter((id) => this.candidates.includes(id));
    if (this.subject === null && mine.length === 2) {
      this.subject = mine[0] ?? null;
      this.parkAt = mine[1] ?? null;
    }
    return ids;
  }

  override async factsFor(documentId: DocumentId) {
    const facts = await super.factsFor(documentId);
    this.readOrder.push(String(documentId));
    if (this.parkAt !== null && documentId === this.parkAt) {
      await this.turnstile.park(`facts:${documentId}`);
    }
    return facts;
  }
}

/**
 * Slice 75 — a rebuild publishes what it captured, not what is true when it writes.
 *
 * `SearchRebuildService.run` fills the build target one batch at a time, and a batch is one
 * transaction that reads **every** document's facts and *then* writes them all: with the shipped
 * `SEARCH_REBUILD_BATCH_SIZE` of 200 the first document's `acl_subjects` are resolved up to two
 * hundred documents' worth of reads before they are written. `search.index` runs at concurrency 8
 * and `PrismaUnitOfWork` opens no isolation level, so READ COMMITTED is what decides the race:
 * a projection that commits inside that window dual-writes current truth into the build target,
 * and the batch's `ON CONFLICT ("document_id") DO UPDATE` — which carries no `WHERE` guard, and
 * assigns `"source_version" = EXCLUDED."source_version"` without ever comparing it — puts the
 * captured representation back on top. `completeRebuild` then makes that the live index.
 *
 * The consequence is the one `SearchIndexConsumer` says is bounded. Its own words: "a stale
 * `acl_subjects` is a search result somebody may not see — or one they should not. The window is
 * bounded by the subtree's size and the debounce". Through this ordering it is not bounded — the
 * denial is undone by the swap and stays undone until something else happens to that document.
 * `PostgresSearchAdapter.query` decides visibility from the index's own `acl_subjects` and
 * `acl_deny_subjects` columns and re-checks nothing, so the entry is the whole decision.
 */
describe('a rebuild and a projection writing the same build target', () => {
  it('must not republish an ACL the index had already been told to withdraw', async () => {
    const first = await createDocument(
      'Turbine borescope inspection dossier',
      await realPdf(['Borescope findings, stage two.']),
      'borescope.pdf',
      'application/pdf',
    );
    const second = await createDocument(
      'Turbine borescope inspection appendix',
      await realPdf(['Appendix, stage two.']),
      'borescope-appendix.pdf',
      'application/pdf',
    );
    await project(first.documentId);
    await project(second.documentId);

    const before = await searchAs(asAlice, 'borescope inspection');
    const beforeIds = before.results.hits.map((hit) => hit.documentId);
    expect(beforeIds).toContain(first.documentId);
    expect(beforeIds).toContain(second.documentId);

    // The build target starts empty — the previous run's swap left it so, and `beginRebuild`
    // therefore takes no row locks the concurrent projection could block on.
    expect(await owner.searchIndexEntryShadow.count({ where: { tenantId: TENANT } })).toBe(0);

    const turnstile = new Turnstile<string>();
    turnstile.arm(1);
    const reader = new ParkedSourceReader(
      unitOfWork,
      [first.documentId, second.documentId],
      turnstile,
    );
    const raced = realSearchStack({
      clock,
      unitOfWork,
      // The shipped default, so the whole tenant is one batch and the ordering is the one
      // production runs — not a batch size invented to make the window appear.
      config: { ...appConfig, search: { ...appConfig.search, rebuildBatchSize: 200 } },
      registry,
      storage: library.storage,
      storagePort: library.storagePort,
      source: reader,
    });

    const requested = await asAlice(() => raced.rebuilds.request());
    expect(requested.state).toBe('RUNNING');

    const observed: { subject: DocumentId | null; denySubjects: readonly string[] | null } = {
      subject: null,
      denySubjects: null,
    };
    const withdrawAccess = (async () => {
      await turnstile.reached[0];
      const subject = reader.subject;
      if (subject === null) {
        throw new Error('The batch did not carry both candidates.');
      }
      observed.subject = subject;
      // An administrator denies exactly this document to exactly this caller, for real: the
      // resolver reads the row, and the projection materialises what the resolver says.
      await owner.aclEntry.create({
        data: {
          id: uuidv7(),
          tenantId: TENANT,
          scopeType: 'DOCUMENT',
          scopeId: subject,
          subjectType: 'USER',
          subjectId: ALICE,
          permission: 'document:view',
          effect: 'DENY',
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        },
      });
      await project(subject);
      // Read the row rather than re-running the query: this must stay well inside the
      // transaction timeout the parked batch is holding open.
      const live = await owner.searchIndexEntry.findUniqueOrThrow({
        where: { documentId: subject },
        select: { aclDenySubjects: true },
      });
      observed.denySubjects = live.aclDenySubjects;
      turnstile.release(0);
    })();

    await asSystem(() => raced.rebuilds.run(requested.id));
    await withdrawAccess;

    const subject = observed.subject;
    expect(subject).not.toBeNull();
    // One batch, and the subject was read — and its ACL resolved — before the caller was held.
    // That is the ordering the race needs, asserted rather than assumed.
    const held = subject === first.documentId ? second.documentId : first.documentId;
    expect(reader.batchSizes).toHaveLength(1);
    expect(turnstile.arrivals).toEqual([`facts:${held}`]);
    expect(reader.readOrder.indexOf(String(subject))).toBeLessThan(
      reader.readOrder.indexOf(String(held)),
    );
    // The projection did its job: the live index carried the denial before the swap.
    expect(observed.denySubjects).toEqual([`user:${ALICE}`]);

    const entry = await owner.searchIndexEntry.findUniqueOrThrow({
      where: { documentId: subject as DocumentId },
      select: { aclDenySubjects: true },
    });
    expect(entry.aclDenySubjects).toEqual([`user:${ALICE}`]);

    const after = await searchAs(asAlice, 'borescope inspection');
    expect(after.results.hits.map((hit) => hit.documentId)).not.toContain(subject);
  }, 180_000);
});

/**
 * The sibling ordering, and the reason the fix cannot be only about overwriting.
 *
 * `IndexPort.rebuildRemove` is documented as existing precisely so that "a document deleted
 * mid-rebuild cannot outlive the swap". It removes the entry from the build target — but the
 * batch that captured the document before the deletion still writes it back afterwards, and the
 * row it writes carries the ACL the document had while it was alive. The swap then publishes a
 * deleted document, with its title and its body, to everyone who could see it before.
 */
describe('a rebuild and a deletion writing the same build target', () => {
  it('must not republish a document the index had already been told to drop', async () => {
    const first = await createDocument(
      'Hydrostatic proof test certificate',
      await realPdf(['Hydrostatic proof, 1.5x design pressure.']),
      'hydrostatic.pdf',
      'application/pdf',
    );
    const second = await createDocument(
      'Hydrostatic proof test appendix',
      await realPdf(['Hydrostatic appendix.']),
      'hydrostatic-appendix.pdf',
      'application/pdf',
    );
    await project(first.documentId);
    await project(second.documentId);

    const before = await searchAs(asAlice, 'hydrostatic proof');
    expect(before.results.hits.map((hit) => hit.documentId)).toContain(first.documentId);
    expect(await owner.searchIndexEntryShadow.count({ where: { tenantId: TENANT } })).toBe(0);

    const turnstile = new Turnstile<string>();
    turnstile.arm(1);
    const reader = new ParkedSourceReader(
      unitOfWork,
      [first.documentId, second.documentId],
      turnstile,
    );
    const raced = realSearchStack({
      clock,
      unitOfWork,
      config: { ...appConfig, search: { ...appConfig.search, rebuildBatchSize: 200 } },
      registry,
      storage: library.storage,
      storagePort: library.storagePort,
      source: reader,
    });

    const requested = await asAlice(() => raced.rebuilds.request());
    const observed: { subject: DocumentId | null; liveRows: number | null } = {
      subject: null,
      liveRows: null,
    };
    const deleteIt = (async () => {
      await turnstile.reached[0];
      const subject = reader.subject;
      if (subject === null) {
        throw new Error('The batch did not carry both candidates.');
      }
      observed.subject = subject;
      try {
        // The real soft delete, then the projection the lane would run for it: `factsFor`
        // answers null for a document that stopped being findable, so this is
        // `removeEverywhere`.
        const row = await owner.document.findUniqueOrThrow({
          where: { id: subject },
          select: { version: true },
        });
        await asAlice(() => library.documents.remove(String(subject), row.version, 'Superseded.'));
        await project(subject);
        observed.liveRows = await owner.searchIndexEntry.count({
          where: { documentId: subject },
        });
      } finally {
        // Never leave the batch parked: a failure here must surface as its own assertion, not
        // as the suite's timeout.
        turnstile.release(0);
      }
    })();

    await asSystem(() => raced.rebuilds.run(requested.id));
    await deleteIt;

    const subject = observed.subject;
    expect(subject).not.toBeNull();
    // The removal reached the live index before the swap.
    expect(observed.liveRows).toBe(0);

    expect(
      await owner.searchIndexEntry.count({ where: { documentId: subject as DocumentId } }),
    ).toBe(0);
    const after = await searchAs(asAlice, 'hydrostatic proof');
    expect(after.results.hits.map((hit) => hit.documentId)).not.toContain(subject);
  }, 180_000);

  /**
   * The other way a document stops being findable, and the reason the guard names both.
   *
   * `findableIdsAfter` excludes `deleted_at IS NOT NULL` *and* `status = 'PURGED'`, and
   * `factsFor` answers null for either. A guard that checked only the first would let a purged
   * record — one whose content the retention policy destroyed on purpose — be written back into
   * the build target and published by the swap. The purge itself is Retention's; what is under
   * test here is the index adapter's guard, so the status is set as a fixture and the real
   * projection is then run over it.
   */
  it('must not republish a document whose record was purged', async () => {
    const first = await createDocument(
      'Pneumatic leak rate record',
      await realPdf(['Leak rate, category two.']),
      'pneumatic.pdf',
      'application/pdf',
    );
    const second = await createDocument(
      'Pneumatic leak rate appendix',
      await realPdf(['Pneumatic appendix.']),
      'pneumatic-appendix.pdf',
      'application/pdf',
    );
    await project(first.documentId);
    await project(second.documentId);
    expect(await owner.searchIndexEntryShadow.count({ where: { tenantId: TENANT } })).toBe(0);

    const turnstile = new Turnstile<string>();
    turnstile.arm(1);
    const reader = new ParkedSourceReader(
      unitOfWork,
      [first.documentId, second.documentId],
      turnstile,
    );
    const raced = realSearchStack({
      clock,
      unitOfWork,
      config: { ...appConfig, search: { ...appConfig.search, rebuildBatchSize: 200 } },
      registry,
      storage: library.storage,
      storagePort: library.storagePort,
      source: reader,
    });

    const requested = await asAlice(() => raced.rebuilds.request());
    const observed: { subject: DocumentId | null; liveRows: number | null } = {
      subject: null,
      liveRows: null,
    };
    const purgeIt = (async () => {
      await turnstile.reached[0];
      const subject = reader.subject;
      if (subject === null) {
        throw new Error('The batch did not carry both candidates.');
      }
      observed.subject = subject;
      try {
        await owner.document.update({
          where: { id: subject },
          data: { status: 'PURGED' },
        });
        await project(subject);
        observed.liveRows = await owner.searchIndexEntry.count({ where: { documentId: subject } });
      } finally {
        turnstile.release(0);
      }
    })();

    await asSystem(() => raced.rebuilds.run(requested.id));
    await purgeIt;

    const subject = observed.subject;
    expect(subject).not.toBeNull();
    expect(observed.liveRows).toBe(0);
    expect(
      await owner.searchIndexEntry.count({ where: { documentId: subject as DocumentId } }),
    ).toBe(0);
  }, 180_000);
});

/**
 * The reader held at the batch *after* the one that wrote a named document.
 *
 * `run()` opens one transaction per batch, so by the time the next batch asks for its ids the
 * previous batch has committed and its rows are in the build target. Parking there puts a
 * concurrent projection strictly *after* the rebuild's own write for that document — the
 * opposite ordering to the one Slice 75 closed, and the one where the projection must win.
 */
class ParkedAfterBatchReader extends PrismaSearchSourceReader {
  /** The candidate whose batch has committed by the time the park is reached. */
  subject: DocumentId | null = null;
  private parked = false;

  constructor(
    unitOfWork: PrismaUnitOfWork,
    private readonly candidate: DocumentId,
    private readonly turnstile: Turnstile<string>,
  ) {
    super(unitOfWork);
  }

  override async findableIdsAfter(cursor: DocumentId | null, limit: number) {
    const ids = await super.findableIdsAfter(cursor, limit);
    if (this.subject !== null && !this.parked) {
      this.parked = true;
      await this.turnstile.park(`after:${this.subject}`);
    }
    return ids;
  }

  override async factsFor(documentId: DocumentId) {
    const facts = await super.factsFor(documentId);
    if (this.subject === null && documentId === this.candidate) {
      this.subject = documentId;
    }
    return facts;
  }
}

/**
 * The reverse ordering: the rebuild wrote first, and the projection is the newer truth.
 *
 * `SearchProjectionService.project` and `SearchRebuildService.run` both reach the build target
 * through the *same* `IndexPort.rebuildUpsert`, and they want opposite things from it. The
 * rebuild's write must give way, because it carries facts captured earlier in its batch. The
 * projection's dual-write must win, because it re-read current truth immediately before writing
 * — it is the mechanism the rebuild's own docstring relies on for "a change that lands mid-fill
 * reaches the build target".
 *
 * A rebuild of a real tenant is many batches. Everything that changes between the batch that
 * wrote a document and the swap arrives through this path, so this is not a narrow window: it is
 * the rest of the run. The batch size is 1 here only to make the boundary exact — at the shipped
 * 200 the same ordering happens to every document whose batch has already committed.
 */
describe('a projection landing after the rebuild already wrote the document', () => {
  it('must let the newer projection reach the build target', async () => {
    const target = await createDocument(
      'Vibration analysis baseline report',
      await realPdf(['Vibration baseline, bearing housing.']),
      'vibration.pdf',
      'application/pdf',
    );
    await project(target.documentId);

    const before = await searchAs(asAlice, 'vibration analysis');
    expect(before.results.hits.map((hit) => hit.documentId)).toContain(target.documentId);
    expect(await owner.searchIndexEntryShadow.count({ where: { tenantId: TENANT } })).toBe(0);

    const turnstile = new Turnstile<string>();
    turnstile.arm(1);
    const reader = new ParkedAfterBatchReader(unitOfWork, target.documentId, turnstile);
    const raced = realSearchStack({
      clock,
      unitOfWork,
      config: { ...appConfig, search: { ...appConfig.search, rebuildBatchSize: 1 } },
      registry,
      storage: library.storage,
      storagePort: library.storagePort,
      source: reader,
    });

    const requested = await asAlice(() => raced.rebuilds.request());
    const observed: { shadowBefore: number | null; denyInShadow: readonly string[] | null } = {
      shadowBefore: null,
      denyInShadow: null,
    };
    const withdrawAccess = (async () => {
      await turnstile.reached[0];
      try {
        // The rebuild's own row for this document is already in the build target.
        observed.shadowBefore = await owner.searchIndexEntryShadow.count({
          where: { documentId: target.documentId },
        });
        await owner.aclEntry.create({
          data: {
            id: uuidv7(),
            tenantId: TENANT,
            scopeType: 'DOCUMENT',
            scopeId: target.documentId,
            subjectType: 'USER',
            subjectId: ALICE,
            permission: 'document:view',
            effect: 'DENY',
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
          },
        });
        await project(target.documentId);
        const row = await owner.searchIndexEntryShadow.findUnique({
          where: { documentId: target.documentId },
          select: { aclDenySubjects: true },
        });
        observed.denyInShadow = row?.aclDenySubjects ?? null;
      } finally {
        turnstile.release(0);
      }
    })();

    await asSystem(() => raced.rebuilds.run(requested.id));
    await withdrawAccess;

    expect(turnstile.arrivals).toEqual([`after:${target.documentId}`]);
    // The ordering the proof needs: the rebuild had already written this document.
    expect(observed.shadowBefore).toBe(1);
    // The projection's dual-write must have reached the build target.
    expect(observed.denyInShadow).toEqual([`user:${ALICE}`]);

    const entry = await owner.searchIndexEntry.findUniqueOrThrow({
      where: { documentId: target.documentId },
      select: { aclDenySubjects: true },
    });
    expect(entry.aclDenySubjects).toEqual([`user:${ALICE}`]);

    const after = await searchAs(asAlice, 'vibration analysis');
    expect(after.results.hits.map((hit) => hit.documentId)).not.toContain(target.documentId);
  }, 180_000);
});
