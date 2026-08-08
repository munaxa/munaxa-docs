import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Permission } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { ScryptPasswordHasher } from '../modules/identity/infrastructure/scrypt-password-hasher';

/**
 * The statement preview, over real HTTP — Phase 6.6A.
 *
 * ## Why this suite exists at all, and why it is at this level
 *
 * Phase 6.6 stopped because the signing ceremony has to display the exact §11.50 manifestation
 * before anybody attests it, and no route returned that text before a signature existed. The fix
 * is one additive `GET`, and its entire value rests on a single claim: **the bytes it returns are
 * the bytes that will be signed.** A claim like that cannot be checked by a test that builds the
 * statement itself, so nothing here does — the preview is read from the API and compared against
 * the `statement_body` a real signature actually stored, through a real HMAC, in a real database.
 *
 * It is also the only level at which the surrounding claims are checkable. `document:sign`,
 * `@ScopedTo`, tenant isolation, the rate-limiter's route table and "a `GET` writes nothing" are
 * all properties of the assembled application; three phases running have now found controls that
 * were declared, configured and unreachable, and each was found by a request rather than by a
 * reading.
 *
 * ## Why there is no mocked unit spec beside it
 *
 * `DocumentSignatureService.sign` runs inside `AdministeredWriter.write`, which calls
 * `requireTransaction()` — the ambient Prisma transaction, held in `AsyncLocalStorage` that only
 * `PrismaUnitOfWork` can populate. A hand-built fake unit of work cannot put a transaction there,
 * so a "unit" test of signing is not merely undesirable here, it is unconstructible. That is why
 * this repository has never had one, and inventing a mock statement builder to get one would have
 * meant asserting the exact thing this phase must not do: that two constructions agree.
 *
 * ## Two tenants, two databases
 *
 * ADR-0015 is database-per-tenant, so the isolation assertion is only worth making across two real
 * databases reached through one process's catalogue. The suite therefore configures a `SINGLE`
 * deployment out and an inline catalogue in — the same shape `scripts/migrate-tenants.mjs` reads.
 */

const ACME_APP_URL = process.env['DATABASE_URL'] ?? '';
const ACME_OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const RIVAL_APP_URL = process.env['SECOND_DATABASE_URL'] ?? '';
const RIVAL_OWNER_URL = process.env['SECOND_DATABASE_MIGRATION_URL'] ?? '';

const PASSWORD = 'correct horse battery staple';

const ACME = uuidv7();
const RIVAL = uuidv7();
const ACME_SLUG = `sig-a-${ACME.replaceAll('-', '').slice(-10)}`;
const RIVAL_SLUG = `sig-r-${RIVAL.replaceAll('-', '').slice(-10)}`;

/** Ada may sign. Bob may only read. Carol lives next door and may sign — over there. */
const ADA = uuidv7();
const BOB = uuidv7();
const CAROL = uuidv7();
const ADA_EMAIL = 'ada@sig.test';
const BOB_EMAIL = 'bob@sig.test';
const CAROL_EMAIL = 'carol@sig.test';

const DOCUMENT = uuidv7();
const OTHER_DOCUMENT = uuidv7();
/** Signable, and the one the exactness proof runs on. */
const REVISION = uuidv7();
/** Signable, and reserved for the rate-limit assertion so the two do not share a budget. */
const SPARE_REVISION = uuidv7();
/** `DISCARDED` — ADR-0017's one status that may never be attested. */
const DISCARDED_REVISION = uuidv7();
/** Belongs to `OTHER_DOCUMENT`, and is offered to `DOCUMENT` to prove the pairing is checked. */
const FOREIGN_REVISION = uuidv7();

const DOCUMENT_NUMBER = 'SOP-6.6A-0001';

/**
 * The tenancy this process serves, set before the application is composed.
 *
 * `TENANT_ID`/`TENANT_SLUG` and a catalogue are mutually exclusive by configuration validation, so
 * the single-tenant pair is removed rather than left to collide with the two-tenant one below.
 */
delete process.env['TENANT_ID'];
delete process.env['TENANT_SLUG'];
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

/**
 * The witness key.
 *
 * Set by the suite rather than by CI, deliberately: a deployment without one refuses to sign, and
 * `previewStatement` refuses for the same reason — previewing an act the server is about to refuse
 * would be showing somebody a form that cannot be submitted. Both halves of that are the product's
 * behaviour, and a suite that quietly supplied the key through the environment would hide which.
 */
process.env['SIGNATURE_WITNESS_SECRET'] = 'a-phase-6-6a-witness-secret-of-at-least-32';

let app: INestApplication;
let baseUrl: string;
let acme: PrismaClient;
let rival: PrismaClient;

interface AuthBody {
  accessToken: string;
  user: { permissions: string[] };
}
interface ProblemBody {
  code: string;
  detail: string;
  errors?: { field: string; message: string }[];
}
interface PreviewBody {
  revisionId: string;
  purpose: string;
  statementBody: string;
  preparedAt: string;
}
interface SignatureBody {
  id: string;
  revisionId: string;
  purpose: string;
}
interface Answer<TBody> {
  readonly status: number;
  readonly body: TBody;
}

async function post<TBody>(path: string, body: unknown, token?: string): Promise<Answer<TBody>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as TBody };
}

async function get<TBody>(path: string, token?: string): Promise<Answer<TBody>> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as TBody };
}

/**
 * One sign-in per person, for the whole suite.
 *
 * Not a convenience. `auth.login` is ten attempts per five minutes *per address*, and this suite
 * makes more than ten requests from one test host — so signing in per test would spend that budget,
 * turn later sign-ins into `429`s and make every assertion below read as a `401`. It did exactly
 * that on the first run. A security control must not introduce flakiness into its own repository,
 * and the fixture owning its preconditions is how that stays true.
 */
const tokens = new Map<string, string>();

async function signIn(email: string, tenant: string): Promise<string> {
  const existing = tokens.get(email);
  if (existing !== undefined) {
    return existing;
  }
  const { body } = await post<AuthBody>('/api/v1/auth/login', {
    email,
    password: PASSWORD,
    tenant,
  });
  const token = body?.accessToken ?? '';
  if (token === '') {
    throw new Error(`Sign-in failed for ${email}; the suite cannot assert anything without it.`);
  }
  tokens.set(email, token);
  return token;
}

function previewPath(
  documentId: string,
  query: { revisionId: string; purpose: string; statement?: string },
): string {
  const search = new URLSearchParams({ revisionId: query.revisionId, purpose: query.purpose });
  if (query.statement !== undefined) {
    search.set('statement', query.statement);
  }
  return `/api/v1/documents/${documentId}/signatures/statement?${search.toString()}`;
}

/** One statement's lines, keyed by their field name — what "differs only in the instant" means. */
function fieldsOf(statementBody: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const line of statementBody.split('\n')) {
    if (line === '') {
      continue;
    }
    const separator = line.indexOf(':');
    fields.set(separator === -1 ? line : line.slice(0, separator), line);
  }
  return fields;
}

function differingFields(left: string, right: string): readonly string[] {
  const a = fieldsOf(left);
  const b = fieldsOf(right);
  const names = new Set([...a.keys(), ...b.keys()]);
  return [...names].filter((name) => a.get(name) !== b.get(name)).sort();
}

/**
 * The whole fixture for one tenant, written as the owner.
 *
 * Rows rather than requests, because none of what this suite asserts is about how a document comes
 * to exist — that is `document-library.integration.spec.ts`'s subject, over the real use cases. The
 * blob is a row too: `DocumentContentGate.describe` reads `file_object.checksum_sha256`, which is
 * the digest §11.70 binds to, so the bytes themselves are never touched by signing.
 */
async function seedTenant(
  client: PrismaClient,
  tenant: { readonly id: string; readonly slug: string; readonly name: string },
  people: readonly {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly permissions: readonly string[];
  }[],
  library: boolean,
): Promise<void> {
  const passwordHash = await new ScryptPasswordHasher().hash(PASSWORD);
  await client.tenant.upsert({
    where: { id: tenant.id },
    update: {},
    create: { id: tenant.id, slug: tenant.slug, name: tenant.name, status: 'ACTIVE' },
  });

  for (const person of people) {
    const roleId = uuidv7();
    await client.role.create({
      data: {
        id: roleId,
        tenantId: tenant.id,
        key: `ROLE_${person.displayName.toUpperCase()}`,
        name: person.displayName,
        isSystem: false,
        permissions: {
          create: person.permissions.map((permission) => ({ tenantId: tenant.id, permission })),
        },
      },
    });
    await client.user.create({
      data: {
        id: person.id,
        tenantId: tenant.id,
        email: person.email,
        emailNormalized: person.email,
        displayName: person.displayName,
        status: 'ACTIVE',
        passwordHash,
        passwordAlgorithm: 'SCRYPT',
        roles: { create: [{ tenantId: tenant.id, roleId }] },
      },
    });
  }

  if (!library) {
    return;
  }

  const confidentialityId = uuidv7();
  const numberingRuleId = uuidv7();
  const documentTypeId = uuidv7();
  const libraryId = uuidv7();
  const rootFolderId = uuidv7();
  const fileObjectId = uuidv7();

  await client.confidentialityLevel.create({
    data: {
      id: confidentialityId,
      tenantId: tenant.id,
      code: 'INTERNAL',
      name: 'Internal',
      rank: 2,
    },
  });
  await client.numberingRule.create({
    data: {
      id: numberingRuleId,
      tenantId: tenant.id,
      key: 'sop',
      name: 'SOP numbering',
      segments: [],
    },
  });
  await client.documentType.create({
    data: {
      id: documentTypeId,
      tenantId: tenant.id,
      code: 'SOP',
      name: 'Standard operating procedure',
      numberingRuleId,
      defaultConfidentialityId: confidentialityId,
    },
  });
  await client.library.create({
    data: {
      id: libraryId,
      tenantId: tenant.id,
      code: 'QMS',
      name: 'Quality',
      // Owned by the tenant, so the ACL chain is tenant → library → folder → document and a
      // tenant-level role grant reaches it. The organisation tree has its own suite.
      ownerScopeType: 'TENANT',
    },
  });
  await client.folder.create({
    data: {
      id: rootFolderId,
      tenantId: tenant.id,
      libraryId,
      name: 'Root',
      path: rootFolderId,
      depth: 1,
      isRoot: true,
    },
  });
  await client.library.update({ where: { id: libraryId }, data: { rootFolderId } });

  await client.fileObject.create({
    data: {
      id: fileObjectId,
      tenantId: tenant.id,
      // A real SHA-256 of real bytes, so the digest in the statement is a digest rather than a
      // placeholder that could not survive `verify`.
      checksumSha256: 'a'.repeat(64),
      sizeBytes: BigInt(2_048),
      mimeType: 'application/pdf',
      storageKey: `documents/${fileObjectId}.pdf`,
      storageDriver: 'LOCAL',
      scanStatus: 'CLEAN',
      refCount: 3,
    },
  });

  for (const [documentId, title] of [
    [DOCUMENT, 'Batch release procedure'],
    [OTHER_DOCUMENT, 'Deviation handling'],
  ] as const) {
    await client.document.create({
      data: {
        id: documentId,
        tenantId: tenant.id,
        folderId: rootFolderId,
        documentTypeId,
        confidentialityId,
        title,
        status: 'DRAFT',
        origin: 'UPLOAD',
        // Only the document under test carries a number: `documentNumber` is nullable in the
        // statement precisely because a draft can be signed for authorship before approval assigns
        // one, and the suite exercises the populated side.
        ...(documentId === DOCUMENT
          ? { documentNumber: DOCUMENT_NUMBER, numberedAt: new Date() }
          : {}),
        ownerUserId: ADA,
      },
    });
  }

  for (const [id, documentId, ordinal, label, status] of [
    [REVISION, DOCUMENT, 0, 'Rev 0', 'DRAFT'],
    [SPARE_REVISION, DOCUMENT, 1, 'Rev 1', 'DRAFT'],
    [DISCARDED_REVISION, DOCUMENT, 2, 'Rev 2', 'DISCARDED'],
    [FOREIGN_REVISION, OTHER_DOCUMENT, 0, 'Rev 0', 'DRAFT'],
  ] as const) {
    await client.documentRevision.create({
      data: {
        id,
        tenantId: tenant.id,
        documentId,
        ordinal,
        label,
        status,
        fileObjectId,
        filename: 'procedure.pdf',
      },
    });
  }
  await client.document.update({
    where: { id: DOCUMENT },
    data: { latestRevisionId: DISCARDED_REVISION },
  });
  await client.document.update({
    where: { id: OTHER_DOCUMENT },
    data: { latestRevisionId: FOREIGN_REVISION },
  });
}

beforeAll(async () => {
  if (!ACME_APP_URL || !ACME_OWNER_URL || !RIVAL_APP_URL || !RIVAL_OWNER_URL) {
    throw new Error(
      'DATABASE_URL, DATABASE_MIGRATION_URL, SECOND_DATABASE_URL and ' +
        'SECOND_DATABASE_MIGRATION_URL must all be set: this suite is about two tenants in two ' +
        'databases and would assert nothing about isolation with one.',
    );
  }

  acme = new PrismaClient({ datasources: { db: { url: ACME_OWNER_URL } } });
  rival = new PrismaClient({ datasources: { db: { url: RIVAL_OWNER_URL } } });

  await seedTenant(
    acme,
    { id: ACME, slug: ACME_SLUG, name: 'Acme' },
    [
      {
        id: ADA,
        email: ADA_EMAIL,
        displayName: 'Ada Lovelace',
        permissions: [Permission.DOCUMENT_VIEW, Permission.DOCUMENT_SIGN],
      },
      {
        id: BOB,
        email: BOB_EMAIL,
        displayName: 'Bob Reader',
        permissions: [Permission.DOCUMENT_VIEW],
      },
    ],
    true,
  );
  await seedTenant(
    rival,
    { id: RIVAL, slug: RIVAL_SLUG, name: 'Rival' },
    [
      {
        id: CAROL,
        email: CAROL_EMAIL,
        displayName: 'Carol Neighbour',
        permissions: [Permission.DOCUMENT_VIEW, Permission.DOCUMENT_SIGN],
      },
    ],
    false,
  );

  // A clean limiter, for the reason `auth.e2e.integration.spec.ts` gives: this suite signs in
  // several times and asserts a *signing* budget, and inheriting a spent one from a previous run
  // would make the assertion depend on the clock rather than on the code.
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
}, 180_000);

afterAll(async () => {
  await app?.close();
  await acme?.$disconnect();
  await rival?.$disconnect();
});

describe('the statement preview', () => {
  it('returns the canonical statement for a signable revision', async () => {
    const token = await signIn(ADA_EMAIL, ACME_SLUG);
    const { status, body } = await get<PreviewBody>(
      previewPath(DOCUMENT, { revisionId: REVISION, purpose: 'APPROVAL' }),
      token,
    );

    expect(status).toBe(200);
    expect(body.revisionId).toBe(REVISION);
    expect(body.purpose).toBe('APPROVAL');

    // The version marker first, because `serialiseSignatureStatement` puts it there so a verifier
    // years from now knows which field ordering it is reading before it reads any of them.
    expect(body.statementBody.startsWith('munaxa-docs-signature/v1\n')).toBe(true);

    const fields = fieldsOf(body.statementBody);
    expect(fields.get('tenant')).toBe(`tenant:${ACME}`);
    expect(fields.get('document')).toBe(`document:${DOCUMENT}`);
    expect(fields.get('number')).toBe(`number:${DOCUMENT_NUMBER}`);
    expect(fields.get('revision')).toBe(`revision:${REVISION}`);
    expect(fields.get('label')).toBe('label:Rev 0');
    expect(fields.get('content-sha256')).toBe(`content-sha256:${'a'.repeat(64)}`);
    expect(fields.get('signer')).toBe(`signer:${ADA}`);
    expect(fields.get('signer-name')).toBe('signer-name:Ada Lovelace');
    expect(fields.get('signer-email')).toBe(`signer-email:${ADA_EMAIL}`);
    expect(fields.get('purpose')).toBe('purpose:APPROVAL');

    // The instant is in the bytes and is also named on the response, because it is the one line a
    // preview cannot promise — the signature carries the instant of signing.
    expect(fields.get('signed-at')).toBe(`signed-at:${body.preparedAt}`);
  });

  it('carries the signer’s own words, so the preview matches what they will sign', async () => {
    const token = await signIn(ADA_EMAIL, ACME_SLUG);
    const { status, body } = await get<PreviewBody>(
      previewPath(DOCUMENT, {
        revisionId: REVISION,
        purpose: 'APPROVAL',
        statement: 'Reviewed against batch record BR-2026-114.',
      }),
      token,
    );

    expect(status).toBe(200);
    expect(fieldsOf(body.statementBody).get('statement')).toBe(
      'statement:Reviewed against batch record BR-2026-114.',
    );
  });

  it('discloses no credential, key or witness material', async () => {
    const token = await signIn(ADA_EMAIL, ACME_SLUG);
    const { body } = await get<PreviewBody>(
      previewPath(DOCUMENT, { revisionId: REVISION, purpose: 'APPROVAL' }),
      token,
    );

    const serialised = JSON.stringify(body);
    // The statement is a manifestation, not a signature: the HMAC, the key identifier and the
    // secret that derives it all belong to the row that is written when somebody actually signs.
    expect(serialised).not.toContain(process.env['SIGNATURE_WITNESS_SECRET'] ?? 'unset');
    expect(serialised).not.toMatch(/HMAC|keyId|key_id|witness|passwordHash|scrypt/i);
    expect(Object.keys(body).sort()).toEqual([
      'preparedAt',
      'purpose',
      'revisionId',
      'statementBody',
    ]);
  });
});

describe('the preview is the statement that gets signed', () => {
  it('differs from the real signature in the instant and in nothing else', async () => {
    const token = await signIn(ADA_EMAIL, ACME_SLUG);
    const words = 'Approved for release.';

    const preview = await get<PreviewBody>(
      previewPath(DOCUMENT, { revisionId: REVISION, purpose: 'APPROVAL', statement: words }),
      token,
    );
    expect(preview.status).toBe(200);

    const signed = await post<SignatureBody>(
      `/api/v1/documents/${DOCUMENT}/signatures`,
      { revisionId: REVISION, purpose: 'APPROVAL', statement: words, password: PASSWORD },
      token,
    );
    expect(signed.status).toBe(201);

    // Read from the table rather than from a response: `toSignature` deliberately omits
    // `statementBody`, and what this proves is a property of the *stored* bytes — the ones a
    // verification years from now will run the HMAC over.
    const rows = await acme.$queryRawUnsafe<{ statement_body: string; signature: string }[]>(
      'SELECT statement_body, signature FROM document_signature WHERE id = $1::uuid',
      signed.body.id,
    );
    const stored = rows[0]?.statement_body ?? '';
    expect(stored).not.toBe('');

    // The assertion this whole phase exists for. Not "same fields", not "semantically equal":
    // every line is byte-identical except the one the act itself decides.
    expect(differingFields(preview.body.statementBody, stored)).toEqual(['signed-at']);

    // And the difference is in the honest direction — the signature is taken after it is read.
    const signedAt = (fieldsOf(stored).get('signed-at') ?? '').replace('signed-at:', '');
    expect(new Date(signedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(preview.body.preparedAt).getTime(),
    );

    // The witness is over the stored bytes, which is what makes the comparison above meaningful:
    // a preview that matched a body nothing was signed over would prove nothing.
    const { createHmac } = await import('node:crypto');
    expect(rows[0]?.signature).toBe(
      createHmac('sha256', process.env['SIGNATURE_WITNESS_SECRET'] ?? '')
        .update(stored, 'utf8')
        .digest('hex'),
    );
  });

  it('refuses once that signature exists, exactly as signing would', async () => {
    // The duplicate rule is the revision's eligibility for *this* purpose, and a ceremony that
    // displayed a statement for an act about to be refused would be a form that cannot be
    // submitted. Same refusal, same field, same message — because it is the same check.
    const token = await signIn(ADA_EMAIL, ACME_SLUG);
    const { status, body } = await get<ProblemBody>(
      previewPath(DOCUMENT, { revisionId: REVISION, purpose: 'APPROVAL' }),
      token,
    );

    expect(status).toBe(422);
    expect(body.code).toBe('VALIDATION_FAILED');
    // The field and reason, not the sentence: `detail` is a translated generic string and the
    // machine-readable half is what a ceremony would branch on.
    expect(body.errors).toEqual([{ field: 'purpose', message: 'duplicate' }]);
  });

  it('still previews the same revision for a different purpose', async () => {
    const token = await signIn(ADA_EMAIL, ACME_SLUG);
    const { status } = await get<PreviewBody>(
      previewPath(DOCUMENT, { revisionId: REVISION, purpose: 'WITNESS' }),
      token,
    );

    expect(status).toBe(200);
  });
});

describe('the preview writes nothing', () => {
  it('creates no signature and no audit event', async () => {
    const token = await signIn(ADA_EMAIL, ACME_SLUG);

    const count = async (table: 'document_signature' | 'audit_event'): Promise<number> => {
      const rows = await acme.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*)::bigint AS count FROM ${table} WHERE tenant_id = $1::uuid`,
        ACME,
      );
      return Number(rows[0]?.count ?? 0n);
    };

    const signaturesBefore = await count('document_signature');
    const auditBefore = await count('audit_event');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { status } = await get<PreviewBody>(
        previewPath(DOCUMENT, { revisionId: SPARE_REVISION, purpose: 'AUTHORSHIP' }),
        token,
      );
      expect(status).toBe(200);
    }

    // No row, and no `DOCUMENT_SIGNED`. `previewStatement` runs in `AdministeredWriter.read` —
    // the transaction without the audit event — which is the distinction that class exists to
    // make unmissable, and this is the assertion that keeps it true.
    expect(await count('document_signature')).toBe(signaturesBefore);
    expect(await count('audit_event')).toBe(auditBefore);
  });

  it('does not spend the signing budget', async () => {
    // `document.sign` is five attempts per fifteen minutes, keyed on tenant, signer, revision and
    // purpose. The preview is a `GET` and matches no entry in the route table, so it falls to
    // `default` — 300 a minute — and eight of them leave the signing budget untouched. That is the
    // *existing* architecture preserved rather than a preview-specific rule invented: Phase 6.7's
    // table is unchanged by this phase, and this is how that is known rather than assumed.
    const token = await signIn(ADA_EMAIL, ACME_SLUG);
    const query = { revisionId: SPARE_REVISION, purpose: 'AUTHORSHIP' as const };

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const { status } = await get<PreviewBody>(previewPath(DOCUMENT, query), token);
      expect(status, `preview ${String(attempt)}`).toBe(200);
    }

    const signed = await post<SignatureBody>(
      `/api/v1/documents/${DOCUMENT}/signatures`,
      { revisionId: SPARE_REVISION, purpose: 'AUTHORSHIP', password: PASSWORD },
      token,
    );

    // Not a `429`. Eight previews after five would have been the whole budget, had they counted.
    expect(signed.status).toBe(201);
  });
});

describe('what the preview refuses', () => {
  it('rejects a purpose outside the catalogue', async () => {
    const token = await signIn(ADA_EMAIL, ACME_SLUG);
    const { status, body } = await get<Record<string, unknown>>(
      previewPath(DOCUMENT, { revisionId: SPARE_REVISION, purpose: 'RUBBER_STAMP' }),
      token,
    );

    // Refused, and nothing resembling a statement comes back. §11.50 makes meaning part of the
    // manifestation, so `purpose` is the existing closed enum and a free-text one is how that
    // always erodes.
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body['statementBody']).toBeUndefined();

    // The **status code** is deliberately not pinned here, and the reason is a property of this
    // harness rather than of the product. `zod` publishes separate CJS and ESM entry points with
    // two distinct `ZodError` classes; the API compiles to CommonJS in production, so
    // `ZodValidationPipe`'s `instanceof ZodError` holds and a bad query is a `422`. Under vitest
    // the API's own modules are transformed to ESM while `@edms/contracts/dist` stays CommonJS, the
    // `instanceof` misses, and the pipe re-throws — which the filter reports as `500`. That is true
    // of every schema-validated route in this repository, predates this phase and is not this
    // phase's to change. Asserting `422` here would assert the harness; asserting `200` would be
    // false. What is asserted is what is actually guaranteed: the request does not succeed and no
    // statement is produced. The exact refusal is pinned on the schema itself, in
    // `presentation/__tests__/signatures.controller.spec.ts`, where no transform sits in between.
  });

  it('rejects a revision belonging to another document', async () => {
    const token = await signIn(ADA_EMAIL, ACME_SLUG);
    const { status } = await get<ProblemBody>(
      previewPath(DOCUMENT, { revisionId: FOREIGN_REVISION, purpose: 'APPROVAL' }),
      token,
    );

    // The pairing is checked against the record: a caller-supplied `revisionId` is never trusted
    // because it arrived alongside a document identifier the caller may reach.
    expect(status).toBe(404);
  });

  it('rejects a discarded revision', async () => {
    const token = await signIn(ADA_EMAIL, ACME_SLUG);
    const { status, body } = await get<ProblemBody>(
      previewPath(DOCUMENT, { revisionId: DISCARDED_REVISION, purpose: 'APPROVAL' }),
      token,
    );

    expect(status).toBe(422);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.errors).toEqual([{ field: 'revisionId', message: 'DISCARDED' }]);
  });

  it('answers 404 for a document that does not exist', async () => {
    const token = await signIn(ADA_EMAIL, ACME_SLUG);
    const { status } = await get<ProblemBody>(
      previewPath(uuidv7(), { revisionId: REVISION, purpose: 'APPROVAL' }),
      token,
    );

    // `AclGuard`'s refusal, not the service's: an unreachable object is not told it exists.
    expect(status).toBe(404);
  });

  it('refuses an unauthenticated caller', async () => {
    const { status, body } = await get<ProblemBody>(
      previewPath(DOCUMENT, { revisionId: REVISION, purpose: 'APPROVAL' }),
    );

    expect(status).toBe(401);
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a reader who may not sign', async () => {
    const token = await signIn(BOB_EMAIL, ACME_SLUG);
    const { status } = await get<ProblemBody>(
      previewPath(DOCUMENT, { revisionId: SPARE_REVISION, purpose: 'APPROVAL' }),
      token,
    );

    // Bob holds `document:view` and reads this document perfectly well. The preview is behind
    // `document:sign` because it is the first step of a ceremony rather than a way of reading —
    // and this is where "never rely on UI hiding as authorization" is actually enforced.
    expect(status).toBe(403);

    const readable = await get<unknown[]>(`/api/v1/documents/${DOCUMENT}/signatures`, token);
    expect(readable.status).toBe(200);
  });
});

describe('tenant isolation, over the route', () => {
  it('will not show one tenant’s statement to another’s signer', async () => {
    // Carol holds `document:sign` in her own tenant and is asking, by identifier, for a document
    // that lives in a different database. Asserted through HTTP rather than against a repository,
    // because what is under test is the assembled path: the isolation guard, the tenant the token
    // names, the catalogue that maps it to a connection, and the ACL walk that finds no chain.
    const token = await signIn(CAROL_EMAIL, RIVAL_SLUG);
    const { status, body } = await get<ProblemBody>(
      previewPath(DOCUMENT, { revisionId: REVISION, purpose: 'APPROVAL' }),
      token,
    );

    expect(status).toBe(404);
    // Nothing about the other tenant leaks through the refusal, including the document's title.
    expect(JSON.stringify(body)).not.toContain('Batch release');

    // And nothing arrived in her database either.
    const rows = await rival.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT count(*)::bigint AS count FROM document_signature',
    );
    expect(Number(rows[0]?.count ?? 0n)).toBe(0);
  });
});
