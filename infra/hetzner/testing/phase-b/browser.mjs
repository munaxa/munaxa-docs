// Phase B (ADR-0026 §10, docs/reports/hetzner-phase-b-browser-test-plan.md): the browser half.
//
// Chromium, driven by the `playwright` package apps/web already depends on, against the local test
// stack through its proxy at http://localhost:8080 (forward.mjs). Every case prints one RESULT line of
// facts; phase-b.sh judges them, together with the database and the store. Nothing here prints a
// password, a token or a signed URL: URLs are reduced to their path before they are written.
//
//   node browser.mjs <case> [<case> …]      (inside the `browser` service of compose.phase-b.yaml)
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { forwardLocalhost } from './forward.mjs';

const require = createRequire('/repo/apps/web/package.json');
const { chromium } = require('playwright');

const e = process.env;
const WEB = 'http://localhost:8080';
const API = e.PB_API_URL ?? 'http://api:3001';
const OUT = '/out';
const STATE = `${OUT}/state.json`;
const CONSOLE = `${OUT}/console.jsonl`;
const MiB = 1024 * 1024;
const DOWNLOAD_WAIT_MS = 120_000;

const result = (name, facts) => console.log(`RESULT ${JSON.stringify({ case: name, ...facts })}`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const save = (patch) =>
  writeFileSync(STATE, JSON.stringify({ ...state(), ...patch }), { mode: 0o600 });
const pathOnly = (url) => (url ? new URL(url).pathname : null);

// --- Content ---------------------------------------------------------------------------------------

function textOfSize(size, label) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz ';
  const noise = randomBytes(size);
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) {
    bytes[i] = (i + 1) % 80 === 0 ? 0x0a : alphabet.charCodeAt(noise[i] % alphabet.length);
  }
  Buffer.from(`phase-b ${label} ${randomBytes(8).toString('hex')}\n`).copy(bytes, 0);
  return bytes;
}

/** A PDF-headed file of an exact size (for size cases; not meant to render). */
function pdfOfSize(size, label) {
  const bytes = randomBytes(size);
  Buffer.from(`%PDF-1.7\n% phase-b ${label} ${randomBytes(8).toString('hex')}\n`, 'latin1').copy(
    bytes,
    0,
  );
  Buffer.from('\n%%EOF\n', 'latin1').copy(bytes, size - 7);
  return bytes;
}

/** A small, valid one-page PDF that a viewer can render (for the preview case). */
function renderablePdf(label) {
  const stream = `BT /F1 24 Tf 72 720 Td (Phase B ${label} ${randomBytes(4).toString('hex')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// --- API (set-up and look-ups only; every judged action goes through the interface) ----------------

async function call(token, method, path, body) {
  const response = await fetch(`${API}/api/v1${path}`, {
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

async function signInApi(email, password) {
  const answer = await call(null, 'POST', '/auth/login', {
    email,
    password,
    tenant: e.SMOKE_TENANT,
  });
  if (answer.status !== 200) throw new Error(`API sign-in answered ${answer.status}`);
  return answer.body.accessToken;
}
const adminToken = () => signInApi(e.SMOKE_ADMIN_EMAIL, e.SMOKE_ADMIN_PASSWORD);

function ok(answer, what) {
  if (answer.status >= 300) {
    throw new Error(
      `${what} answered ${answer.status} ${JSON.stringify(answer.body?.code ?? null)}`,
    );
  }
  return answer.body;
}

/** One upload, as the web client performs it; the presigned PUT goes to storage:9000. */
async function uploadApi(token, bytes, filename, mimeType) {
  const created = ok(
    await call(token, 'POST', '/uploads', {
      filename,
      mimeType,
      sizeBytes: bytes.length,
      magicBytes: bytes.subarray(0, 64).toString('base64'),
      checksumSha256: sha256(bytes),
    }),
    `upload of ${filename}`,
  );
  const put = await fetch(created.url, {
    method: created.method,
    headers: created.headers,
    body: bytes,
  });
  if (!put.ok) throw new Error(`PUT of ${filename} answered ${put.status}`);
  const done = ok(
    await call(token, 'POST', `/uploads/${created.uploadSessionId}/complete`, { parts: [] }),
    `completion of ${filename}`,
  );
  if (done.scanStatus !== 'CLEAN') throw new Error(`${filename} scanned ${done.scanStatus}`);
  return done.fileObjectId;
}

// --- The browser -------------------------------------------------------------------------------------

let browser;
let stopForward;

async function open() {
  stopForward = await forwardLocalhost(8080, e.PB_PROXY_URL ?? 'http://proxy:8080');
  browser = await chromium.launch(e.PB_CHROMIUM ? { executablePath: e.PB_CHROMIUM } : {});
}

async function close() {
  await browser?.close();
  await stopForward?.();
}

/** A signed-in context, optionally in Arabic (the interface reads only the edms_locale cookie). */
async function session(email, password, { arabic = false } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  if (arabic) {
    await context.addCookies([{ name: 'edms_locale', value: 'ar', url: WEB }]);
  }
  const page = await context.newPage();
  watchConsole(page);
  await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(arabic ? 'البريد الإلكتروني' : 'Email address').fill(email);
  await page.getByLabel(arabic ? 'كلمة المرور' : 'Password').fill(password);
  await page.getByLabel(arabic ? 'المؤسسة' : 'Organisation').fill(e.SMOKE_TENANT);
  await page.getByRole('button', { name: arabic ? 'تسجيل الدخول' : 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  return { context, page };
}
const asAdmin = (options) => session(e.SMOKE_ADMIN_EMAIL, e.SMOKE_ADMIN_PASSWORD, options);

function watchConsole(page) {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      appendFileSync(
        CONSOLE,
        `${JSON.stringify({ page: pathOnly(page.url()), text: message.text().slice(0, 300) })}\n`,
      );
    }
  });
}

/**
 * Runs an action that may start a download, and says exactly what arrived: a download (saved, with
 * its bytes hashed), or the page or message shown instead — and, either way, the response headers of
 * the verified download link the browser followed, if it followed one.
 */
async function attempt(page, action, { expectedDigest = null, timeoutMs = DOWNLOAD_WAIT_MS } = {}) {
  const startUrl = page.url();
  let linkResponse = null;
  const onResponse = (response) => {
    if (new URL(response.url()).pathname === '/api/v1/downloads') linkResponse = response;
  };
  page.on('response', onResponse);
  const download = page.waitForEvent('download', { timeout: timeoutMs }).catch(() => null);
  const begin = Date.now();
  await action();
  const settled = await Promise.race([
    download,
    page
      .waitForURL((url) => url.pathname === '/api/v1/downloads', { timeout: timeoutMs })
      .then(
        () => null,
        () => null,
      ),
    page
      .getByRole('status')
      .first()
      .waitFor({ timeout: timeoutMs })
      .then(
        () => null,
        () => null,
      ),
  ]);
  const got = settled ?? (await Promise.race([download, sleep(1_000).then(() => null)]));
  page.off('response', onResponse);
  const facts = { downloadEvent: got !== null, savedBytes: 0, ms: Date.now() - begin };
  if (got !== null) {
    const path = `${OUT}/saved-${randomBytes(6).toString('hex')}`;
    await got.saveAs(path);
    const bytes = readFileSync(path);
    facts.savedBytes = bytes.length;
    facts.suggestedFilename = got.suggestedFilename();
    facts.sameBytes = expectedDigest === null ? null : sha256(bytes) === expectedDigest;
  }
  if (linkResponse !== null) {
    facts.status = linkResponse.status();
    facts.disposition = linkResponse.headers()['content-disposition'] ?? null;
    facts.contentType = linkResponse.headers()['content-type'] ?? null;
  }
  if (new URL(page.url()).pathname === '/api/v1/downloads') {
    facts.message =
      (await page
        .locator('p')
        .first()
        .textContent()
        .catch(() => null)) ?? null;
    facts.dir = await page
      .locator('html')
      .getAttribute('dir')
      .catch(() => null);
  } else {
    const toasts = await page
      .getByRole('status')
      .allTextContents()
      .catch(() => []);
    facts.message = toasts.join(' | ') || null;
  }
  facts.navigatedAway = got !== null && page.url() !== startUrl;
  return facts;
}

const documentPage = (page, id) =>
  page.goto(`${WEB}/documents/${id}`, { waitUntil: 'networkidle' });
const headerDownload = (page, name = 'Download') =>
  page.getByRole('button', { name, exact: true }).first().click();

/** Captures the verified link a click issues, without following it. */
async function captureLink(page, click) {
  let captured = null;
  await page.route('**/api/v1/downloads**', async (route) => {
    captured = route.request().url();
    await route.abort();
  });
  await click();
  for (let i = 0; i < 100 && captured === null; i += 1) await sleep(100);
  await page.unroute('**/api/v1/downloads**');
  return captured;
}

/** Follows a link by navigation, as the browser would after `window.location.assign`. */
async function followLink(page, url, expectedDigest = null) {
  return attempt(page, () => page.goto(url).catch(() => undefined), {
    expectedDigest,
    timeoutMs: 20_000,
  });
}

// --- Cases -------------------------------------------------------------------------------------------

const cases = {
  /** The data every later case uses, created through the API as an administrator would. */
  async setup() {
    mkdirSync(OUT, { recursive: true });
    const token = await adminToken();
    const tag = randomBytes(2).toString('hex');
    const levels = ok(
      await call(token, 'GET', '/admin/confidentiality-levels?pageSize=100'),
      'levels',
    );
    const ranks = (Array.isArray(levels) ? levels : (levels.items ?? levels.data ?? [])).map(
      (l) => l.rank,
    );
    const rank = Math.max(0, ...ranks) + 1;
    const open = ok(
      await call(token, 'POST', '/admin/confidentiality-levels', {
        code: `PB-OPEN-${tag}`,
        name: `Phase B open ${tag}`,
        rank,
        allowDownload: true,
      }),
      'open level',
    );
    const closed = ok(
      await call(token, 'POST', '/admin/confidentiality-levels', {
        code: `PB-NODL-${tag}`,
        name: `Phase B no download ${tag}`,
        rank: rank + 1,
        allowDownload: false,
      }),
      'no-download level',
    );
    const rule = ok(
      await call(token, 'POST', '/admin/numbering-rules', {
        key: `phase-b-${tag}`,
        name: `Phase B ${tag}`,
        segments: [
          { kind: 'LITERAL', value: 'PB' },
          { kind: 'SEQUENCE', padding: 4 },
        ],
        resetScope: ['NEVER'],
      }),
      'numbering rule',
    );
    const type = ok(
      await call(token, 'POST', '/admin/document-types', {
        code: `PB-TYPE-${tag}`,
        name: `Phase B type ${tag}`,
        numberingRuleId: rule.id,
        defaultConfidentialityId: open.id,
      }),
      'type',
    );
    const library = ok(
      await call(token, 'POST', '/admin/libraries', {
        code: `PB-LIB-${tag}`,
        name: `Phase B library ${tag}`,
        ownerScopeType: 'TENANT',
      }),
      'library',
    );

    const documents = {};
    const make = async (name, bytes, filename, mimeType, extra = {}) => {
      const fileObjectId = await uploadApi(token, bytes, filename, mimeType);
      const created = ok(
        await call(token, 'POST', '/documents', {
          folderId: library.rootFolderId,
          documentTypeId: type.id,
          title: `Phase B ${name}`,
          fileObjectId,
          filename,
          ...extra,
        }),
        `${name} document`,
      );
      documents[name] = {
        id: created.id,
        fileObjectId,
        digest: sha256(bytes),
        filename,
        title: `Phase B ${name}`,
      };
    };
    await make('text', textOfSize(4096, 'text'), 'phase-b-text.txt', 'text/plain');
    await make('pdf', renderablePdf('preview'), 'phase-b-report.pdf', 'application/pdf');
    await make('binary', pdfOfSize(5 * MiB, 'binary'), 'phase-b-binary.pdf', 'application/pdf');
    await make('large', pdfOfSize(120 * MiB, 'large'), 'phase-b-large.pdf', 'application/pdf');
    await make('arabic', textOfSize(2048, 'arabic'), 'تقرير الربع الأول.txt', 'text/plain');
    await make('accented', textOfSize(2048, 'accented'), 'Résumé café.txt', 'text/plain');
    await make('mixed', textOfSize(2048, 'mixed'), 'Résumé تقرير.txt', 'text/plain');
    await make('quotes', textOfSize(2048, 'quotes'), 'QA "draft" 2.txt', 'text/plain');
    await make(
      'confidential',
      textOfSize(2048, 'confidential'),
      'phase-b-confidential.txt',
      'text/plain',
      { confidentialityId: closed.id },
    );
    for (const name of ['swapped', 'vanished', 'quarantined', 'unavailable']) {
      await make(name, textOfSize(4096, name), `phase-b-${name}.txt`, 'text/plain');
    }
    let html = null;
    try {
      await make(
        'html',
        Buffer.from('<!doctype html><title>x</title><script>document.title="RAN"</script>'),
        'phase-b.html',
        'text/html',
      );
      html = 'accepted';
    } catch (error) {
      html = `refused at upload: ${String(error.message).slice(0, 120)}`;
    }

    const role = ok(
      await call(token, 'POST', '/admin/roles', {
        key: `phase-b-viewer-${tag}`,
        name: `Phase B viewer ${tag}`,
        permissions: ['document:view'],
      }),
      'viewer role',
    );
    const viewer = {
      email: `viewer-${randomBytes(4).toString('hex')}@acme.invalid`,
      password: `Pb-${randomBytes(24).toString('hex')}`,
    };
    const user = ok(
      await call(token, 'POST', '/admin/users', {
        email: viewer.email,
        displayName: 'Phase B viewer',
        roleIds: [role.id],
      }),
      'viewer',
    );
    ok(
      await call(token, 'PUT', `/admin/users/${user.id}/password`, { password: viewer.password }),
      'viewer password',
    );
    if (user.status !== 'ACTIVE') await call(token, 'POST', `/admin/users/${user.id}/activate`);

    save({
      documents,
      viewer,
      library: { id: library.id, folderId: library.rootFolderId },
      typeId: type.id,
    });
    result('setup', { documents: Object.keys(documents), html });
  },

  /** B-8, then B-1/B-2: file a document through the upload dialog, then download it every way. */
  async 'upload-and-download'() {
    const { documents, library, typeId } = state();
    const { context, page } = await asAdmin();
    const bytes = textOfSize(64 * 1024, 'ui-upload');
    const title = `phase-b-ui-${randomBytes(3).toString('hex')}`;
    const path = `${OUT}/${title}.txt`;
    writeFileSync(path, bytes);
    await page.goto(`${WEB}/documents?libraryId=${library.id}&folderId=${library.folderId}`, {
      waitUntil: 'networkidle',
    });
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add documents' });
    await dialog.locator('input[type=file]').setInputFiles(path);
    await dialog.locator('select[name=documentTypeId]').selectOption(typeId);
    const submit = dialog.getByRole('button', { name: /^File \d+ documents?$/ });
    await submit.waitFor({ state: 'visible', timeout: 60_000 });
    for (let i = 0; i < 120 && !(await submit.isEnabled()); i += 1) await sleep(500);
    await submit.click();
    await dialog.waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => undefined);
    const token = await adminToken();
    let filed = null;
    for (let i = 0; i < 60 && filed === null; i += 1) {
      const list = await call(token, 'GET', `/documents?folderId=${library.folderId}&pageSize=100`);
      const items = Array.isArray(list.body)
        ? list.body
        : (list.body?.items ?? list.body?.data ?? []);
      filed = items.find((item) => item.title === title) ?? null;
      if (filed === null) await sleep(1_000);
    }
    const detail =
      filed === null ? null : (await call(token, 'GET', `/documents/${filed.id}`)).body;
    result('ui-upload', {
      filed: filed !== null,
      scanStatus: detail?.file?.scanStatus ?? null,
      recordedDigest: detail?.file?.checksumSha256 ?? null,
      chosenDigest: sha256(bytes),
    });
    if (filed !== null) {
      documents.ui = { id: filed.id, digest: sha256(bytes), title };
      save({ documents });
    }

    for (const [name, key] of [
      ['download-text', 'text'],
      ['download-pdf', 'pdf'],
      ['download-binary', 'binary'],
      ['download-large', 'large'],
      ['download-ui-upload', 'ui'],
    ]) {
      if (!documents[key]) continue;
      await documentPage(page, documents[key].id);
      result(
        name,
        await attempt(page, () => headerDownload(page), { expectedDigest: documents[key].digest }),
      );
    }

    await page.goto(`${WEB}/documents?libraryId=${library.id}&folderId=${library.folderId}`, {
      waitUntil: 'networkidle',
    });
    const row = page.getByRole('row').filter({ hasText: documents.text.title });
    result(
      'download-library-row',
      await attempt(
        page,
        async () => {
          await row.getByRole('button', { name: 'Actions' }).click();
          await page.getByRole('menuitem', { name: 'Download' }).click();
        },
        { expectedDigest: documents.text.digest },
      ),
    );

    await documentPage(page, documents.text.id);
    const revisions = page.getByRole('region', { name: 'Revisions' });
    result(
      'download-revision',
      await attempt(
        page,
        () =>
          revisions.getByRole('listitem').first().getByRole('button', { name: 'Download' }).click(),
        { expectedDigest: documents.text.digest },
      ),
    );
    await context.close();
  },

  /** B-3: the name Chromium saves each file under. */
  async filenames() {
    const { documents } = state();
    const { context, page } = await asAdmin();
    for (const [name, key, expected] of [
      ['name-arabic', 'arabic', 'تقرير الربع الأول.txt'],
      ['name-accented', 'accented', 'Résumé café.txt'],
      ['name-mixed', 'mixed', 'Résumé تقرير.txt'],
      // The name is sanitised at the API (a quote is never part of a header value).
      ['name-quotes', 'quotes', 'QA _draft_ 2.txt'],
    ]) {
      await documentPage(page, documents[key].id);
      result(name, {
        expectedFilename: expected,
        ...(await attempt(page, () => headerDownload(page), {
          expectedDigest: documents[key].digest,
        })),
      });
    }
    await context.close();
  },

  /** B-4: attachment versus inline, the PDF preview, and an HTML file that must never run. */
  async disposition() {
    const { documents } = state();
    const { context, page } = await asAdmin();
    await documentPage(page, documents.text.id);
    result(
      'attachment',
      await attempt(page, () => headerDownload(page), { expectedDigest: documents.text.digest }),
    );

    // `inline` is not offered by the interface; the API's own option, followed in the browser.
    const token = await adminToken();
    const inline = await call(token, 'POST', `/documents/${documents.text.id}/content?inline=true`);
    const facts = await followLink(page, inline.body.url, documents.text.digest);
    const shown = await page
      .locator('body')
      .textContent()
      .catch(() => '');
    result('inline-text', { ...facts, rendered: shown.includes('phase-b text') });

    await documentPage(page, documents.pdf.id);
    const preview = page.getByRole('region', { name: 'Preview' });
    let painted = false;
    let previewState = null;
    for (let i = 0; i < 60 && !painted; i += 1) {
      previewState = (await preview.textContent().catch(() => null))?.slice(0, 80) ?? null;
      painted = await preview
        .locator('canvas')
        .evaluate((canvas) => {
          const context2d = canvas.getContext('2d');
          const { data } = context2d.getImageData(0, 0, canvas.width, canvas.height);
          for (let p = 0; p < data.length; p += 4)
            if (data[p] < 250 || data[p + 1] < 250 || data[p + 2] < 250) return true;
          return false;
        })
        .catch(() => false);
      if (!painted) {
        await sleep(2_000);
        await page.reload({ waitUntil: 'networkidle' });
      }
    }
    result('preview-pdf', { canvasPainted: painted, downloadEvent: false, previewState });

    if (documents.html) {
      const htmlLink = await call(
        token,
        'POST',
        `/documents/${documents.html.id}/content?inline=true`,
      );
      const htmlFacts = await followLink(page, htmlLink.body.url, documents.html.digest);
      result('inline-html', {
        ...htmlFacts,
        scriptRan: (await page.title().catch(() => '')) === 'RAN',
      });
    } else {
      result('inline-html', { scriptRan: false, note: 'text/html is not accepted at upload' });
    }
    await context.close();
  },

  /** B-5, B-6f: a 30 s link (test-only setting) before and after expiry; an edited link. */
  async links() {
    const { documents } = state();
    const { context, page } = await asAdmin();
    await documentPage(page, documents.text.id);
    const link = await captureLink(page, () => headerDownload(page));
    const before = await followLink(page, link, documents.text.digest);
    await sleep(35_000);
    const after = await followLink(page, link, documents.text.digest);
    result('expired-link', {
      beforeExpiry: before.downloadEvent ? 'download' : before.status,
      beforeSameBytes: before.sameBytes,
      afterExpiryStatus: after.status,
      afterExpiryDownload: after.downloadEvent,
      afterExpiryText: after.message,
    });

    await documentPage(page, documents.text.id);
    const fresh = await captureLink(page, () => headerDownload(page));
    const edited = new URL(fresh);
    const token = edited.searchParams.get('token');
    edited.searchParams.set('token', `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`);
    result('edited-link', await followLink(page, edited.toString()));

    const stranger = await browser.newContext({ acceptDownloads: true });
    const strangerPage = await stranger.newPage();
    const bearer = await followLink(strangerPage, fresh, documents.text.digest);
    result('followed-without-session', {
      status: bearer.status ?? null,
      outcome: bearer.downloadEvent ? 'downloaded' : `refused ${String(bearer.status)}`,
    });
    await stranger.close();
    await context.close();
  },

  /** B-6: who may download. */
  async access() {
    const { documents, viewer } = state();
    const asViewer = await session(viewer.email, viewer.password);
    await documentPage(asViewer.page, documents.text.id);
    const button = asViewer.page.getByRole('button', { name: 'Download', exact: true });
    const buttonAbsent = (await button.count()) === 0;
    result('viewer-without-download', {
      buttonAbsent,
      downloadEvent: false,
      ...(buttonAbsent ? {} : await attempt(asViewer.page, () => button.first().click())),
    });
    await asViewer.context.close();

    const { context, page } = await asAdmin();
    await documentPage(page, documents.confidential.id);
    result('confidential', await attempt(page, () => headerDownload(page), { timeoutMs: 15_000 }));

    const response = await page.goto(`${WEB}/documents/0199f5a1-5a9e-7000-8000-00000000dead`);
    const text =
      (await page
        .locator('body')
        .textContent()
        .catch(() => '')) ?? '';
    result('other-tenant', {
      downloadEvent: false,
      notFound: response?.status() === 404 || /not found|could not be found/i.test(text),
    });

    await context.clearCookies();
    await page.goto(`${WEB}/documents/${documents.text.id}`, { waitUntil: 'networkidle' });
    result('signed-out', {
      downloadEvent: false,
      atSignIn: new URL(page.url()).pathname.startsWith('/login'),
    });
    await context.close();
  },

  async 'integrity-setup'() {
    const { documents } = state();
    result('integrity-setup', {
      documents: Object.fromEntries(
        ['swapped', 'vanished', 'quarantined', 'unavailable'].map((name) => [
          name,
          documents[name].fileObjectId,
        ]),
      ),
    });
  },

  /** B-7: links issued through the interface, captured unfollowed, so the store can change after. */
  async 'integrity-issue'() {
    const { documents } = state();
    const { context, page } = await asAdmin();
    const links = {};
    for (const name of ['swapped', 'vanished', 'quarantined']) {
      await documentPage(page, documents[name].id);
      links[name] = await captureLink(page, () => headerDownload(page));
    }
    save({ links });
    result('integrity-issue', {
      issued: Object.fromEntries(Object.entries(links).map(([k, v]) => [k, v !== null])),
    });
    await context.close();
  },

  /** B-7: follow the captured links; for the outage, use the Download button itself. */
  async 'integrity-follow'(...names) {
    const { documents, links } = state();
    const { context, page } = await asAdmin();
    for (const name of names) {
      if (name === 'unavailable' || name === 'unavailable-again') {
        await documentPage(page, documents.unavailable.id);
        result(
          `integrity-${name}`,
          await attempt(page, () => headerDownload(page), {
            expectedDigest: documents.unavailable.digest,
            timeoutMs: 30_000,
          }),
        );
        continue;
      }
      result(`integrity-${name}`, await followLink(page, links[name], documents[name].digest));
    }
    await context.close();
  },

  /** B-9: the Arabic interface. */
  async arabic() {
    const { documents } = state();
    const { context, page } = await asAdmin({ arabic: true });
    await documentPage(page, documents.text.id);
    const dir = await page.locator('html').getAttribute('dir');
    result('arabic-download', {
      dir,
      ...(await attempt(page, () => headerDownload(page, 'تنزيل'), {
        expectedDigest: documents.text.digest,
      })),
    });
    await documentPage(page, documents.swapped.id);
    const notices = await page.locator('[role=alert], [role=status]').allTextContents();
    result('arabic-integrity', { downloadEvent: false, message: notices.join(' | ') || null });
    await context.close();
  },

  /** B-10: a report export and an audit export, each opened in its own tab. */
  async exports() {
    const { context, page } = await asAdmin();
    const exported = async (name, start, panelName) => {
      await start();
      const panel = page.getByRole('region', { name: panelName });
      let button = null;
      for (let i = 0; i < 60; i += 1) {
        button = panel.getByRole('button', { name: 'Download' }).first();
        if ((await button.count()) > 0) break;
        await sleep(3_000);
        await page.reload({ waitUntil: 'networkidle' });
      }
      const tab = context.waitForEvent('page', { timeout: 30_000 });
      await button.click();
      const opened = await tab;
      const download = await opened.waitForEvent('download', { timeout: 30_000 }).catch(() => null);
      if (download === null) {
        result(name, { downloadEvent: false });
        return;
      }
      const saved = `${OUT}/export-${name}`;
      await download.saveAs(saved);
      const direct = await fetch(download.url());
      result(name, {
        downloadEvent: true,
        matchesStore:
          sha256(readFileSync(saved)) === sha256(Buffer.from(await direct.arrayBuffer())),
        link: pathOnly(download.url()),
      });
    };
    await page.goto(`${WEB}/reports`, { waitUntil: 'networkidle' });
    await exported(
      'report-export',
      async () => {
        await page
          .getByRole('region', { name: 'Reports you can run' })
          .getByRole('button')
          .first()
          .click();
        await page.getByRole('button', { name: 'Run report' }).click();
        await page.getByRole('button', { name: 'CSV', exact: true }).click();
      },
      'Recent exports',
    );
    await page.goto(`${WEB}/audit`, { waitUntil: 'networkidle' });
    await exported(
      'audit-export',
      () => page.getByRole('button', { name: 'Export this range' }).click(),
      'Evidence exports',
    );
    await context.close();
  },

  /** Every browser console error recorded by the cases above. */
  async console() {
    const lines = existsSync(CONSOLE)
      ? readFileSync(CONSOLE, 'utf8').split('\n').filter(Boolean)
      : [];
    result('console', { errors: lines.slice(0, 50).map((line) => JSON.parse(line)) });
  },
};

const names = process.argv.slice(2);
const unknown = names.filter((name) => !(name in cases));
if (names.length === 0 || unknown.length > 0) {
  console.error(`unknown or missing case(s): ${unknown.join(', ') || '(none given)'}`);
  process.exit(2);
}
const args = names[0] === 'integrity-follow' ? [names.slice(1)] : null;
try {
  await open();
  if (args !== null) {
    await cases['integrity-follow'](...args[0]);
  } else {
    for (const name of names) await cases[name]();
  }
} catch (error) {
  console.log(
    `FAIL  browser case(s) ${names.join(' ')}: ${String(error.message).replace(/https?:\/\/\S+/g, '<url>')}`,
  );
  process.exitCode = 1;
} finally {
  await close();
}
