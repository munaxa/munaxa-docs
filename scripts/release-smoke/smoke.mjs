#!/usr/bin/env node
// The release smoke: runbook §16 and the release checks, through the API and the web image as a
// client sees them. No dependencies beyond Node 22, so it runs from a bare checkout.
//
// It is run by scripts/release-smoke/run.sh, which starts the stack from three image references
// (the release digests in publish-images.yml; images built from the commit in CI). It needs:
//
//   SMOKE_API_URL        e.g. http://127.0.0.1:3001
//   SMOKE_WEB_URL        e.g. http://127.0.0.1:3000
//   SMOKE_TENANT         the tenant the administrator belongs to (acme)
//   SMOKE_DECOY_TENANT   a second tenant in the catalogue, slugged `docs` (RC-1)
//   SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD   the provisioned administrator
//
// Every check is recorded. A failed check marked `blocking` makes the run exit 1; the summary is
// written to stdout and, in GitHub Actions, to the step summary. No credential or token is printed.

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const env = (name) => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set.`);
  }
  return value;
};

const API = env('SMOKE_API_URL');
const WEB = env('SMOKE_WEB_URL');
const TENANT = env('SMOKE_TENANT');
const DECOY = env('SMOKE_DECOY_TENANT');
const ADMIN = { email: env('SMOKE_ADMIN_EMAIL'), password: env('SMOKE_ADMIN_PASSWORD') };

/** The EICAR test file, assembled at runtime so no file in this repository is itself detected. */
const EICAR = Buffer.from(
  ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''),
);
const aPdf = (marker) =>
  Buffer.from(`%PDF-1.7\n% ${marker}\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n`, 'latin1');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = randomUUID().slice(0, 8);

const results = [];

/** Runs one check. A thrown error or a false return is a failure; a string return is evidence. */
async function check(id, title, blocking, body) {
  let outcome;
  try {
    const evidence = await body();
    outcome = { id, title, blocking, pass: evidence !== false, evidence: evidence || '' };
  } catch (error) {
    outcome = { id, title, blocking, pass: false, evidence: String(error?.message ?? error) };
  }
  results.push(outcome);
  const mark = outcome.pass ? 'PASS' : blocking ? 'FAIL (blocking)' : 'FAIL';
  process.stdout.write(`${mark.padEnd(16)} ${id.padEnd(6)} ${title}  ${outcome.evidence}\n`);
  return outcome.pass;
}

function expectStatus(reply, ...wanted) {
  if (!wanted.includes(reply.status)) {
    const detail = reply.body === null ? '' : ` ${JSON.stringify(reply.body).slice(0, 300)}`;
    throw new Error(`answered ${String(reply.status)}, expected ${wanted.join(' or ')}.${detail}`);
  }
  return `HTTP ${String(reply.status)}`;
}

async function call(method, path, token, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

const items = (body) => (Array.isArray(body) ? body : (body?.items ?? body?.data ?? []));

function signIn(tenant) {
  return call('POST', '/api/v1/auth/login', undefined, { ...ADMIN, tenant });
}

/** Open an upload, PUT the bytes to the presigned target, complete it — as the web client does. */
async function upload(token, bytes, filename, mimeType) {
  const opened = await call('POST', '/api/v1/uploads', token, {
    filename,
    mimeType,
    sizeBytes: bytes.length,
    magicBytes: bytes.subarray(0, 64).toString('base64'),
  });
  expectStatus(opened, 201);
  if (opened.body.alreadyStored) {
    throw new Error('the content was already stored; the smoke uploads unique content only');
  }
  const put = await fetch(opened.body.url, {
    method: opened.body.method,
    headers: opened.body.headers,
    body: bytes,
  });
  if (!put.ok) {
    throw new Error(`the transfer to the object store answered ${String(put.status)}`);
  }
  const done = await call(
    'POST',
    `/api/v1/uploads/${String(opened.body.uploadSessionId)}/complete`,
    token,
    { parts: [] },
  );
  expectStatus(done, 200, 201);
  return done.body;
}

// --- Service --------------------------------------------------------------------------------

await check('H1', 'API liveness', true, async () =>
  expectStatus(await call('GET', '/api/health/live'), 200),
);

await check('H2', 'API readiness: databases, cache and scanner UP', true, async () => {
  const reply = await call('GET', '/api/health/ready');
  expectStatus(reply, 200);
  if (reply.body?.status !== 'UP') {
    throw new Error(`status ${String(reply.body?.status)}: ${JSON.stringify(reply.body)}`);
  }
  return 'status UP';
});

await check('H3', 'OpenAPI explorer not served in production', true, async () => {
  const reply = await fetch(`${API}/api/docs`);
  return reply.status === 404
    ? 'HTTP 404'
    : (() => {
        throw new Error(`answered ${String(reply.status)}`);
      })();
});

// --- Authentication and tenancy (runbook §16 1–3, RC-1, RC-4, WEB-1) --------------------------

let session;
await check('A1', 'Sign in to the named tenant', true, async () => {
  const reply = await signIn(TENANT);
  expectStatus(reply, 200);
  session = reply.body;
  return typeof session?.accessToken === 'string' ? 'token issued' : false;
});

await check('A2', 'GET /auth/me answers for the signed-in administrator', true, async () => {
  const reply = await call('GET', '/api/v1/auth/me', session.accessToken);
  expectStatus(reply, 200);
  return reply.body?.email === ADMIN.email ? 'right user' : false;
});

await check('A3', 'A blank organisation resolves no tenant (RC-1)', true, async () =>
  expectStatus(await signIn(''), 400, 401),
);

await check('A4', 'The same credentials do not open the decoy tenant `docs`', true, async () =>
  expectStatus(await signIn(DECOY), 401),
);

await check('A5', 'Refresh without a tenant is refused (RC-4)', true, async () =>
  expectStatus(
    await call('POST', '/api/v1/auth/refresh', undefined, { refreshToken: session.refreshToken }),
    400,
    401,
  ),
);

// --- Configuration the document steps need (an empty tenant has none) -------------------------

const config = {};
await check(
  'C1',
  'Administration: numbering rule, confidentiality, type, library',
  true,
  async () => {
    const token = session.accessToken;
    const rule = await call('POST', '/api/v1/admin/numbering-rules', token, {
      key: `smoke-${run}`,
      name: `Smoke ${run}`,
      segments: [
        { kind: 'LITERAL', value: `S${run.slice(0, 6)}` },
        { kind: 'SEQUENCE', padding: 4 },
      ],
      resetScope: ['NEVER'],
    });
    expectStatus(rule, 201);
    const levels = items((await call('GET', '/api/v1/admin/confidentiality-levels', token)).body);
    let levelId = levels[0]?.id;
    if (levelId === undefined) {
      const level = await call('POST', '/api/v1/admin/confidentiality-levels', token, {
        code: `S${run.slice(0, 6)}`,
        name: `Smoke ${run}`,
        rank: 10,
      });
      expectStatus(level, 201);
      levelId = level.body.id;
    }
    const type = await call('POST', '/api/v1/admin/document-types', token, {
      code: `S${run.slice(0, 6)}`,
      name: `Smoke ${run}`,
      numberingRuleId: rule.body.id,
      defaultConfidentialityId: levelId,
    });
    expectStatus(type, 201);
    const library = await call('POST', '/api/v1/admin/libraries', token, {
      code: `S${run.slice(0, 6)}`,
      name: `Smoke ${run}`,
      ownerScopeType: 'TENANT',
    });
    expectStatus(library, 201);
    Object.assign(config, { documentTypeId: type.body.id, folderId: library.body.rootFolderId });
    return config.folderId ? 'created' : false;
  },
);

// --- Documents and object storage (runbook §16 5–7) -------------------------------------------

const clean = aPdf(`smoke ${run}`);
let cleanUpload;
await check(
  'S1',
  'Clean PDF: presigned upload to the object store, scanned CLEAN',
  true,
  async () => {
    cleanUpload = await upload(session.accessToken, clean, `smoke-${run}.pdf`, 'application/pdf');
    return cleanUpload.scanStatus === 'CLEAN'
      ? 'CLEAN'
      : (() => {
          throw new Error(`scanStatus ${String(cleanUpload.scanStatus)}`);
        })();
  },
);

let documentId;
await check('S2', 'File the clean upload as a document', true, async () => {
  const reply = await call('POST', '/api/v1/documents', session.accessToken, {
    folderId: config.folderId,
    documentTypeId: config.documentTypeId,
    title: `Smoke ${run}`,
    fileObjectId: cleanUpload.fileObjectId,
    filename: `smoke-${run}.pdf`,
    acknowledgeDuplicate: true,
  });
  expectStatus(reply, 201);
  documentId = reply.body.id;
  return 'HTTP 201';
});

await check('S3', 'Download: the stored bytes hash to the uploaded SHA-256', true, async () => {
  const link = await call('POST', `/api/v1/documents/${documentId}/content`, session.accessToken);
  expectStatus(link, 200, 201);
  const fetched = await fetch(link.body.url);
  if (!fetched.ok) {
    throw new Error(`the download answered ${String(fetched.status)}`);
  }
  const got = sha256(Buffer.from(await fetched.arrayBuffer()));
  return got === sha256(clean) ? `sha256 ${got.slice(0, 12)}… equal` : false;
});

// --- Antivirus (runbook §16 10–12) ------------------------------------------------------------

let infected;
await check('V1', 'EICAR upload is scanned INFECTED', true, async () => {
  const marker = Buffer.from(`\n${run}\n`);
  infected = await upload(
    session.accessToken,
    Buffer.concat([EICAR, marker]),
    'eicar.txt',
    'text/plain',
  );
  return infected.scanStatus === 'INFECTED'
    ? 'INFECTED'
    : (() => {
        throw new Error(`scanStatus ${String(infected.scanStatus)}`);
      })();
});

await check('V2', 'The infected file cannot be filed (409 CONTENT_NOT_SCANNED)', true, async () => {
  const reply = await call('POST', '/api/v1/documents', session.accessToken, {
    folderId: config.folderId,
    documentTypeId: config.documentTypeId,
    title: `Infected ${run}`,
    fileObjectId: infected.fileObjectId,
    filename: 'eicar.txt',
    acknowledgeDuplicate: true,
  });
  expectStatus(reply, 409);
  return JSON.stringify(reply.body).includes('CONTENT_NOT_SCANNED')
    ? 'HTTP 409 CONTENT_NOT_SCANNED'
    : false;
});

// --- Sign-out revokes the refresh token (runbook §16 3, WEB-1) --------------------------------

await check('A6', 'Sign-out revokes the refresh token', true, async () => {
  const body = { refreshToken: session.refreshToken, tenant: TENANT };
  expectStatus(await call('POST', '/api/v1/auth/logout', undefined, body), 204);
  return expectStatus(await call('POST', '/api/v1/auth/refresh', undefined, body), 401);
});

// --- Web image ---------------------------------------------------------------------------------

await check('W1', 'Web: the sign-in page renders', true, async () => {
  const reply = await fetch(`${WEB}/login`);
  return reply.status === 200
    ? 'HTTP 200'
    : (() => {
        throw new Error(`answered ${String(reply.status)}`);
      })();
});

await check(
  'W2',
  'Web: every branding asset the sign-in page references is served',
  true,
  async () => {
    const html = await (await fetch(`${WEB}/login`)).text();
    const paths = [
      ...new Set([...html.matchAll(/(?:src|href)="(\/branding\/[^"]+)"/g)].map((m) => m[1])),
    ];
    if (!paths.some((p) => p.includes('/favicon/')) || !paths.some((p) => p.includes('/logos/'))) {
      throw new Error('the page references no favicon or no logo');
    }
    for (const path of paths) {
      const reply = await fetch(`${WEB}${path}`);
      const type = reply.headers.get('content-type') ?? '';
      if (reply.status !== 200 || !type.startsWith('image/')) {
        throw new Error(`${path} answered ${String(reply.status)} ${type}`);
      }
    }
    return `${String(paths.length)} assets`;
  },
);

// --- Summary -----------------------------------------------------------------------------------

const failedBlocking = results.filter((r) => !r.pass && r.blocking);
const lines = [
  '### Release smoke',
  '',
  '| Check | Result | Evidence |',
  '| --- | --- | --- |',
  ...results.map(
    (r) =>
      `| ${r.id} ${r.title} | ${r.pass ? 'PASS' : r.blocking ? '**FAIL (blocking)**' : 'FAIL'} | ${r.evidence.replaceAll('|', '\\|').slice(0, 200)} |`,
  ),
  '',
  failedBlocking.length === 0
    ? `**${String(results.length)}/${String(results.length)} passed.**`
    : `**${String(failedBlocking.length)} blocking check(s) failed: NO-GO.**`,
];
process.stdout.write(`\n${lines.join('\n')}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}
process.exitCode = failedBlocking.length === 0 ? 0 : 1;
