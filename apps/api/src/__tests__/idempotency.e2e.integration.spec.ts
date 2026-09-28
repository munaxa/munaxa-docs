import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Permission } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { ScryptPasswordHasher } from '../modules/identity/infrastructure/scrypt-password-hasher';

/**
 * `Idempotency-Key` under concurrency, over real HTTP — RC validation, D-20.
 *
 * Reproduced live first: five simultaneous `POST /documents` under one key created four documents,
 * and a second run five. The interceptor looked the key up, ran the request and stored the answer
 * afterwards, so every request that arrived before the first one finished found nothing and ran.
 *
 * What is asserted here is the effect, counted in the databases — documents, audit rows, outbox
 * events and blob references — not the interceptor's opinion of itself. Two application instances
 * are booted, each with its own container, connection pools and interceptor, and the racing requests
 * alternate between them: a fix that serialised requests inside one process would pass a
 * single-instance test and fail this one. Two tenants live in two databases (ADR-0015), so the
 * isolation assertions are about the architecture rather than a `WHERE` clause.
 *
 * Queue consumers are off; nothing here depends on an event being delivered, only on its being
 * written once.
 */

const ACME_APP_URL = process.env['DATABASE_URL'] ?? '';
const ACME_OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const RIVAL_APP_URL = process.env['SECOND_DATABASE_URL'] ?? '';
const RIVAL_OWNER_URL = process.env['SECOND_DATABASE_MIGRATION_URL'] ?? '';
const PASSWORD = 'correct horse battery staple';

const ACME = uuidv7();
const RIVAL = uuidv7();
const ACME_SLUG = `idem-a-${ACME.replaceAll('-', '').slice(-10)}`;
const RIVAL_SLUG = `idem-r-${RIVAL.replaceAll('-', '').slice(-10)}`;

delete process.env['TENANT_ID'];
delete process.env['TENANT_SLUG'];
process.env['QUEUE_CONSUMERS_ENABLED'] = 'false';
process.env['TENANT_CATALOGUE'] = JSON.stringify({
  tenants: [
    {
      id: ACME,
      slug: ACME_SLUG,
      database: { url: ACME_APP_URL, migrationUrl: ACME_OWNER_URL },
      storage: { driver: 'LOCAL', container: 'munaxa-docs', prefix: ACME_SLUG },
      search: { index: `docs-${ACME_SLUG}` },
    },
    {
      id: RIVAL,
      slug: RIVAL_SLUG,
      database: { url: RIVAL_APP_URL, migrationUrl: RIVAL_OWNER_URL },
      storage: { driver: 'LOCAL', container: 'munaxa-docs', prefix: RIVAL_SLUG },
      search: { index: `docs-${RIVAL_SLUG}` },
    },
  ],
});

interface Tenancy {
  readonly id: string;
  readonly slug: string;
  readonly owner: PrismaClient;
  readonly email: string;
  folderId: string;
  documentTypeId: string;
  token: string;
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
}

const apps: INestApplication[] = [];
/** One base URL per application instance. */
const instances: string[] = [];

let acme: Tenancy;
let rival: Tenancy;

async function send(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Reply['body'] = null;
  try {
    parsed = JSON.parse(text) as Reply['body'];
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

function create(tenancy: Tenancy, instance: number, body: unknown, key: string): Promise<Reply> {
  return send(instances[instance % instances.length] ?? '', '/api/v1/documents', body, {
    Authorization: `Bearer ${tenancy.token}`,
    'Idempotency-Key': key,
  });
}

/** A blob in the tenant's store, scanned as the test needs it. Rows: bytes are not the subject. */
async function blob(tenancy: Tenancy, scanStatus: 'CLEAN' | 'PENDING' = 'CLEAN'): Promise<string> {
  const id = uuidv7();
  await tenancy.owner.fileObject.create({
    data: {
      id,
      tenantId: tenancy.id,
      checksumSha256: id.replaceAll('-', '').padEnd(64, '0'),
      sizeBytes: BigInt(2_048),
      mimeType: 'application/pdf',
      storageKey: `documents/${id}.pdf`,
      storageDriver: 'LOCAL',
      scanStatus,
      refCount: 0,
    },
  });
  return id;
}

function documentBody(
  tenancy: Tenancy,
  title: string,
  fileObjectId: string,
): Record<string, unknown> {
  return {
    folderId: tenancy.folderId,
    documentTypeId: tenancy.documentTypeId,
    title,
    fileObjectId,
    filename: 'procedure.pdf',
    // Deliberately acknowledged: the duplicate-content check (D-21, recorded) must not be what stops
    // the second document. Only the idempotency claim may.
    acknowledgeDuplicate: true,
  };
}

/** The effects one creation leaves, counted where they live. */
async function effects(
  tenancy: Tenancy,
  title: string,
  fileObjectId: string,
): Promise<{ documents: string[]; audit: number; outbox: number; refCount: number }> {
  const documents = await tenancy.owner.document.findMany({
    where: { tenantId: tenancy.id, title },
    select: { id: true },
  });
  const ids = documents.map((document) => document.id);
  const audit = await tenancy.owner.auditEvent.count({ where: { subjectId: { in: ids } } });
  const outbox = await tenancy.owner.outboxMessage.count({
    where: { aggregateId: { in: ids }, eventType: 'document.created' },
  });
  const file = await tenancy.owner.fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
  return { documents: ids, audit, outbox, refCount: file.refCount };
}

async function claims(tenancy: Tenancy, key: string): Promise<number> {
  return tenancy.owner.idempotencyKey.count({ where: { tenantId: tenancy.id, key } });
}

async function seed(tenancy: Tenancy, name: string): Promise<void> {
  const { owner, id: tenantId } = tenancy;
  await owner.tenant.create({ data: { id: tenantId, slug: tenancy.slug, name, status: 'ACTIVE' } });
  const roleId = uuidv7();
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
    await tx.role.create({
      data: {
        id: roleId,
        tenantId,
        key: 'AUTHOR',
        name: 'Author',
        isSystem: false,
        permissions: {
          create: [Permission.DOCUMENT_VIEW, Permission.DOCUMENT_CREATE].map((permission) => ({
            tenantId,
            permission,
          })),
        },
      },
    });
    await tx.user.create({
      data: {
        id: uuidv7(),
        tenantId,
        email: tenancy.email,
        emailNormalized: tenancy.email,
        displayName: 'Author',
        status: 'ACTIVE',
        passwordHash: await new ScryptPasswordHasher().hash(PASSWORD),
        passwordAlgorithm: 'SCRYPT',
        roles: { create: [{ tenantId, roleId }] },
      },
    });
  });

  const confidentialityId = uuidv7();
  const numberingRuleId = uuidv7();
  const libraryId = uuidv7();
  tenancy.documentTypeId = uuidv7();
  tenancy.folderId = uuidv7();
  await owner.confidentialityLevel.create({
    data: { id: confidentialityId, tenantId, code: 'INTERNAL', name: 'Internal', rank: 2 },
  });
  await owner.numberingRule.create({
    data: { id: numberingRuleId, tenantId, key: 'sop', name: 'SOP numbering', segments: [] },
  });
  await owner.documentType.create({
    data: {
      id: tenancy.documentTypeId,
      tenantId,
      code: 'SOP',
      name: 'Standard operating procedure',
      numberingRuleId,
      defaultConfidentialityId: confidentialityId,
    },
  });
  // Owned by the tenant, so a tenant-level role grant reaches the folder.
  await owner.library.create({
    data: { id: libraryId, tenantId, code: 'QMS', name: 'Quality', ownerScopeType: 'TENANT' },
  });
  await owner.folder.create({
    data: {
      id: tenancy.folderId,
      tenantId,
      libraryId,
      name: 'Root',
      path: tenancy.folderId,
      depth: 1,
      isRoot: true,
    },
  });
  await owner.library.update({
    where: { id: libraryId },
    data: { rootFolderId: tenancy.folderId },
  });
}

async function signIn(tenancy: Tenancy): Promise<void> {
  const reply = await send(instances[0] ?? '', '/api/v1/auth/login', {
    email: tenancy.email,
    password: PASSWORD,
    tenant: tenancy.slug,
  });
  if (reply.status !== 200) {
    throw new Error(`Sign-in for ${tenancy.email} answered ${String(reply.status)}.`);
  }
  tenancy.token = String(reply.body?.['accessToken']);
}

async function boot(): Promise<string> {
  const { AppModule } = await import('../app.module');
  const { configureApp } = await import('../bootstrap');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  await app.listen(0);
  apps.push(app);
  return (await app.getUrl()).replace('[::1]', 'localhost');
}

beforeAll(async () => {
  if (!ACME_APP_URL || !ACME_OWNER_URL || !RIVAL_APP_URL || !RIVAL_OWNER_URL) {
    throw new Error(
      'DATABASE_URL, DATABASE_MIGRATION_URL, SECOND_DATABASE_URL and SECOND_DATABASE_MIGRATION_URL ' +
        'must all be set: the cross-tenant assertions need two databases.',
    );
  }
  acme = {
    id: ACME,
    slug: ACME_SLUG,
    owner: new PrismaClient({ datasources: { db: { url: ACME_OWNER_URL } } }),
    email: 'author@acme.idem.test',
    folderId: '',
    documentTypeId: '',
    token: '',
  };
  rival = {
    id: RIVAL,
    slug: RIVAL_SLUG,
    owner: new PrismaClient({ datasources: { db: { url: RIVAL_OWNER_URL } } }),
    email: 'author@rival.idem.test',
    folderId: '',
    documentTypeId: '',
    token: '',
  };
  await seed(acme, 'Acme');
  await seed(rival, 'Rival');

  // A clean limiter, for the reason `auth.e2e.integration.spec.ts` gives.
  const { RedisCacheAdapter } = await import('../infrastructure/cache/redis-cache.adapter');
  const { loadConfig } = await import('../core/config/configuration');
  const cache = new RedisCacheAdapter(loadConfig());
  await cache.deleteByPrefix('rl:');
  await cache.onModuleDestroy();

  instances.push(await boot(), await boot());
  await signIn(acme);
  await signIn(rival);
}, 180_000);

afterAll(async () => {
  for (const app of apps) {
    await app.close();
  }
  await acme?.owner.$disconnect();
  await rival?.owner.$disconnect();
});

describe('five identical requests at once, across two instances (Test 1)', () => {
  it('create one document, with one audit trail, one event and one blob reference', async () => {
    const fileObjectId = await blob(acme);
    const title = `Concurrent ${uuidv7()}`;
    const key = uuidv7();
    const body = documentBody(acme, title, fileObjectId);

    const replies = await Promise.all(
      Array.from({ length: 5 }, (_, i) => create(acme, i, body, key)),
    );

    const created = replies.filter((reply) => reply.status === 201);
    const inProgress = replies.filter(
      (reply) => reply.status === 409 && reply.body?.['code'] === 'REQUEST_IN_PROGRESS',
    );
    expect(created.length + inProgress.length).toBe(5);
    expect(created.length).toBeGreaterThanOrEqual(1);
    // Every answer that carries a document names the same one.
    expect(new Set(created.map((reply) => reply.body?.['id'])).size).toBe(1);

    const after = await effects(acme, title, fileObjectId);
    expect(after.documents).toHaveLength(1);
    expect(after.documents[0]).toBe(created[0]?.body?.['id']);
    expect(after.outbox).toBe(1);
    expect(after.refCount).toBe(1);
    // The audit rows one creation writes, and no more: a control creation without a key.
    const controlFile = await blob(acme);
    const controlTitle = `Control ${uuidv7()}`;
    const control = await send(
      instances[0] ?? '',
      '/api/v1/documents',
      documentBody(acme, controlTitle, controlFile),
      { Authorization: `Bearer ${acme.token}` },
    );
    expect(control.status).toBe(201);
    expect(after.audit).toBe((await effects(acme, controlTitle, controlFile)).audit);

    // Test 4, on the same key: the retry after completion is the stored answer, from either
    // instance, and creates nothing.
    for (const instance of [0, 1]) {
      const retry = await create(acme, instance, body, key);
      expect(retry.status).toBe(201);
      expect(retry.body?.['id']).toBe(after.documents[0]);
    }
    expect((await effects(acme, title, fileObjectId)).documents).toHaveLength(1);
    expect(await claims(acme, key)).toBe(1);
  });
});

describe('the same key in two tenants at once (Test 2)', () => {
  it('is two independent scopes: one document each, and neither answer names the other’s', async () => {
    const key = uuidv7();
    const acmeFile = await blob(acme);
    const rivalFile = await blob(rival);
    const title = `Shared key ${uuidv7()}`;

    const replies = await Promise.all([
      ...Array.from({ length: 3 }, (_, i) =>
        create(acme, i, documentBody(acme, title, acmeFile), key).then((reply) => ({
          tenant: 'acme',
          reply,
        })),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        create(rival, i + 1, documentBody(rival, title, rivalFile), key).then((reply) => ({
          tenant: 'rival',
          reply,
        })),
      ),
    ]);

    const acmeDocs = (await effects(acme, title, acmeFile)).documents;
    const rivalDocs = (await effects(rival, title, rivalFile)).documents;
    expect(acmeDocs).toHaveLength(1);
    expect(rivalDocs).toHaveLength(1);
    for (const { tenant, reply } of replies) {
      expect([201, 409]).toContain(reply.status);
      if (reply.status === 201) {
        expect(reply.body?.['id']).toBe(tenant === 'acme' ? acmeDocs[0] : rivalDocs[0]);
      }
    }
    // Each tenant's replay is its own.
    expect((await create(rival, 0, documentBody(rival, title, rivalFile), key)).body?.['id']).toBe(
      rivalDocs[0],
    );
    expect((await create(acme, 1, documentBody(acme, title, acmeFile), key)).body?.['id']).toBe(
      acmeDocs[0],
    );
  });
});

describe('the same key with different bodies at once (Test 3)', () => {
  it('performs each distinct request once, and never answers one with the other’s result', async () => {
    const key = uuidv7();
    const fileA = await blob(acme);
    const fileB = await blob(acme);
    const titleA = `Body A ${uuidv7()}`;
    const titleB = `Body B ${uuidv7()}`;

    const replies = await Promise.all([
      ...Array.from({ length: 3 }, (_, i) =>
        create(acme, i, documentBody(acme, titleA, fileA), key).then((reply) => ({
          want: titleA,
          reply,
        })),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        create(acme, i + 1, documentBody(acme, titleB, fileB), key).then((reply) => ({
          want: titleB,
          reply,
        })),
      ),
    ]);

    // The contract since Slice 56: another body is another request, performed on its own.
    expect((await effects(acme, titleA, fileA)).documents).toHaveLength(1);
    expect((await effects(acme, titleB, fileB)).documents).toHaveLength(1);
    for (const { want, reply } of replies) {
      if (reply.status === 201) {
        expect(reply.body?.['title']).toBe(want);
      } else {
        expect(reply.body?.['code']).toBe('REQUEST_IN_PROGRESS');
      }
    }
    expect(await claims(acme, key)).toBe(2);
  });
});

describe('a request that fails (Test 5)', () => {
  it('gives the key back: the same request, retried once it can succeed, is performed', async () => {
    const key = uuidv7();
    // Refused at a deterministic boundary: content the scanner has not cleared (D-3's gate).
    const fileObjectId = await blob(acme, 'PENDING');
    const title = `Fails first ${uuidv7()}`;
    const body = documentBody(acme, title, fileObjectId);

    const concurrent = await Promise.all(
      Array.from({ length: 5 }, (_, i) => create(acme, i, body, key)),
    );
    for (const reply of concurrent) {
      expect(['CONTENT_NOT_SCANNED', 'REQUEST_IN_PROGRESS']).toContain(reply.body?.['code']);
    }
    expect((await effects(acme, title, fileObjectId)).documents).toHaveLength(0);
    // Nothing left holding the key: not a stored failure, not a stuck claim.
    expect(await claims(acme, key)).toBe(0);

    const refused = await create(acme, 0, body, key);
    expect(refused.body?.['code']).toBe('CONTENT_NOT_SCANNED');

    await acme.owner.fileObject.update({
      where: { id: fileObjectId },
      data: { scanStatus: 'CLEAN' },
    });
    const retried = await create(acme, 1, body, key);
    expect(retried.status).toBe(201);
    expect((await effects(acme, title, fileObjectId)).documents).toEqual([retried.body?.['id']]);
  });

  it('frees a key whose owner died mid-request once the claim’s lease runs out', async () => {
    const key = uuidv7();
    const fileObjectId = await blob(acme);
    const title = `Abandoned ${uuidv7()}`;
    const body = documentBody(acme, title, fileObjectId);
    const { fingerprint } = await import('../core/http/idempotency.interceptor');
    // The row a process leaves when it dies after claiming and before answering.
    await acme.owner.$executeRaw`
      INSERT INTO idempotency_key (id, tenant_id, key, request_method, request_path, request_hash,
                                   state, owner_token, lease_expires_at, expires_at)
      VALUES (${uuidv7()}::uuid, ${ACME}::uuid, ${key}, 'POST', '/api/v1/documents',
              ${fingerprint(body)}, 'IN_PROGRESS', ${uuidv7()}::uuid,
              now() + interval '1 hour', now() + interval '1 day')`;

    const blocked = await create(acme, 0, body, key);
    expect(blocked.status).toBe(409);
    expect(blocked.body?.['code']).toBe('REQUEST_IN_PROGRESS');
    expect((await effects(acme, title, fileObjectId)).documents).toHaveLength(0);

    await acme.owner.$executeRaw`
      UPDATE idempotency_key SET lease_expires_at = now() - interval '1 second' WHERE key = ${key}`;
    const taken = await create(acme, 1, body, key);
    expect(taken.status).toBe(201);
    expect((await effects(acme, title, fileObjectId)).documents).toHaveLength(1);
  });
});
