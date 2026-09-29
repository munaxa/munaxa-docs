import 'reflect-metadata';

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Permission } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { ScryptPasswordHasher } from '../modules/identity/infrastructure/scrypt-password-hasher';

/**
 * Upload → real scanner → document, over real HTTP — RC D-3.
 *
 * The RC found `ANTIVIRUS_PORT` bound to the unconfigured adapter whatever `AV_DRIVER` said: every
 * upload was `SKIPPED` and `POST /documents` refused it `CONTENT_NOT_SCANNED`, and the RC's content
 * paths ran on a ledgered, test-only database update. This suite is the replacement evidence.
 *
 * **Nothing here marks a blob.** Every scan status below was written by the product, from a verdict
 * the ICAP adapter got from c-icap and ClamAV (`AV_ICAP_TEST_URL`, `infra/antivirus/`). The
 * databases are read to count effects, never written to set one.
 *
 * Four application instances share two tenant databases and one object store:
 *
 * - two on the real scanner, so racing requests cross process boundaries;
 * - one whose scanner address has nothing listening — the scanner is down;
 * - one whose scanner accepts and never answers, with the shortest scan timeout configuration
 *   allows — the scanner is hung.
 *
 * Storage is the `LOCAL` driver under the real tenant wrapper: uploads are PUT to the API's own
 * signed transfer endpoint, as a browser does against a single-server installation.
 */

const ACME_APP_URL = process.env['DATABASE_URL'] ?? '';
const ACME_OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const RIVAL_APP_URL = process.env['SECOND_DATABASE_URL'] ?? '';
const RIVAL_OWNER_URL = process.env['SECOND_DATABASE_MIGRATION_URL'] ?? '';
const SCANNER = process.env['AV_ICAP_TEST_URL'] ?? '';
const PASSWORD = 'correct horse battery staple';

const ACME = uuidv7();
const RIVAL = uuidv7();
const ACME_SLUG = `av-a-${ACME.replaceAll('-', '').slice(-10)}`;
const RIVAL_SLUG = `av-r-${RIVAL.replaceAll('-', '').slice(-10)}`;

/** The EICAR test file, assembled at runtime so no file in this repository is itself detected. */
const EICAR = Buffer.from(
  ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''),
  'latin1',
);

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

interface Uploaded {
  readonly fileObjectId: string;
  readonly scanStatus: string | null;
  readonly deduplicated: boolean;
  readonly reply: Record<string, unknown>;
}

const apps: INestApplication[] = [];
let healthy: string[] = [];
let down = '';
let hung = '';
let slow = '';
let slowHung = '';
let erroring = '';
let slowProxy: Server | undefined;
/** Emits `scan` when an instance behind the slow proxy opens a scanner connection — a barrier. */
const slowScans = new EventEmitter();
let storageRoot = '';
let silent: Server | undefined;
const held: Socket[] = [];
const touched = new Set<string>();

let acme: Tenancy;
let rival: Tenancy;

async function call(
  base: string,
  method: string,
  path: string,
  token: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token !== '' && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
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

/** The signed transfer URL, pointed at the instance under test rather than the configured default. */
function onInstance(url: string, base: string): string {
  const signed = new URL(url);
  const target = new URL(base);
  signed.protocol = target.protocol;
  signed.host = target.host;
  return signed.toString();
}

/** Upload exactly as a client does: open a session, PUT the bytes, complete. */
async function upload(
  base: string,
  tenancy: Tenancy,
  bytes: Buffer,
  filename: string,
  mimeType: string,
  options: { announceDigest?: boolean } = {},
): Promise<Uploaded> {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const opened = await call(base, 'POST', '/api/v1/uploads', tenancy.token, {
    filename,
    mimeType,
    sizeBytes: bytes.length,
    magicBytes: bytes.subarray(0, 64).toString('base64'),
    ...(options.announceDigest === true && { checksumSha256: digest }),
  });
  if (opened.status !== 201 || opened.body === null) {
    throw new Error(
      `Opening an upload answered ${String(opened.status)}: ${JSON.stringify(opened.body)}`,
    );
  }
  const already = opened.body['alreadyStored'] as { fileObjectId: string } | null;
  if (already !== null) {
    touched.add(already.fileObjectId);
    return {
      fileObjectId: already.fileObjectId,
      scanStatus: null,
      deduplicated: true,
      reply: opened.body,
    };
  }
  const put = await fetch(onInstance(String(opened.body['url']), base), {
    method: String(opened.body['method']),
    headers: opened.body['headers'] as Record<string, string>,
    body: bytes,
  });
  if (!put.ok) {
    throw new Error(`The transfer answered ${String(put.status)}.`);
  }
  const done = await call(
    base,
    'POST',
    `/api/v1/uploads/${String(opened.body['uploadSessionId'])}/complete`,
    tenancy.token,
    { parts: [] },
  );
  if (done.status !== 201 && done.status !== 200) {
    throw new Error(
      `Completing an upload answered ${String(done.status)}: ${JSON.stringify(done.body)}`,
    );
  }
  const reply = done.body ?? {};
  touched.add(String(reply['fileObjectId']));
  return {
    fileObjectId: String(reply['fileObjectId']),
    scanStatus: String(reply['scanStatus']),
    deduplicated: reply['deduplicated'] === true,
    reply,
  };
}

function fileDocument(
  base: string,
  tenancy: Tenancy,
  fileObjectId: string,
  title: string,
  headers: Record<string, string> = {},
) {
  return call(
    base,
    'POST',
    '/api/v1/documents',
    tenancy.token,
    {
      folderId: tenancy.folderId,
      documentTypeId: tenancy.documentTypeId,
      title,
      fileObjectId,
      filename: 'scanned.pdf',
      acknowledgeDuplicate: true,
    },
    headers,
  );
}

async function blobRow(tenancy: Tenancy, id: string) {
  return tenancy.owner.fileObject.findUniqueOrThrow({ where: { id } });
}

async function scanEvents(tenancy: Tenancy, fileObjectId: string) {
  const rows = await tenancy.owner.outboxMessage.findMany({
    where: {
      aggregateId: fileObjectId,
      eventType: { in: ['storage.scan-completed', 'storage.file-quarantined'] },
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => {
    const payload = row.payload as { status?: string; threat?: string };
    return { type: row.eventType, status: payload.status ?? null, threat: payload.threat ?? null };
  });
}

async function uploadAudit(tenancy: Tenancy, fileObjectId: string) {
  const rows = await tenancy.owner.auditEvent.findMany({
    where: { subjectId: fileObjectId, action: 'FILE_UPLOADED' },
    orderBy: { sequence: 'asc' },
  });
  return rows.map((row) => (row.payload as { after: Record<string, unknown> }).after);
}

/** A small, valid, unique PDF: clean content nobody has uploaded before. */
function aPdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${marker}\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n`, 'latin1');
}

/** A stored zip holding EICAR and a unique note, so each is new content with the same threat. */
function eicarZip(marker: string): Buffer {
  const entries = [
    { name: 'note.txt', data: Buffer.from(`note ${marker}\n`) },
    { name: 'eicar.com', data: EICAR },
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'latin1');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.data);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
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
          create: [
            Permission.DOCUMENT_VIEW,
            Permission.DOCUMENT_CREATE,
            Permission.DOCUMENT_DOWNLOAD,
          ].map((permission) => ({ tenantId, permission })),
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
  const reply = await call(healthy[0] ?? '', 'POST', '/api/v1/auth/login', '', {
    email: tenancy.email,
    password: PASSWORD,
    tenant: tenancy.slug,
  });
  if (reply.status !== 200) {
    throw new Error(`Sign-in for ${tenancy.email} answered ${String(reply.status)}.`);
  }
  tenancy.token = String(reply.body?.['accessToken']);
}

/** One application instance, booted with its own antivirus configuration. */
async function boot(env: Record<string, string>): Promise<string> {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const { AppModule } = await import('../app.module');
    const { configureApp } = await import('../bootstrap');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    await app.listen(0);
    apps.push(app);
    return (await app.getUrl()).replace('[::1]', 'localhost');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ready) => probe.listen(0, '127.0.0.1', ready));
  const { port } = probe.address() as AddressInfo;
  await new Promise((done) => probe.close(done));
  return port;
}

/** How long the slow scanner holds its answer: longer than Prisma's 5,000 ms transaction default. */
const SLOW_SCAN_MS = 6_000;

/**
 * The real scanner, slower — STG-1.
 *
 * A TCP proxy in front of `AV_ICAP_TEST_URL` that forwards the request at once and holds the
 * scanner's answer until {@link SLOW_SCAN_MS} after the connection opened. Every verdict is still
 * c-icap's and ClamAV's own; only its arrival is late, which is what a large file, a loaded engine
 * or a slow network looks like to the API. Each connection announces itself on `slowScans`, so a
 * test can act while a scan is provably in flight rather than after a guessed sleep.
 */
async function delayingProxy(target: URL, delayMs: number): Promise<Server> {
  const server = createServer((client) => {
    held.push(client);
    const opened = Date.now();
    const upstream = connect(Number(target.port === '' ? '1344' : target.port), target.hostname);
    const waiting: Buffer[] = [];
    let released = false;
    let upstreamEnded = false;
    const release = () => {
      released = true;
      for (const chunk of waiting.splice(0)) {
        client.write(chunk);
      }
      if (upstreamEnded) {
        client.end();
      }
    };
    const timer = setTimeout(release, Math.max(0, opened + delayMs - Date.now()));
    upstream.on('data', (chunk: Buffer) => (released ? client.write(chunk) : waiting.push(chunk)));
    upstream.on('end', () => {
      upstreamEnded = true;
      if (released) {
        client.end();
      }
    });
    const close = () => {
      clearTimeout(timer);
      upstream.destroy();
      client.destroy();
    };
    upstream.on('error', close);
    client.on('error', close);
    client.on('close', () => upstream.destroy());
    client.pipe(upstream);
    slowScans.emit('scan');
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return server;
}

beforeAll(async () => {
  if (!ACME_APP_URL || !ACME_OWNER_URL || !RIVAL_APP_URL || !RIVAL_OWNER_URL) {
    throw new Error(
      'DATABASE_URL, DATABASE_MIGRATION_URL, SECOND_DATABASE_URL and SECOND_DATABASE_MIGRATION_URL ' +
        'must all be set: the isolation assertions need two databases.',
    );
  }
  if (SCANNER === '') {
    throw new Error(
      'AV_ICAP_TEST_URL must name a running ICAP antivirus service (infra/antivirus/): every verdict ' +
        'this suite asserts comes from a real scanner.',
    );
  }
  storageRoot = await mkdtemp(join(tmpdir(), 'munaxa-av-'));

  acme = {
    id: ACME,
    slug: ACME_SLUG,
    owner: new PrismaClient({ datasources: { db: { url: ACME_OWNER_URL } } }),
    email: 'author@acme.av.test',
    folderId: '',
    documentTypeId: '',
    token: '',
  };
  rival = {
    id: RIVAL,
    slug: RIVAL_SLUG,
    owner: new PrismaClient({ datasources: { db: { url: RIVAL_OWNER_URL } } }),
    email: 'author@rival.av.test',
    folderId: '',
    documentTypeId: '',
    token: '',
  };
  await seed(acme, 'Acme');
  await seed(rival, 'Rival');

  const { RedisCacheAdapter } = await import('../infrastructure/cache/redis-cache.adapter');
  const { loadConfig } = await import('../core/config/configuration');
  const cache = new RedisCacheAdapter(loadConfig());
  await cache.deleteByPrefix('rl:');
  await cache.onModuleDestroy();

  // A scanner that accepts connections and never answers.
  const server = createServer((socket) => {
    held.push(socket);
    socket.on('error', () => undefined);
  });
  silent = server;
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const hungPort = (server.address() as AddressInfo).port;
  const deadPort = await freePort();

  const common = {
    QUEUE_CONSUMERS_ENABLED: 'false',
    STORAGE_DRIVER: 'LOCAL',
    STORAGE_LOCAL_ROOT: storageRoot,
    AV_DRIVER: 'ICAP',
  };
  healthy = [
    await boot({ ...common, AV_ICAP_URL: SCANNER }),
    await boot({ ...common, AV_ICAP_URL: SCANNER }),
  ];
  down = await boot({ ...common, AV_ICAP_URL: `icap://127.0.0.1:${String(deadPort)}/avscan` });
  hung = await boot({
    ...common,
    AV_ICAP_URL: `icap://127.0.0.1:${String(hungPort)}/avscan`,
    AV_SCAN_TIMEOUT_MS: '1000',
  });
  // STG-1: the scanner outlives the database transaction's 5 s — slowly verdicting, or not at all.
  const scannerUrl = new URL(SCANNER);
  slowProxy = await delayingProxy(scannerUrl, SLOW_SCAN_MS);
  const slowPort = (slowProxy.address() as AddressInfo).port;
  slow = await boot({
    ...common,
    AV_ICAP_URL: `icap://127.0.0.1:${String(slowPort)}${scannerUrl.pathname}`,
    AV_SCAN_TIMEOUT_MS: '60000',
  });
  slowHung = await boot({
    ...common,
    AV_ICAP_URL: `icap://127.0.0.1:${String(hungPort)}/avscan`,
    AV_SCAN_TIMEOUT_MS: '7000',
  });
  const wrongService = new URL(SCANNER);
  wrongService.pathname = '/no-such-service';
  erroring = await boot({ ...common, AV_ICAP_URL: wrongService.toString() });
  await signIn(acme);
  await signIn(rival);
}, 300_000);

afterAll(async () => {
  for (const app of apps) {
    await app.close();
  }
  held.forEach((socket) => socket.destroy());
  for (const server of [silent, slowProxy]) {
    if (server !== undefined) {
      await new Promise((done) => server.close(done));
    }
  }
  await acme?.owner.$disconnect();
  await rival?.owner.$disconnect();
  if (storageRoot !== '') {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

const A = () => healthy[0] ?? '';
const B = () => healthy[1] ?? '';

describe('a clean file, scanned by the real scanner', () => {
  it('is CLEAN, is filed, and downloads with its own bytes — with the audit and events that say so', async () => {
    const bytes = aPdf(`clean ${uuidv7()}`);
    const uploaded = await upload(A(), acme, bytes, 'procedure.pdf', 'application/pdf');

    expect(uploaded.scanStatus).toBe('CLEAN');
    const row = await blobRow(acme, uploaded.fileObjectId);
    // Written from the scanner's own answer: its server name and the ISTag of its signature set.
    expect(row.scanStatus).toBe('CLEAN');
    expect(row.scanner).toMatch(/^ICAP C-ICAP\/[\d.]+ ISTag=\S+/);
    expect(row.scannedAt).not.toBeNull();
    expect(row.scanThreat).toBeNull();

    const filed = await fileDocument(A(), acme, uploaded.fileObjectId, `Clean ${uuidv7()}`);
    expect(filed.status).toBe(201);
    const documentId = String(filed.body?.['id']);

    const link = await call(A(), 'POST', `/api/v1/documents/${documentId}/content`, acme.token);
    expect(link.status).toBe(201);
    const fetched = await fetch(onInstance(String(link.body?.['url']), A()));
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(bytes)).toBe(true);

    expect(await uploadAudit(acme, uploaded.fileObjectId)).toEqual([
      expect.objectContaining({ scanStatus: 'CLEAN', checksumSha256: row.checksumSha256 }),
    ]);
    expect(await scanEvents(acme, uploaded.fileObjectId)).toEqual([
      { type: 'storage.scan-completed', status: 'CLEAN', threat: null },
    ]);
    expect(
      await acme.owner.outboxMessage.count({
        where: { aggregateId: documentId, eventType: 'document.created' },
      }),
    ).toBe(1);
  });
});

describe('EICAR, detected by the real scanner', () => {
  it('is INFECTED and quarantined, is never filed, and the database refuses to attach it', async () => {
    const uploaded = await upload(A(), acme, EICAR, 'eicar.txt', 'text/plain');

    expect(uploaded.scanStatus).toBe('INFECTED');
    // The client is told the status and nothing about the scanner or the signature.
    expect(Object.keys(uploaded.reply).sort()).toEqual(
      [
        'checksumSha256',
        'deduplicated',
        'fileObjectId',
        'mimeType',
        'scanStatus',
        'sizeBytes',
      ].sort(),
    );
    const row = await blobRow(acme, uploaded.fileObjectId);
    expect(row.scanStatus).toBe('INFECTED');
    expect(row.scanThreat).toMatch(/eicar/i);
    expect(row.scanner).toMatch(/^ICAP C-ICAP/);

    expect(await scanEvents(acme, uploaded.fileObjectId)).toEqual([
      { type: 'storage.scan-completed', status: 'INFECTED', threat: null },
      { type: 'storage.file-quarantined', status: null, threat: row.scanThreat },
    ]);
    expect(await uploadAudit(acme, uploaded.fileObjectId)).toEqual([
      expect.objectContaining({ scanStatus: 'INFECTED', threat: row.scanThreat }),
    ]);

    const title = `Infected ${uuidv7()}`;
    const refused = await fileDocument(A(), acme, uploaded.fileObjectId, title);
    expect(refused.status).toBe(409);
    expect(refused.body?.['code']).toBe('CONTENT_NOT_SCANNED');
    expect(JSON.stringify(refused.body)).not.toMatch(/eicar/i);
    expect(await acme.owner.document.count({ where: { title } })).toBe(0);
    expect((await blobRow(acme, uploaded.fileObjectId)).refCount).toBe(0);

    // The second gate, underneath the use case: no revision may point at it, whoever writes the row.
    const clean = await upload(A(), acme, aPdf(`host ${uuidv7()}`), 'host.pdf', 'application/pdf');
    const host = await fileDocument(A(), acme, clean.fileObjectId, `Host ${uuidv7()}`);
    expect(host.status).toBe(201);
    await expect(
      acme.owner.$executeRawUnsafe(
        'UPDATE document_revision SET file_object_id = $1::uuid WHERE document_id = $2::uuid',
        uploaded.fileObjectId,
        String(host.body?.['id']),
      ),
    ).rejects.toThrow(/scan status INFECTED/);
  });

  it('finds EICAR inside an archive, and uploading it again changes nothing', async () => {
    const bytes = eicarZip(uuidv7());
    const first = await upload(A(), acme, bytes, 'bundle.zip', 'application/zip');
    expect(first.scanStatus).toBe('INFECTED');

    // Once more, announcing the digest: deduplicated onto the quarantined blob, which keeps its
    // verdict — a blob that has one is never re-scanned into another.
    const again = await upload(B(), acme, bytes, 'bundle.zip', 'application/zip', {
      announceDigest: true,
    });
    expect(again).toMatchObject({ fileObjectId: first.fileObjectId, deduplicated: true });
    expect((await blobRow(acme, first.fileObjectId)).scanStatus).toBe('INFECTED');
    expect(await scanEvents(acme, first.fileObjectId)).toHaveLength(2);
    expect((await fileDocument(B(), acme, first.fileObjectId, `Zip ${uuidv7()}`)).status).toBe(409);
  });
});

describe('the scanner is down', () => {
  it('records FAILED, never CLEAN, refuses filing, and reports the gate degraded', async () => {
    const started = Date.now();
    const uploaded = await upload(
      down,
      acme,
      aPdf(`outage ${uuidv7()}`),
      'outage.pdf',
      'application/pdf',
    );
    expect(Date.now() - started).toBeLessThan(10_000);

    expect(uploaded.scanStatus).toBe('FAILED');
    const row = await blobRow(acme, uploaded.fileObjectId);
    expect(row).toMatchObject({ scanStatus: 'FAILED', scanner: null, scanThreat: null });
    expect(await uploadAudit(acme, uploaded.fileObjectId)).toEqual([
      expect.objectContaining({ scanStatus: 'FAILED', scanFailure: 'UNREACHABLE' }),
    ]);

    const refused = await fileDocument(down, acme, uploaded.fileObjectId, `Outage ${uuidv7()}`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'CONTENT_NOT_SCANNED' });

    const degraded = await call(down, 'GET', '/api/health', '');
    expect(degraded.status).toBe(200);
    expect(degraded.body?.['dependencies']).toContainEqual(
      expect.objectContaining({ name: 'antivirus', status: 'DEGRADED' }),
    );
    const up = await call(A(), 'GET', '/api/health', '');
    expect(up.body?.['dependencies']).toContainEqual(
      expect.objectContaining({ name: 'antivirus', status: 'UP' }),
    );
  });

  it('does not let EICAR through while down, and quarantines it once the scanner is back', async () => {
    const bytes = eicarZip(uuidv7());
    const during = await upload(down, acme, bytes, 'bundle.zip', 'application/zip');
    expect(during.scanStatus).toBe('FAILED');
    expect((await fileDocument(down, acme, during.fileObjectId, `Down ${uuidv7()}`)).status).toBe(
      409,
    );

    const after = await upload(A(), acme, bytes, 'bundle.zip', 'application/zip', {
      announceDigest: true,
    });
    expect(after).toMatchObject({ fileObjectId: during.fileObjectId, deduplicated: true });
    const row = await blobRow(acme, during.fileObjectId);
    expect(row.scanStatus).toBe('INFECTED');
    expect(row.scanThreat).toMatch(/eicar/i);
    expect((await scanEvents(acme, during.fileObjectId)).map((event) => event.type)).toEqual([
      'storage.scan-completed',
      'storage.scan-completed',
      'storage.file-quarantined',
    ]);
    expect((await fileDocument(A(), acme, during.fileObjectId, `Back ${uuidv7()}`)).status).toBe(
      409,
    );
  });

  it('recovers a clean file by uploading it again, by either route', async () => {
    // Announcing the digest: the target is never issued, and the blob is re-scanned then.
    const one = aPdf(`recover-announced ${uuidv7()}`);
    const failedOne = await upload(down, acme, one, 'one.pdf', 'application/pdf');
    expect(failedOne.scanStatus).toBe('FAILED');
    await upload(A(), acme, one, 'one.pdf', 'application/pdf', { announceDigest: true });
    expect((await blobRow(acme, failedOne.fileObjectId)).scanStatus).toBe('CLEAN');
    expect(
      (await fileDocument(A(), acme, failedOne.fileObjectId, `Recovered ${uuidv7()}`)).status,
    ).toBe(201);

    // Without it: the bytes are transferred, completion finds the digest, and re-scans the blob.
    const two = aPdf(`recover-transferred ${uuidv7()}`);
    const failedTwo = await upload(down, acme, two, 'two.pdf', 'application/pdf');
    const again = await upload(B(), acme, two, 'two.pdf', 'application/pdf');
    expect(again).toMatchObject({
      fileObjectId: failedTwo.fileObjectId,
      deduplicated: true,
      scanStatus: 'CLEAN',
    });
    const audit = await uploadAudit(acme, failedTwo.fileObjectId);
    expect(audit.at(-1)).toMatchObject({ rescanned: { from: 'FAILED', to: 'CLEAN' } });
    expect(
      (await fileDocument(B(), acme, failedTwo.fileObjectId, `Recovered ${uuidv7()}`)).status,
    ).toBe(201);
  });
});

describe('the scanner hangs', () => {
  it('times out into FAILED, never CLEAN, within the configured bound', async () => {
    const started = Date.now();
    const uploaded = await upload(
      hung,
      acme,
      aPdf(`hung ${uuidv7()}`),
      'hung.pdf',
      'application/pdf',
    );
    const elapsed = Date.now() - started;

    expect(uploaded.scanStatus).toBe('FAILED');
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(10_000);
    expect(await uploadAudit(acme, uploaded.fileObjectId)).toEqual([
      expect.objectContaining({ scanStatus: 'FAILED', scanFailure: 'TIMEOUT' }),
    ]);
    expect((await fileDocument(hung, acme, uploaded.fileObjectId, `Hung ${uuidv7()}`)).status).toBe(
      409,
    );
  });
});

describe('concurrency', () => {
  it('six simultaneous uploads of one clean file, across two instances: one blob, one verdict', async () => {
    const bytes = aPdf(`race-clean ${uuidv7()}`);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        upload(index % 2 === 0 ? A() : B(), acme, bytes, 'race.pdf', 'application/pdf'),
      ),
    );
    const ids = new Set(results.map((result) => result.fileObjectId));
    expect(ids.size).toBe(1);
    expect(results.every((result) => result.scanStatus === 'CLEAN')).toBe(true);
    const [id] = [...ids];
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(await acme.owner.fileObject.count({ where: { checksumSha256: digest } })).toBe(1);
    expect(await scanEvents(acme, id ?? '')).toEqual([
      { type: 'storage.scan-completed', status: 'CLEAN', threat: null },
    ]);
  });

  it('six simultaneous uploads of one infected file: INFECTED for all, filed by none', async () => {
    const bytes = eicarZip(uuidv7());
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        upload(index % 2 === 0 ? A() : B(), acme, bytes, 'race.zip', 'application/zip'),
      ),
    );
    const [id] = [...new Set(results.map((result) => result.fileObjectId))];
    expect(new Set(results.map((result) => result.fileObjectId)).size).toBe(1);
    expect(results.every((result) => result.scanStatus === 'INFECTED')).toBe(true);
    expect((await blobRow(acme, id ?? '')).scanStatus).toBe('INFECTED');

    const title = `Race infected ${uuidv7()}`;
    const filed = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        fileDocument(index % 2 === 0 ? A() : B(), acme, id ?? '', title),
      ),
    );
    expect(filed.map((reply) => reply.status)).toEqual([409, 409, 409, 409, 409]);
    expect(await acme.owner.document.count({ where: { title } })).toBe(0);
  });

  it('five simultaneous re-uploads of a FAILED file: one re-scan wins, the verdict is kept', async () => {
    const bytes = aPdf(`race-recover ${uuidv7()}`);
    const failed = await upload(down, acme, bytes, 'race.pdf', 'application/pdf');
    expect(failed.scanStatus).toBe('FAILED');

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        upload(index % 2 === 0 ? A() : B(), acme, bytes, 'race.pdf', 'application/pdf', {
          announceDigest: true,
        }),
      ),
    );
    expect(results.every((result) => result.fileObjectId === failed.fileObjectId)).toBe(true);
    expect((await blobRow(acme, failed.fileObjectId)).scanStatus).toBe('CLEAN');
    // The FAILED verdict from the outage, then exactly one re-scan: the losers read the winner's.
    expect((await scanEvents(acme, failed.fileObjectId)).map((event) => event.status)).toEqual([
      'FAILED',
      'CLEAN',
    ]);
  });

  it('five simultaneous filings of one clean file under one key: one document', async () => {
    const uploaded = await upload(
      A(),
      acme,
      aPdf(`race-file ${uuidv7()}`),
      'race.pdf',
      'application/pdf',
    );
    const title = `Race filed ${uuidv7()}`;
    const key = uuidv7();
    const replies = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        fileDocument(index % 2 === 0 ? A() : B(), acme, uploaded.fileObjectId, title, {
          'Idempotency-Key': key,
        }),
      ),
    );
    expect(replies.filter((reply) => reply.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(
      replies.every(
        (reply) => reply.status === 201 || reply.body?.['code'] === 'REQUEST_IN_PROGRESS',
      ),
    ).toBe(true);
    expect(await acme.owner.document.count({ where: { title } })).toBe(1);
  });
});

describe('tenant isolation', () => {
  it('scans each tenant’s copy separately, from its own storage, into its own database', async () => {
    const bytes = aPdf(`shared ${uuidv7()}`);
    const mine = await upload(A(), acme, bytes, 'shared.pdf', 'application/pdf');
    const theirs = await upload(B(), rival, bytes, 'shared.pdf', 'application/pdf', {
      announceDigest: true,
    });

    // Content addressing is per tenant: the rival's announced digest did not find Acme's blob.
    expect(theirs.deduplicated).toBe(false);
    expect(theirs.fileObjectId).not.toBe(mine.fileObjectId);
    expect(theirs.scanStatus).toBe('CLEAN');
    expect((await blobRow(rival, theirs.fileObjectId)).scanner).toMatch(/^ICAP C-ICAP/);
    expect(await rival.owner.fileObject.count({ where: { id: mine.fileObjectId } })).toBe(0);

    const prefixes = await readdir(storageRoot);
    expect(prefixes).toEqual(expect.arrayContaining([ACME_SLUG, RIVAL_SLUG]));
  });

  it('never lets one tenant file another tenant’s blob, clean or infected', async () => {
    const clean = await upload(
      A(),
      acme,
      aPdf(`acme-only ${uuidv7()}`),
      'a.pdf',
      'application/pdf',
    );
    const infected = await upload(A(), acme, eicarZip(uuidv7()), 'a.zip', 'application/zip');
    // The answer for an identifier that exists nowhere: another tenant's blobs must be
    // indistinguishable from it, so the refusal says nothing about their existence or verdict.
    const nowhere = await fileDocument(B(), rival, uuidv7(), `Cross ${uuidv7()}`);
    expect(nowhere.status).toBe(422);
    for (const id of [clean.fileObjectId, infected.fileObjectId]) {
      const reply = await fileDocument(B(), rival, id, `Cross ${uuidv7()}`);
      expect(reply.status).toBe(nowhere.status);
      expect(reply.body?.['errors']).toEqual(nowhere.body?.['errors']);
      expect(JSON.stringify(reply.body)).not.toMatch(/INFECTED|CLEAN|NOT_SCANNED|eicar/i);
    }
  });
});

describe('STG-1: the scan is not bound by a database transaction', () => {
  /*
   * Staging found every upload whose store read and scan took longer than 5 s answering 500: the
   * scan ran inside the completion's PostgreSQL transaction, whose Prisma default timeout is
   * 5,000 ms, so `AV_SCAN_TIMEOUT_MS` never governed anything. A clean 50 MiB PDF could not be
   * filed. Every test here outlives that transaction on purpose and asserts the verdict the
   * scanner actually gave — never a 500, never a CLEAN it did not give.
   */
  const digestOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

  it('a real verdict slower than the transaction: CLEAN, filed, downloaded intact, audited once', async () => {
    const bytes = aPdf(`slow-clean ${uuidv7()}`);
    const started = Date.now();
    const uploaded = await upload(slow, acme, bytes, 'slow.pdf', 'application/pdf');
    expect(Date.now() - started).toBeGreaterThanOrEqual(SLOW_SCAN_MS);

    expect(uploaded.scanStatus).toBe('CLEAN');
    const row = await blobRow(acme, uploaded.fileObjectId);
    expect(row).toMatchObject({ scanStatus: 'CLEAN', checksumSha256: digestOf(bytes) });
    expect(row.scanner).toMatch(/^ICAP C-ICAP\/[\d.]+ ISTag=\S+/);

    const filed = await fileDocument(slow, acme, uploaded.fileObjectId, `Slow ${uuidv7()}`);
    expect(filed.status).toBe(201);
    const link = await call(
      slow,
      'POST',
      `/api/v1/documents/${String(filed.body?.['id'])}/content`,
      acme.token,
    );
    const fetched = await fetch(onInstance(String(link.body?.['url']), slow));
    expect(Buffer.from(await fetched.arrayBuffer()).equals(bytes)).toBe(true);

    expect(await uploadAudit(acme, uploaded.fileObjectId)).toEqual([
      expect.objectContaining({ scanStatus: 'CLEAN', checksumSha256: digestOf(bytes) }),
    ]);
    expect(await scanEvents(acme, uploaded.fileObjectId)).toEqual([
      { type: 'storage.scan-completed', status: 'CLEAN', threat: null },
    ]);
  }, 60_000);

  it('a slow INFECTED verdict is still INFECTED, quarantined once, and never filed', async () => {
    const uploaded = await upload(slow, acme, eicarZip(uuidv7()), 'slow.zip', 'application/zip');
    expect(uploaded.scanStatus).toBe('INFECTED');
    expect((await blobRow(acme, uploaded.fileObjectId)).scanThreat).toMatch(/eicar/i);
    expect((await scanEvents(acme, uploaded.fileObjectId)).map((event) => event.type)).toEqual([
      'storage.scan-completed',
      'storage.file-quarantined',
    ]);
    const refused = await fileDocument(slow, acme, uploaded.fileObjectId, `Slow eicar ${uuidv7()}`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'CONTENT_NOT_SCANNED' });
    expect((await blobRow(acme, uploaded.fileObjectId)).refCount).toBe(0);
  }, 60_000);

  it('AV_SCAN_TIMEOUT_MS above 5 s governs: a hung scanner is FAILED/TIMEOUT at its bound, not a 500', async () => {
    const started = Date.now();
    const uploaded = await upload(
      slowHung,
      acme,
      aPdf(`hung7 ${uuidv7()}`),
      'h.pdf',
      'application/pdf',
    );
    const elapsed = Date.now() - started;
    expect(uploaded.scanStatus).toBe('FAILED');
    expect(elapsed).toBeGreaterThanOrEqual(7_000);
    expect(elapsed).toBeLessThan(20_000);
    expect(await uploadAudit(acme, uploaded.fileObjectId)).toEqual([
      expect.objectContaining({ scanStatus: 'FAILED', scanFailure: 'TIMEOUT' }),
    ]);
    expect(
      (await fileDocument(slowHung, acme, uploaded.fileObjectId, `T ${uuidv7()}`)).status,
    ).toBe(409);
  }, 60_000);

  it('a scanner that answers with an error is FAILED/SCANNER_ERROR, never CLEAN, never filed', async () => {
    const uploaded = await upload(
      erroring,
      acme,
      aPdf(`err ${uuidv7()}`),
      'e.pdf',
      'application/pdf',
    );
    expect(uploaded.scanStatus).toBe('FAILED');
    expect(await uploadAudit(acme, uploaded.fileObjectId)).toEqual([
      expect.objectContaining({ scanStatus: 'FAILED', scanFailure: 'SCANNER_ERROR' }),
    ]);
    expect(
      (await fileDocument(erroring, acme, uploaded.fileObjectId, `E ${uuidv7()}`)).status,
    ).toBe(409);
  });

  it('retry after FAILED gets a fresh real verdict through a slow scanner, by either route', async () => {
    // Transferred again: completion finds the digest and re-scans outside the transaction.
    const one = aPdf(`retry-transfer ${uuidv7()}`);
    const failedOne = await upload(slowHung, acme, one, 'one.pdf', 'application/pdf');
    expect(failedOne.scanStatus).toBe('FAILED');
    const again = await upload(slow, acme, one, 'one.pdf', 'application/pdf');
    expect(again).toMatchObject({
      fileObjectId: failedOne.fileObjectId,
      deduplicated: true,
      scanStatus: 'CLEAN',
    });
    expect((await uploadAudit(acme, failedOne.fileObjectId)).at(-1)).toMatchObject({
      rescanned: { from: 'FAILED', to: 'CLEAN' },
    });
    expect((await scanEvents(acme, failedOne.fileObjectId)).map((event) => event.status)).toEqual([
      'FAILED',
      'CLEAN',
    ]);
    expect((await fileDocument(slow, acme, failedOne.fileObjectId, `R1 ${uuidv7()}`)).status).toBe(
      201,
    );

    // Digest announced: the session is never issued a target, and the re-scan happens at presign.
    const two = aPdf(`retry-announce ${uuidv7()}`);
    const failedTwo = await upload(slowHung, acme, two, 'two.pdf', 'application/pdf');
    await upload(slow, acme, two, 'two.pdf', 'application/pdf', { announceDigest: true });
    expect((await blobRow(acme, failedTwo.fileObjectId)).scanStatus).toBe('CLEAN');
    expect((await fileDocument(slow, acme, failedTwo.fileObjectId, `R2 ${uuidv7()}`)).status).toBe(
      201,
    );
  }, 120_000);

  it.each([5, 20, 30, 50, 120])(
    'a %i MiB clean file, real scanner: CLEAN, filed, downloaded byte-identical, audited',
    async (mebibytes) => {
      const bytes = Buffer.concat([
        Buffer.from('%PDF-1.7\n', 'latin1'),
        randomBytes(mebibytes * 1024 * 1024),
        Buffer.from('\n%%EOF\n', 'latin1'),
      ]);
      const uploaded = await upload(
        A(),
        acme,
        bytes,
        `large-${String(mebibytes)}.pdf`,
        'application/pdf',
      );
      expect(uploaded.scanStatus).toBe('CLEAN');
      const row = await blobRow(acme, uploaded.fileObjectId);
      expect(row).toMatchObject({
        scanStatus: 'CLEAN',
        checksumSha256: digestOf(bytes),
        sizeBytes: BigInt(bytes.length),
      });

      const filed = await fileDocument(
        A(),
        acme,
        uploaded.fileObjectId,
        `Large ${String(mebibytes)} ${uuidv7()}`,
      );
      expect(filed.status).toBe(201);
      const link = await call(
        A(),
        'POST',
        `/api/v1/documents/${String(filed.body?.['id'])}/content`,
        acme.token,
      );
      const fetched = await fetch(onInstance(String(link.body?.['url']), A()));
      const got = Buffer.from(await fetched.arrayBuffer());
      expect(digestOf(got)).toBe(digestOf(bytes));

      expect(await uploadAudit(acme, uploaded.fileObjectId)).toEqual([
        expect.objectContaining({ scanStatus: 'CLEAN', checksumSha256: digestOf(bytes) }),
      ]);
      expect(await scanEvents(acme, uploaded.fileObjectId)).toEqual([
        { type: 'storage.scan-completed', status: 'CLEAN', threat: null },
      ]);
    },
    240_000,
  );

  it('clean and infected bytes scanned at the same time, slow and fast: verdicts never cross', async () => {
    const pairs = Array.from({ length: 3 }, () => ({
      clean: aPdf(`cross-clean ${uuidv7()}`),
      infected: eicarZip(uuidv7()),
    }));
    const results = await Promise.all(
      pairs.flatMap(({ clean, infected }, index) => [
        upload(index % 2 === 0 ? slow : A(), acme, clean, 'c.pdf', 'application/pdf').then((r) => ({
          r,
          bytes: clean,
          want: 'CLEAN',
        })),
        upload(index % 2 === 0 ? A() : slow, acme, infected, 'i.zip', 'application/zip').then(
          (r) => ({ r, bytes: infected, want: 'INFECTED' }),
        ),
      ]),
    );
    for (const { r, bytes, want } of results) {
      expect(r.scanStatus).toBe(want);
      const row = await blobRow(acme, r.fileObjectId);
      // The verdict sits on the row of the bytes that were scanned, and nowhere else.
      expect(row).toMatchObject({ scanStatus: want, checksumSha256: digestOf(bytes) });
    }
  }, 120_000);

  it('identical bytes uploaded while an earlier scan is still running: one blob, one verdict event', async () => {
    const bytes = aPdf(`same-slow ${uuidv7()}`);
    const results = await Promise.all([
      upload(slow, acme, bytes, 's.pdf', 'application/pdf'),
      upload(slow, acme, bytes, 's.pdf', 'application/pdf'),
      upload(A(), acme, bytes, 's.pdf', 'application/pdf'),
    ]);
    expect(new Set(results.map((r) => r.fileObjectId)).size).toBe(1);
    expect(results.every((r) => r.scanStatus === 'CLEAN')).toBe(true);
    expect(await acme.owner.fileObject.count({ where: { checksumSha256: digestOf(bytes) } })).toBe(
      1,
    );
    expect(await scanEvents(acme, results[0]?.fileObjectId ?? '')).toEqual([
      { type: 'storage.scan-completed', status: 'CLEAN', threat: null },
    ]);
  }, 120_000);

  it('filing a blob while its slow re-scan is in flight is refused, and INFECTED stays unfileable', async () => {
    const bytes = eicarZip(uuidv7());
    const failed = await upload(slowHung, acme, bytes, 'f.zip', 'application/zip');
    expect(failed.scanStatus).toBe('FAILED');

    const scanning = once(slowScans, 'scan');
    const rescan = upload(slow, acme, bytes, 'f.zip', 'application/zip');
    await scanning; // the re-scan is now provably at the scanner
    const title = `In flight ${uuidv7()}`;
    const during = await fileDocument(A(), acme, failed.fileObjectId, title);
    expect(during.status).toBe(409);
    expect(during.body).toMatchObject({ code: 'CONTENT_NOT_SCANNED' });

    expect((await rescan).scanStatus).toBe('INFECTED');
    expect((await fileDocument(A(), acme, failed.fileObjectId, title)).status).toBe(409);
    expect(await acme.owner.document.count({ where: { title } })).toBe(0);
    expect((await blobRow(acme, failed.fileObjectId)).refCount).toBe(0);
  }, 120_000);

  it('a session claimed by the expiry sweep during a slow scan: refused, no blob row, nothing to file', async () => {
    const bytes = aPdf(`reaped ${uuidv7()}`);
    const opened = await call(slow, 'POST', '/api/v1/uploads', acme.token, {
      filename: 'r.pdf',
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      magicBytes: bytes.subarray(0, 64).toString('base64'),
    });
    const sessionId = String(opened.body?.['uploadSessionId']);
    await fetch(onInstance(String(opened.body?.['url']), slow), {
      method: String(opened.body?.['method']),
      headers: opened.body?.['headers'] as Record<string, string>,
      body: bytes,
    });
    const scanning = once(slowScans, 'scan');
    const completing = call(slow, 'POST', `/api/v1/uploads/${sessionId}/complete`, acme.token, {
      parts: [],
    });
    await scanning;
    // What `storage.sweep-upload-sessions` does to an OPEN session past its deadline: claim it.
    await acme.owner.uploadSession.updateMany({
      where: { id: sessionId, state: 'OPEN' },
      data: { state: 'EXPIRED' },
    });

    const done = await completing;
    expect(done.status).toBe(422);
    expect(done.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await acme.owner.fileObject.count({ where: { checksumSha256: digestOf(bytes) } })).toBe(
      0,
    );
    expect(
      (await acme.owner.uploadSession.findUniqueOrThrow({ where: { id: sessionId } })).state,
    ).toBe('EXPIRED');
  }, 60_000);
});

describe('what this suite wrote', () => {
  it('holds only verdicts the real scanner gave — no substituted CLEAN anywhere', async () => {
    for (const tenancy of [acme, rival]) {
      const rows = await tenancy.owner.fileObject.findMany({
        where: { tenantId: tenancy.id, id: { in: [...touched] } },
        select: { scanStatus: true, scanner: true },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        if (row.scanStatus === 'CLEAN' || row.scanStatus === 'INFECTED') {
          expect(row.scanner).toMatch(/^ICAP C-ICAP\/[\d.]+ ISTag=/);
        } else {
          expect(row.scanStatus).toBe('FAILED');
          expect(row.scanner).toBeNull();
        }
      }
    }
  });
});
