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
// `replay-only`: run from the smoke container, which holds no storage credentials — API calls and
// the browser-side PUT only, never the adapter.
const REPLAY_ONLY = e.PROBE_MODE === 'replay-only';
const where = REPLAY_ONLY ? 'smoke container' : 'api container';
const storage = REPLAY_ONLY
  ? null
  : new S3StorageAdapter({
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
  if (REPLAY_ONLY) {
    await replayThroughTheApi();
    return;
  }
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

  await replayThroughTheApi();
})().catch((error) => {
  print('failed', error.message.replace(/https?:\/\/\S+/g, '<url>'));
  process.exit(1);
});

/**
 * Phase 2: the upload exactly as the product performs it — target from the API, PUT, completion —
 * in variants that differ in one thing each, so a failure names its cause:
 *
 *   A  as the smoke test: CORS preflight, PUT, completion at once
 *   B  PUT, completion at once
 *   C  PUT, the staged object inspected with the adapter, then completion
 *
 * After a failed completion the staged object is gone (the product discards it), so B also records
 * what HEAD saw for a fresh upload 0 ms and 2 s after its PUT, without completing it. Statuses and
 * yes/no facts only. The run's throwaway sign-in arrives by environment (`-e NAME`).
 */
async function replayThroughTheApi() {
  const api = 'http://api:3001';
  const signIn = await fetch(`${api}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: e.SMOKE_ADMIN_EMAIL,
      password: e.SMOKE_ADMIN_PASSWORD,
      tenant: e.SMOKE_TENANT,
    }),
  });
  print(`replay (${where}): sign-in status`, signIn.status);
  const { accessToken } = await signIn.json();
  const auth = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  const staged = (id) => `${e.RUN_PREFIX}tenants/${e.SMOKE_TENANT}/staging/${id}`;

  async function target(bytes, filename = 'replay.txt') {
    const created = await fetch(`${api}/api/v1/uploads`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        filename,
        mimeType: 'text/plain',
        sizeBytes: bytes.length,
        magicBytes: bytes.toString('base64'),
        checksumSha256: createHash('sha256').update(bytes).digest('hex'),
      }),
    });
    return created.json();
  }
  const put = async (t, bytes) =>
    (await fetch(t.url, { method: t.method, headers: t.headers, body: bytes })).status;
  const complete = async (t) => {
    const done = await fetch(`${api}/api/v1/uploads/${t.uploadSessionId}/complete`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ parts: [] }),
    });
    const body = await done.json().catch(() => ({}));
    return `${done.status}${body.scanStatus ? ` ${body.scanStatus}` : ''}`;
  };
  const describe = (head, bytes, digest) =>
    head === null
      ? 'not found'
      : `size ${head.sizeBytes === bytes.length ? 'ok' : `${head.sizeBytes}≠${bytes.length}`}, ` +
        `sha256 ${head.checksumSha256 === null ? 'absent' : head.checksumSha256 === digest ? 'ok' : 'wrong'}`;
  const fresh = (label) => Buffer.from(`P-1 ${label} ${Date.now()} ${Math.random()}\n`, 'utf8');

  for (let round = 1; round <= 3; round += 1) {
    // D — the smoke test's own content and file name, as the smoke test sends them.
    {
      const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const bytes = Buffer.from(`Munaxa Docs Hetzner template smoke test ${nonce}\n`, 'utf8');
      const t = await target(bytes, `smoke-${nonce}.txt`);
      const preflight = await fetch(t.url, {
        method: 'OPTIONS',
        headers: {
          origin: e.SMOKE_CORS_ORIGIN || 'https://p1-storage-test.munaxa.invalid',
          'access-control-request-method': t.method,
          'access-control-request-headers': 'content-type,x-amz-checksum-sha256',
        },
      });
      const status = await put(t, bytes);
      print(
        `replay ${round}D (${where}): smoke content, preflight, PUT, complete`,
        `${preflight.status}, ${status}, ${await complete(t)}`,
      );
    }
    // A — as the smoke test does it.
    {
      const bytes = fresh('A');
      const t = await target(bytes);
      const preflight = await fetch(t.url, {
        method: 'OPTIONS',
        headers: {
          origin: e.SMOKE_CORS_ORIGIN || 'https://p1-storage-test.munaxa.invalid',
          'access-control-request-method': t.method,
          'access-control-request-headers': 'content-type,x-amz-checksum-sha256',
        },
      });
      const status = await put(t, bytes);
      print(
        `replay ${round}A: preflight, PUT, complete`,
        `${preflight.status}, ${status}, ${await complete(t)}`,
      );
    }
    // B — no preflight, no inspection.
    {
      const bytes = fresh('B');
      const t = await target(bytes);
      const status = await put(t, bytes);
      print(`replay ${round}B: PUT, complete`, `${status}, ${await complete(t)}`);
    }
    if (REPLAY_ONLY) {
      continue;
    }
    // DC — the smoke test's content, inspected before completion (sizes, SHA-256, content type).
    {
      const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const bytes = Buffer.from(`Munaxa Docs Hetzner template smoke test ${nonce}\n`, 'utf8');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const t = await target(bytes, `smoke-${nonce}.txt`);
      const status = await put(t, bytes);
      const head = await storage.head(staged(t.uploadSessionId));
      const signedType = Object.entries(t.headers).find(
        ([k]) => k.toLowerCase() === 'content-type',
      )?.[1];
      print(
        `replay ${round}DC: smoke content (${bytes.length} bytes), PUT, HEAD, complete`,
        `${status}, ${describe(head, bytes, digest)}, ` +
          `content-type ${head === null ? 'n/a' : head.contentType === signedType ? 'as signed' : 'differs'}, ` +
          `${await complete(t)}`,
      );
    }
    // C — inspected before completion.
    {
      const bytes = fresh('C');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const t = await target(bytes);
      const status = await put(t, bytes);
      const head = await storage.head(staged(t.uploadSessionId));
      print(
        `replay ${round}C: PUT, HEAD, complete`,
        `${status}, ${describe(head, bytes, digest)}, ${await complete(t)}`,
      );
    }
    // What HEAD sees for a fresh upload immediately and 2 s later (not completed; cleaned up with
    // the run prefix).
    {
      const bytes = fresh('T');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const t = await target(bytes);
      await put(t, bytes);
      const now = await storage.head(staged(t.uploadSessionId));
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const later = await storage.head(staged(t.uploadSessionId));
      print(
        `replay ${round}T: HEAD at 0 s / 2 s`,
        `${describe(now, bytes, digest)} / ${describe(later, bytes, digest)}`,
      );
    }
  }
}
