#!/usr/bin/env node
// Object-storage backup and restore — Phase 6.13, and the half of disaster recovery this repository
// had never been able to execute.
//
// ## Why this exists at all, and what it is not
//
// `docs/operations/backup-and-restore.md` §1 backs object storage up with **bucket versioning and
// cross-region replication**. That is a bucket *policy*: it is configured on a provider, not run
// from a repository, and it is the right answer for production. What it is not is something a
// rehearsal can execute — so Phase 6.10 verified a database restore beside an object store it could
// not back up, and Phase 6.11 and 6.12 each recorded the same gap.
//
// This is the minimum tooling that closes it, and it is deliberately modest: a **verifiable copy**
// of a bucket's objects and a restore of them into an empty one. It does not replace the documented
// production mechanism and does not pretend to — replication protects against losing a region, and
// this protects against not knowing whether a restore works.
//
// ## Why it goes through the product's own adapter
//
// Because ADR-0007 §1 says every storage operation goes through one port and no provider type
// appears above the adapter. A backup script with its own S3 client would be a second storage
// implementation to keep correct — and the first thing it would get wrong is the one Phase 6.12
// found, since the checksum handling that makes an object verifiable lives *in* that adapter.
// Reading the built adapter keeps one implementation and one set of bugs.
//
// ## What is recorded, and why the manifest is the point
//
// Every object's key, size and **SHA-256 computed from the bytes as they were read**. A restore is
// then checkable rather than merely completed: the destination is compared against the manifest
// object by object, and a byte that changed in transit is a mismatch rather than a surprise years
// later. That is the same standard §3's fourth condition sets for a restored blob.
//
//   node scripts/storage-backup.mjs backup  --dir <path>
//   node scripts/storage-backup.mjs verify  --dir <path>
//   node scripts/storage-backup.mjs restore --dir <path> [--endpoint <url>] [--bucket <name>]
//
// Reads the source store from the same STORAGE_* variables the API reads. `restore` refuses a
// destination that already holds any of the manifest's keys: this is a rehearsal into an empty
// environment, and a restore that could overwrite proves something else.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fromApi = createRequire(join(ROOT, 'apps', 'api', 'package.json'));

/**
 * The product's own S3 adapter, from its build output.
 *
 * Requires `pnpm build` — which is the same requirement the end-to-end suite has, and for the same
 * reason: this operates the artefact the image ships rather than a re-implementation of it.
 */
let S3StorageAdapter;
try {
  ({ S3StorageAdapter } = fromApi('./dist/infrastructure/storage/s3.adapter.js'));
} catch (error) {
  console.error(
    'The API build is missing. This tool drives the product’s own storage adapter rather than a ' +
      `second S3 client (ADR-0007 §1), so it needs \`pnpm build\` first. (${String(error)})`,
  );
  process.exit(1);
}

const command = process.argv[2];
const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};

const DIR = flag('dir', join(ROOT, '.storage-backup'));
const MANIFEST = join(DIR, 'manifest.json');

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} must be set.`);
    process.exit(1);
  }
  return value;
}

function adapterFor(endpoint, bucket) {
  return new S3StorageAdapter({
    driver: 'S3',
    bucket,
    region: process.env.STORAGE_REGION ?? 'us-east-1',
    endpoint,
    forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE ?? 'true') === 'true',
    credentials: {
      accessKeyId: required('STORAGE_ACCESS_KEY_ID'),
      secretAccessKey: required('STORAGE_SECRET_ACCESS_KEY'),
    },
    now: () => new Date(),
  });
}

const source = () =>
  adapterFor(required('STORAGE_ENDPOINT'), process.env.STORAGE_BUCKET ?? 'munaxa-docs');

/** Every key in the bucket. The listing is the whole bucket because a tenant prefix is a prefix. */
async function everyKey(storage) {
  return [...(await storage.list(''))].sort();
}

/** The tenant a key belongs to — its first segment, which `TenantScopedStorage` put there. */
function tenantOf(key) {
  return key.split('/')[0] ?? '';
}

async function backup() {
  mkdirSync(join(DIR, 'objects'), { recursive: true });
  const storage = source();
  const started = Date.now();

  const objects = [];
  for (const key of await everyKey(storage)) {
    const bytes = await storage.read(key);
    if (bytes === null) {
      // Listed and then unreadable: a real condition worth failing on rather than skipping, because
      // a backup missing an object is the one thing a backup may not be.
      console.error(`Listed but unreadable: ${key}`);
      process.exit(1);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // Named by the digest of its own bytes, so the copy is content-addressed exactly as the store
    // is — and two identical objects cost one file.
    writeFileSync(join(DIR, 'objects', sha256), bytes);
    objects.push({ key, tenant: tenantOf(key), bytes: bytes.length, sha256 });
  }

  const manifest = {
    takenAt: new Date().toISOString(),
    endpoint: required('STORAGE_ENDPOINT'),
    bucket: process.env.STORAGE_BUCKET ?? 'munaxa-docs',
    objectCount: objects.length,
    totalBytes: objects.reduce((sum, object) => sum + object.bytes, 0),
    tenants: [...new Set(objects.map((object) => object.tenant))].sort(),
    objects,
    durationMs: Date.now() - started,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

/** The artefact, checked before anybody restores from it. */
function verify() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const mismatched = [];
  for (const object of manifest.objects) {
    const bytes = readFileSync(join(DIR, 'objects', object.sha256));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== object.sha256 || bytes.length !== object.bytes) {
      mismatched.push({ key: object.key, expected: object.sha256, actual, bytes: bytes.length });
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      manifest: MANIFEST,
      objectCount: manifest.objectCount,
      totalBytes: manifest.totalBytes,
      tenants: manifest.tenants,
      takenAt: manifest.takenAt,
      mismatched,
      intact: mismatched.length === 0,
    })}\n`,
  );
  process.exit(mismatched.length === 0 ? 0 : 1);
}

async function restore() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const endpoint = flag('endpoint', manifest.endpoint);
  const bucket = flag('bucket', manifest.bucket);
  const storage = adapterFor(endpoint, bucket);
  const started = Date.now();

  // Empty, or this proves overwriting rather than recovery.
  const occupied = [];
  for (const object of manifest.objects) {
    if ((await storage.head(object.key)) !== null) {
      occupied.push(object.key);
    }
  }
  if (occupied.length > 0) {
    console.error(
      `The destination already holds ${String(occupied.length)} of these objects, starting with ` +
        `${occupied[0]}. This restores into an EMPTY store — restoring over an existing one ` +
        'demonstrates that a restore can overwrite, which is not the claim.',
    );
    process.exit(1);
  }

  for (const object of manifest.objects) {
    const bytes = readFileSync(join(DIR, 'objects', object.sha256));
    await storage.put(object.key, [bytes], { contentType: 'application/octet-stream' });
  }

  // Read back through the same adapter, and compare the *bytes* rather than the count.
  const differences = [];
  for (const object of manifest.objects) {
    const bytes = await storage.read(object.key);
    const actual = bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
    if (actual !== object.sha256) {
      differences.push({ key: object.key, expected: object.sha256, actual });
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      endpoint,
      bucket,
      restored: manifest.objects.length,
      totalBytes: manifest.totalBytes,
      tenants: manifest.tenants,
      differences,
      durationMs: Date.now() - started,
    })}\n`,
  );
  process.exit(differences.length === 0 ? 0 : 1);
}

switch (command) {
  case 'backup':
    await backup();
    break;
  case 'verify':
    verify();
    break;
  case 'restore':
    await restore();
    break;
  default:
    console.error('Usage: storage-backup.mjs <backup|verify|restore> [--dir <path>]');
    process.exit(1);
}
