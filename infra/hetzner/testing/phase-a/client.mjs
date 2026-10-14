// Phase A (ADR-0026 §10): the client half of the local upload and download checks.
//
// Run by phase-a.sh in the smoke runner's container (api image, `edge` + `ci-storage` networks), so
// it calls the API as the web server does and the object store as a browser would. It prints
// statuses and facts only — never a URL (a presigned URL carries a credential), a token or a
// password — as `RESULT <json>` lines that phase-a.sh checks against database and store state.
//
//   node client.mjs <step> [arguments]
//
// Steps: sizes, no-digest, slow <variant>, load <count>, dl-setup, dl-pre, dl-post.
// State shared with phase-a.sh lives in /pa (a private temporary directory, removed afterwards).

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';

const e = process.env;
const API = e.PA_API_URL ?? 'http://api:3001';
const TTL_API = e.PA_TTL_API_URL ?? 'http://phase-a-api-ttl:3001';
const STATE = '/pa/state.json';
const MiB = 1024 * 1024;

const result = (step, facts) => console.log(`RESULT ${JSON.stringify({ step, ...facts })}`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const state = () => JSON.parse(readFileSync(STATE, 'utf8'));
const save = (value) => writeFileSync(STATE, JSON.stringify(value), { mode: 0o600 });

// --- Content -------------------------------------------------------------------------------------

/**
 * Printable text of an exact size, unique to this call.
 *
 * Text, because the product sniffs the leading bytes and `text/plain` is on its allow-list; unique,
 * because identical bytes deduplicate onto an earlier upload and would skip the transfer and scan
 * this phase is measuring. Random lines rather than one repeated character, so no step is flattered
 * by compression anywhere on the way.
 */
function textOfSize(size, label) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';
  const block = Buffer.alloc(64 * 1024);
  const noise = randomBytes(block.length);
  for (let i = 0; i < block.length; i += 1) {
    block[i] = (i + 1) % 80 === 0 ? 0x0a : alphabet.charCodeAt(noise[i] % alphabet.length);
  }
  const bytes = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset += block.length) {
    block.copy(bytes, offset, 0, Math.min(block.length, size - offset));
  }
  const head = Buffer.from(`phase-a ${label} ${randomBytes(12).toString('hex')}\n`, 'utf8');
  head.copy(bytes, 0, 0, Math.min(head.length, size));
  return bytes;
}

/**
 * A PDF-headed file of an exact size, unique to this call.
 *
 * For the large-file steps: the product caps each format family (upload-policy.ts) — text at
 * 32 MiB, PDF at 512 MiB — under the deployment ceiling, so only a family allowed 128 MiB or more
 * reaches the ceiling at all. The body is random (incompressible) bytes between a PDF header and
 * trailer: enough for the sniff, which reads the leading bytes, and for the scanner, which reads
 * everything.
 */
function pdfOfSize(size, label) {
  const bytes = randomBytes(size);
  Buffer.from(`%PDF-1.7\n% phase-a ${label} ${randomBytes(12).toString('hex')}\n`, 'latin1').copy(
    bytes,
    0,
  );
  Buffer.from('\n%%EOF\n', 'latin1').copy(bytes, size - 7);
  return bytes;
}

// --- API -----------------------------------------------------------------------------------------

async function call(base, token, method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, body: json };
}

async function signIn(email, password, base = API) {
  const answer = await call(base, null, 'POST', '/auth/login', {
    email,
    password,
    tenant: e.SMOKE_TENANT,
  });
  if (answer.status !== 200) {
    throw new Error(`sign-in for a test user answered ${answer.status}`);
  }
  return answer.body.accessToken;
}

const admin = (base = API) => signIn(e.SMOKE_ADMIN_EMAIL, e.SMOKE_ADMIN_PASSWORD, base);

/** What a problem answer may safely show: its code and detail, never a URL. */
function problem(body) {
  if (body === null || typeof body !== 'object') return null;
  const strip = (value) =>
    typeof value === 'string' ? value.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200) : value;
  return { code: strip(body.code ?? body.title ?? null), detail: strip(body.detail ?? null) };
}

async function createUpload(
  base,
  token,
  bytes,
  { filename, withDigest = true, mimeType = 'text/plain' },
) {
  return call(base, token, 'POST', '/uploads', {
    filename,
    mimeType,
    sizeBytes: bytes.length,
    magicBytes: bytes.subarray(0, 64).toString('base64'),
    ...(withDigest && { checksumSha256: sha256(bytes) }),
  });
}

async function put(target, bytes) {
  const response = await fetch(target.url, {
    method: target.method,
    headers: target.headers,
    body: bytes,
  });
  const text = await response.text();
  return { status: response.status, code: (text.match(/<Code>([^<]*)<\/Code>/) ?? [])[1] ?? null };
}

async function complete(base, token, id) {
  const answer = await call(base, token, 'POST', `/uploads/${id}/complete`, { parts: [] });
  return {
    status: answer.status,
    scanStatus: answer.body?.scanStatus ?? null,
    fileObjectId: answer.body?.fileObjectId ?? null,
    problem: answer.status >= 400 ? problem(answer.body) : null,
  };
}

/**
 * One upload, end to end, as the web client performs it.
 *
 * The facts are collected as each stage answers, so an upload interrupted part-way — the API
 * restarting under it, say — still reports how far it got and which session it left.
 */
async function upload(base, token, bytes, label, options = {}) {
  const started = Date.now();
  const extension = options.mimeType === 'application/pdf' ? 'pdf' : 'txt';
  const facts = { label, sizeBytes: bytes.length, digest: sha256(bytes) };
  try {
    const created = await createUpload(base, token, bytes, {
      filename: `${label}.${extension}`,
      ...options,
    });
    facts.create = created.status;
    if (created.status !== 201) {
      facts.problem = problem(created.body);
      return facts;
    }
    const target = created.body;
    facts.sessionId = target.uploadSessionId;
    facts.signedChecksum = Object.keys(target.headers).some(
      (name) => name.toLowerCase() === 'x-amz-checksum-sha256',
    );
    const transfer = await put(target, bytes);
    facts.put = transfer.status;
    facts.putCode = transfer.code;
    const done = await complete(base, token, target.uploadSessionId);
    facts.complete = done.status;
    facts.scanStatus = done.scanStatus;
    facts.fileObjectId = done.fileObjectId;
    facts.problem = done.problem;
  } catch (error) {
    facts.error = String(error.cause?.code ?? error.message).replace(/https?:\/\/\S+/g, '<url>');
  } finally {
    facts.ms = Date.now() - started;
  }
  return facts;
}

/**
 * A PUT sent at a fixed rate, the way a slow connection sends it.
 *
 * `node:http` rather than fetch, because fetch cannot pace a body. The headers are the signed ones,
 * unchanged; only the timing differs from an ordinary upload.
 */
function slowPut(target, bytes, bytesPerSecond) {
  return new Promise((resolve) => {
    const url = new URL(target.url);
    const request = http.request(
      url,
      { method: target.method, headers: target.headers },
      (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            code: (text.match(/<Code>([^<]*)<\/Code>/) ?? [])[1] ?? null,
          }),
        );
      },
    );
    request.on('error', (error) => resolve({ status: null, code: error.code ?? 'ERROR' }));
    const chunk = 16 * 1024;
    let offset = 0;
    const tick = () => {
      if (offset >= bytes.length) {
        request.end();
        return;
      }
      const end = Math.min(offset + chunk, bytes.length);
      request.write(bytes.subarray(offset, end));
      offset = end;
      setTimeout(tick, (chunk / bytesPerSecond) * 1000);
    };
    tick();
  });
}

// --- Steps ---------------------------------------------------------------------------------------

const steps = {
  /**
   * 1. Size boundaries against the 128 MiB ceiling (AV_ICAP_MAX_BYTES), as PDFs; and one text file
   * just over the text family's own 32 MiB cap, to record how that refusal reads.
   */
  async sizes() {
    const token = await admin();
    for (const [label, size] of [
      ['size-1MiB', 1 * MiB],
      ['size-127MiB', 127 * MiB],
      ['size-128MiB', 128 * MiB],
      ['size-128MiB-plus-1', 128 * MiB + 1],
    ]) {
      const facts = await upload(API, token, pdfOfSize(size, label), label, {
        mimeType: 'application/pdf',
      });
      result('sizes', facts);
    }
    const text = 'text-32MiB-plus-1';
    result('sizes', await upload(API, token, textOfSize(32 * MiB + 1, text), text));
  },

  /** 2. An upload created without a SHA-256, as a browser without SubtleCrypto would send it. */
  async 'no-digest'() {
    const token = await admin();
    const bytes = textOfSize(1 * MiB, 'no-digest');
    result('no-digest', await upload(API, token, bytes, 'no-digest', { withDigest: false }));
    const state = { noDigest: { digest: sha256(bytes) } };
    save(state);
  },

  /**
   * 3. Uploads slower than their link (STORAGE_SIGNED_URL_TTL_SECONDS=30 on the TTL API).
   *
   *   expired-before-put  the PUT starts after the link expired
   *   slow-before-sweep   the PUT starts in time and ends after expiry; completion before any sweep
   *   sweep-during-put    the PUT starts in time; phase-a.sh fires the upload sweep while it runs
   */
  async slow(variant) {
    const token = await admin(TTL_API);
    const plan = {
      'expired-before-put': { size: 256 * 1024, rate: null, waitBeforePut: 35_000 },
      'slow-before-sweep': { size: 1 * MiB, rate: 20 * 1024, waitBeforePut: 0 },
      'sweep-during-put': { size: 1 * MiB, rate: 10 * 1024, waitBeforePut: 0 },
    }[variant];
    const bytes = textOfSize(plan.size, `slow-${variant}`);
    const created = await createUpload(TTL_API, token, bytes, { filename: `slow-${variant}.txt` });
    if (created.status !== 201) {
      result('slow', { variant, create: created.status, problem: problem(created.body) });
      return;
    }
    const target = created.body;
    const issuedAt = Date.now();
    const ttlSeconds = Math.round((Date.parse(target.expiresAt) - issuedAt) / 1000);
    console.log(`slow ${variant}: session issued, link valid ~${ttlSeconds} s`);
    await sleep(plan.waitBeforePut);
    const putStartedAfter = Date.now() - issuedAt;
    const transfer =
      plan.rate === null ? await put(target, bytes) : await slowPut(target, bytes, plan.rate);
    const putEndedAfter = Date.now() - issuedAt;
    const done = await complete(TTL_API, token, target.uploadSessionId);
    result('slow', {
      variant,
      sessionId: target.uploadSessionId,
      digest: sha256(bytes),
      sizeBytes: bytes.length,
      ttlSeconds,
      putStartedAfterS: Math.round(putStartedAfter / 1000),
      putEndedAfterS: Math.round(putEndedAfter / 1000),
      put: transfer.status,
      putCode: transfer.code,
      complete: done.status,
      scanStatus: done.scanStatus,
      problem: done.problem,
    });
  },

  /** 5. Several large uploads at once; phase-a.sh measures the API's memory meanwhile. */
  async load(count) {
    const token = await admin();
    const n = Number(count);
    const files = Array.from({ length: n }, (_unused, i) =>
      pdfOfSize(120 * MiB + i, `load${n}-${i}`),
    );
    console.log(`load ${n}: ${n} files of ~120 MiB prepared; starting together`);
    const started = Date.now();
    const outcomes = await Promise.all(
      files.map((bytes, i) =>
        upload(API, token, bytes, `load${n}-${i}`, { mimeType: 'application/pdf' }),
      ),
    );
    for (const facts of outcomes) result(`load${n}`, facts);
    result(`load${n}-total`, { count: n, wallSeconds: Math.round((Date.now() - started) / 1000) });
  },

  /**
   * 6a. A library, a type, two confidentiality levels, a user without `document:download`, and four
   * documents — all through the administration API, as an administrator would set them up.
   */
  async 'dl-setup'() {
    const token = await admin();
    const ok = (answer, what) => {
      if (answer.status >= 300) {
        throw new Error(
          `${what} answered ${answer.status}: ${JSON.stringify(problem(answer.body))}`,
        );
      }
      return answer.body;
    };
    // Codes and ranks unique to this run: both are unique per tenant.
    const tag = randomBytes(2).toString('hex');
    const levels = ok(
      await call(API, token, 'GET', '/admin/confidentiality-levels?pageSize=100'),
      'confidentiality level list',
    );
    const ranks = (Array.isArray(levels) ? levels : (levels.items ?? levels.data ?? [])).map(
      (level) => level.rank,
    );
    const rank = Math.max(0, ...ranks) + 1;
    const open = ok(
      await call(API, token, 'POST', '/admin/confidentiality-levels', {
        code: `PA-OPEN-${tag}`,
        name: `Phase A open ${tag}`,
        rank,
        allowDownload: true,
      }),
      'open confidentiality level',
    );
    const closed = ok(
      await call(API, token, 'POST', '/admin/confidentiality-levels', {
        code: `PA-NODL-${tag}`,
        name: `Phase A no download ${tag}`,
        rank: rank + 1,
        allowDownload: false,
      }),
      'no-download confidentiality level',
    );
    const rule = ok(
      await call(API, token, 'POST', '/admin/numbering-rules', {
        key: `phase-a-${tag}`,
        name: `Phase A ${tag}`,
        segments: [
          { kind: 'LITERAL', value: 'PA' },
          { kind: 'SEQUENCE', padding: 4 },
        ],
        resetScope: ['NEVER'],
      }),
      'numbering rule',
    );
    const type = ok(
      await call(API, token, 'POST', '/admin/document-types', {
        code: `PA-TYPE-${tag}`,
        name: `Phase A type ${tag}`,
        numberingRuleId: rule.id,
        defaultConfidentialityId: open.id,
      }),
      'document type',
    );
    const library = ok(
      await call(API, token, 'POST', '/admin/libraries', {
        code: `PA-LIB-${tag}`,
        name: `Phase A library ${tag}`,
        ownerScopeType: 'TENANT',
      }),
      'library',
    );

    const documents = {};
    for (const [name, confidentialityId, filename] of [
      ['open', null, 'phase-a-open.txt'],
      ['nodl', closed.id, 'phase-a-nodl.txt'],
      ['tampered', null, 'phase-a-tampered.txt'],
      ['missing', null, 'phase-a-missing.txt'],
      ['unicode', null, 'Résumé تقرير.txt'],
    ]) {
      const bytes = textOfSize(4096, `dl-${name}`);
      const stored = await upload(API, token, bytes, `dl-${name}`);
      if (stored.complete !== 201 || stored.scanStatus !== 'CLEAN') {
        throw new Error(`the ${name} document's upload answered ${JSON.stringify(stored)}`);
      }
      const document = ok(
        await call(API, token, 'POST', '/documents', {
          folderId: library.rootFolderId,
          documentTypeId: type.id,
          ...(confidentialityId === null ? {} : { confidentialityId }),
          title: `Phase A ${name}`,
          fileObjectId: stored.fileObjectId,
          filename,
        }),
        `${name} document`,
      );
      documents[name] = {
        id: document.id,
        fileObjectId: stored.fileObjectId,
        digest: stored.digest,
        filename,
      };
    }

    // A role that may see documents and may not download them — made for this run, so the case
    // does not depend on how the seeded roles happen to be configured.
    const reader = ok(
      await call(API, token, 'POST', '/admin/roles', {
        key: `phase-a-viewer-${tag}`,
        name: `Phase A viewer ${tag}`,
        permissions: ['document:view'],
      }),
      'view-only role',
    );
    const password = `Pa-${randomBytes(24).toString('hex')}`;
    const email = `reader-${randomBytes(4).toString('hex')}@acme.invalid`;
    const user = ok(
      await call(API, token, 'POST', '/admin/users', {
        email,
        displayName: 'Phase A reader',
        roleIds: [reader.id],
      }),
      'reader user',
    );
    ok(
      await call(API, token, 'PUT', `/admin/users/${user.id}/password`, { password }),
      'reader password',
    );
    if (user.status !== 'ACTIVE') {
      await call(API, token, 'POST', `/admin/users/${user.id}/activate`);
    }
    console.log(`dl-setup: role '${reader.key}' holds document:view and not document:download`);
    save({ ...safeState(), documents, reader: { email, password, role: reader.key } });
    result('dl-setup', {
      documents: Object.fromEntries(
        Object.entries(documents).map(([k, v]) => [
          k,
          { fileObjectId: v.fileObjectId, digest: v.digest },
        ]),
      ),
      readerRole: reader.key,
    });
  },

  /** 6b. Before the integrity verifier runs: what a tampered or missing object looks like. */
  async 'dl-pre'() {
    const { documents } = state();
    const token = await admin();
    for (const name of ['tampered', 'missing']) {
      result('dl-pre', { case: name, ...(await download(API, token, documents[name])) });
    }
  },

  /** 6c. After the verifier, and every authorization and link case. */
  async 'dl-post'() {
    const { documents, reader } = state();
    const token = await admin();

    for (const name of ['open', 'unicode', 'nodl', 'tampered', 'missing']) {
      result('dl-post', { case: name, ...(await download(API, token, documents[name])) });
    }

    const readerToken = await signIn(reader.email, reader.password);
    const refused = await call(API, readerToken, 'POST', `/documents/${documents.open.id}/content`);
    result('dl-post', {
      case: 'reader-without-download-permission',
      issue: refused.status,
      problem: problem(refused.body),
    });

    // An expired link: issued by the API whose links last 30 s, redeemed after 35 s.
    const ttlToken = await admin(TTL_API);
    const shortLived = await call(
      TTL_API,
      ttlToken,
      'POST',
      `/documents/${documents.open.id}/content`,
    );
    const fresh = await fetch(shortLived.body.url);
    await fresh.arrayBuffer();
    await sleep(35_000);
    const stale = await fetch(shortLived.body.url);
    const staleText = await stale.text();
    result('dl-post', {
      case: 'expired-link',
      issue: shortLived.status,
      beforeExpiry: fresh.status,
      afterExpiry: stale.status,
      afterExpiryCode: (staleText.match(/<Code>([^<]*)<\/Code>/) ?? [])[1] ?? null,
    });

    // Edited links: the signature altered, and the path pointed at another object.
    const issued = await call(API, token, 'POST', `/documents/${documents.open.id}/content`);
    const url = new URL(issued.body.url);
    const signature = url.searchParams.get('X-Amz-Signature');
    const flipped = new URL(url);
    flipped.searchParams.set(
      'X-Amz-Signature',
      `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`,
    );
    const other = await call(API, token, 'POST', `/documents/${documents.unicode.id}/content`);
    const moved = new URL(url);
    moved.pathname = new URL(other.body.url).pathname;
    for (const [name, edited] of [
      ['edited-signature', flipped],
      ['edited-path', moved],
    ]) {
      const answer = await fetch(edited);
      const text = await answer.text();
      result('dl-post', {
        case: name,
        status: answer.status,
        code: (text.match(/<Code>([^<]*)<\/Code>/) ?? [])[1] ?? null,
      });
    }
  },
};

/** Everything already in the state file, minus nothing: a later step adds to it. */
function safeState() {
  try {
    return state();
  } catch {
    return {};
  }
}

/** Issue a download link as the web client does, follow it as a browser would, and compare. */
async function download(base, token, document) {
  const issued = await call(base, token, 'POST', `/documents/${document.id}/content`);
  if (issued.status !== 201 && issued.status !== 200) {
    return { issue: issued.status, problem: problem(issued.body) };
  }
  const response = await fetch(issued.body.url, { headers: { 'accept-encoding': 'gzip' } });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    issue: issued.status,
    get: response.status,
    sameBytes: response.status === 200 ? sha256(bytes) === document.digest : null,
    contentType: response.headers.get('content-type'),
    disposition: response.headers.get('content-disposition'),
  };
}

const [step, ...args] = process.argv.slice(2);
if (!(step in steps)) {
  console.error(`unknown step '${step}'`);
  process.exit(2);
}
steps[step](...args).catch((error) => {
  console.log(
    `FAIL  client step ${step}: ${String(error.message).replace(/https?:\/\/\S+/g, '<url>')}`,
  );
  process.exit(1);
});
