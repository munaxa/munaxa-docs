#!/usr/bin/env node
// Storage readiness for a document store (readiness report §5.3; gate P-1, README.md §6) — what the
// product's verified reads, quarantine and recovery depend on, asked of the store through the
// product's OWN S3 adapter (its signing, its HEAD, its reads, its multipart writer).
//
// Run by run-storage-readiness.sh in the API image, with a storage configuration in the environment
// (STORAGE_*), writing only under RUN_PREFIX and removing every object version it wrote at the end.
// It prints facts only — statuses, sizes, yes/no — never a URL (a signed one carries the key id), a
// header value or a credential.
//
// Each line is PASS, FAIL, UNSUPPORTED (the store lacks the feature and nothing expects it) or INFO.
// A feature the operator says the store must have (STORAGE_TEST_EXPECT_VERSIONING=1,
// STORAGE_TEST_EXPECT_OBJECT_LOCK=1) is a FAIL when absent, never UNSUPPORTED.
//
//   1  private: an unsigned GET and an unsigned listing are refused
//   2  upload integrity: a presigned PUT carrying the SHA-256 is accepted; HEAD returns size and digest
//   3  the store refuses same-size bytes that do not match the signed digest
//   4  download integrity: the bytes read back hash to what was written; the stream is exactly sized
//   5  missing object: HEAD, read and stream all answer "absent", not an error or empty bytes
//   6  multipart: the server-side writer's object reads back whole (uneven parts, > 1 part)
//   7  an aborted multipart write leaves no object and no unfinished upload
//   8  corruption is visible: bytes changed under a key are what a read returns, so the verifier's
//      SHA-256 check fails and the product quarantines (the quarantine itself: Phase B, integration)
//   9  versioning: a prior version is listed, read and restored; a deleted object is restored
//  10  Object Lock: a locked version cannot be deleted before its retention ends, and can after
//  11  credential scope: the credential cannot list another bucket (STORAGE_TEST_OTHER_BUCKET)
//  12  cleanup: no version of anything this run wrote is left

const { createHash, randomBytes } = require('node:crypto');
const { S3StorageAdapter } = require('/app/apps/api/dist/infrastructure/storage/s3.adapter.js');

const e = process.env;
const prefix = e.RUN_PREFIX;
if (!prefix || !/^[a-z0-9-]+\/$/.test(prefix)) {
  console.log('FAIL  RUN_PREFIX must be one lower-case segment ending in /');
  process.exit(1);
}
const expectVersioning = e.STORAGE_TEST_EXPECT_VERSIONING === '1';
const expectLock = e.STORAGE_TEST_EXPECT_OBJECT_LOCK === '1';
const lockSeconds = Number(e.STORAGE_TEST_LOCK_SECONDS ?? '20');
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
  // The S3 minimum part size, so a 12 MiB object needs several parts (the product's default part is
  // larger; its writer is the same code either way).
  streamPartBytes: 5 * 1024 * 1024,
});

const counts = { PASS: 0, FAIL: 0, UNSUPPORTED: 0, INFO: 0 };
const say = (kind, name, detail = '') => {
  counts[kind] += 1;
  console.log(`${kind.padEnd(11)} ${name}${detail ? ` — ${detail}` : ''}`);
};
const check = (name, ok, detail) => say(ok ? 'PASS' : 'FAIL', name, detail);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tag = (xml, name) =>
  [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map((m) => m[1]);
const blocks = (xml, name) =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
// The store's error code only, never the body (which can echo the request).
const code = async (response) => tag(await response.text(), 'Code')[0] ?? 'none';
// The error code and the store's own short message, for refusals whose wording identifies the cause.
const reason = async (response) => {
  const xml = await response.text();
  return `${tag(xml, 'Code')[0] ?? 'none'}: ${(tag(xml, 'Message')[0] ?? '').slice(0, 120)}`;
};

// Raw requests through the adapter's own signer (private methods, reached on purpose: the test
// asks the store with exactly the requests the product would sign).
const raw = (method, key, headers = {}, query = {}, body) =>
  storage.send(method, key, headers, query, body);
const bucketGet = (query) => storage.sendToBucket(query);

async function versionsOf(key) {
  const response = await bucketGet({ versions: '', prefix: key });
  if (!response.ok) return null;
  const xml = await response.text();
  const parse = (kind) =>
    blocks(xml, kind)
      .map((b) => ({
        kind,
        key: tag(b, 'Key')[0],
        versionId: tag(b, 'VersionId')[0],
        latest: tag(b, 'IsLatest')[0] === 'true',
      }))
      .filter((v) => v.key === key);
  return [...parse('Version'), ...parse('DeleteMarker')];
}

async function everyVersionUnder(p) {
  const response = await bucketGet({ versions: '', prefix: p });
  if (!response.ok) return null;
  const xml = await response.text();
  return [...blocks(xml, 'Version'), ...blocks(xml, 'DeleteMarker')].map((b) => ({
    key: tag(b, 'Key')[0],
    versionId: tag(b, 'VersionId')[0],
  }));
}

async function presignedPut(key, bytes, digest) {
  const target = await storage.createUploadTarget({
    key,
    contentType: 'application/octet-stream',
    sizeBytes: bytes.length,
    checksumSha256: digest,
    expiresInSeconds: 300,
  });
  const response = await fetch(target.url, {
    method: target.method,
    headers: target.headers,
    body: bytes,
  });
  await response.arrayBuffer().catch(() => undefined);
  return response.status;
}

async function* uneven(total, seed) {
  let sent = 0;
  let i = 0;
  while (sent < total) {
    const size = Math.min(total - sent, [700_000, 3_100_000, 1_900_000, 5_300_000][i % 4]);
    const chunk = createHash('sha512').update(`${seed}-${i}`).digest();
    yield Buffer.concat(
      Array.from({ length: Math.ceil(size / chunk.length) }, () => chunk),
    ).subarray(0, size);
    sent += size;
    i += 1;
  }
}

(async () => {
  const key = `${prefix}object`;
  const original = randomBytes(64 * 1024);
  const originalDigest = sha256(original);

  // 1. Private.
  const anonymous = await fetch(`${storage.origin}${storage.pathFor(key)}`);
  await anonymous.arrayBuffer().catch(() => undefined);
  const anonymousList = await fetch(
    `${storage.origin}${storage.options.forcePathStyle ? `/${e.STORAGE_BUCKET}` : '/'}?list-type=2`,
  );
  await anonymousList.arrayBuffer().catch(() => undefined);
  check(
    '1 an unsigned GET is refused',
    anonymous.status === 403 || anonymous.status === 401,
    `HTTP ${anonymous.status}`,
  );
  check(
    '1 an unsigned listing is refused',
    anonymousList.status === 403 || anonymousList.status === 401,
    `HTTP ${anonymousList.status}`,
  );

  // 2. Upload integrity.
  const putStatus = await presignedPut(key, original, originalDigest);
  check(
    '2 a presigned PUT carrying the SHA-256 is accepted',
    putStatus === 200,
    `HTTP ${putStatus}`,
  );
  const head = await storage.head(key);
  check(
    '2 HEAD states the size',
    head?.sizeBytes === original.length,
    `${head?.sizeBytes} of ${original.length}`,
  );
  check(
    '2 HEAD returns the SHA-256 it was given',
    head?.checksumSha256 === originalDigest,
    head?.checksumSha256 ? 'present' : 'absent',
  );

  // 3. Checksum enforcement.
  const forged = Buffer.from(original);
  forged[0] ^= 1;
  const forgedStatus = await presignedPut(`${prefix}forged`, forged, originalDigest);
  check(
    '3 same-size bytes not matching the signed digest are refused',
    forgedStatus >= 400 && forgedStatus < 500,
    `HTTP ${forgedStatus}`,
  );
  check(
    '3 and no object is left by the refused PUT',
    (await storage.head(`${prefix}forged`)) === null,
  );

  // 4. Download integrity.
  const back = await storage.read(key);
  check('4 a read returns the bytes written', back !== null && sha256(back) === originalDigest);
  const stream = await storage.openRead(key);
  let streamed = 0;
  const hash = createHash('sha256');
  for await (const chunk of stream.body) {
    streamed += chunk.byteLength;
    hash.update(chunk);
  }
  check(
    '4 a streamed read states and delivers exactly the size',
    stream.sizeBytes === original.length &&
      streamed === original.length &&
      hash.digest('hex') === originalDigest,
  );

  // 5. Missing.
  const missing = `${prefix}never-written`;
  check('5 HEAD of a missing object answers absent', (await storage.head(missing)) === null);
  check('5 a read of a missing object answers absent', (await storage.read(missing)) === null);
  check(
    '5 a stream of a missing object answers absent',
    (await storage.openRead(missing)) === null,
  );

  // 6. Multipart, through the product's own writer.
  const bigKey = `${prefix}multipart`;
  const total = 12 * 1024 * 1024 + 12345;
  const parts = [];
  const uploadPart = storage.uploadPart.bind(storage);
  storage.uploadPart = (k, id, n, part) => {
    parts.push(part.length);
    return uploadPart(k, id, n, part);
  };
  const written = await storage.put(bigKey, uneven(total, 'a'), {
    contentType: 'application/octet-stream',
  });
  storage.uploadPart = uploadPart;
  const bigBack = await storage.read(bigKey);
  check(
    '6 a multipart object reads back whole',
    bigBack?.length === total && sha256(bigBack) === written.checksumSha256,
    `${parts.length} parts`,
  );
  check('6 it was really written in more than one part', parts.length > 1, parts.join('+'));
  const bigHead = await storage.head(bigKey);
  say(
    'INFO',
    '6 HEAD of a multipart object',
    `size ${bigHead?.sizeBytes === total ? 'correct' : 'WRONG'}, SHA-256 ${bigHead?.checksumSha256 ? 'present' : 'absent (the product records the digest it computed while writing)'}`,
  );

  // 7. An aborted multipart write.
  const abortKey = `${prefix}aborted`;
  async function* failing() {
    yield* uneven(6 * 1024 * 1024, 'b');
    throw new Error('the source failed part-way');
  }
  let refused = false;
  try {
    await storage.put(abortKey, failing(), { contentType: 'application/octet-stream' });
  } catch {
    refused = true;
  }
  check('7 a write whose source fails is refused', refused);
  check('7 and leaves no object', (await storage.head(abortKey)) === null);
  const uploads = await bucketGet({ uploads: '', prefix: abortKey });
  if (uploads.ok) {
    check(
      '7 and no unfinished multipart upload',
      tag(await uploads.text(), 'UploadId').length === 0,
    );
  } else {
    say(
      'INFO',
      '7 unfinished uploads cannot be listed with this credential',
      `HTTP ${uploads.status}`,
    );
  }

  // 8. Corruption is visible to the verifier.
  const altered = randomBytes(original.length);
  const overwrite = await raw(
    'PUT',
    key,
    { 'content-type': 'application/octet-stream' },
    {},
    altered,
  );
  check(
    '8 (set-up) the object is overwritten with other bytes',
    overwrite.ok,
    `HTTP ${overwrite.status}`,
  );
  const afterOverwrite = await storage.read(key);
  check(
    '8 a read returns the new bytes, not a cached copy: the SHA-256 check would quarantine',
    afterOverwrite !== null &&
      sha256(afterOverwrite) !== originalDigest &&
      sha256(afterOverwrite) === sha256(altered),
  );

  // 9. Versioning.
  const versioning = await bucketGet({ versioning: '' });
  const status = versioning.ok
    ? (tag(await versioning.text(), 'Status')[0] ?? 'never enabled')
    : `HTTP ${versioning.status}`;
  if (status !== 'Enabled') {
    say(
      expectVersioning ? 'FAIL' : 'UNSUPPORTED',
      '9 versioning is not enabled on this bucket',
      status,
    );
  } else {
    say('PASS', '9 versioning is enabled');
    const versions = (await versionsOf(key)) ?? [];
    const prior = versions.find((v) => v.kind === 'Version' && !v.latest);
    check(
      '9 the overwritten version is listed',
      prior !== undefined,
      `${versions.length} version(s)`,
    );
    if (prior) {
      const old = await raw(
        'GET',
        key,
        { 'accept-encoding': 'identity' },
        { versionId: prior.versionId },
      );
      const oldBytes = Buffer.from(await old.arrayBuffer());
      check('9 the prior version reads back intact', old.ok && sha256(oldBytes) === originalDigest);
      const source = `/${e.STORAGE_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}?versionId=${encodeURIComponent(prior.versionId)}`;
      const restore = await raw('PUT', key, { 'x-amz-copy-source': source });
      await restore.arrayBuffer().catch(() => undefined);
      const restored = await storage.read(key);
      check(
        '9 restoring the prior version makes it current again',
        restore.ok && restored !== null && sha256(restored) === originalDigest,
        `HTTP ${restore.status}`,
      );
      const deleted = await raw('DELETE', key);
      await deleted.arrayBuffer().catch(() => undefined);
      check(
        '9 after a delete the object is absent',
        (await storage.head(key)) === null,
        `HTTP ${deleted.status}`,
      );
      const afterDelete = (await versionsOf(key)) ?? [];
      const marker = afterDelete.find((v) => v.kind === 'DeleteMarker' && v.latest);
      const lastVersion = afterDelete.find((v) => v.kind === 'Version' && !v.latest && v.versionId);
      if (marker && lastVersion) {
        const undo = await raw('DELETE', key, {}, { versionId: marker.versionId });
        await undo.arrayBuffer().catch(() => undefined);
        const back2 = await storage.read(key);
        check(
          '9 removing the delete marker restores the object',
          undo.ok && back2 !== null && sha256(back2) === originalDigest,
          `HTTP ${undo.status}`,
        );
      } else {
        check(
          '9 a delete leaves a delete marker over the kept versions',
          false,
          `${afterDelete.length} entries`,
        );
      }
    }
  }

  // 10. Object Lock.
  const lockConfig = await bucketGet({ 'object-lock': '' });
  const lockEnabled =
    lockConfig.ok && tag(await lockConfig.text(), 'ObjectLockEnabled')[0] === 'Enabled';
  if (!lockEnabled) {
    say(
      expectLock ? 'FAIL' : 'UNSUPPORTED',
      '10 Object Lock is not enabled on this bucket',
      `HTTP ${lockConfig.status}`,
    );
  } else {
    const lockedKey = `${prefix}locked`;
    const until = new Date(Date.now() + lockSeconds * 1000);
    const body = Buffer.from('locked');
    const put = await raw(
      'PUT',
      lockedKey,
      {
        'content-md5': createHash('md5').update(body).digest('base64'),
        'x-amz-object-lock-mode': 'GOVERNANCE',
        'x-amz-object-lock-retain-until-date': until.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      },
      {},
      body,
    );
    check(
      '10 a version is written under GOVERNANCE retention',
      put.ok,
      put.ok ? `${lockSeconds} s` : `HTTP ${put.status} ${await code(put)}`,
    );
    const versionId = put.headers.get('x-amz-version-id');
    if (put.ok && versionId) {
      const early = await raw('DELETE', lockedKey, {}, { versionId });
      const why = await reason(early);
      // Providers word the refusal differently (S3: 403 AccessDenied; MinIO: 400 "WORM protected"),
      // so what is checked is a 4xx refusal AND the version still being there.
      const still = await raw('GET', lockedKey, { 'accept-encoding': 'identity' }, { versionId });
      const stillBytes = Buffer.from(await still.arrayBuffer());
      check(
        '10 deleting that version before the retention ends is refused, and it is still there',
        early.status >= 400 && early.status < 500 && still.ok && stillBytes.equals(body),
        `HTTP ${early.status} ${why}`,
      );
      await sleep(Math.max(0, until.getTime() - Date.now()) + 2000);
      const late = await raw('DELETE', lockedKey, {}, { versionId });
      await late.arrayBuffer().catch(() => undefined);
      check(
        '10 after the retention ends the version can be removed',
        late.ok,
        `HTTP ${late.status}`,
      );
    }
  }

  // 11. Credential scope.
  if (e.STORAGE_TEST_OTHER_BUCKET) {
    const other = await fetch(`${storage.origin}/${e.STORAGE_TEST_OTHER_BUCKET}?list-type=2`);
    // Signed with this credential for the other bucket: the adapter signs for its own bucket, so a
    // second adapter is made for the other one.
    const otherStorage = new S3StorageAdapter({
      ...storage.options,
      bucket: e.STORAGE_TEST_OTHER_BUCKET,
    });
    const signed = await otherStorage.sendToBucket({ 'list-type': '2' });
    await other.arrayBuffer().catch(() => undefined);
    check(
      '11 this credential cannot list another bucket',
      signed.status === 403,
      `HTTP ${signed.status} ${await code(signed)}`,
    );
  } else {
    say(
      'INFO',
      '11 credential scope not tested (set STORAGE_TEST_OTHER_BUCKET to a bucket this key must not reach)',
    );
  }

  // 12. Cleanup: every version and delete marker under the run prefix.
  const left =
    (await everyVersionUnder(prefix)) ?? (await storage.list(prefix)).map((k) => ({ key: k }));
  for (const v of left) {
    const r = await raw('DELETE', v.key, {}, v.versionId ? { versionId: v.versionId } : {});
    await r.arrayBuffer().catch(() => undefined);
  }
  const remaining = (await everyVersionUnder(prefix)) ?? (await storage.list(prefix));
  check(
    '12 nothing this run wrote is left (every version removed)',
    remaining.length === 0,
    `${left.length} removed, ${remaining.length} left`,
  );

  console.log(`\nRESULT ${JSON.stringify(counts)}`);
  process.exit(counts.FAIL === 0 ? 0 : 1);
})().catch((error) => {
  console.log(
    `FAIL        the readiness check stopped: ${error && error.name}: ${String(error && error.message).slice(0, 200)}`,
  );
  process.exit(1);
});
