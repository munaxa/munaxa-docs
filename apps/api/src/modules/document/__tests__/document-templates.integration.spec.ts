import 'reflect-metadata';

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  NumberSegmentKind,
  RevisionLabelStyle,
  ScanStatus,
  ScopeType,
  Settings,
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
  type RetentionStack,
  realDisposition,
  realDocumentLibrary,
  realRetention,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';

/**
 * A document template's body, and who holds the reference on it — Slice 102.
 *
 * `DocumentTemplateService` is the one place in this product that pointed a row at a `file_object`
 * and took nothing. This file's own header states the model it broke: "a thousand documents from
 * one template are **one blob with a thousand and one references**" — the thousand are the
 * documents' revisions, and the *one* is the template's own, which nothing acquired.
 *
 * `retention.reclaim-blobs` selects `ref_count = 0` past a grace period, so the body of a live
 * template was destroyed by the first sweep that met it — after which `createFrom` refuses for
 * ever, because `create` resolves the blob through `describe` and that filters `deleted_at: null`.
 *
 * Nothing here is concurrent, and that is the finding rather than an omission: the repository puts
 * the row's `version` in the `WHERE` of every write and raises `VersionConflictError` on a count of
 * zero, so two administrators editing one template cannot both win. What was wrong was arithmetic,
 * not ordering, and a proof that manufactured a race would be proving the wrong thing.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const FIXED_NOW = new Date('2026-09-01T09:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };
/** A day later, for the one collaborator that has to run after the blob grace period. */
const A_DAY_LATER = new Date(FIXED_NOW.getTime() + 24 * 60 * 60 * 1_000);
const sweepClock = { now: () => new Date(A_DAY_LATER), timestamp: () => 0, elapsedMs: () => 0 };
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => logger,
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
const ADMIN = asId<UserId>(uuidv7());
const ADMIN_ROLE = uuidv7();

let root: string;
let appConfig: AppConfig;
let owner: PrismaClient;
let unitOfWork: PrismaUnitOfWork;
let library: DocumentLibraryStack;
let sweep: RetentionStack;

let folderId: string;
let documentTypeId: string;
let confidentialityId: string;

function contextFor(userId: UserId): RequestContext {
  return {
    tenantId: TENANT,
    userId,
    roles: [ADMIN_ROLE],
    permissions: [],
    sessionId: null,
    correlationId: 'template-suite',
    permissionVersion: 1,
    locale: 'en',
  };
}

const asAdmin = <T>(work: () => Promise<T>): Promise<T> => runWithContext(contextFor(ADMIN), work);

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  root = await mkdtemp(join(tmpdir(), 'edms-templates-'));

  appConfig = {
    env: 'test',
    database: { url: APP_URL, poolSize: 10 },
    storage: { driver: 'LOCAL', signedUrlTtlSeconds: 300 },
    acl: { cacheTtlSeconds: 0, maxSubjectEntries: 5_000 },
  } as unknown as AppConfig;

  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `tpl-${TENANT.replaceAll('-', '').slice(-16)}`,
      name: 'Template Test',
      status: 'ACTIVE',
    },
  });
  await owner.user.create({
    data: {
      id: ADMIN,
      tenantId: TENANT,
      email: `${ADMIN}@templates.test`,
      emailNormalized: `${ADMIN}@templates.test`,
      displayName: 'admin',
      status: 'ACTIVE',
      updatedAt: FIXED_NOW,
    },
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
    signingSecret: 'a-template-suite-secret-of-at-least-32-c',
    antivirus: {
      scanner: 'unconfigured',
      scan: () => Promise.reject(new Error('AV_DRIVER is NONE')),
    },
    users: { get: () => Promise.resolve(null) } as never,
  });
  /*
   * The blob reaper, on a clock a day past everything this suite writes.
   *
   * `reclaimBlobs` selects `ref_count = 0` and `updated_at` older than the grace period, so a sweep
   * on the suite's own fixed instant would select nothing whatever the counts said. A grace of zero
   * days and a clock one day ahead is the grace period having passed, stated as data rather than as
   * a sleep.
   */
  sweep = realRetention({
    clock: sweepClock,
    unitOfWork,
    storage: library.storagePort,
    storageService: library.storage,
    disposition: realDisposition(sweepClock, library.storage, library.writer),
    settings: { [Settings.RETENTION_BLOB_GRACE_DAYS.key]: 0 },
  });

  await seedTree();
}, 180_000);

afterAll(async () => {
  await owner?.$disconnect();
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('a template body and the blob reaper', () => {
  it('survives the sweep, and still starts a document afterwards', async () => {
    const body = await seedBody('survives');

    const template = await asAdmin(() =>
      library.templates.create({
        name: 'Survives the sweep',
        documentTypeId,
        confidentialityId,
        defaultFolderId: folderId,
        fileObjectId: body,
        filename: 'survives.pdf',
      }),
    );
    expect(template.fileObjectId, 'the template points at the body').toBe(body);

    // The invariant, before anything else can have touched it: one reference per live pointer.
    // This is the assertion that fails before the fix — the count is zero while a template names it.
    expect(await referenceCountOf(body)).toBe(await pointersTo(body));

    await asAdmin(() => sweep.retention.reclaimBlobs(100));

    const after = await owner.fileObject.findUniqueOrThrow({ where: { id: body } });
    expect(after.deletedAt, 'the reaper must not take a live template’s body').toBeNull();

    // The harm the reference exists to prevent, asserted as the operation rather than as the row:
    // `create` resolves the blob through `describe`, which filters `deleted_at: null`, so a
    // reclaimed body makes every future document from this template impossible.
    const document = await asAdmin(() =>
      library.templates.createFrom(String(template.id), { title: 'Started from the template' }),
    );
    expect(document.id).toBeTruthy();

    // And the document's own revision took its own: one blob, two pointers, two references — the
    // "thousand and one" of this module's header, at a thousand of one.
    expect(await referenceCountOf(body)).toBe(await pointersTo(body));
    expect(await pointersTo(body), 'the template and the new revision').toBe(2);
  }, 120_000);
});

describe('replacing a template’s body', () => {
  it('moves the reference from the displaced body to the new one', async () => {
    const first = await seedBody('displaced');
    const second = await seedBody('replacement');

    const template = await asAdmin(() =>
      library.templates.create({
        name: 'Replaced body',
        documentTypeId,
        confidentialityId,
        defaultFolderId: folderId,
        fileObjectId: first,
        filename: 'first.pdf',
      }),
    );
    expect(await referenceCountOf(first)).toBe(1);
    expect(await referenceCountOf(second)).toBe(0);

    const current = await asAdmin(() => library.templates.get(String(template.id)));
    await asAdmin(() =>
      library.templates.update(
        String(template.id),
        { fileObjectId: second, filename: 'second.pdf' },
        current.version,
      ),
    );

    // The displaced body is released and the new one is claimed — the rule the preview pipeline
    // states for the same situation and Slice 99 applied to the bulk export's manifest.
    expect(await referenceCountOf(first), 'the displaced body is released').toBe(0);
    expect(await referenceCountOf(second), 'the new body is claimed').toBe(1);
    expect(await referenceCountOf(first)).toBe(await pointersTo(first));
    expect(await referenceCountOf(second)).toBe(await pointersTo(second));

    // And the released one is now genuinely the reaper's, which is the other half of the rule: a
    // blob nothing points at must be collectable, or the bytes can never be disposed of.
    await asAdmin(() => sweep.retention.reclaimBlobs(100));
    const displaced = await owner.fileObject.findUniqueOrThrow({ where: { id: first } });
    const attached = await owner.fileObject.findUniqueOrThrow({ where: { id: second } });
    expect(displaced.deletedAt, 'nothing points at it, so the reaper may take it').not.toBeNull();
    expect(attached.deletedAt, 'the template points at it, so the reaper may not').toBeNull();
  }, 120_000);

  it('leaves the count alone when the body is replaced with itself', async () => {
    const body = await seedBody('unchanged');

    const template = await asAdmin(() =>
      library.templates.create({
        name: 'Same body again',
        documentTypeId,
        confidentialityId,
        defaultFolderId: folderId,
        fileObjectId: body,
        filename: 'same.pdf',
      }),
    );
    expect(await referenceCountOf(body)).toBe(1);

    /*
     * A real request, not a contrivance: content addressing means an administrator who re-uploads
     * the identical bytes is handed the same `file_object` back, so the patch names the body the
     * template already has. One pointer, one reference — a dereference here would drop it to zero
     * and hand a live template's body to the reaper, and a second reference would strand it for
     * ever.
     */
    const current = await asAdmin(() => library.templates.get(String(template.id)));
    await asAdmin(() =>
      library.templates.update(
        String(template.id),
        { fileObjectId: body, filename: 'same-again.pdf' },
        current.version,
      ),
    );

    expect(await referenceCountOf(body), 'the same body, still one reference').toBe(1);
    expect(await referenceCountOf(body)).toBe(await pointersTo(body));

    await asAdmin(() => sweep.retention.reclaimBlobs(100));
    const after = await owner.fileObject.findUniqueOrThrow({ where: { id: body } });
    expect(after.deletedAt, 'still a live template’s body').toBeNull();
  }, 120_000);
});

// --- Helpers ---------------------------------------------------------------------------------

async function referenceCountOf(fileObjectId: string): Promise<number> {
  const row = await owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
  return row.refCount;
}

/**
 * Live pointers at a blob, counted the way the purge adapter counts them.
 *
 * A template row holds one whatever its `deleted_at` says, because a soft-deleted template is
 * restorable and its body has to still be there when it is. A revision holds one "unless it was
 * DISCARDED (which gave its back) or soft-deleted (the delete cascade gave its back)" — the
 * disposition adapter's own words, and the rule Slice 98 made true.
 */
async function pointersTo(fileObjectId: string): Promise<number> {
  const templates = await owner.documentTemplate.count({
    where: { tenantId: TENANT, fileObjectId },
  });
  const revisions = await owner.documentRevision.count({
    where: { tenantId: TENANT, fileObjectId, deletedAt: null, status: { not: 'DISCARDED' } },
  });
  return templates + revisions;
}

/**
 * A blob as a completed upload leaves it: real bytes under the tenant's prefix, `CLEAN`, and a
 * reference count of **zero**.
 *
 * Written directly for the reason the other suites write rows directly — what is under test is the
 * *template's* accounting, and driving a presigned upload for each one would put the upload path's
 * own reference counting inside the measurement. The bytes are real so the reaper's delete is a
 * real delete rather than a swallowed miss.
 */
async function seedBody(name: string): Promise<string> {
  const id = uuidv7();
  const content = Buffer.from(`%PDF-1.4 ${name}\n`, 'utf8');
  const storageKey = `templates/${name}-${id}.pdf`;
  const path = join(root, TENANT, storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await owner.fileObject.create({
    data: {
      id,
      tenantId: TENANT,
      checksumSha256: createHash('sha256').update(content).digest('hex'),
      sizeBytes: BigInt(content.length),
      mimeType: 'application/pdf',
      storageKey,
      storageDriver: 'LOCAL',
      scanStatus: ScanStatus.CLEAN,
      refCount: 0,
      updatedAt: FIXED_NOW,
    },
  });
  return id;
}

async function seedTree(): Promise<void> {
  const created = await asAdmin(() =>
    library.libraries.createLibrary({
      code: 'TPL',
      name: 'Controlled',
      ownerScopeType: ScopeType.TENANT,
    }),
  );
  const folder = await asAdmin(() =>
    library.libraries.createFolder({
      libraryId: created.id,
      parentId: created.rootFolderId,
      name: 'Forms',
      inheritAcl: true,
    }),
  );
  folderId = folder.id;

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
  confidentialityId = confidentiality.id;

  const rule = await asAdmin(() =>
    library.numbering.create({
      key: 'tpl',
      name: 'Templates',
      separator: '-',
      segments: [
        { kind: NumberSegmentKind.LITERAL, value: 'TPL' },
        { kind: NumberSegmentKind.SEQUENCE, padding: 3 },
      ],
      resetScope: ['NEVER'],
      reserveOnSubmit: false,
      strictGapless: false,
    }),
  );
  const type = await asAdmin(() =>
    library.configuration.createDocumentType({
      code: 'FORM',
      name: 'Form',
      numberingRuleId: rule.id,
      defaultConfidentialityId: confidentiality.id,
      revisionLabelStyle: RevisionLabelStyle.NUMERIC,
      isActive: true,
      fields: [],
    }),
  );
  documentTypeId = type.id;
}
