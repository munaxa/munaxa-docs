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
  RevisionLabelStyle,
  ScanStatus,
  Settings,
  type DocumentId,
  type TenantId,
  type UploadSessionId,
  type UserId,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { ReadAuditBuffer } from '../../../core/audit/read-audit.port';
import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { RecordStamps } from '../../../core/persistence';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { decodeTransferToken } from '../../../testing/transfer-token';
import {
  type DocumentLibraryStack,
  type PreviewStack,
  type RetentionStack,
  realAuditWriter,
  realDisposition,
  realDocumentLibrary,
  realDocumentPreview,
  realPreviewStack,
  realReadAuditBuffer,
  realRetention,
} from '../../../testing/real-collaborators';

import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import { seedRoleGrant } from '../../../testing/acl-seed';
import type { DocumentPreviewService } from '../../document/application/document-preview.service';
import { decodePreviewToken } from '../domain/preview-stream-token';
import { encodePng } from '../domain/png';
import { ThumbnailService } from '../application/thumbnail.service';

/**
 * The preview pipeline against a real PostgreSQL and a real filesystem store — the assertions
 * only a database can be trusted about:
 *
 * - **Antivirus first**: a render against a blob whose verdict is not `CLEAN` is refused,
 *   recorded as failed, and produces no artefact rows.
 * - **Idempotency under redelivery**: the outbox is at-least-once; a redelivered render writes
 *   nothing twice, and `uq_preview_artifact` — `NULLS NOT DISTINCT` since this phase — refuses
 *   the duplicate page-less row even for a raw write that bypasses every use case.
 * - **The serving order**: permission is the route's; state and confidentiality are asserted
 *   here — a level that forbids download still previews (that is 14 §1's whole point), a level
 *   that forbids print refuses it, and a watermark level issues stream tokens whose mark names
 *   the viewer.
 * - **Derived artefacts are derived**: `derived = true`, under the `derived/` prefix, reference-
 *   counted so nothing sweeps them while an artefact row points at them, and purged with their
 *   revision by the cascade.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const FIXED_NOW = new Date('2026-08-21T09:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };
/** A day later, for the one collaborator that has to run after the blob grace period. */
const A_DAY_LATER = new Date(FIXED_NOW.getTime() + 24 * 60 * 60 * 1_000);
const sweepClock = { now: () => new Date(A_DAY_LATER), timestamp: () => 0, elapsedMs: () => 0 };
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
const ALICE = asId<UserId>(uuidv7());
const SIGNING_SECRET = 'an-integration-suite-secret-of-at-least-32';

let root: string;
let transfer: Server;
let appConfig: AppConfig;
let library: DocumentLibraryStack;
let preview: PreviewStack;
let sweep: RetentionStack;
/** The unit of work, hoisted so a suite can compose a second stack against the same database. */
let unitOfWork: PrismaUnitOfWork;
let access: DocumentPreviewService;
/** The buffer a served view lands in, held so this suite can decide when the batch is written. */
let readAudit: ReadAuditBuffer;
let owner: PrismaClient;

let rootFolderId: string;
let documentTypeId: string;
let openTypeId: string;
let secretConfidentialityId: string;

function contextFor(userId: UserId): RequestContext {
  return {
    tenantId: TENANT,
    userId,
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: 'preview-pipeline',
    permissionVersion: 1,
    locale: 'en',
  };
}

function as<T>(work: () => Promise<T>, userId: UserId = ALICE): Promise<T> {
  return runWithContext(contextFor(userId), work);
}

let thumbnails: ThumbnailService | null = null;
function thumbnailer(): ThumbnailService {
  thumbnails ??= new ThumbnailService(library.storage, logger, new RecordStamps(clock));
  return thumbnails;
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
  const target = await as(() =>
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
  const completed = await as(() =>
    library.storage.completeUploadSession(asId<UploadSessionId>(target.uploadSessionId), []),
  );
  return completed.fileObjectId;
}

async function markClean(fileObjectId: string): Promise<void> {
  await owner.fileObject.update({
    where: { id: fileObjectId },
    data: { scanStatus: ScanStatus.CLEAN, scanner: 'integration-suite', scannedAt: FIXED_NOW },
  });
}

async function createDocument(
  content: Buffer,
  filename: string,
  mimeType: string,
  overrides: { confidentialityId?: string; documentTypeId?: string } = {},
): Promise<{ documentId: string; revisionId: string; fileObjectId: string }> {
  const fileObjectId = await upload(content, filename, mimeType);
  await markClean(fileObjectId);
  const created = await as(() =>
    library.documents.create({
      folderId: rootFolderId,
      documentTypeId: overrides.documentTypeId ?? documentTypeId,
      title: unique('Controlled '),
      fileObjectId,
      filename,
      origin: 'UPLOAD',
      acknowledgeDuplicate: false,
      ...(overrides.confidentialityId !== undefined && {
        confidentialityId: overrides.confidentialityId,
      }),
    }),
  );
  const revision = await owner.documentRevision.findFirstOrThrow({
    where: { documentId: created.id, ordinal: 0 },
  });
  return { documentId: created.id, revisionId: revision.id, fileObjectId };
}

function render(revisionId: string, fileObjectId: string): Promise<void> {
  return as(() => preview.render.ensureRendered({ revisionId, fileObjectId }));
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  root = await mkdtemp(join(tmpdir(), 'munaxa-preview-'));

  // The pipeline fetches its source through the presigned URL a browser would use — the whole
  // point of 14 §5's least-privilege row — so the suite serves the `LOCAL` driver's transfer
  // endpoint for real: token checked, bytes off the same disk the adapter wrote.
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
      ocr: 'TESSERACT',
      mail: 'NONE',
      antivirus: 'NONE',
      office: 'NONE',
    },
    ocr: { tesseractPath: 'tesseract', languages: 'ara+eng' },
    office: { libreofficePath: 'soffice' },
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
    registry: everyTenantRegistry(APP_URL),
    storageRoot: root,
    signingSecret: SIGNING_SECRET,
    antivirus: {
      scanner: 'unconfigured',
      scan: () => Promise.reject(new Error('AV_DRIVER is NONE')),
    },
    users,
    /*
     * The real upload-time thumbnailer — Slice 103.
     *
     * Every other suite takes the double, which draws nothing, and that is why what the
     * thumbnailer does to `file_object.ref_count` had never been asked. This one uploads a real
     * PNG, so it asks the real implementation.
     */
    thumbnailer: {
      // Built lazily because it needs the storage service this very call is constructing. One
      // instance, made on the first document and reused, which is what the container does too.
      generate: (revisionId, fileObjectId, mimeType) =>
        thumbnailer().generate(revisionId, fileObjectId, mimeType),
    },
  });
  preview = realPreviewStack({
    clock,
    unitOfWork,
    storage: library.storage,
    storagePort: library.storagePort,
    config: appConfig,
    ocr: {
      // The engine is a subprocess this suite does not require installed; what is under test is
      // that its answer lands in `ocr_result`, the artefact and the outbox — the same reason the
      // antivirus above is a refusing double.
      engine: 'suite-engine',
      supports: (mimeType: string) =>
        mimeType.startsWith('image/') || mimeType === 'application/pdf',
      extract: () =>
        Promise.resolve({
          text: 'words read off the pixels',
          language: 'ara+eng',
          confidence: 0.55,
          engine: 'suite-engine',
          engineVersion: '9.9.9',
        }),
    },
  });
  /*
   * The blob reaper, on a clock a day past everything this suite writes — Slice 103.
   *
   * `reclaimBlobs` selects `ref_count = 0` and `updated_at` older than the grace period, so a
   * sweep on the suite's own instant would select nothing whatever the counts said. A grace of
   * zero days and a clock a day ahead is the grace period having passed, stated as data rather
   * than as a sleep.
   */
  sweep = realRetention({
    clock: sweepClock,
    unitOfWork,
    storage: library.storagePort,
    storageService: library.storage,
    disposition: realDisposition(sweepClock, library.storage, library.writer),
    settings: { [Settings.RETENTION_BLOB_GRACE_DAYS.key]: 0 },
  });
  readAudit = realReadAuditBuffer(clock, unitOfWork, realAuditWriter(clock, unitOfWork));
  access = realDocumentPreview({
    clock,
    unitOfWork,
    readAudit,
    storage: library.storage,
    storagePort: library.storagePort,
    config: appConfig,
    configuration: library.configuration,
    users,
    directory: {
      contactFor: () =>
        Promise.resolve({ userId: ALICE, email: 'alice@example.test', displayName: 'Test User' }),
      contactsFor: () => Promise.resolve([]),
    } as never,
  });

  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `prev-${String(Date.now())}-${TENANT.slice(0, 8)}`,
      name: 'Preview Pipeline Test',
      status: 'ACTIVE',
    },
  });
  await owner.user.create({
    data: {
      id: ALICE,
      tenantId: TENANT,
      email: `${ALICE}@example.test`,
      emailNormalized: `${ALICE}@example.test`,
      displayName: 'Test User',
      status: 'ACTIVE',
      updatedAt: FIXED_NOW,
    },
  });

  // Slice 123: the role the context claims, seeded so the resolver can find it. Document creation
  // now resolves `document:create` on the destination folder — the decision `AclGuard` cannot make
  // for a folder that arrives in the body — and until it did, the role key in the context named no
  // row and was never resolved. `acl-seed.ts` states the rule this follows: "the honest response is
  // to seed the grant rather than to keep the resolver from asking".
  await seedRoleGrant(owner, {
    tenantId: TENANT,
    roleId: uuidv7(),
    key: 'TENANT_ADMIN',
    userIds: [ALICE],
    now: FIXED_NOW,
  });

  const lib = await as(() =>
    library.libraries.createLibrary({
      code: unique('LIB'),
      name: 'Quality',
      ownerScopeType: 'TENANT',
    }),
  );
  rootFolderId = lib.rootFolderId;

  const internal = await as(() =>
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
  const secret = await as(() =>
    library.configuration.createConfidentiality({
      code: unique('C'),
      name: 'Secret',
      rank: 90,
      allowDownload: false,
      allowPrint: false,
      watermark: true,
      requireReason: false,
    }),
  );
  secretConfidentialityId = secret.id;

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
  const type = await as(() =>
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
  openTypeId = type.id;
}, 120_000);

afterAll(async () => {
  await owner.$disconnect();
  await new Promise<void>((resolve) => transfer.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

describe('rendering a PDF', () => {
  let revisionId: string;
  let fileObjectId: string;

  beforeAll(async () => {
    const created = await createDocument(
      await realPdf(['Quality manual, first page.', 'Second page of the manual.']),
      'manual.pdf',
      'application/pdf',
    );
    revisionId = created.revisionId;
    fileObjectId = created.fileObjectId;
    await render(revisionId, fileObjectId);
  }, 60_000);

  it('settles READY with the page count and the renderer recorded', async () => {
    const row = await owner.previewRender.findUniqueOrThrow({ where: { revisionId } });
    expect(row.state).toBe('READY');
    expect(row.pageCount).toBe(2);
    expect(row.renderer).toBe('munaxa-pdf');
    expect(row.reason).toBeNull();
  });

  it('references the source as its own rendition and stores the text per page as derived blobs', async () => {
    const artifacts = await owner.previewArtifact.findMany({
      where: { revisionId },
      include: { fileObject: true },
      orderBy: [{ kind: 'asc' }, { page: 'asc' }],
    });
    const rendition = artifacts.find((row) => row.kind === 'PDF');
    expect(rendition?.fileObjectId).toBe(fileObjectId);

    const text = artifacts.filter((row) => row.kind === 'TEXT');
    expect(text.map((row) => row.page)).toEqual([1, 2]);
    for (const row of text) {
      // 11 §7 in rows: disposable, derived, under their own prefix — the properties that make
      // "purge with the source" and "exclude from quota" prefix- and flag-questions later.
      expect(row.fileObject.derived).toBe(true);
      expect(row.fileObject.storageKey.startsWith('derived/')).toBe(true);
      expect(row.fileObject.refCount).toBeGreaterThanOrEqual(1);
    }

    const source = await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
    // One reference from the revision, one from the rendition artefact row.
    expect(source.refCount).toBe(2);
  });

  it('publishes preview.rendered through the outbox, transactionally with the rows', async () => {
    const events = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, eventType: 'preview.rendered', aggregateId: revisionId },
    });
    expect(events).toHaveLength(1);
  });

  it('did not queue OCR: the text layer was usable', () => {
    expect(preview.enqueuedOcrJobs.filter((job) => job.jobId === `ocr:${revisionId}`)).toHaveLength(
      0,
    );
  });

  it('writes nothing twice under redelivery, even when forced past the READY short-circuit', async () => {
    const before = await owner.previewArtifact.count({ where: { revisionId } });
    const refBefore = (await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } }))
      .refCount;

    await render(revisionId, fileObjectId);
    // And once more with the short-circuit disarmed, which is the redelivery-races-first case.
    await owner.previewRender.update({ where: { revisionId }, data: { state: 'PENDING' } });
    await render(revisionId, fileObjectId);

    expect(await owner.previewArtifact.count({ where: { revisionId } })).toBe(before);
    expect(
      (await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } })).refCount,
    ).toBe(refBefore);
    expect((await owner.previewRender.findUniqueOrThrow({ where: { revisionId } })).state).toBe(
      'READY',
    );
  });

  it('the database itself refuses a second page-less artefact of one kind', async () => {
    const rendition = await owner.previewArtifact.findFirstOrThrow({
      where: { revisionId, kind: 'PDF', page: null },
    });
    await expect(
      owner.previewArtifact.create({
        data: {
          id: uuidv7(),
          tenantId: TENANT,
          revisionId,
          kind: 'PDF',
          page: null,
          fileObjectId: rendition.fileObjectId,
          renderer: 'raw-write',
          rendererVersion: '0',
          updatedAt: FIXED_NOW,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('the antivirus gate', () => {
  it('refuses to render before the verdict is CLEAN, visibly and terminally', async () => {
    const clean = await createDocument(await realPdf(['Gated.']), 'gated.pdf', 'application/pdf');
    // A blob whose verdict never arrived — `SKIPPED`, exactly what AV_DRIVER=NONE records.
    const unclean = await upload(
      await realPdf(['Never scanned.']),
      'unscanned.pdf',
      'application/pdf',
    );

    await render(clean.revisionId, unclean);

    const row = await owner.previewRender.findUniqueOrThrow({
      where: { revisionId: clean.revisionId },
    });
    expect(row.state).toBe('FAILED');
    expect(row.reason).toContain('not clean');
    expect(await owner.previewArtifact.count({ where: { revisionId: clean.revisionId } })).toBe(0);
    const failures = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, eventType: 'preview.failed', aggregateId: clean.revisionId },
    });
    expect(failures.length).toBeGreaterThanOrEqual(1);
  });
});

describe('an unsupported format', () => {
  it('is a terminal, honest answer — no renderer, no artefacts, the reason recorded', async () => {
    const dwg = Buffer.concat([Buffer.from('AC1032', 'ascii'), Buffer.alloc(64, 0x20)]);
    const created = await createDocument(dwg, 'plan.dwg', 'image/vnd.dwg', {
      documentTypeId: openTypeId,
    });
    await render(created.revisionId, created.fileObjectId);

    const row = await owner.previewRender.findUniqueOrThrow({
      where: { revisionId: created.revisionId },
    });
    expect(row.state).toBe('UNSUPPORTED');
    expect(row.reason).toContain('image/vnd.dwg');
    expect(await owner.previewArtifact.count({ where: { revisionId: created.revisionId } })).toBe(
      0,
    );
  });
});

describe('OCR, the slow lane', () => {
  let revisionId: string;
  let fileObjectId: string;

  beforeAll(async () => {
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    const created = await createDocument(
      Buffer.from(await document.save()),
      'scan.pdf',
      'application/pdf',
    );
    revisionId = created.revisionId;
    fileObjectId = created.fileObjectId;
    await render(revisionId, fileObjectId);
  }, 60_000);

  it('queues OCR only when text extraction yielded nothing usable', () => {
    const jobs = preview.enqueuedOcrJobs.filter((job) => job.jobId === `ocr:${revisionId}`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.queue).toBe('documents.ocr');
  });

  it('records the engine, version, language and confidence, and stores the text as an OCR artefact', async () => {
    await as(() => preview.ocr.extractText({ revisionId, fileObjectId }));

    const result = await owner.ocrResult.findUniqueOrThrow({ where: { revisionId } });
    expect(result.engine).toBe('suite-engine');
    expect(result.engineVersion).toBe('9.9.9');
    expect(result.language).toBe('ara+eng');
    expect(result.confidence).toBe(55);
    expect(result.characterCount).toBeGreaterThan(0);

    const artifact = await owner.previewArtifact.findFirstOrThrow({
      where: { revisionId, kind: 'OCR' },
      include: { fileObject: true },
    });
    expect(artifact.fileObject.derived).toBe(true);

    const events = await owner.outboxMessage.findMany({
      where: { tenantId: TENANT, eventType: 'preview.ocr-completed', aggregateId: revisionId },
    });
    expect(events).toHaveLength(1);
  });

  it('does nothing twice: a redelivered OCR job finds the result and stops', async () => {
    const before = await owner.previewArtifact.count({ where: { revisionId } });
    await as(() => preview.ocr.extractText({ revisionId, fileObjectId }));
    expect(await owner.previewArtifact.count({ where: { revisionId } })).toBe(before);
  });

  it('serves the OCR text flagged as the inference it is', async () => {
    const pages = await as(() => preview.queries.textPages(asId(revisionId)));
    expect(pages?.source).toBe('OCR');
    expect(pages?.lowConfidence).toBe(true);
    expect(pages?.pages[0]?.text).toContain('words read off the pixels');
  });
});

describe('serving: permission → state → confidentiality', () => {
  let documentId: string;
  let revisionId: string;

  beforeAll(async () => {
    const created = await createDocument(
      await realPdf(['Restricted content.']),
      'secret.pdf',
      'application/pdf',
      { confidentialityId: secretConfidentialityId },
    );
    documentId = created.documentId;
    revisionId = created.revisionId;
    await render(created.revisionId, created.fileObjectId);
  }, 60_000);

  it('previews under a level that forbids download — readable, not downloadable, watermarked', async () => {
    const manifest = await as(() => access.manifest(documentId));
    expect(manifest.state).toBe('READY');
    expect(manifest.confidentiality).toEqual({
      downloadAllowed: false,
      printAllowed: false,
      watermark: true,
    });

    const content = await as(() => access.viewContent(documentId));
    expect(content.state).toBe('READY');
    expect(content.url).toContain('/preview/stream?token=');
    const token = new URL(content.url ?? '').searchParams.get('token') ?? '';
    const decoded = decodePreviewToken(SIGNING_SECRET, token, FIXED_NOW);
    if (!('grant' in decoded)) {
      throw new Error('The issued token did not decode.');
    }
    // The mark names the viewer and the controlled identity — 14 §4's parameters, in the
    // credential itself, where no client can peel them off the bytes.
    expect(decoded.grant.watermark?.viewer).toBe('Test User');
    expect(decoded.grant.tenantId).toBe(TENANT);
  });

  it('audits the served view through DOCUMENT_VIEWED, above the read-audit rank', async () => {
    // Buffered since Phase 9 (13 §5): a view must not cost a transaction, and must not cost the
    // tenant's audit advisory lock, per page turn. Still written, still hash-chained — the flush
    // is when, not whether.
    await readAudit.flush();

    const events = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, action: 'DOCUMENT_VIEWED', subjectId: documentId },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses print when the level forbids it, whatever permission the caller holds', async () => {
    await expect(as(() => access.printContent(documentId))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      await owner.auditEvent.count({
        where: { tenantId: TENANT, action: 'DOCUMENT_PRINTED', subjectId: documentId },
      }),
    ).toBe(0);
  });

  it('prints through the preview path where the level allows, audited as PRINTED', async () => {
    const open = await createDocument(
      await realPdf(['Printable content.']),
      'printable.pdf',
      'application/pdf',
    );
    await render(open.revisionId, open.fileObjectId);

    const printed = await as(() => access.printContent(open.documentId));
    expect(printed.state).toBe('READY');
    expect(printed.url).toContain('/preview/stream?token=');

    const events = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, action: 'DOCUMENT_PRINTED', subjectId: open.documentId },
    });
    expect(events).toHaveLength(1);
  });

  it('refuses a revision addressed through another document, as nonexistence', async () => {
    const other = await createDocument(await realPdf(['Other.']), 'other.pdf', 'application/pdf');
    await expect(
      as(() => access.revisionManifest(other.documentId, revisionId)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the compare API consuming the artefacts', () => {
  it('answers AVAILABLE from rendered text, and PENDING while a side still renders', async () => {
    const { realRevisionControl } = await import('../../../testing/real-collaborators');
    const prisma = sharedDatabase(appConfig, logger, APP_URL);
    const revisionStack = realRevisionControl({
      clock,
      unitOfWork: new PrismaUnitOfWork(prisma),
      documents: library.documents,
      configuration: library.configuration,
      storage: library.storage,
      storagePort: library.storagePort,
      config: appConfig,
      users: { get: (id: string) => Promise.resolve({ id } as never) },
    });

    const rendered = await createDocument(
      await realPdf(['Comparable words.']),
      'compare.pdf',
      'application/pdf',
    );
    await render(rendered.revisionId, rendered.fileObjectId);
    const available = await as(() =>
      revisionStack.revisionQueries.compare(rendered.documentId, 0, 0),
    );
    expect(available.text.state).toBe('AVAILABLE');
    expect(available.text.comparison?.identical).toBe(true);
    expect(available.pages.comparable).toBe(true);

    const unrendered = await createDocument(
      await realPdf(['Not yet rendered.']),
      'pending.pdf',
      'application/pdf',
    );
    const pending = await as(() =>
      revisionStack.revisionQueries.compare(unrendered.documentId, 0, 0),
    );
    // No render row yet: the comparison is queued and says so — 10 §4's promise, honoured.
    expect(pending.text.state).toBe('PENDING');
  });
});

/**
 * Two workers on one revision — Slice 92.
 *
 * The lane's own consumer says a restore fires `revision.created` *and* `revision.restored` for
 * the same revision, so two jobs for one revision is routine rather than exotic; `documents.preview`
 * runs at concurrency four and declares no per-tenant cap. `claim` is an upsert that counts the
 * attempt without moving the state, so the READY short-circuit only refuses a render that has
 * already *finished* — two passes that meet while the first is still rendering both go on, which
 * is the interleaving here. The window between them is the whole render, seconds wide.
 *
 * Everything the design set out to protect survives that: the artefact rows converge through
 * `uq_preview_artifact`, the derived blobs converge because `storeDerived` is content-addressed,
 * and the reference counts follow what the rows actually did. The announcement does not.
 * `settle` writes unconditionally and the publish beside it is unguarded, so both passes announce
 * a render that happened once — and `preview.*` routes to the search index and to every subscribed
 * webhook endpoint. Two rows carry two event ids, so a subscriber deduplicating on the id cannot
 * collapse them; this is the duplicate the sibling lifecycle paths guard against in as many words
 * ("an event announcing it would tell the search index and every webhook subscriber that something
 * happened when nothing did").
 */
describe('two preview workers meeting on one revision', () => {
  it('announces the render once, and leaves one artefact set behind', async () => {
    const created = await createDocument(
      await realPdf(['Concurrent render, page one.', 'And page two.']),
      'concurrent.pdf',
      'application/pdf',
    );
    const { revisionId, fileObjectId } = created;

    /*
     * The seam: the real storage service, wrapped for one caller, holding its first source fetch.
     *
     * The park is on `createDownloadUrl` rather than on anything inside the persistence
     * transaction, and that placement is the whole of what makes this test about production.
     * `ensureRendered` reads and claims in one transaction, renders with no transaction open, then
     * opens a second to persist. Parking inside the second holds a transaction past Prisma's
     * five-second interactive budget and the worker dies of the seam rather than of the race —
     * which is what the first attempt at this test measured. Parking in the gap holds nothing.
     */
    let reached: () => void = () => undefined;
    const atSource = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let admit: () => void = () => undefined;
    const parked = new Promise<void>((resolve) => {
      admit = resolve;
    });
    let parkedOnce = false;
    const held = new Proxy(library.storage, {
      get(target, property, receiver) {
        if (property === 'createDownloadUrl') {
          return async (...args: readonly unknown[]) => {
            if (!parkedOnce) {
              parkedOnce = true;
              reached();
              await parked;
            }
            return (target.createDownloadUrl as (...rest: readonly unknown[]) => Promise<unknown>)(
              ...args,
            );
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...rest: readonly unknown[]) => unknown).bind(target)
          : value;
      },
    });

    const stalling = realPreviewStack({
      clock,
      unitOfWork,
      storage: held,
      storagePort: library.storagePort,
      config: appConfig,
    });

    const first = as(() => stalling.render.ensureRendered({ revisionId, fileObjectId }));
    await atSource;

    // Asserted rather than assumed: the first pass holds a claim and has settled nothing, so the
    // second passes the same READY check rather than short-circuiting on it.
    const parkedState = await owner.previewRender.findUniqueOrThrow({ where: { revisionId } });
    expect(parkedState.state).toBe('PENDING');

    await as(() => preview.render.ensureRendered({ revisionId, fileObjectId }));
    admit();
    await first;

    // One render, one announcement. A second reaches every webhook subscribed to `preview.*`
    // carrying its own event id, which is the duplicate no subscriber can deduplicate away.
    expect(
      await owner.outboxMessage.count({
        where: { tenantId: TENANT, eventType: 'preview.rendered', aggregateId: revisionId },
      }),
    ).toBe(1);

    // And the halves that already held, asserted so a change that fixes the announcement by
    // breaking the artefacts fails here: one artefact per kind and page, one blob each, and the
    // reference counts unchanged by the second pass.
    const artifacts = await owner.previewArtifact.findMany({
      where: { revisionId },
      select: { fileObjectId: true },
    });
    expect(artifacts).toHaveLength(3);
    expect(new Set(artifacts.map((row) => row.fileObjectId)).size).toBe(3);
    expect(
      (await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } })).refCount,
    ).toBe(2);
    expect((await owner.previewRender.findUniqueOrThrow({ where: { revisionId } })).state).toBe(
      'READY',
    );
  }, 120_000);
});

/**
 * Two OCR workers meeting on one revision — Slice 93.
 *
 * `extractText` guards on `results.findForRevision`, which is a read in a transaction that commits
 * before any work is done, so it refuses only an extraction that has already *finished*. The
 * engine then runs with no transaction open, and the window between the guard and the persistence
 * transaction is the whole OCR run — the slow lane's, deliberately the longest in the product.
 * `documents.ocr` runs at concurrency two and declares no per-tenant cap.
 *
 * The result row, the artefact and the blob all converge on their own: `uq_ocr_result_revision`
 * makes the upsert idempotent, `uq_preview_artifact` keys the artefact, and `storeDerived` is
 * content-addressed. The announcement does not — `results.save` returns `void`, so the caller
 * cannot tell the pass that created the result from the pass that merely overwrote it, and the
 * publish beside it is unguarded.
 */
describe('two OCR workers meeting on one revision', () => {
  it('announces the completion once, and leaves one result, artefact and blob behind', async () => {
    // A page size no other fixture uses. `scan.pdf` in the block above is a blank 200x200 page,
    // and pdf-lib's output for two blank pages of the same size is byte-identical whenever both
    // are produced inside the same second — at which point the product refuses the second as a
    // duplicate of the first's content, which is the library working correctly and this test
    // borrowing a sibling's fixture. The dimensions are the whole of what makes it its own.
    const document = await PDFDocument.create();
    document.addPage([241, 179]);
    const created = await createDocument(
      Buffer.from(await document.save()),
      'concurrent-scan.pdf',
      'application/pdf',
    );
    const { revisionId, fileObjectId } = created;

    /*
     * The seam: the real storage service, wrapped for one caller, holding its first source fetch.
     *
     * `createDownloadUrl` is reached from `fetchSource`, which sits between the guard transaction
     * and the persistence transaction — so the park holds no transaction open. Parking inside the
     * persistence transaction instead would hold one past Prisma's five-second interactive budget
     * and the worker would die of the seam rather than of the race, which is the trap Slice 92
     * fell into and measured.
     */
    let reached: () => void = () => undefined;
    const atSource = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let admit: () => void = () => undefined;
    const parked = new Promise<void>((resolve) => {
      admit = resolve;
    });
    let parkedOnce = false;
    const held = new Proxy(library.storage, {
      get(target, property, receiver) {
        if (property === 'createDownloadUrl') {
          return async (...args: readonly unknown[]) => {
            if (!parkedOnce) {
              parkedOnce = true;
              reached();
              await parked;
            }
            return (target.createDownloadUrl as (...rest: readonly unknown[]) => Promise<unknown>)(
              ...args,
            );
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...rest: readonly unknown[]) => unknown).bind(target)
          : value;
      },
    });

    const stalling = realPreviewStack({
      clock,
      unitOfWork,
      storage: held,
      storagePort: library.storagePort,
      config: appConfig,
      ocr: {
        engine: 'suite-engine',
        supports: (mimeType: string) =>
          mimeType.startsWith('image/') || mimeType === 'application/pdf',
        extract: () =>
          Promise.resolve({
            text: 'words read off the pixels',
            language: 'ara+eng',
            confidence: 0.55,
            engine: 'suite-engine',
            engineVersion: '9.9.9',
          }),
      },
    });

    const first = as(() => stalling.ocr.extractText({ revisionId, fileObjectId }));
    await atSource;

    // Asserted rather than assumed: the first pass has written nothing, so the second passes the
    // same `findForRevision` guard rather than short-circuiting on it.
    expect(await owner.ocrResult.count({ where: { revisionId } })).toBe(0);

    await as(() => preview.ocr.extractText({ revisionId, fileObjectId }));

    // The state the second pass left, read before the first is let go. Its blob is what the first
    // pass must not reference again — and read as a *delta*, because `storeDerived` is content
    // addressed across the tenant: another suite storing the same words shares this very row, so
    // its absolute count is a fact about the file rather than about this test.
    const settledArtifact = await owner.previewArtifact.findFirstOrThrow({
      where: { revisionId, kind: 'OCR' },
      select: { fileObjectId: true },
    });
    const refBefore = (
      await owner.fileObject.findUniqueOrThrow({ where: { id: settledArtifact.fileObjectId } })
    ).refCount;

    admit();
    await first;

    // One completion, one announcement. A second reaches the search index and every webhook
    // subscribed to `preview.*` carrying its own event id, which no subscriber can deduplicate.
    expect(
      await owner.outboxMessage.count({
        where: { tenantId: TENANT, eventType: 'preview.ocr-completed', aggregateId: revisionId },
      }),
    ).toBe(1);

    // And the convergence that already held, asserted so a change that fixes the announcement by
    // breaking the result, the artefact or the blob fails here.
    expect(await owner.ocrResult.count({ where: { revisionId } })).toBe(1);
    const artifacts = await owner.previewArtifact.findMany({
      where: { revisionId, kind: 'OCR' },
      select: { fileObjectId: true },
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.fileObjectId).toBe(settledArtifact.fileObjectId);
    // The losing pass took no second reference: its `save` answered UNCHANGED, so the blob is held
    // once for the one artefact that points at it.
    expect(
      (await owner.fileObject.findUniqueOrThrow({ where: { id: settledArtifact.fileObjectId } }))
        .refCount,
    ).toBe(refBefore);
  }, 120_000);
});

/**
 * The upload-time thumbnail's own reference — Slice 103.
 *
 * `ThumbnailService` is the one path in this product that writes a `preview_artifact` row without
 * going through `PreviewArtifactRepository.save`, and it was the one that took no reference.
 * `storeDerived` inserts the `file_object` at a count of zero and leaves the reference to whoever
 * points at it; the render and OCR lanes take theirs — "reference counting follows what the row
 * actually did" — and the thumbnailer did not.
 *
 * Two ordinary things go wrong, and the test asserts both because they are two consequences of one
 * missing statement. `retention.reclaim-blobs` selects `ref_count = 0` past the grace period and
 * does not exempt a derived blob, so it destroys the thumbnail of a live revision. And the
 * disposition is worse: `RetentionDispositionAdapter.purge` gives a reference back for *every*
 * preview artefact it finds, so one that never took a reference drives the count to -1,
 * `ck_file_object_ref_count` refuses the statement, and the purge fails — permanently, for any
 * document that has an upload-time thumbnail.
 *
 * Nothing here is concurrent. The defect is arithmetic in a single transaction, and a proof that
 * manufactured a race would be proving the wrong thing.
 */
describe('the upload-time thumbnail and the blob reaper', () => {
  it('holds a reference, survives the sweep, and lets the document be purged', async () => {
    // Large enough that the thumbnail is genuinely downscaled: a source at or under the maximum
    // edge would be copied through unchanged, and content addressing would then hand the artefact
    // the *revision's* blob rather than one of its own — a different arrangement from the one this
    // test is about.
    const created = await createDocument(bluePng(640, 480), 'diagram.png', 'image/png');

    const artifact = await owner.previewArtifact.findFirstOrThrow({
      where: { tenantId: TENANT, revisionId: created.revisionId, kind: 'THUMBNAIL' },
      select: { fileObjectId: true },
    });

    /*
     * The invariant: one reference per live pointer at the blob.
     *
     * Stated as the pointer count rather than as `1`, because `storeDerived` is content addressed
     * — two revisions whose thumbnails came out byte-identical share a `file_object` and each owes
     * it a reference. This is the assertion that fails before the fix, at zero.
     */
    expect(await referencesOn(artifact.fileObjectId)).toBe(await pointersAt(artifact.fileObjectId));

    // The nightly sweep, through the real reaper, with the grace period past.
    await as(() => sweep.retention.reclaimBlobs(200));
    const afterSweep = await owner.fileObject.findUniqueOrThrow({
      where: { id: artifact.fileObjectId },
    });
    expect(afterSweep.deletedAt, 'the reaper must not take a live revision’s thumbnail').toBeNull();

    /*
     * And the disposition, which is the sharper half: `purge` dereferences every preview artefact
     * it finds. An artefact holding no reference takes the count below zero and the check
     * constraint refuses it, so the destruction a retention policy exists to perform can never
     * complete. Driven through the real adapter, in a real transaction.
     */
    const disposition = realDisposition(clock, library.storage, library.writer);
    const outcome = await as(() =>
      unitOfWork.run(() => disposition.purge(asId<DocumentId>(created.documentId))),
    );
    expect(outcome.blobsDereferenced, 'the revision’s blob and its thumbnail').toBeGreaterThan(0);

    // The document is gone, and so is every reference it held: both blobs sit at zero, which is
    // what makes them the reaper's rather than stranded.
    expect(await referencesOn(artifact.fileObjectId)).toBe(0);
    expect(await referencesOn(created.fileObjectId)).toBe(0);
  }, 120_000);
});

/** A small, non-interlaced, 8-bit RGBA PNG — what the product's own decoder accepts. */
function bluePng(width: number, height: number): Buffer {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = 20;
    pixels[index * 4 + 1] = 90;
    pixels[index * 4 + 2] = 200 - (index % 40);
    pixels[index * 4 + 3] = 255;
  }
  return encodePng({ width, height, pixels });
}

async function referencesOn(fileObjectId: string): Promise<number> {
  const row = await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
  return row.refCount;
}

/**
 * Live pointers at a blob, counted the way the purge adapter counts them: every preview artefact,
 * and every revision that is neither DISCARDED nor soft-deleted.
 */
async function pointersAt(fileObjectId: string): Promise<number> {
  const artifacts = await owner.previewArtifact.count({
    where: { tenantId: TENANT, fileObjectId },
  });
  const revisions = await owner.documentRevision.count({
    where: { tenantId: TENANT, fileObjectId, deletedAt: null, status: { not: 'DISCARDED' } },
  });
  return artifacts + revisions;
}
