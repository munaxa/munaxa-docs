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
  realDocumentLibrary,
  realDocumentPreview,
  realPreviewStack,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import type { DocumentPreviewService } from '../../document/application/document-preview.service';
import { decodePreviewToken } from '../domain/preview-stream-token';

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
let access: DocumentPreviewService;
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
  const unitOfWork = new PrismaUnitOfWork(prisma);
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
  access = realDocumentPreview({
    clock,
    unitOfWork,
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
