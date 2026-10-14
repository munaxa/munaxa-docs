#!/usr/bin/env node
// Gate P-1 diagnostic: what an external store does with the product's upload contract, step by
// step, through the product's own S3 adapter (as scripts/storage-backup.mjs does) — README.md §6.
//
// Run by run-stack-test.sh in the API container, with the API's own storage configuration, only when
// EXTERNAL_STORAGE_ENV names a real bucket. It writes one small object under RUN_PREFIX (removed by
// the stack test's cleanup) and prints facts only: statuses, yes/no answers and response header
// NAMES. It never prints a URL (a presigned URL carries the access key id), a header value or a key.
//
// What it separates, which the API's completion cannot: the completion refuses with one generic
// UNSUPPORTED_CONTENT whether the size differed or the store returned no SHA-256 on HEAD.

const { createHash } = require('node:crypto');
const { S3StorageAdapter } = require('/app/apps/api/dist/infrastructure/storage/s3.adapter.js');

const e = process.env;
const storage = new S3StorageAdapter({
  driver: e.STORAGE_DRIVER,
  bucket: e.STORAGE_BUCKET,
  region: e.STORAGE_REGION,
  endpoint: e.STORAGE_ENDPOINT,
  forcePathStyle: e.STORAGE_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: e.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: e.STORAGE_SECRET_ACCESS_KEY,
  },
  now: () => new Date(),
});

const print = (label, value) => console.log(`probe: ${label}: ${value}`);

(async () => {
  const bytes = Buffer.from(`P-1 storage probe ${Date.now()}\n`, 'utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const key = `${e.RUN_PREFIX}probe/${digest}`;

  const target = await storage.createUploadTarget({
    key,
    contentType: 'text/plain',
    sizeBytes: bytes.length,
    checksumSha256: digest,
    expiresInSeconds: 300,
  });
  print('signed upload headers', Object.keys(target.headers).join(', '));

  const put = await fetch(target.url, {
    method: target.method,
    headers: target.headers,
    body: bytes,
  });
  print('PUT status', put.status);
  print(
    'PUT response checksum headers',
    [...put.headers.keys()].filter((name) => name.includes('checksum')).join(', ') || 'none',
  );
  if (!put.ok) {
    const body = await put.text();
    print('PUT error code', (body.match(/<Code>([^<]*)<\/Code>/) ?? [])[1] ?? 'none');
    process.exit(1);
  }

  const head = await storage.head(key);
  print('HEAD found the object', head !== null ? 'yes' : 'no');
  if (head !== null) {
    print(
      'HEAD size equals the bytes',
      head.sizeBytes === bytes.length ? 'yes' : `no (${head.sizeBytes} vs ${bytes.length})`,
    );
    print('HEAD returned a SHA-256', head.checksumSha256 !== null ? 'yes' : 'no');
    if (head.checksumSha256 !== null) {
      print('HEAD SHA-256 equals the bytes', head.checksumSha256 === digest ? 'yes' : 'no');
    }
  }

  // The same object fetched back whole: the scanner and downloads read it this way.
  const read = await storage.read(key);
  print(
    'GET returned the same bytes',
    read !== null && Buffer.compare(read, bytes) === 0 ? 'yes' : 'no',
  );
})().catch((error) => {
  print('failed', error.message.replace(/https?:\/\/\S+/g, '<url>'));
  process.exit(1);
});
