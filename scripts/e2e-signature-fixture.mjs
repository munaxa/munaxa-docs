#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { ALL_PERMISSIONS, Permission } from '../packages/domain/dist/index.js';

/**
 * The fixture the signing end-to-end test signs against — Phase 6.6.
 *
 * ## Why this is a script rather than part of the test file
 *
 * The browser suite runs inside `apps/web`, which has no Prisma client and should not gain one: the
 * web application talks to the API and to nothing else, and a test helper that reached the database
 * from there would be the first piece of `apps/web` that knew a schema exists. Spawning this from
 * the suite keeps that boundary intact — the test sets up through a process, then behaves like a
 * browser for the rest of its life.
 *
 * ## Rows rather than requests
 *
 * A library, a folder, a document and a revision are written directly. None of that is what the
 * test is about — `document-library.integration.spec.ts` covers how a document comes to exist,
 * through the real use cases — and driving eight screens to reach a signable revision would make
 * this test fail for eight reasons that have nothing to do with signing.
 *
 * What is **not** faked is anything the ceremony touches: the person is real with a real scrypt
 * password hash, the permission grant is a real role, and every request the browser makes from
 * here on goes through the real API.
 *
 * Prints one line of JSON on stdout so the caller can read the identifiers back.
 *
 *   node scripts/e2e-signature-fixture.mjs           seeds, prints JSON
 *   node scripts/e2e-signature-fixture.mjs --cleanup < previously-printed-json
 */

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  throw new Error('DATABASE_MIGRATION_URL must be set.');
}

const client = new PrismaClient({ datasources: { db: { url } } });

if (process.argv.includes('--cleanup')) {
  await cleanup();
  await client.$disconnect();
  process.exit(0);
}

const fixture = await seed();
await client.$disconnect();
process.stdout.write(`${JSON.stringify(fixture)}\n`);

async function seed() {
  const tenantId = randomUUID();
  const slug = `e2e${tenantId.replaceAll('-', '').slice(-10)}`;
  const signerId = randomUUID();
  const readerId = randomUUID();
  const documentId = randomUUID();
  const revisionId = randomUUID();

  const password = 'correct horse battery staple';
  const passwordHash = await scrypt(password);

  await client.tenant.create({
    data: { id: tenantId, slug, name: 'Signing E2E', status: 'ACTIVE' },
  });

  // Two people, and the difference between them is the whole negative case: the signer holds
  // `document:sign`, the reader holds only `document:view`. `document:sign` is seeded to no
  // production role by design (ADR-0017 §5) — this is a test fixture granting it deliberately,
  // through the ordinary role mechanism rather than by widening any shipped role.
  // Two roles differing in **exactly one permission**, and everything else granted.
  //
  // Not laziness. The document screen fetches the folder list, the category list, the
  // confidentiality levels, the user list, the departments, the metadata fields and the document
  // types alongside the document itself — all administrative reads — so a caller holding only
  // `document:view` cannot render the page at all. Granting the whole catalogue to both and
  // removing `document:sign` from one keeps the negative case exact: the reader differs from the
  // signer in the single permission under test and in nothing else, which is a sharper fixture
  // than two narrow roles would be.
  //
  // The values are the catalogue's own — `Permission.DOCUMENT_SIGN` is the string `document:sign`,
  // and `role_permission.permission` stores that rather than the key name. Importing them rather
  // than typing them is what stops this drifting from the enum.
  const signerPermissions = [...ALL_PERMISSIONS];
  const readerPermissions = signerPermissions.filter(
    (permission) => permission !== Permission.DOCUMENT_SIGN,
  );
  const roles = [
    { id: randomUUID(), key: 'E2E_SIGNER', permissions: signerPermissions },
    { id: randomUUID(), key: 'E2E_READER', permissions: readerPermissions },
  ];
  for (const role of roles) {
    await client.role.create({
      data: {
        id: role.id,
        tenantId,
        key: role.key,
        name: role.key,
        isSystem: false,
        permissions: {
          create: role.permissions.map((permission) => ({ tenantId, permission })),
        },
      },
    });
  }

  const people = [
    { id: signerId, email: 'signer@e2e.test', name: 'Ada Lovelace', roleId: roles[0].id },
    { id: readerId, email: 'reader@e2e.test', name: 'Bob Reader', roleId: roles[1].id },
  ];
  for (const person of people) {
    await client.user.create({
      data: {
        id: person.id,
        tenantId,
        email: person.email,
        emailNormalized: person.email,
        displayName: person.name,
        status: 'ACTIVE',
        passwordHash,
        passwordAlgorithm: 'SCRYPT',
        roles: { create: [{ tenantId, roleId: person.roleId }] },
      },
    });
  }

  const confidentialityId = randomUUID();
  const numberingRuleId = randomUUID();
  const documentTypeId = randomUUID();
  const libraryId = randomUUID();
  const folderId = randomUUID();
  const fileObjectId = randomUUID();

  await client.confidentialityLevel.create({
    data: { id: confidentialityId, tenantId, code: 'INTERNAL', name: 'Internal', rank: 2 },
  });
  await client.numberingRule.create({
    data: { id: numberingRuleId, tenantId, key: 'sop', name: 'SOP numbering', segments: [] },
  });
  await client.documentType.create({
    data: {
      id: documentTypeId,
      tenantId,
      code: 'SOP',
      name: 'Standard operating procedure',
      numberingRuleId,
      defaultConfidentialityId: confidentialityId,
    },
  });
  await client.library.create({
    data: { id: libraryId, tenantId, code: 'QMS', name: 'Quality', ownerScopeType: 'TENANT' },
  });
  await client.folder.create({
    data: { id: folderId, tenantId, libraryId, name: 'Root', path: folderId, depth: 1, isRoot: true },
  });
  await client.library.update({ where: { id: libraryId }, data: { rootFolderId: folderId } });

  await client.fileObject.create({
    data: {
      id: fileObjectId,
      tenantId,
      checksumSha256: 'b'.repeat(64),
      sizeBytes: BigInt(2048),
      mimeType: 'application/pdf',
      storageKey: `documents/${fileObjectId}.pdf`,
      storageDriver: 'LOCAL',
      scanStatus: 'CLEAN',
      refCount: 1,
    },
  });

  await client.document.create({
    data: {
      id: documentId,
      tenantId,
      folderId,
      documentTypeId,
      confidentialityId,
      title: 'Batch release procedure',
      status: 'DRAFT',
      origin: 'UPLOAD',
      documentNumber: 'SOP-E2E-0001',
      numberedAt: new Date(),
      ownerUserId: signerId,
    },
  });
  await client.documentRevision.create({
    data: {
      id: revisionId,
      tenantId,
      documentId,
      ordinal: 0,
      label: 'Rev 0',
      status: 'DRAFT',
      fileObjectId,
      filename: 'procedure.pdf',
    },
  });
  await client.document.update({
    where: { id: documentId },
    data: { latestRevisionId: revisionId },
  });

  return {
    tenantId,
    slug,
    password,
    signer: { id: signerId, email: 'signer@e2e.test', name: 'Ada Lovelace' },
    reader: { id: readerId, email: 'reader@e2e.test' },
    documentId,
    revisionId,
    revisionLabel: 'Rev 0',
    documentNumber: 'SOP-E2E-0001',
    contentSha256: 'b'.repeat(64),
  };
}

/** Every tenant this script has ever created in this database, gone. */
async function cleanup() {
  const tenants = await client.tenant.findMany({
    where: { slug: { startsWith: 'e2e' } },
    select: { id: true },
  });
  for (const { id } of tenants) {
    for (const table of [
      'audit_event',
      'document_signature',
      'document_revision',
      'document',
      'folder',
      'library',
      'document_type',
      'numbering_rule',
      'confidentiality_level',
      'file_object',
      'user_role',
      'role_permission',
      'session',
      '"user"',
      'role',
    ]) {
      await client
        .$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, id)
        .catch(() => 0);
    }
    await client.tenant.delete({ where: { id } }).catch(() => null);
  }
}

/**
 * The same scrypt parameters `ScryptPasswordHasher` uses, in the same encoding.
 *
 * Duplicated here rather than imported because this script runs outside the API's module graph.
 * It is asserted by the test itself: if the parameters drifted, the sign-in the browser performs
 * would fail and the whole suite would go red rather than quietly signing in a way production
 * cannot.
 */
async function scrypt(password) {
  const { scrypt: derive, randomBytes } = await import('node:crypto');
  // OWASP's scrypt parameters, exactly as `ScryptPasswordHasher` records them: N = 2^17, r = 8,
  // p = 1, a 16-byte salt and a 32-byte key, joined by `$` after the scheme name. `maxmem` has to
  // be raised because Node's default is 32 MB and these parameters need four times that.
  const n = 2 ** 17;
  const salt = randomBytes(16);
  const key = await new Promise((resolve, reject) => {
    derive(password, salt, 32, { N: n, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, derived) => {
      if (error) {
        reject(error);
      } else {
        resolve(derived);
      }
    });
  });
  return ['scrypt', n, 8, 1, salt.toString('base64'), key.toString('base64')].join('$');
}
