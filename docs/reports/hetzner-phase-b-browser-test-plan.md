# Phase B — browser download tests on the local MinIO stack (plan)

- **Status:** **Scripts prepared, not run** (`296b131`, `a66c4b8`: `infra/hetzner/testing/phase-b/`).
  No browser automation has been run, and nothing against R2. Decided since:
  - B-5 uses a test-only 30 s link lifetime (`compose.phase-b.yaml`).
  - The non-ASCII file-name fix (`4b3677f`) came first, so B-3 is now a pass criterion, not a
    finding.
  - Downloads are now verified API links (`5ce5185`). B-7 therefore checks that no file bytes are
    saved, and B-6e still records that a link is a bearer link for its 60 s.
- **Date:** 2026-10-14
- **Context:** [ADR-0026](../architecture/adr/0026-hetzner-hosting-evaluation.md) §10. It follows
  Phase A (API-level checks) and precedes Phase C (R2).

## 1. What exists today

- **Browser runner.** The `playwright` library 1.62.1 is a dependency of `apps/web`. It is driven
  from Vitest (project `e2e`, `apps/web/vitest.config.ts`), not `@playwright/test`. Chromium comes
  from `CHROMIUM_PATH`, or `/opt/pw-browsers/...` in this environment, where it is pre-installed.
- **Existing suite.** `apps/web/src/test/e2e/` (17 specs: sign-in, sessions, permissions, search,
  signing, …) runs against a real API, the web server and PostgreSQL, but with
  `STORAGE_DRIVER=NONE` or local disk. **No spec uploads, downloads or previews a file.** CI runs it
  in the `e2e` job in five shards.
- **How the web app downloads.** A server action calls `POST /documents/:id/content` (or the
  revision route), then `window.location.assign(url)` goes to the **presigned store URL**.
  - The UI only ever asks for `attachment`. `inline` is reachable through the API (`?inline=true`)
    but no button uses it.
  - Inline viewing goes through the preview panel: pdf.js or `<img>`, fed by
    `/api/v1/preview/stream`, which the API serves.
  - Report and audit exports open in a new tab with `window.open`.
- **The Hetzner test stack.**
  - A browser on the host can reach the web app through Caddy on `http://localhost:8080`
    (`CORS_ORIGINS` and `WEB_BASE_URL` are set to that origin).
  - It **cannot** reach MinIO. Presigned URLs name `http://storage:9000`, on the internal
    `ci-storage` network, which publishes no port. That is why Phase A's client plays the browser
    from inside the network.
- **File names.** `Content-Disposition` is `attachment; filename="<raw UTF-8>"`, with no
  `filename*=UTF-8''`. Phase A recorded `Résumé تقرير.txt` arriving as mojibake to a strict reader.

## 2. Approach

A Phase B script set under `infra/hetzner/testing/phase-b/`, sourced by `run-stack-test.sh`
through `EXTRA_CHECKS`, like Phase A. It refuses to run with `EXTERNAL_STORAGE_ENV`.

- **Where the browser runs.**
  - Chromium runs in a test-only container joined to the `edge` and `ci-storage` networks, so
    `storage:9000` resolves as it does for the API.
  - Inside that container, a small TCP forward listens on `127.0.0.1:8080` and passes to
    `proxy:8080`. The browser therefore uses the real origin `http://localhost:8080`, and CORS,
    cookies and secure-context rules (Web Crypto needs one for the upload checksum) behave as they
    would for a user.
  - No port of MinIO is published, and no product setting changes.
- **Browser and image.** Playwright 1.62.1 from the repository's lockfile. Chromium comes from the
  pre-installed `/opt/pw-browsers` build, mounted read-only into the container, or from the
  official Playwright image of the same version if the mounted build lacks system libraries.
  **Decision for the run:** which of the two. No `playwright install`.
- **Seeding.**
  - Tenant, users and administrator: the stack test's provisioning, as Phase A.
  - Users with and without `document:download`, and a confidentiality level without download:
    Phase A's `client.mjs` steps, over the API.
  - Documents are created both by API (fast, for most cases) and **through the UI** (one case,
    B-8).
- **Evidence.** Each check is judged from the saved file (SHA-256 and size), the response headers
  Chromium saw, the database and MinIO.
  - Screenshots are taken on failure only.
  - Sign-in state is kept in a temporary directory that is deleted at the end.
  - No credential or signed URL is printed in full: URLs are logged with the query string removed.
- **Output.** `PASS`, `FAIL`, `FINDING` and `MEASURE` lines, as in Phase A.

## 3. Cases

| # | Case | How | Expected today |
| --- | --- | --- | --- |
| **B-1** | **Successful download from the document screen** | Sign in through `/login` and open the document. Click *Download*, then `page.waitForEvent('download')` and `download.saveAs()` | A download event, and the page does not navigate away |
| **B-2** | **Byte-for-byte match** | B-1 for a small text file, a PDF, random binary data (5 MiB) and one ~127 MiB file; also from the library row action and the revision panel. SHA-256 and size of the saved file against the recorded digest and the uploaded bytes | Identical bytes for every type and route |
| **B-3** | **Accented and Arabic file names** | Files named `Résumé.txt`, `تقرير الربع الأول.pdf`, `Résumé تقرير.txt`, and one with spaces, quotes and a semicolon. Record `download.suggestedFilename()` and the raw `Content-Disposition` header | **Expected to fail for non-ASCII names** (raw UTF-8 with no `filename*`): recorded as a FINDING with the name Chromium actually chose. ASCII names correct. Fixing it is an application change (RFC 6266 `filename*=UTF-8''`), proposed in the download-integrity proposal, for separate approval |
| **B-4a** | **Attachment** | B-1's link | `Content-Disposition: attachment`; saved, not rendered |
| **B-4b** | **Inline** | Request a link with `?inline=true` through the API, then open it in a page. Separately, open the preview panel for a PDF and an image | Text renders in the page with no download event. The PDF renders in pdf.js (canvas painted) from `/api/v1/preview/stream`, with `nosniff` and `no-store` |
| **B-4c** | **Inline cannot be abused** | An HTML or SVG file, if any accepted type allows it, opened inline | Never executed as a page in the app's origin (it is served from the store's origin with `nosniff`); a FINDING if a script would run |
| **B-5** | **Expired link** | Intercept the navigation to the store URL with `page.route`, keep the URL and abort the request. After the link's lifetime (300 s by default; the case waits it out rather than shortening it), open the URL in a fresh page | Before expiry: a download. After: 403 `AccessDenied` from the store, and no download |
| **B-6a** | **No `document:download`** | Sign in as a reader without it | No download button, or a refusal message (403 "You do not have permission to do this."), and no download event |
| **B-6b** | **Confidentiality level without download** | Document at that level | Refusal message (403) and no download |
| **B-6c** | **Another tenant's document** | Open its id in the URL while signed in to this tenant | Not found, no link issued |
| **B-6d** | **Signed out** | Sign out, then retry the download action or the document URL | Redirected to sign-in, no link issued |
| **B-6e** | **A captured link used by someone else** | Open the B-5 URL before expiry in a new browser context with no cookies | **Expected to download.** A signed store URL is a bearer token for its lifetime. Recorded as a FINDING; it is one of the reasons for the download-integrity proposal |
| **B-6f** | **Edited link** | Change the signature or the path of a captured URL | 403 `SignatureDoesNotMatch`, no download |
| **B-7** | **Tampered, missing and quarantined objects** | Overwrite one object in MinIO with same-size different bytes, delete another, and mark a third as quarantined by the verifier | The UI shows "This file failed its integrity check…", and **no download event**. Tampered bytes never saved |
| **B-8** | **Upload through the UI, then download** | `setInputFiles` in the upload dialog (the browser computes the SHA-256), complete, wait for CLEAN, then download | The saved file is identical to the chosen file; the recorded digest equals the browser's |
| **B-9** | **Arabic interface** | B-1 and B-7 with the interface in Arabic (RTL) | The same results, with the messages in Arabic. The wording is captured for native review |
| **B-10** | **Report and audit exports** | Run each export, then its `window.open` tab | The download in the new tab is identical to the export's recorded digest; `noopener` is respected |

**Also recorded for every case:**
- browser console errors;
- any CSP violation;
- any request to an origin other than `localhost:8080` and `storage:9000`.

## 4. Pass criteria

- Every case marked "expected" above holds.
- The FINDING cases (B-3 non-ASCII, B-4c if anything executes, B-6e) are recorded with their
  evidence, not hidden.
- No container restarts.
- No credential in any log.
- Teardown leaves no container, volume or temporary sign-in state.

A pass shows the browser path works **against MinIO** only. It says nothing about R2's handling of
`response-content-disposition`, CORS for `GET`, or non-ASCII names (Phase C).

## 5. Boundaries

- Local stack and local MinIO only.
- No R2, no AWS, no Cloudflare setting, no DNS.
- No application code change: test scripts only. B-3's expected failure is recorded, not fixed.
- Nothing is published or deployed.

## 6. What I need from the owner before running it

- Approval to write the Phase B scripts (test-only, in `infra/hetzner/testing/phase-b/`) and run
  them locally.
- Whether B-5 should wait out the real 300 s link lifetime (proposed) or use a test-only API
  container with a 30 s lifetime, as Phase A did.
- Whether the non-ASCII file-name fix should be approved before Phase B (then B-3 becomes a PASS
  criterion) or after it (B-3 stays a FINDING).
