import 'reflect-metadata';

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  MetadataDataType,
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
  realDocumentLibrary,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import type { ConfigurationService } from '../../administration/application/configuration.service';
import type { LibraryAdminService } from '../../library/application/library-admin.service';
import type { DefaultStorageService } from '../../storage/application/storage.service';
import type { DefaultDocumentService } from '../application/document.service';

/**
 * The document library, end to end, against a real PostgreSQL and a real filesystem store.
 *
 * The assertions here are the ones a repository double cannot be trusted about, and they fall into
 * three groups.
 *
 * **Atomicity.** A document, its first revision and the reference count on its blob are written
 * together or not at all, and a refused create leaves nothing behind — including no reference on a
 * blob that would then never be collected.
 *
 * **Database-enforced invariants.** The malware gate and the "a document cannot present another
 * document's revision as its own" rule are triggers, not application code, and only the database
 * can be asked whether they hold. Both are asserted by trying to break them directly, bypassing
 * every use case — which is the only honest way to test a defence that exists precisely for the
 * case where the use case is not what is writing.
 *
 * **Isolation.** Two tenants in one database, which is the on-premise shape and the layer beneath
 * ADR-0015. A document, its blob and one person's favourites must all be invisible across the
 * boundary.
 *
 * The storage here is the real `LOCAL` adapter over a temporary directory, wrapped in the real
 * tenant scoping — so an upload in this suite genuinely writes bytes to a genuinely prefixed path.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const FIXED_NOW = new Date('2026-08-20T09:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
const OTHER_TENANT = asId<TenantId>(uuidv7());
const ALICE = asId<UserId>(uuidv7());
const BOB = asId<UserId>(uuidv7());

const SIGNING_SECRET = 'an-integration-suite-secret-of-at-least-32';

let root: string;
let appConfig: AppConfig;
let documents: DefaultDocumentService;
let storage: DefaultStorageService;
let libraries: LibraryAdminService;
let configuration: ConfigurationService;
let numbering: DocumentLibraryStack['numbering'];
let localAdapter: DocumentLibraryStack['localStorage'];
let owner: PrismaClient;

/** Fixtures created once and reused: this suite is about documents, not about configuration. */
let libraryId: string;
let rootFolderId: string;
let otherFolderId: string;
let documentTypeId: string;
let strictTypeId: string;
let confidentialityId: string;
let secretConfidentialityId: string;
let referenceFieldKey: string;

function contextFor(tenantId: TenantId, userId: UserId): RequestContext {
  return {
    tenantId,
    userId,
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: 'document-library',
    permissionVersion: 1,
    locale: 'en',
  };
}

function as<T>(work: () => Promise<T>, userId: UserId = ALICE, tenantId = TENANT): Promise<T> {
  return runWithContext(contextFor(tenantId, userId), work);
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(3, '0')}`;
}

/** A PDF whose bytes are distinct per call, so each upload is genuinely different content. */
function aPdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${marker}\n1 0 obj\n<<>>\nendobj\n`);
}

const MAGIC = new Uint8Array(Buffer.from('%PDF-1.7\n% ', 'utf8'));

/**
 * The path the scoping wrapper would have produced, for asserting against the disk directly.
 *
 * The suite's registry gives each tenant a prefix equal to its own identifier, so this mirrors what
 * `TenantScopedStorage` does rather than restating a convention — and asserting through the raw
 * adapter is what makes "the bytes really are under this tenant's prefix" a claim about the
 * filesystem instead of a claim about the wrapper.
 */
function scopedPath(tenantId: string, key: string): string {
  return `${tenantId}/${key}`;
}

/**
 * The whole upload handshake, as a browser performs it.
 *
 * Ask for a target, redeem it against the transfer endpoint's own logic, complete. Nothing is
 * short-circuited: the bytes land on a staging key, the digest is read back off the disk, and the
 * blob is moved to its content key by the service under test.
 */
async function upload(content: Buffer, filename = 'procedure.pdf'): Promise<string> {
  const target = await as(() =>
    storage.createUploadSession({
      filename,
      mimeType: 'application/pdf',
      sizeBytes: content.length,
      magicBytes: MAGIC,
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
  await localAdapter.beginWrite(decoded.grant.key);
  await writeFile(localAdapter.partialPathFor(decoded.grant.key), content);
  await localAdapter.finishWrite(decoded.grant.key);

  const completed = await as(() =>
    storage.completeUploadSession(asId<UploadSessionId>(target.uploadSessionId), []),
  );
  return completed.fileObjectId;
}

/**
 * Marks a blob CLEAN.
 *
 * `AV_DRIVER` is `NONE` in this suite, so the gate records `SKIPPED` — correctly, because a scanner
 * that could not be reached has not cleared anything. Attaching content therefore needs a verdict,
 * and writing one directly is what a scan worker will do through the outbox in a later phase.
 */
async function markClean(fileObjectId: string): Promise<void> {
  await owner.fileObject.update({
    where: { id: fileObjectId },
    data: {
      scanStatus: ScanStatus.CLEAN,
      scanner: 'integration-suite',
      scannedAt: FIXED_NOW,
    },
  });
}

async function uploadClean(content: Buffer, filename?: string): Promise<string> {
  const id = await upload(content, filename);
  await markClean(id);
  return id;
}

async function createDocument(
  overrides: Partial<Parameters<DefaultDocumentService['create']>[0]> = {},
) {
  const fileObjectId = overrides.fileObjectId ?? (await uploadClean(aPdf(unique('doc'))));
  return as(() =>
    documents.create({
      folderId: rootFolderId,
      documentTypeId,
      title: unique('Procedure '),
      fileObjectId,
      filename: 'procedure.pdf',
      origin: 'UPLOAD',
      acknowledgeDuplicate: false,
      ...overrides,
    }),
  );
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  root = await mkdtemp(join(tmpdir(), 'munaxa-library-'));
  appConfig = {
    env: 'test',
    database: { url: APP_URL, poolSize: 10 },
    storage: {
      driver: 'LOCAL',
      signedUrlTtlSeconds: 300,
      maxUploadBytes: 2 * 1024 * 1024 * 1024,
    },
  } as unknown as AppConfig;

  const prisma = sharedDatabase(appConfig, logger, APP_URL);
  const unitOfWork = new PrismaUnitOfWork(prisma);

  // The whole library, composed the way the container composes it — real storage over a real
  // temporary directory, under the real tenant scoping. `AV_DRIVER=NONE` here, so the gate records
  // SKIPPED rather than CLEAN: a scanner that could not be reached has cleared nothing, and that is
  // the behaviour under test rather than a limitation of the suite.
  const stack = realDocumentLibrary({
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
        id === ALICE || id === BOB
          ? Promise.resolve({ id } as never)
          : Promise.reject(Object.assign(new Error('not found'), { code: 'NOT_FOUND' })),
    },
  });
  storage = stack.storage;
  documents = stack.documents;
  libraries = stack.libraries;
  configuration = stack.configuration;
  numbering = stack.numbering;
  localAdapter = stack.localStorage;

  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

  for (const tenantId of [TENANT, OTHER_TENANT]) {
    await owner.tenant.create({
      data: {
        id: tenantId,
        slug: `lib-${String(Date.now())}-${tenantId.slice(0, 8)}`,
        name: 'Document Library Test',
        status: 'ACTIVE',
      },
    });
  }
  for (const [id, tenantId] of [
    [ALICE, TENANT],
    [BOB, TENANT],
  ] as const) {
    await owner.user.create({
      data: {
        id,
        tenantId,
        // The whole identifier, not a slice: `uuidv7` leads with its timestamp, so two identifiers
        // minted in the same millisecond share their first characters and collide on the email.
        email: `${id}@example.test`,
        emailNormalized: `${id}@example.test`,
        displayName: 'Test User',
        status: 'ACTIVE',
        updatedAt: FIXED_NOW,
      },
    });
  }

  // The configuration a document is assembled from — Phase 2's work, consumed here.
  const library = await as(() =>
    libraries.createLibrary({
      code: unique('LIB'),
      name: 'Quality',
      ownerScopeType: 'TENANT',
    }),
  );
  libraryId = library.id;
  rootFolderId = library.rootFolderId;
  const other = await as(() =>
    libraries.createFolder({
      libraryId,
      parentId: rootFolderId,
      name: 'Procedures',
      inheritAcl: true,
    }),
  );
  otherFolderId = other.id;

  const internal = await as(() =>
    configuration.createConfidentiality({
      code: unique('C'),
      name: 'Internal',
      rank: 10,
      allowDownload: true,
      allowPrint: true,
      watermark: false,
      requireReason: false,
    }),
  );
  confidentialityId = internal.id;
  const secret = await as(() =>
    configuration.createConfidentiality({
      code: unique('C'),
      name: 'Secret',
      rank: 90,
      allowDownload: false,
      allowPrint: false,
      watermark: true,
      requireReason: true,
    }),
  );
  secretConfidentialityId = secret.id;

  const rule = await as(() =>
    numbering.create({
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

  const owner_ = await as(() =>
    configuration.createMetadataField({
      key: unique('owner-'),
      name: 'Process owner',
      dataType: MetadataDataType.USER,
      options: [],
      validation: {},
      isSearchable: true,
    }),
  );
  referenceFieldKey = owner_.key;
  const reference = await as(() =>
    configuration.createMetadataField({
      key: unique('ref-'),
      name: 'Reference',
      dataType: MetadataDataType.TEXT,
      options: [],
      validation: { maxLength: 12 },
      isSearchable: true,
    }),
  );
  const reviewDate = await as(() =>
    configuration.createMetadataField({
      key: unique('review-'),
      name: 'Review date',
      dataType: MetadataDataType.DATE,
      options: [],
      validation: {},
      isSearchable: true,
    }),
  );

  const type = await as(() =>
    configuration.createDocumentType({
      code: unique('T'),
      name: 'Procedure',
      numberingRuleId: rule.id,
      defaultConfidentialityId: confidentialityId,
      revisionLabelStyle: RevisionLabelStyle.NUMERIC,
      isActive: true,
      fields: [
        { metadataFieldId: reference.id, isRequired: false, sortOrder: 0, defaultValue: null },
        { metadataFieldId: reviewDate.id, isRequired: false, sortOrder: 1, defaultValue: null },
        { metadataFieldId: owner_.id, isRequired: false, sortOrder: 2, defaultValue: null },
      ],
    }),
  );
  documentTypeId = type.id;

  const strict = await as(() =>
    configuration.createDocumentType({
      code: unique('T'),
      name: 'Controlled record',
      numberingRuleId: rule.id,
      defaultConfidentialityId: confidentialityId,
      revisionLabelStyle: RevisionLabelStyle.ALPHABETIC,
      isActive: true,
      fields: [
        { metadataFieldId: reference.id, isRequired: true, sortOrder: 0, defaultValue: null },
      ],
    }),
  );
  strictTypeId = strict.id;
});

afterAll(async () => {
  await owner.$disconnect();
  await rm(root, { recursive: true, force: true });
});

// --- Upload -------------------------------------------------------------------------------

describe('uploading content', () => {
  it('stores the bytes under a content key derived from what actually arrived', async () => {
    const content = aPdf('content-key');
    const fileObjectId = await upload(content);

    const stored = await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
    // The digest the store reported, not the one anybody claimed. The key is derived from it, so
    // the two can never disagree.
    expect(stored.checksumSha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(stored.storageKey).toBe(
      `blobs/${stored.checksumSha256.slice(0, 2)}/${stored.checksumSha256.slice(2, 4)}/${stored.checksumSha256}`,
    );
    expect(Number(stored.sizeBytes)).toBe(content.length);
  });

  it('leaves the staging object behind only as long as the transfer', async () => {
    const fileObjectId = await upload(aPdf('staging'));
    const sessions = await owner.uploadSession.findMany({ where: { fileObjectId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.state).toBe('COMPLETED');
    // Moved to its content key, and the staging copy removed — otherwise every upload would be
    // stored twice and the second copy would be referenced by nothing.
    expect(await localAdapter.head(scopedPath(TENANT, sessions[0]?.targetKey ?? ''))).toBeNull();
  });

  it('deduplicates identical content into one blob', async () => {
    const content = aPdf('identical');
    const first = await upload(content);
    const second = await upload(content);
    expect(second).toBe(first);

    const count = await owner.fileObject.count({
      where: {
        tenantId: TENANT,
        checksumSha256: createHash('sha256').update(content).digest('hex'),
      },
    });
    expect(count).toBe(1);
  });

  it('records SKIPPED rather than CLEAN when no scanner is configured', async () => {
    // The one thing this product must not have is an environment where "upload works" means "the
    // gate is off". A scanner that could not be reached has cleared nothing.
    const fileObjectId = await upload(aPdf('unscanned'));
    const stored = await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
    expect(stored.scanStatus).toBe('SKIPPED');
  });

  it('refuses a file whose bytes are not what it says they are, before storing anything', async () => {
    await expect(
      as(() =>
        storage.createUploadSession({
          filename: 'not-really.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          magicBytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]),
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' });

    // Nothing was recorded, which is the half that matters: a refusal that left a session behind
    // would leave a key promised to somebody and a sweeper with something to find.
    expect(await owner.uploadSession.count({ where: { filename: 'not-really.pdf' } })).toBe(0);
  });

  it('tells a client that already-stored content needs no transfer at all', async () => {
    const content = aPdf('pre-checked');
    const fileObjectId = await upload(content);
    const digest = createHash('sha256').update(content).digest('hex');

    const target = await as(() =>
      storage.createUploadSession({
        filename: 'again.pdf',
        mimeType: 'application/pdf',
        sizeBytes: content.length,
        magicBytes: MAGIC,
        checksumSha256: digest,
      }),
    );
    expect(target.alreadyStored).toEqual({ fileObjectId });
    expect(target.url).toBe('');
  });
});

// --- Creating a document ------------------------------------------------------------------

describe('creating a document', () => {
  it('writes the document, its first revision and the blob’s reference in one transaction', async () => {
    const fileObjectId = await uploadClean(aPdf('atomic'));
    const document = await createDocument({ fileObjectId, title: 'Calibration procedure' });

    expect(document.status).toBe('DRAFT');
    expect(document.latestRevision?.ordinal).toBe(0);
    // The label is rendered from the ordinal in the type's style, and stored — a type whose style
    // changes later must not silently relabel history.
    expect(document.latestRevision?.label).toBe('Original');
    expect(document.latestRevision?.file.fileObjectId).toBe(fileObjectId);

    const stored = await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
    expect(stored.refCount).toBe(1);
  });

  it('leaves nothing behind when the create is refused', async () => {
    const fileObjectId = await uploadClean(aPdf('rolled-back'));
    const before = await owner.document.count({ where: { tenantId: TENANT } });

    await expect(createDocument({ fileObjectId, folderId: uuidv7() })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    expect(await owner.document.count({ where: { tenantId: TENANT } })).toBe(before);
    // And no reference on the blob, which would otherwise make it uncollectable forever.
    const stored = await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
    expect(stored.refCount).toBe(0);
  });

  it('refuses content that has not passed the scanner', async () => {
    const fileObjectId = await upload(aPdf('unscanned-attach'));
    await expect(createDocument({ fileObjectId })).rejects.toMatchObject({
      code: 'CONTENT_NOT_SCANNED',
    });
  });

  it('freezes the type’s policy rather than referencing it', async () => {
    const document = await createDocument({});
    // Frozen at creation. Editing the type afterwards changes what the *next* document inherits,
    // which is what lets a type be edited without rewriting history.
    expect(document.confidentialityId).toBe(confidentialityId);

    const row = await owner.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(row.confidentialityId).toBe(confidentialityId);
  });

  it('lets a document be more sensitive than its type’s default, and never less', async () => {
    const stricter = await createDocument({ confidentialityId: secretConfidentialityId });
    expect(stricter.confidentialityName).toBe('Secret');

    const lower = await as(() =>
      configuration.createConfidentiality({
        code: unique('C'),
        name: 'Public',
        rank: 1,
        allowDownload: true,
        allowPrint: true,
        watermark: false,
        requireReason: false,
      }),
    );
    // Every handling rule on a level subtracts, so choosing a lower rank at creation would be a way
    // to grant access the type's author decided against — from a dropdown.
    await expect(createDocument({ confidentialityId: lower.id })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses a document type that has been retired', async () => {
    const { numberingRuleId } = await owner.documentType.findUniqueOrThrow({
      where: { id: documentTypeId },
    });
    const retired = await as(() =>
      configuration.createDocumentType({
        code: unique('T'),
        name: 'Retired',
        numberingRuleId,
        defaultConfidentialityId: confidentialityId,
        revisionLabelStyle: RevisionLabelStyle.NUMERIC,
        isActive: false,
        fields: [],
      }),
    );
    await expect(createDocument({ documentTypeId: retired.id })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('has no document number until approval, and that is not a gap', async () => {
    const document = await createDocument({});
    // Numbers are reserved at submission and assigned at approval (ADR-0004), which is Phase 5's.
    expect(document.documentNumber).toBeNull();
  });
});

// --- Metadata -----------------------------------------------------------------------------

describe('business metadata', () => {
  it('stores each field in the column its own type calls for', async () => {
    const document = await createDocument({
      metadata: { [referenceFieldKey]: ALICE },
    });
    const values = await owner.documentMetadataValue.findMany({
      where: { documentId: document.id },
    });
    const populated = values.filter(
      (value) =>
        value.textValue !== null ||
        value.numberValue !== null ||
        value.dateValue !== null ||
        value.booleanValue !== null ||
        value.referenceValue !== null,
    );
    expect(populated).toHaveLength(1);
    // A USER field goes in `reference_value`, not in `text_value`. Typed columns are the whole
    // reason "which documents does Alice own" is an index lookup rather than a scan and a cast.
    expect(populated[0]?.referenceValue).toBe(ALICE);
  });

  it('refuses a value of the wrong shape rather than coercing it to null', async () => {
    const fields = await owner.metadataField.findMany({
      where: { tenantId: TENANT, dataType: 'DATE' },
    });
    const dateKey = fields[0]?.key ?? '';
    await expect(createDocument({ metadata: { [dateKey]: 'soon' } })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses a reference to somebody who does not work here', async () => {
    await expect(
      createDocument({ metadata: { [referenceFieldKey]: uuidv7() } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a field that is not on the document’s type rather than dropping it', async () => {
    await expect(createDocument({ metadata: { nonesuch: 'x' } })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses a document missing a field its type requires', async () => {
    await expect(createDocument({ documentTypeId: strictTypeId })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('clears a field that a later edit leaves out', async () => {
    const fields = await owner.metadataField.findMany({
      where: { tenantId: TENANT, dataType: 'TEXT' },
    });
    const textKey = fields[0]?.key ?? '';
    const document = await createDocument({ metadata: { [textKey]: 'QA-1' } });

    const updated = await as(() =>
      documents.update(document.id, { metadata: {} }, document.version),
    );
    const value = updated.metadata.find((entry) => entry.key === textKey);
    // A patch that supplies four of ten fields means the other six are cleared. The caller decided
    // that; the repository does it in two statements rather than leaving stale values behind.
    expect(value?.columns.textValue ?? null).toBeNull();
  });
});

// --- Duplicates ---------------------------------------------------------------------------

describe('duplicate detection', () => {
  it('names what it found rather than merely refusing', async () => {
    const fileObjectId = await uploadClean(aPdf('duplicate'));
    const first = await createDocument({ fileObjectId, title: 'Original filing' });

    await expect(createDocument({ fileObjectId, title: 'Second filing' })).rejects.toMatchObject({
      code: 'DUPLICATE',
      details: { documentId: first.id, matchCount: 1 },
    });
  });

  it('accepts the same content when the caller says it knows', async () => {
    // A duplicate is frequently legitimate — the same signed form filed against two projects. What
    // is a mistake is doing it *unknowingly*.
    const fileObjectId = await uploadClean(aPdf('acknowledged'));
    await createDocument({ fileObjectId, title: 'First' });
    const second = await createDocument({
      fileObjectId,
      title: 'Second, deliberately',
      acknowledgeDuplicate: true,
    });
    expect(second.id).toBeTruthy();

    const stored = await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
    // One blob, two references. Content addressing means the second filing costs no storage.
    expect(stored.refCount).toBe(2);
  });

  it('answers the duplicate question directly, with where each match is filed', async () => {
    const fileObjectId = await uploadClean(aPdf('reported'));
    const document = await createDocument({ fileObjectId, title: 'Filed here' });

    const matches = await as(() => documents.findDuplicates(fileObjectId));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ documentId: document.id, title: 'Filed here' });
    expect(matches[0]?.folderPath).toBeTruthy();
  });
});

// --- Navigation, favourites and recents ---------------------------------------------------

describe('navigating the library', () => {
  const page = { page: 1, pageSize: 50, sortDirection: 'desc' as const, deleted: 'live' as const };

  it('lists what is in a folder, and what is anywhere beneath one', async () => {
    const inRoot = await createDocument({ folderId: rootFolderId });
    const inChild = await createDocument({ folderId: otherFolderId });

    const direct = await as(() => documents.list({ ...page, folderId: otherFolderId }));
    expect(direct.data.map((row) => row.id)).toContain(inChild.id);
    expect(direct.data.map((row) => row.id)).not.toContain(inRoot.id);

    // The materialised path makes "everything beneath" one indexed prefix scan whatever the depth.
    const subtree = await as(() => documents.list({ ...page, underFolderId: rootFolderId }));
    const ids = subtree.data.map((row) => row.id);
    expect(ids).toContain(inRoot.id);
    expect(ids).toContain(inChild.id);
  });

  it('matches no rows when the folder filter names a folder that does not exist', async () => {
    // Ignoring the filter would silently widen the list to the whole tenant, which is the wrong
    // answer in the one direction that matters.
    const result = await as(() => documents.list({ ...page, underFolderId: uuidv7() }));
    expect(result.data).toHaveLength(0);
  });

  it('keeps favourites private to the person who made them', async () => {
    const document = await createDocument({});
    await as(() => documents.setFavorite(document.id, true), ALICE);

    const forAlice = await as(() => documents.get(document.id), ALICE);
    const forBob = await as(() => documents.get(document.id), BOB);
    expect(forAlice.isFavorite).toBe(true);
    // A favourite is a private convenience, not a shared classification. A tenant-wide flag is a
    // metadata field the administrator defines.
    expect(forBob.isFavorite).toBe(false);
  });

  it('filters a list down to one person’s favourites', async () => {
    const document = await createDocument({});
    await as(() => documents.setFavorite(document.id, true), BOB);

    const bobs = await as(() => documents.list({ ...page, favorite: true }), BOB);
    expect(bobs.data.map((row) => row.id)).toContain(document.id);
    const alices = await as(() => documents.list({ ...page, favorite: true }), ALICE);
    expect(alices.data.map((row) => row.id)).not.toContain(document.id);
  });

  it('is idempotent about starring something already starred', async () => {
    const document = await createDocument({});
    await as(() => documents.setFavorite(document.id, true));
    await expect(as(() => documents.setFavorite(document.id, true))).resolves.toBeUndefined();
  });

  it('remembers what a person opened, and counts how often', async () => {
    const document = await createDocument({});
    await as(() => documents.open(document.id), ALICE);
    await as(() => documents.open(document.id), ALICE);

    const view = await owner.documentView.findUniqueOrThrow({
      where: { userId_documentId: { userId: ALICE, documentId: document.id } },
    });
    // One row moved forward, not two rows appended. "Which documents did I open lately" is a
    // question about a screenful, and a log would grow without bound to answer it.
    expect(view.viewCount).toBe(2);

    const recent = await as(() => documents.listRecent(ALICE, { ...page, pageSize: 10 }), ALICE);
    expect(recent.data[0]?.document.id).toBe(document.id);
  });

  it('does not count a listing as an opening', async () => {
    const document = await createDocument({});
    await as(() => documents.list({ ...page, folderId: rootFolderId }), BOB);

    const view = await owner.documentView.findUnique({
      where: { userId_documentId: { userId: BOB, documentId: document.id } },
    });
    // A list that rendered twenty rows has not opened twenty documents, and a recents list built
    // from every read would be a list of whatever the screen last drew.
    expect(view).toBeNull();
  });
});

// --- Moving, deleting, restoring ----------------------------------------------------------

describe('moving and removing', () => {
  it('moves a document and refuses to do it blindly', async () => {
    const document = await createDocument({ folderId: rootFolderId });

    // A move changes the ACL chain the document resolves through, so it may not be done by
    // somebody who has not looked at where the document currently is.
    await expect(
      as(() => documents.move(document.id, otherFolderId, undefined)),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const moved = await as(() => documents.move(document.id, otherFolderId, document.version));
    expect(moved.folderId).toBe(otherFolderId);
  });

  it('treats a move to where it already is as a success without a write', async () => {
    const document = await createDocument({ folderId: otherFolderId });
    const same = await as(() => documents.move(document.id, otherFolderId, document.version));
    expect(same.version).toBe(document.version);
  });

  it('gives the blob’s reference back on delete, and takes it again on restore', async () => {
    const fileObjectId = await uploadClean(aPdf('lifecycle'));
    const document = await createDocument({ fileObjectId });
    expect(
      (await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } })).refCount,
    ).toBe(1);

    await as(() =>
      documents.remove(document.id, document.version, 'superseded by a newer drawing'),
    );
    // Nothing is deleted from storage: retention decides that later, at a count of zero, after a
    // grace period. A delete that removed bytes would make the recycle bin a lie.
    const dereferenced = await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
    expect(dereferenced.refCount).toBe(0);
    expect(await localAdapter.head(scopedPath(TENANT, dereferenced.storageKey))).not.toBeNull();

    const deleted = await as(() => documents.get(document.id));
    await as(() => documents.restore(document.id, deleted.version));
    const restored = await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
    expect(restored.refCount).toBe(1);
  });

  it('hides a deleted document from an ordinary list and shows it in the recycle bin', async () => {
    const document = await createDocument({});
    await as(() =>
      documents.remove(document.id, document.version, 'superseded by a newer drawing'),
    );

    const live = await as(() =>
      documents.list({ page: 1, pageSize: 100, sortDirection: 'desc', deleted: 'live' }),
    );
    expect(live.data.map((row) => row.id)).not.toContain(document.id);

    const bin = await as(() =>
      documents.list({ page: 1, pageSize: 100, sortDirection: 'desc', deleted: 'deleted' }),
    );
    expect(bin.data.map((row) => row.id)).toContain(document.id);
  });

  it('refuses a second writer who is working from a stale version', async () => {
    const document = await createDocument({});
    await as(() => documents.update(document.id, { title: 'First writer' }, document.version));
    await expect(
      as(() => documents.update(document.id, { title: 'Second writer' }, document.version)),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});

// --- Download -----------------------------------------------------------------------------

describe('downloading', () => {
  it('issues a short-lived link and audits having issued it', async () => {
    const document = await createDocument({});
    const before = await owner.auditEvent.count({
      where: { tenantId: TENANT, action: 'FILE_DOWNLOAD_ISSUED' },
    });

    const signed = await as(() => documents.downloadUrl(document.id, false));
    expect(signed.url).toContain('token=');
    expect(signed.expiresAt.getTime()).toBe(FIXED_NOW.getTime() + 300_000);

    // Audited *before* the URL exists: a signed URL outlives the request and can be redeemed by
    // whoever holds it, so the record of who was handed one is the evidence of how bytes left.
    const after = await owner.auditEvent.count({
      where: { tenantId: TENANT, action: 'FILE_DOWNLOAD_ISSUED' },
    });
    expect(after).toBe(before + 1);
  });

  it('refuses a download the confidentiality level forbids, whatever the permission says', async () => {
    const document = await createDocument({ confidentialityId: secretConfidentialityId });
    // A level subtracts and never grants: holding `document:download` is not enough if the
    // document's own classification forbids it.
    await expect(as(() => documents.downloadUrl(document.id, false))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

// --- What the database refuses on its own --------------------------------------------------

describe('the database’s own defences', () => {
  it('refuses to attach unscanned content even when the use case is bypassed', async () => {
    // Written directly, as a repair script or a backfill would. The use case's check is the one
    // that produces a sentence a person reads; this is the one that still holds at three in the
    // morning.
    const fileObjectId = await upload(aPdf('trigger-scan'));
    const document = await createDocument({});

    await expect(
      owner.documentRevision.create({
        data: {
          id: uuidv7(),
          tenantId: TENANT,
          documentId: document.id,
          ordinal: 1,
          label: 'R1',
          status: 'DRAFT',
          fileObjectId,
          filename: 'sneaked.pdf',
          updatedAt: FIXED_NOW,
        },
      }),
    ).rejects.toThrow(/scan status/i);
  });

  it('refuses to move a referenced blob out of CLEAN without withdrawing the revision first', async () => {
    // A scanner re-running on a signature update and finding something it missed is a real
    // operation with a real procedure: withdraw, then quarantine. Refusing the write is what stops
    // the quarantine silently leaving a document pointing at hostile content.
    const fileObjectId = await uploadClean(aPdf('requarantine'));
    await createDocument({ fileObjectId });

    await expect(
      owner.fileObject.update({
        where: { id: fileObjectId },
        data: { scanStatus: 'INFECTED', scanThreat: 'EICAR-Test' },
      }),
    ).rejects.toThrow(/cannot leave CLEAN/i);
  });

  it('refuses a document that claims another document’s revision as its own', async () => {
    // The single worst thing a document-control system can get wrong: presenting somebody else's
    // approved content as this document's.
    const mine = await createDocument({});
    const theirs = await createDocument({});
    const theirRevision = await owner.documentRevision.findFirstOrThrow({
      where: { documentId: theirs.id },
    });

    await expect(
      owner.document.update({
        where: { id: mine.id },
        data: { currentRevisionId: theirRevision.id },
      }),
    ).rejects.toThrow(/as its own/i);
  });

  it('refuses a reference count that has gone negative', async () => {
    // A negative count means the count has already drifted from what it counts, at which point the
    // next retention sweep deletes a blob a document still points at.
    const fileObjectId = await uploadClean(aPdf('refcount'));
    await expect(
      owner.fileObject.update({ where: { id: fileObjectId }, data: { refCount: -1 } }),
    ).rejects.toThrow(/ck_file_object_ref_count/i);
  });

  it('keeps a revision’s ordinal unique per document', async () => {
    const document = await createDocument({});
    const fileObjectId = await uploadClean(aPdf('second-ordinal'));
    await expect(
      owner.documentRevision.create({
        data: {
          id: uuidv7(),
          tenantId: TENANT,
          documentId: document.id,
          ordinal: 0,
          label: 'Original',
          status: 'DRAFT',
          fileObjectId,
          filename: 'again.pdf',
          updatedAt: FIXED_NOW,
        },
      }),
    ).rejects.toThrow();
  });
});

// --- Tenant isolation ----------------------------------------------------------------------

describe('two tenants sharing one database', () => {
  beforeEach(() => {
    // The on-premise shape: one PostgreSQL serving two companies, where a tenant column and a
    // row-level security policy are the whole of the separation.
  });

  it('does not show one tenant’s documents to another', async () => {
    const document = await createDocument({});
    const theirs = await as(
      () => documents.list({ page: 1, pageSize: 100, sortDirection: 'desc', deleted: 'all' }),
      ALICE,
      OTHER_TENANT,
    );
    expect(theirs.data.map((row) => row.id)).not.toContain(document.id);
  });

  it('answers “not found” for another tenant’s document by identifier', async () => {
    const document = await createDocument({});
    await expect(as(() => documents.get(document.id), ALICE, OTHER_TENANT)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('stores each tenant’s bytes under its own prefix', async () => {
    const document = await createDocument({});
    const revision = await owner.documentRevision.findFirstOrThrow({
      where: { documentId: document.id },
    });
    const file = await owner.fileObject.findUniqueOrThrow({
      where: { id: revision.fileObjectId },
    });
    // The stored key carries no prefix — the prefix says where the bytes live, not what the blob
    // is — and the bytes are under the tenant's own directory on disk.
    expect(file.storageKey.startsWith('blobs/')).toBe(true);
    expect(await localAdapter.head(scopedPath(TENANT, file.storageKey))).not.toBeNull();
    // The same logical key under the other tenant's prefix is a different object, and it is absent.
    // Two customers holding the same standard form is two objects, by construction.
    expect(await localAdapter.head(scopedPath(OTHER_TENANT, file.storageKey))).toBeNull();
  });
});
