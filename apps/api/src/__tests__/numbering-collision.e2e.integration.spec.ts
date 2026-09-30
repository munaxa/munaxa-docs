import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_PERMISSIONS, Permission } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { ScryptPasswordHasher } from '../modules/identity/infrastructure/scrypt-password-hasher';

/**
 * NUM-1: two numbering series that render the same text, over HTTP, against a real database.
 *
 * Uniqueness of an issued number is the database's — `uq_number_reservation_formatted` — and this
 * suite does not weaken it. What it pins is what the caller gets when a second series draws a value
 * the first already issued: before NUM-1 that was the unique violation, answered as a 500 on every
 * attempt, because the counter's advance rolled back with it and the retry drew the same value. Now
 * it is a controlled `409 DUPLICATE` naming the rule and the value, the transaction rolls back whole,
 * and nothing of the refused submission or decision survives.
 *
 * Two rules with the same literal are a configuration the product accepts — each is valid on its
 * own — so this is the collision validation cannot prevent, and the draw has to refuse. Both draw
 * paths are covered: reservation at submission, and the draw at final approval a gapless rule makes.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';
const PASSWORD = 'correct horse battery staple';

const tenantId = uuidv7();
const slug = `num-${tenantId.replaceAll('-', '').slice(-12)}`;
const admin = { id: uuidv7(), email: `admin@${slug}.test` };
const reviewer = { id: uuidv7(), email: `reviewer@${slug}.test` };
const ROUTING_ROLE_KEY = 'numreviewers';

process.env['TENANT_ID'] = tenantId;
process.env['TENANT_SLUG'] = slug;

let app: INestApplication;
let baseUrl: string;
let owner: PrismaClient;
let adminToken: string;
let reviewerToken: string;

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** The refusal body — RFC 7807 plus the field errors a collision carries. */
interface Problem {
  readonly code: string;
  readonly errors?: readonly { readonly field: string; readonly message: string }[];
}

interface Created {
  readonly id: string;
}

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token !== null && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** The body of a successful reply, typed by the caller that knows the route's shape. */
function ok<TBody = Created>(
  reply: Reply,
  what: string,
  statuses: readonly number[] = [200, 201],
): TBody {
  if (!statuses.includes(reply.status)) {
    throw new Error(`${what}: HTTP ${String(reply.status)} ${JSON.stringify(reply.body)}`);
  }
  return reply.body as TBody;
}

/** Reads inside the tenant, as the owner, the way the other suites do. */
async function inTenant<T>(
  work: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
    return work(tx);
  });
}

interface Setup {
  readonly folderId: string;
  readonly confidentialityId: string;
  readonly workflowId: string;
}
let setup: Setup;

async function rule(key: string, literal: string, gapless: boolean): Promise<string> {
  return ok(
    await call('POST', '/admin/numbering-rules', adminToken, {
      key,
      name: `Rule ${key}`,
      segments: [
        { kind: 'LITERAL', value: literal },
        { kind: 'SEQUENCE', padding: 4 },
      ],
      resetScope: ['NEVER'],
      reserveOnSubmit: !gapless,
      strictGapless: gapless,
    }),
    `rule ${key}`,
  ).id;
}

async function documentType(code: string, numberingRuleId: string): Promise<string> {
  return ok(
    await call('POST', '/admin/document-types', adminToken, {
      code,
      name: `Type ${code}`,
      numberingRuleId,
      workflowDefinitionId: setup.workflowId,
      defaultConfidentialityId: setup.confidentialityId,
    }),
    `type ${code}`,
  ).id;
}

/** A clean blob, as the antivirus gate would leave one, and a draft document filed from it. */
async function draft(documentTypeId: string, title: string): Promise<string> {
  const fileObjectId = uuidv7();
  await owner.fileObject.create({
    data: {
      id: fileObjectId,
      tenantId,
      checksumSha256: uuidv7().replaceAll('-', '').padEnd(64, '0'),
      sizeBytes: BigInt(1_024),
      mimeType: 'application/pdf',
      storageKey: `documents/${fileObjectId}.pdf`,
      storageDriver: 'LOCAL',
      scanStatus: 'CLEAN',
      refCount: 0,
    },
  });
  return ok(
    await call('POST', '/documents', adminToken, {
      folderId: setup.folderId,
      documentTypeId,
      title,
      fileObjectId,
      filename: 'draft.pdf',
      acknowledgeDuplicate: true,
    }),
    `draft ${title}`,
  ).id;
}

/** Everything a refused submission or decision could have left behind for one document. */
async function footprint(documentId: string, numberingRuleId: string) {
  return inTenant(async (tx) => {
    const instanceIds = (
      await tx.workflowInstance.findMany({ where: { documentId }, select: { id: true } })
    ).map((row) => row.id);
    return {
      document: await tx.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { status: true, documentNumber: true },
      }),
      instances: instanceIds.length,
      runningInstances: await tx.workflowInstance.count({
        where: { documentId, state: 'RUNNING' },
      }),
      tasks: await tx.approvalTask.count({ where: { instanceId: { in: instanceIds } } }),
      decidedTasks: await tx.approvalTask.count({
        where: { instanceId: { in: instanceIds }, decision: { not: null } },
      }),
      reservations: await tx.numberReservation.count({ where: { documentId } }),
      sequences: await tx.numberSequence.count({ where: { numberingRuleId } }),
      audit: await tx.auditEvent.count({ where: { subjectId: documentId } }),
    };
  });
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  const passwordHash = await new ScryptPasswordHasher().hash(PASSWORD);

  await owner.tenant.create({
    data: { id: tenantId, slug, name: 'Numbering Ltd', status: 'ACTIVE' },
  });
  await inTenant(async (tx) => {
    const everything = uuidv7();
    const routing = uuidv7();
    await tx.role.create({
      data: {
        id: everything,
        tenantId,
        key: 'numadmin',
        name: 'Numbering administrator',
        isSystem: false,
        // Everything but deciding, as the seeded tenant administrator holds.
        permissions: {
          create: ALL_PERMISSIONS.filter(
            (permission) =>
              permission !== Permission.DOCUMENT_APPROVE &&
              permission !== Permission.DOCUMENT_REJECT,
          ).map((permission) => ({ tenantId, permission })),
        },
      },
    });
    await tx.role.create({
      data: {
        id: routing,
        tenantId,
        key: ROUTING_ROLE_KEY,
        name: 'Numbering reviewers',
        isSystem: false,
        permissions: {
          create: [Permission.DOCUMENT_VIEW, Permission.DOCUMENT_APPROVE].map((permission) => ({
            tenantId,
            permission,
          })),
        },
      },
    });
    for (const [person, roleId] of [
      [admin, everything],
      [reviewer, routing],
    ] as const) {
      await tx.user.create({
        data: {
          id: person.id,
          tenantId,
          email: person.email,
          emailNormalized: person.email,
          displayName: person.email,
          status: 'ACTIVE',
          passwordHash,
          passwordAlgorithm: 'SCRYPT',
          roles: { create: [{ tenantId, roleId }] },
        },
      });
    }
  });

  const { RedisCacheAdapter } = await import('../infrastructure/cache/redis-cache.adapter');
  const { loadConfig } = await import('../core/config/configuration');
  const cache = new RedisCacheAdapter(loadConfig());
  await cache.deleteByPrefix('rl:');
  await cache.onModuleDestroy();

  const { AppModule } = await import('../app.module');
  const { configureApp } = await import('../bootstrap');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');

  adminToken = ok<{ accessToken: string }>(
    await call('POST', '/auth/login', null, {
      email: admin.email,
      password: PASSWORD,
      tenant: slug,
    }),
    'admin sign-in',
  ).accessToken;
  reviewerToken = ok<{ accessToken: string }>(
    await call('POST', '/auth/login', null, {
      email: reviewer.email,
      password: PASSWORD,
      tenant: slug,
    }),
    'reviewer sign-in',
  ).accessToken;

  const confidentialityId = ok(
    await call('POST', '/admin/confidentiality-levels', adminToken, {
      code: 'INTERNAL',
      name: 'Internal',
      rank: 2,
    }),
    'confidentiality',
  ).id;
  const workflow = ok<{
    id: string;
    version: number;
    versions: { id: string; state: string }[];
  }>(
    await call('POST', '/admin/workflows', adminToken, {
      key: 'numreview',
      name: 'Numbering review',
      definition: {
        stages: [{ name: 'Review', participants: [{ kind: 'ROLE', roleKey: ROUTING_ROLE_KEY }] }],
      },
    }),
    'workflow',
  );
  const version = workflow.versions.find((entry) => entry.state === 'DRAFT');
  ok(
    await call(
      'POST',
      `/admin/workflows/${workflow.id}/versions/${String(version?.id)}/publish`,
      adminToken,
      undefined,
      { 'If-Match': String(workflow.version) },
    ),
    'publish workflow',
  );
  const library = ok<{ rootFolderId: string }>(
    await call('POST', '/admin/libraries', adminToken, {
      code: 'NUM',
      name: 'Numbering',
      ownerScopeType: 'TENANT',
      rootFolderName: 'Root',
    }),
    'library',
  );
  setup = { folderId: library.rootFolderId, confidentialityId, workflowId: workflow.id };
}, 180_000);

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

describe('two numbering series that render the same text (NUM-1)', () => {
  it('refuses the colliding submission with 409, twice, and leaves nothing of it behind', async () => {
    const first = await rule('clxfirst', 'CLX', false);
    const second = await rule('clxsecond', 'CLX', false);
    const firstDocument = await draft(await documentType('CLXA', first), 'First series');
    const secondDocument = await draft(await documentType('CLXB', second), 'Second series');

    ok(await call('POST', `/documents/${firstDocument}/submit`, adminToken, {}), 'first submit');
    expect(
      await inTenant((tx) =>
        tx.numberReservation.findFirstOrThrow({ where: { documentId: firstDocument } }),
      ),
    ).toMatchObject({ formatted: 'CLX-0001', state: 'RESERVED' });

    const before = await footprint(secondDocument, second);

    for (const attempt of [1, 2]) {
      const refused = await call('POST', `/documents/${secondDocument}/submit`, adminToken, {});
      expect(refused.status, `attempt ${String(attempt)}`).toBe(409);
      expect((refused.body as Problem).code).toBe('DUPLICATE');
      expect((refused.body as Problem).errors).toEqual([
        {
          field: 'documentNumber',
          message:
            'NUMBER_SERIES_COLLISION: numbering rule "clxsecond" drew CLX-0001, which is already issued',
        },
      ]);
    }

    const after = await footprint(secondDocument, second);
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      document: { status: 'DRAFT', documentNumber: null },
      instances: 0,
      tasks: 0,
      reservations: 0,
      // The counter's advance rolled back with the refusal — which is also why a retry cannot pass.
      sequences: 0,
    });
    // Uniqueness held: one CLX-0001, owned by the first series.
    expect(
      await inTenant((tx) =>
        tx.numberReservation.count({ where: { tenantId, formatted: 'CLX-0001' } }),
      ),
    ).toBe(1);
  });

  it('refuses the colliding draw at final approval with 409 and leaves the approval undecided', async () => {
    const reserving = await rule('glxreserving', 'GLX', false);
    const gapless = await rule('glxgapless', 'GLX', true);
    const reservingDocument = await draft(
      await documentType('GLXA', reserving),
      'Reserving series',
    );
    const gaplessDocument = await draft(await documentType('GLXB', gapless), 'Gapless series');

    ok(await call('POST', `/documents/${reservingDocument}/submit`, adminToken, {}), 'reserve');
    ok(
      await call('POST', `/documents/${gaplessDocument}/submit`, adminToken, {}),
      'gapless submit',
    );

    const inbox = ok<{ data: { id: string; documentId: string }[] }>(
      await call('GET', '/approval-tasks?pageSize=100', reviewerToken),
      'inbox',
    );
    const task = inbox.data.find((item) => item.documentId === gaplessDocument);
    expect(task, 'the gapless document reached the reviewer').toBeDefined();

    const before = await footprint(gaplessDocument, gapless);
    for (const attempt of [1, 2]) {
      const refused = await call(
        'POST',
        `/approval-tasks/${String(task?.id)}/decision`,
        reviewerToken,
        { decision: 'APPROVED' },
      );
      expect(refused.status, `attempt ${String(attempt)}`).toBe(409);
      expect((refused.body as Problem).code).toBe('DUPLICATE');
      expect((refused.body as Problem).errors?.[0]?.message).toContain(
        '"glxgapless" drew GLX-0001',
      );
    }

    const after = await footprint(gaplessDocument, gapless);
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      document: { documentNumber: null },
      runningInstances: 1,
      decidedTasks: 0,
      reservations: 0,
      sequences: 0,
    });
  });
});
