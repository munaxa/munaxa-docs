// Phase B, step 9 (ADR-0026 §10): verified downloads at and past their resource limits.
//
// Not a browser case: plain HTTP, as a browser's navigation would send it, so dozens of downloads can
// run at once. Run in the `browser` service (its networks reach the proxy, every API container and
// nothing else). Each case prints one RESULT line; phase-b.sh judges it with the database, the store
// and the API containers' own state. No URL, token or password is ever printed.
//
//   node limits.mjs setup
//   node limits.mjs overflow <api> <count> <case>   issue <count> links on <api>, follow them all at once
//   node limits.mjs interrupt <staging|sending>     leave one download part-way, at the stack's API
//   node limits.mjs follow-one <api> <case>         one download; writes /out/following.flag as it starts
//
// <api> is a service name: `api` (followed through the proxy, as a browser does) or one of the
// test-only API containers of compose.phase-b.yaml (followed at that container directly).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const e = process.env;
const STATE = '/out/limits-state.json';
const MiB = 1024 * 1024;

const result = (name, facts) => console.log(`RESULT ${JSON.stringify({ case: name, ...facts })}`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const save = (patch) =>
  writeFileSync(STATE, JSON.stringify({ ...state(), ...patch }), { mode: 0o600 });
const apiBase = (service) => `http://${service}:3001`;

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
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, body: json };
}

/** The administrator's token, reused for four minutes; a rate-limited sign-in is waited out. */
async function adminToken(base) {
  const cached = state().tokens?.[base];
  if (cached && Date.now() - cached.at < 4 * 60_000) return cached.token;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const answer = await call(base, null, 'POST', '/auth/login', {
      email: e.SMOKE_ADMIN_EMAIL,
      password: e.SMOKE_ADMIN_PASSWORD,
      tenant: e.SMOKE_TENANT,
    });
    if (answer.status === 200) {
      save({
        tokens: {
          ...(state().tokens ?? {}),
          [base]: { token: answer.body.accessToken, at: Date.now() },
        },
      });
      return answer.body.accessToken;
    }
    if (answer.status !== 429) throw new Error(`sign-in answered ${answer.status}`);
    await sleep(30_000);
  }
  throw new Error('sign-in stayed rate-limited for six minutes');
}

/** Where a link is followed: the proxy for the stack's API, the container itself otherwise. */
function followUrl(link, service) {
  const url = new URL(link);
  const target =
    service === 'api' ? new URL(e.PB_PROXY_URL ?? 'http://proxy:8080') : new URL(apiBase(service));
  url.protocol = target.protocol;
  url.host = target.host;
  return url;
}

async function follow(link, service, digest, signal) {
  const begin = performance.now();
  const response = await fetch(followUrl(link, service), { signal });
  const ttfbMs = Math.round(performance.now() - begin);
  const hash = createHash('sha256');
  let size = 0;
  let text = '';
  for await (const chunk of response.body ?? []) {
    hash.update(chunk);
    size += chunk.byteLength;
    if (response.status !== 200 && text.length < 4096) text += Buffer.from(chunk).toString('utf8');
  }
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    disposition: response.headers.get('content-disposition'),
    contentType: response.headers.get('content-type'),
    ttfbMs,
    totalMs: Math.round(performance.now() - begin),
    bodyBytes: size,
    sameBytes: response.status === 200 ? hash.digest('hex') === digest : false,
    page: (text.match(/<p>([^<]*)<\/p>/) ?? [])[1] ?? null,
  };
}

const cases = {
  /** One 128 MiB PDF document, through the stack's API (every API container shares the database). */
  async setup() {
    const base = apiBase('api');
    const token = await adminToken(base);
    const library = ok(
      await call(base, token, 'POST', '/admin/libraries', {
        code: `PB-LIMITS-${randomBytes(2).toString('hex')}`,
        name: 'Phase B limits',
        ownerScopeType: 'TENANT',
      }),
      'library',
    );
    const types = ok(await call(base, token, 'GET', '/admin/document-types?pageSize=100'), 'types');
    const type = (Array.isArray(types) ? types : (types.items ?? types.data ?? []))[0];
    const bytes = randomBytes(128 * MiB);
    Buffer.from(`%PDF-1.7\n% phase-b limits ${randomBytes(8).toString('hex')}\n`, 'latin1').copy(
      bytes,
      0,
    );
    Buffer.from('\n%%EOF\n', 'latin1').copy(bytes, bytes.length - 7);
    const created = ok(
      await call(base, token, 'POST', '/uploads', {
        filename: 'phase-b-limits.pdf',
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
        magicBytes: bytes.subarray(0, 64).toString('base64'),
        checksumSha256: sha256(bytes),
      }),
      'upload',
    );
    const put = await fetch(created.url, {
      method: created.method,
      headers: created.headers,
      body: bytes,
    });
    if (!put.ok) throw new Error(`PUT answered ${put.status}`);
    const done = ok(
      await call(base, token, 'POST', `/uploads/${created.uploadSessionId}/complete`, {
        parts: [],
      }),
      'completion',
    );
    const document = ok(
      await call(base, token, 'POST', '/documents', {
        folderId: library.rootFolderId,
        documentTypeId: type.id,
        title: 'Phase B limits 128 MiB',
        fileObjectId: done.fileObjectId,
        filename: 'phase-b-limits.pdf',
      }),
      'document',
    );
    save({
      document: {
        id: document.id,
        fileObjectId: done.fileObjectId,
        digest: sha256(bytes),
        sizeBytes: bytes.length,
      },
    });
    result('limits-setup', { fileObjectId: done.fileObjectId, scanStatus: done.scanStatus });
  },

  /** `count` links issued on `service`, then followed all at once. */
  async overflow(service, count, name) {
    const { document } = state();
    const base = apiBase(service);
    const token = await adminToken(base);
    const links = [];
    const issues = [];
    for (let i = 0; i < Number(count); i += 1) {
      const issued = await call(base, token, 'POST', `/documents/${document.id}/content`);
      issues.push(issued.status);
      if (issued.status === 201 || issued.status === 200) links.push(issued.body.url);
    }
    const started = performance.now();
    const outcomes = await Promise.all(
      links.map((link) =>
        follow(link, service, document.digest).catch((error) => ({
          error: String(error.cause?.code ?? error.message),
        })),
      ),
    );
    result(name, {
      service,
      count: Number(count),
      issues,
      wallMs: Math.round(performance.now() - started),
      statuses: outcomes.map((o) => o.status ?? o.error),
      served: outcomes.filter((o) => o.status === 200 && o.sameBytes).length,
      busy: outcomes.filter((o) => o.status === 503 && o.retryAfter === '30').length,
      other: outcomes.filter(
        (o) => !(o.status === 200 && o.sameBytes) && !(o.status === 503 && o.retryAfter === '30'),
      ),
      corrupt: outcomes.filter((o) => o.status === 200 && !o.sameBytes).length,
      ttfbMs: outcomes.map((o) => o.ttfbMs),
      totalMs: outcomes.map((o) => o.totalMs),
      pages: [...new Set(outcomes.map((o) => o.page).filter(Boolean))],
    });
  },

  /** A download left part-way: while it is still being verified, or while it is being sent. */
  async interrupt(when) {
    const { document } = state();
    const base = apiBase('api');
    const token = await adminToken(base);
    const issued = await call(base, token, 'POST', `/documents/${document.id}/content`);
    const abort = new AbortController();
    const begin = performance.now();
    let headers = null;
    let received = 0;
    try {
      if (when === 'staging') setTimeout(() => abort.abort(), 150);
      const response = await fetch(followUrl(issued.body.url, 'api'), { signal: abort.signal });
      headers = response.status;
      for await (const chunk of response.body ?? []) {
        received += chunk.byteLength;
        if (when === 'sending' && received >= 4 * MiB) abort.abort();
      }
    } catch (error) {
      result(`interrupt-${when}`, {
        abortedAfterMs: Math.round(performance.now() - begin),
        status: headers,
        receivedBytes: received,
        of: document.sizeBytes,
        error: String(error.name),
      });
      return;
    }
    result(`interrupt-${when}`, { notInterrupted: true, status: headers, receivedBytes: received });
  },

  /** One download; the flag file tells the shell the request is on its way (to cut the store). */
  async 'follow-one'(service, name) {
    const { document } = state();
    const base = apiBase(service);
    const token = await adminToken(base);
    const issued = await call(base, token, 'POST', `/documents/${document.id}/content`);
    writeFileSync('/out/following.flag', String(Date.now()));
    const outcome = await follow(issued.body.url, service, document.digest).catch((error) => ({
      error: String(error.cause?.code ?? error.message),
    }));
    result(name, { service, issue: issued.status, ...outcome });
  },
};

function ok(answer, what) {
  if (answer.status >= 300) throw new Error(`${what} answered ${answer.status}`);
  return answer.body;
}

const [name, ...args] = process.argv.slice(2);
if (!(name in cases)) {
  console.error(`unknown case '${name}'`);
  process.exit(2);
}
try {
  await cases[name](...args);
} catch (error) {
  console.log(
    `FAIL  limits case ${name}: ${String(error.message).replace(/https?:\/\/\S+/g, '<url>')}`,
  );
  process.exitCode = 1;
}
