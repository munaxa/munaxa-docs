#!/usr/bin/env node
// Phase A step 4 (ADR-0026 §10): the server-side multipart writer — `S3StorageAdapter.put`, which
// audit evidence exports, report exports and audit checkpoints use — against the test MinIO.
//
// Run by phase-a.sh in the API container with the API's own storage configuration. It writes only
// under RUN_PREFIX (removed with the stack) and prints facts only: sizes, yes/no answers, statuses.
//
//   A  ~50 MiB from a source whose chunks are deliberately uneven, so the adapter's parts are too
//      (it sends a part once at least `streamPartBytes` have accumulated). Read back whole; compared
//      byte for byte and by SHA-256 with what was sent and with what `put` reported.
//   B  a source that fails part-way: `put` must refuse, abort the multipart upload, and leave neither
//      an object nor an unfinished upload behind.

const { createHash, randomBytes } = require('node:crypto');
const { S3StorageAdapter } = require('/app/apps/api/dist/infrastructure/storage/s3.adapter.js');

const e = process.env;
const MiB = 1024 * 1024;
const print = (label, value) => console.log(`multipart: ${label}: ${value}`);
const result = (facts) => console.log(`RESULT ${JSON.stringify({ step: 'multipart', ...facts })}`);

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

// The sizes of the parts the adapter actually sends, observed rather than predicted: the private
// method is wrapped, not replaced, so every part still goes to the store exactly as before.
const partSizes = [];
const uploadPart = storage.uploadPart.bind(storage);
storage.uploadPart = (key, uploadId, partNumber, part) => {
  partSizes.push(part.length);
  return uploadPart(key, uploadId, partNumber, part);
};

const UNEVEN = [1_000_003, 777_777, 3_333_331, 65_537, 2_097_169];

function* unevenChunks(total, failAfter = Infinity) {
  let sent = 0;
  let i = 0;
  while (sent < total) {
    if (sent >= failAfter) {
      throw new Error('the source failed part-way (deliberate)');
    }
    const size = Math.min(UNEVEN[i % UNEVEN.length], total - sent);
    yield randomBytes(size);
    sent += size;
    i += 1;
  }
}

async function* collect(source, into) {
  for (const chunk of source) {
    into.push(chunk);
    yield chunk;
  }
}

/** Unfinished multipart uploads under a key — the bucket-level `?uploads` listing. */
async function pendingUploads(key) {
  const response = await storage.sendToBucket({ uploads: '', prefix: key });
  const xml = await response.text();
  return [...xml.matchAll(/<Upload>[\s\S]*?<Key>([^<]*)<\/Key>/g)].map((m) => m[1]);
}

(async () => {
  // A — uneven chunks, ~50 MiB.
  const keyA = `${e.RUN_PREFIX}phase-a/multipart/uneven-${randomBytes(4).toString('hex')}`;
  const sent = [];
  const total = 50 * MiB + 12_345;
  const stored = await storage.put(keyA, collect(unevenChunks(total), sent), {
    contentType: 'application/octet-stream',
  });
  const bytes = Buffer.concat(sent);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const read = await storage.read(keyA);
  const head = await storage.head(keyA);
  const facts = {
    case: 'uneven',
    sizeBytes: bytes.length,
    partSizes: [...partSizes],
    nonTrailingPartsEqual: new Set(partSizes.slice(0, -1)).size <= 1,
    reportedSize: stored.sizeBytes,
    reportedDigestMatches: stored.checksumSha256 === digest,
    readBackIdentical: read !== null && Buffer.compare(read, bytes) === 0,
    readBackDigestMatches:
      read !== null && createHash('sha256').update(read).digest('hex') === digest,
    headSize: head?.sizeBytes ?? null,
    pendingUploadsAfter: (await pendingUploads(keyA)).length,
  };
  print('A parts (bytes)', facts.partSizes.join(', '));
  result(facts);

  // B — the source fails after ~20 MiB, i.e. after at least one part has been sent.
  partSizes.length = 0;
  const keyB = `${e.RUN_PREFIX}phase-a/multipart/failing-${randomBytes(4).toString('hex')}`;
  let refusal = null;
  try {
    await storage.put(keyB, unevenChunks(50 * MiB, 20 * MiB), {
      contentType: 'application/octet-stream',
    });
  } catch (error) {
    refusal = error.constructor.name;
  }
  result({
    case: 'failing-source',
    partsSentBeforeFailure: partSizes.length,
    refused: refusal,
    objectAfter: (await storage.head(keyB)) !== null,
    pendingUploadsAfter: (await pendingUploads(keyB)).length,
  });
})().catch((error) => {
  console.log(`FAIL  multipart: ${String(error.message).replace(/https?:\/\/\S+/g, '<url>')}`);
  process.exit(1);
});
