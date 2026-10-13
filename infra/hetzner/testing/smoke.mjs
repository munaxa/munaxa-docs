#!/usr/bin/env node
// End-to-end check of the Hetzner template's test stack (infra/hetzner/README.md §5).
//
// Runs as the `smoke` service of testing/compose.test.yaml, on the stack's own networks: it reaches
// the proxy as a browser would, the API directly as the web server does, and MinIO at the address
// the API's presigned URLs name. Exits 0 only if every check passes; prints each check's outcome
// and never prints a credential, a token or a URL carrying a signature.
//
// What it proves, and what it does not:
//   - the proxy's routing rule and that the health and metrics endpoints are not public;
//   - the API is ready in production mode with every dependency, the scanner included;
//   - the real upload contract — presigned PUT with a signed x-amz-checksum-sha256, completion,
//     scan — against MinIO, including the store refusing bytes that do not match the signed digest;
//   - a clean file is CLEAN and the EICAR test file is not.
// It does NOT prove that Hetzner Object Storage or Cloudflare R2 behave like MinIO (gate P-1).

import { createHash } from 'node:crypto';

const PROXY = process.env.SMOKE_PROXY_URL ?? 'http://proxy:8080';
const API = process.env.SMOKE_API_URL ?? 'http://api:3001';
const TENANT = required('SMOKE_TENANT');
const EMAIL = required('SMOKE_ADMIN_EMAIL');
const PASSWORD = required('SMOKE_ADMIN_PASSWORD');

const results = [];

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(2);
  }
  return value;
}

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(name, probe, seconds) {
  const deadline = Date.now() + seconds * 1000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const outcome = await probe();
      if (outcome === true) {
        return true;
      }
      last = String(outcome);
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  console.log(`      ${name} never became ready: ${last}`);
  return false;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// --- 1. Readiness, from inside the network (as an operator would; never through the proxy) ------

const ready = await waitFor(
  'API readiness',
  async () => {
    const response = await fetch(`${API}/api/health/ready`);
    const body = await response.json().catch(() => ({}));
    return response.ok && body.status === 'UP' ? true : `${response.status} ${body.status ?? ''}`;
  },
  300,
);
check('API /api/health/ready is UP (every tenant database, Redis, scanner)', ready);

// --- 2. The proxy: the only public entry point ------------------------------------------------

const login = await fetch(`${PROXY}/login`);
const loginHtml = await login.text();
check('proxy → web: GET /login', login.ok && /<html/i.test(loginHtml), `HTTP ${login.status}`);

for (const path of [
  '/api/health',
  '/api/health/ready',
  '/api/health/live',
  '/api/metrics',
  '/api/v1/auth/me',
]) {
  const response = await fetch(`${PROXY}${path}`);
  const body = await response.text();
  // Refused by the proxy itself: a 404 that never reached the API (no API correlation header).
  check(
    `proxy does not expose ${path}`,
    response.status === 404 && !response.headers.has('x-correlation-id') && !body.includes(TENANT),
    `HTTP ${response.status}`,
  );
}

// The preview stream must reach the API. The route is `GET /api/v1/preview/stream?token=…`
// (preview-stream.controller.ts). The API answers an invalid token with its own empty 404 — it does
// not say whether anything exists — so neither status nor body tells it from the proxy's refusal.
// Headers do: every API response carries an `x-correlation-id`, and this controller sets
// `cache-control: private, no-store`; the proxy's own 404 carries neither.
const fromApi = (response) => response.headers.has('x-correlation-id');
const viaProxy = await fetch(`${PROXY}/api/v1/preview/stream?token=not-a-valid-token`);
check(
  'proxy → API: /api/v1/preview/stream* is routed to the API',
  fromApi(viaProxy) && viaProxy.headers.get('cache-control') === 'private, no-store',
  `HTTP ${viaProxy.status}, answered by ${fromApi(viaProxy) ? 'the API' : 'the proxy'}`,
);

// --- 3. Sign in, as the web server does (server-side, to the API) ------------------------------

const signIn = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD, tenant: TENANT }),
});
const session = await signIn.json().catch(() => ({}));
check(
  'sign-in with the provisioned administrator',
  signIn.ok && typeof session.accessToken === 'string',
  `HTTP ${signIn.status}`,
);
const auth = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' };

// --- 4. The upload contract against the object store -----------------------------------------

async function requestTarget(bytes, digest, filename) {
  const response = await fetch(`${API}/api/v1/uploads`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      filename,
      mimeType: 'text/plain',
      sizeBytes: bytes.length,
      magicBytes: Buffer.from(bytes.subarray(0, 1024)).toString('base64'),
      checksumSha256: digest,
    }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function transfer(target, bytes) {
  const response = await fetch(target.url, {
    method: target.method,
    headers: target.headers,
    body: bytes,
  });
  return response.status;
}

async function complete(target) {
  const response = await fetch(`${API}/api/v1/uploads/${target.uploadSessionId}/complete`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ parts: [] }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

// Unique per run, so content addressing never answers "already stored" for a re-run.
const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const clean = Buffer.from(`Munaxa Docs Hetzner template smoke test ${nonce}\n`, 'utf8');
const cleanDigest = sha256(clean);

const cleanTarget = await requestTarget(clean, cleanDigest, `smoke-${nonce}.txt`);
const signedChecksum = Object.keys(cleanTarget.body.headers ?? {}).some(
  (name) => name.toLowerCase() === 'x-amz-checksum-sha256',
);
check(
  'upload target issued, with a signed x-amz-checksum-sha256',
  cleanTarget.status === 201 && signedChecksum,
  `HTTP ${cleanTarget.status}`,
);
const putStatus = await transfer(cleanTarget.body, clean);
check('browser-side PUT to the object store accepted', putStatus === 200, `HTTP ${putStatus}`);
const cleanDone = await complete(cleanTarget.body);
check(
  'completion: stored digest equals the bytes, scanned CLEAN',
  cleanDone.status < 300 &&
    cleanDone.body.checksumSha256 === cleanDigest &&
    cleanDone.body.scanStatus === 'CLEAN',
  `HTTP ${cleanDone.status} scan=${cleanDone.body.scanStatus}`,
);

// Same size, different bytes: the store itself must refuse what does not match the signed digest.
const forged = Buffer.from(clean);
forged[0] ^= 0x01;
const forgedTarget = await requestTarget(
  clean,
  sha256(Buffer.concat([clean, Buffer.from(nonce)])),
  `forged-${nonce}.txt`,
);
const forgedPut =
  forgedTarget.status === 201 ? await transfer(forgedTarget.body, forged) : forgedTarget.status;
check(
  'object store refuses bytes that do not match the signed SHA-256',
  forgedPut === 400,
  `HTTP ${forgedPut}`,
);

// The EICAR test file, assembled at runtime as infra/antivirus/probe.mjs does.
const eicar = Buffer.from(
  ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''),
  'latin1',
);
const eicarTarget = await requestTarget(eicar, sha256(eicar), `eicar-${nonce}.txt`);
let eicarScan = `HTTP ${eicarTarget.status}`;
let eicarBlocked = false;
if (eicarTarget.status === 201 && !eicarTarget.body.alreadyStored) {
  await transfer(eicarTarget.body, eicar);
  const done = await complete(eicarTarget.body);
  eicarScan = `HTTP ${done.status} scan=${done.body.scanStatus}`;
  eicarBlocked = done.body.scanStatus === 'INFECTED';
} else if (eicarTarget.body.alreadyStored) {
  eicarScan = 'already stored by an earlier run; scan verdict not re-checked';
}
check('EICAR test file is scanned INFECTED, never CLEAN', eicarBlocked, eicarScan);

// --- Summary ----------------------------------------------------------------------------------

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);
