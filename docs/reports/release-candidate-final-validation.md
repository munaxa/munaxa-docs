# Release candidate — final validation gate

**Scope:** release-candidate validation of Munaxa Docs, Phases 1–19, from baseline `f1d9385` to RC head
`584e555`. **Date:** 2026-09-28. This report is point-in-time evidence.

**D-3 update (2026-09-28, after the gate).** D-3, the one release blocker, was fixed afterwards, in
`06ab302`, `84ed9ad` and `a560bb0`, and validated against a real ClamAV scanner behind c-icap. The
sections below that concern D-3 are updated and say so; the original D-3 findings are kept in §8 as
the record of what was wrong. Nothing else in this report was re-opened.

## Gate

> **D-3 is fixed. Real antivirus CLEAN and INFECTED behaviour is validated against ClamAV behind
> c-icap, on the production code path. No release blocker remains open. The release candidate may
> proceed to final production-readiness validation.**

This report does not declare the product production-ready. Passing tests are not a release decision:
§15 lists what a production deployment still has to provide, including a scanner configured to fail
closed.

*Original gate statement, superseded by the D-3 update:* "RC validation is complete, but production
release remains blocked until D-3 is resolved and real antivirus CLEAN/INFECTED behavior is
validated."

### How evidence is labelled

Every conclusion below carries one of these labels.

| Label | Meaning |
| --- | --- |
| **PROD-PATH** | Validated on the production code path against real infrastructure (PostgreSQL 16, Redis 7, MinIO over S3, the built API, the production web build behind `server.mjs`, Chromium). |
| **TEST-ONLY** | Validated only because a test-only substitution stood in for a missing production capability. Almost always this is D-3's CLEAN substitution: a direct database update, `scanner='TEST-ONLY-D3-SUBSTITUTION'`, ledgered per file. In the Phase 11 retention scenarios it is instead the ledgered clock move. Neither is production evidence of the substituted capability. |
| **REAL-SCANNER** | D-3 update. A verdict produced by a real antivirus engine: ClamAV 1.5.4 with ClamAV's official signatures, behind c-icap 0.5.10, reached by the product's own ICAP adapter over a socket. Never a database write, a stub or a scripted server. |
| **ENV** | A limitation of the validation environment, not of the product. |
| **ARCH** | A recorded architectural observation. |
| **POLICY** | A policy or documentation observation. |

---

## 1. Executive summary

- **Scope.** All 19 phases were executed against the real stack. Every phase finished with its acceptance driver fully passing, and each phase's final driver evidence has zero failures. Phase 19's single scripted miss was a check-timing artefact, resolved on a controlled restart (§10).
- **Fixes.**
  - Twenty-one findings were raised.
  - Fifteen are fixed: D-2, D-3 (after the gate), D-5, D-6, D-7, D-8, D-11, D-12, D-13, D-16, D-17, D-18, D-19 and D-20, plus one found-and-fixed security hole folded into D-19.
  - Each fix landed with its own regression tests, which fail on the unfixed code, and each was revalidated live.
- **D-2 final revalidation passes.**
  - Its own suites: 33 unit tests, 10 real-socket API tests and 3 real-browser `/login` tests.
  - A live gate driver against the running RC: 14/14.
- **Final gate at `584e555`.**
  - Unit: 1,653 tests.
  - Integration: 1,150 passed in 52 files.
  - End to end: 233 passed in 16 files across the 5 CI shards (74 + 25 + 99 + 14 + 21).
  - CI run 539: 9/9 jobs green.
  - Prisma schema: valid, with all 30 migrations applied on all 10 databases.
- **D-3, the release blocker at the gate, is fixed (§8).**
  - `AV_DRIVER=ICAP` now binds a real ICAP adapter. `HOSTED` is refused, because it has no adapter.
  - Against ClamAV behind c-icap (**REAL-SCANNER**): clean files are CLEAN, can be filed and download with their own bytes; EICAR is INFECTED, quarantined and never filed; a scanner that is down or hung gives FAILED, never CLEAN.
  - Validation also found a local-storage race by which an infected upload could have been recorded CLEAN. It is fixed in `a560bb0` (§8).
- **Deferred or recorded.** Seven findings (D-1, D-4, D-9, D-10, D-14, D-15, D-21), one deployment-window note and three LOW hardening items (§7).

## 2. RC commit / SHA

| Item | Value |
| --- | --- |
| RC baseline (validation start, = `origin/main` at start) | `f1d93854a8e0c8ca5f208c34f49564a90d37deb4` |
| **Validated RC head (code)** | **`584e555e8be77a2768f5c7eca55d6d74a5dbf6dc`** |
| Branch | `claude/gifted-wozniak-g94u76` |
| Working tree at the gate | clean (0 changes); every final-gate run was made at `584e555` |
| This report | a documentation-only commit on top of `584e555`; no application change |
| **D-3 fix head (code)** | **`a560bb0afd91504b09f7e64d235e78951c4bf877`**, which adds three commits to `584e555` and the report (see below) |

The RC branch holds ten fix commits on the baseline:

| Commit | Change |
| --- | --- |
| `a328dd7` | D-2 |
| `569e793` | D-5, D-6 |
| `b7c2a07` | D-7 |
| `d255835` | D-8 |
| `69ec4b0` | D-11, D-12 |
| `84ae956` | D-13 |
| `56695fe` | D-16, D-17 |
| `2855fff` | D-18 |
| `f983d08` | D-19 |
| `584e555` | D-20 |
| `06ab302` | D-3: the ICAP adapter, configuration, health, the scanner infrastructure, CI scanner, tests |
| `84ed9ad` | D-3: integration fixtures carry the new antivirus settings (no assertion changed) |
| `a560bb0` | D-3: atomic local copy; scans bound to the content digest |

**Environment** (**ENV**):

| Component | Version |
| --- | --- |
| Node | 22.22.2 |
| pnpm | 10.33.0 |
| PostgreSQL | 16.15 (source cluster :5432 and DR cluster :5433) |
| Redis | 7.4.11 |
| MinIO | built from pinned source (`DEVELOPMENT.GOGET`), as CI does |
| Chromium | 141.0.7390.37 |
| Docker | 29.3.1 |
| Prisma / @prisma/client | 6.19.3 |
| Next.js | 15 |
| NestJS | 11 |
| BullMQ | 5 |

## 3. Test totals (final gate, at `584e555`)

| Suite | Result |
| --- | --- |
| Unit (all packages) | **1,653 passed**: api 803, web 503, domain 164, i18n 80, contracts 63, utils 38, worker 2 |
| Integration (real PostgreSQL ×2 tenants, Redis, MinIO) | **1,150 passed in 52 files** |
| End to end (5 CI shards, built API + production web build + Chromium) | **233 passed in 16 files across the 5 CI shards (74 + 25 + 99 + 14 + 21)** |
| CI run 539 on `584e555` | **9/9 jobs green**: lint, typecheck, test and build; integration; five E2E shards; three container images; product isolation |
| Lint, format, typecheck | pass |
| Prisma | schema valid; 30/30 migrations applied on rc ×2, ci ×2, e2e ×2, upgrade-rehearsal ×2 and the restored DR cluster ×2 |
| D-2 dedicated regression | resolver 27/27, config refusal 2/2, web guard 4/4, API real sockets 10/10, browser `/login` 3/3, live gate driver 14/14 |

**D-3 gate (at `a560bb0`, clean tree).** The table above was taken at `584e555`, before the D-3 fix. These were taken after it:

| Suite | Result |
| --- | --- |
| Unit (all packages) | **1,713 passed**: api 863, web 503, domain 164, i18n 80, contracts 63, utils 38, worker 2 |
| Integration, with the real scanner | **1,176 passed in 54 files**, including `icap-antivirus.integration.spec` (10) and `antivirus.e2e.integration.spec` (14), both **REAL-SCANNER** |
| End to end (5 CI shards) | **233 passed** (74 + 25 + 99 + 14 + 21) |
| CI run 544 on `a560bb0` | **9/9 jobs green**, the integration job running ClamAV and c-icap with official signatures |
| Lint, format, typecheck, build | pass |

CI runs 542 and 543 failed on the way to 544:
- **542:** integration fixtures lacked the new settings. Fixed in `84ed9ad`.
- **543:** the real-scanner concurrency test caught the local-copy race (§8.5). Fixed in `a560bb0`. The same run also hit a Chromium `Unable to capture screenshot` error in one visual-regression screenshot. That error was also seen on the docs-only `475d12b` in run 540. The web app is untouched by D-3, and the step passed in run 544. **ENV**

Live acceptance drivers, final runs:

| Phase | Result |
| --- | --- |
| 3 | 32/32 |
| 4/5 | 83/83 |
| 6 | 80/80 |
| 7 | 42/42 |
| 11 | 83/83 |
| 12 | 47/47 |
| 13 | 30/30 |
| 14 | 36/36 |
| 15 | 20/20 |
| 16 | 28/28 |
| 17 | 17/17 |
| 18 | 14/14 (upgrade) plus the production-configuration matrix (13 cases) |
| 19 | 10/10 (restored deployment) |

## 4. Phase 1–19 status

| # | Phase | Final status | Evidence |
| --- | --- | --- | --- |
| 1 | RC baseline | **Pass** (read-only) | RC = `f1d9385` = `origin/main`; clean tree; no application changes |
| 2 | Clean environment validation | **Pass** | empty PostgreSQL 16 / Redis 7 / MinIO; every migration applied to empty databases; built API, worker and web booted healthy; the full CI suite set run (§3 supersedes with final-gate numbers) |
| 3 | Tenant provisioning | **Pass**, 32/32 on every clean reset (last at the final gate) | D-1 recorded: catalogue-mode provisioning needs the single-tenant workaround |
| 4 | Complete document lifecycle | **Pass**, 83/83 | D-4 recorded (publish on approval ignored). At the gate D-3 blocked the upload path, so it was **TEST-ONLY** beyond upload. **D-3 update:** rerun on the real scanner with no substitution, 81/83. The 2 misses are the RC's own D-3 defect probes, which asserted "SKIPPED" and "409"; they now observe CLEAN and 201 (**REAL-SCANNER**) |
| 5 | Document / revision | **Pass**, 30 checks (21 + 9) | **TEST-ONLY** for content |
| 6 | Authorization matrix | **Pass**, 26 checks within 80/80 | **PROD-PATH** |
| 7 | Workflow / approval / delegation | **Pass**, 42/42 | D-5, D-6, D-7 fixed; `keepOriginal=true` + `ALL` recorded as **POLICY** |
| 8 | Signatures | **Pass**, 17 checks plus the E2E signing shard | **PROD-PATH** for signing; **TEST-ONLY** for the signed content |
| 9 | Search / preview / OCR / derived data | **Pass**, 12 checks | preview and index of content are **TEST-ONLY** (content reached CLEAN by substitution) |
| 10 | Reporting / exports | **Pass**, 12 checks | D-8 fixed; derived exports are SKIPPED by design and downloadable |
| 11 | Retention / legal hold | **Pass**, 83/83 | D-9, D-10 recorded; due dates moved by 53 ledgered **TEST-ONLY** time-travel updates |
| 12 | Storage integrity | **Pass**, 47/47 | D-11, D-12 fixed |
| 13 | Background workers | **Pass**, 30/30 | D-13 fixed; D-14, D-15 recorded |
| 14 | Bulk operations | **Pass**, 36/36 | D-16, D-17 fixed; D-3 holds inside bulk upload. **D-3 update:** rerun on the real scanner with no substitution, 34/36. The 2 misses are the D-3 probe, whose "unscanned" upload is now really scanned CLEAN and admitted. A live bulk upload of a real-CLEAN and a real-INFECTED file then gave APPLIED and BLOCKED `CONTENT_NOT_SCANNED` (**REAL-SCANNER**) |
| 15 | Web application acceptance | **Pass**, 20/20 on a clean production web build | D-18, D-19 fixed; 33 routes in English and Arabic (RTL) plus phone width; D-3 refusal shown in the real upload dialog |
| 16 | Concurrency / integrity | **Pass**, 28/28 on a clean reset | D-20 fixed; D-21 recorded |
| 17 | Tenant isolation | **Pass**, 17/17 | plus 25 isolation checks in the Phase 6/11/12/14 drivers |
| 18 | Migration / deployment | **Pass**, upgrade 14/14, production-configuration matrix 13/13 | see §9 |
| 19 | Backup / restore / recovery | **Pass**, DR rehearsal zero differences; storage 196/196; restored deployment 10/10 | see §10 |

## 5. Findings D-1 … D-21: final status

| ID | Severity | Summary | Final status |
| --- | --- | --- | --- |
| D-1 | Medium (operability) | `provision.js` cannot run in catalogue (multi-tenant/CLOUD) mode: it reads `TENANT_SLUG`, which the config refuses beside a catalogue | **DEFERRED** — workaround: provision each tenant in single-tenant form (used throughout) |
| D-2 | Serious (availability) | Sign-in limit keyed on the web server's address: 10 sign-ins per 5 minutes for the whole deployment, across tenants | **FIXED** `a328dd7`; final revalidation passes (§12) |
| D-3 | **Release blocker** (at the gate) | No antivirus adapter: uploaded content can never be CLEAN, so it can never become a document | **FIXED** `06ab302`, `84ed9ad`, `a560bb0`; validated against a real scanner (§8) |
| D-4 | Medium | `onComplete.publish` ignored; approved documents stop at APPROVED | **RECORDED** (manual publish works and is verified) |
| D-5 | High | Escalated `ALL` stage with `keepOriginal=false` ended REJECTED and voided the number | **FIXED** `569e793` |
| D-6 | Medium | The escalation target was never notified | **FIXED** `569e793` |
| D-7 | Medium | A no-op timer firing failed its job, and every reminder rolled back its own event | **FIXED** `b7c2a07` |
| D-8 | High | Product-generated exports and evidence bundles could never be downloaded | **FIXED** `d255835` |
| D-9 | Medium (compliance) | `ON_ARCHIVE` / `ON_SUPERSEDE` retention never schedules | **RECORDED** |
| D-10 | Low | A malformed id or a hold on a missing document answers 500, not 404/422; nothing leaks | **RECORDED** |
| D-11 | High (integrity/security) | Tampered (MISMATCH) or lost (UNREADABLE) blobs were still signed for and served | **FIXED** `69ec4b0` |
| D-12 | High (availability) | After reclamation, re-uploading the same bytes failed with 503 for ever | **FIXED** `69ec4b0` |
| D-13 | Medium-high (reliability) | Redis data loss lost workflow timers and cron schedules permanently | **FIXED** `84ae956` |
| D-14 | Low (error normalisation) | During a Redis outage, authenticated requests get a raw 500; sign-in fails closed as 429 | **RECORDED**; fail-closed kept |
| D-15 | Medium-low | An outbox row is marked done when its job is queued; a queued-but-unprocessed job is lost with Redis data | **RECORDED**; runbook states it |
| D-16 | Medium (security) | Bulk results revealed whether a hidden document exists, and which rule hid it | **FIXED** `56695fe` |
| D-17 | Medium-low | The 100 KiB body limit capped bulk requests below `bulk.maxObjects`, answered as 500 | **FIXED** `56695fe` |
| D-18 | High | Refused session or unavailable API: endless `/login` ⇄ workspace redirect loop | **FIXED** `2855fff` |
| D-19 | Security | Open redirect through the login `next` (`/\evil.example`), and `/.//evil.example` in the D-18 route | **FIXED** `f983d08` |
| D-20 | Medium (correctness) | Concurrent retries under one `Idempotency-Key` all executed (4–5 documents from 5 requests) | **FIXED** `584e555` |
| D-21 | Low (data quality) | Duplicate-content check is check-then-insert; concurrent creates without a key all succeed | **RECORDED** |

## 6. Fixed findings and their validating evidence

Every fix below carries regression tests that fail on the unfixed code (verified by reverting or mutating), and every one is green in the final-gate suites and in CI run 539. No fixed finding has regressed.

| ID | Regression tests (final gate) | Live revalidation | Label |
| --- | --- | --- | --- |
| D-2 | `proxy-trust.spec` (27), configuration spec (2), web `client-address.spec` (4), `client-address.integration.spec` (10), `sign-in-addresses.e2e.spec` (3) | final gate driver 14/14 (§12) | PROD-PATH |
| D-5, D-6 | `completion.spec`, `workflow-engine.integration.spec` | Phase 7 42/42 | PROD-PATH |
| D-7 | `workflow-engine.integration.spec` (duplicate delivery, reminder) | Phase 7 42/42, Phase 13 30/30 | PROD-PATH |
| D-8 | reporting, audit-compliance and blob-reclamation integration specs | Phase 10, Phase 11 83/83 | PROD-PATH (derived artefacts are SKIPPED by design) |
| D-11 | storage-integrity integration suite (real MinIO, real verifier) | Phase 12 47/47 | PROD-PATH for the refusal; the served-intact baseline is TEST-ONLY |
| D-12 | partial unique indexes; reclaim → re-upload integration | Phase 12 47/47; migration applied in the upgrade rehearsal | PROD-PATH |
| D-13 | queue-recovery integration (real Redis flush) | Phase 13 30/30; Phase 19 rebuild into an empty Redis (1 timer, 26 schedules) | PROD-PATH |
| D-16, D-17 | bulk suite; `request-size.integration.spec`; `body-limits.spec` | Phase 14 36/36 | PROD-PATH |
| D-18 | `session-check.spec`, layout, page and route specs; `session-states.e2e.spec` (6) | Phase 15 20/20 | PROD-PATH |
| D-19 | `destination.spec` (40+ vectors), action, page and route specs; `open-redirect.e2e.spec` (15, Chromium) | Phase 15 20/20 | PROD-PATH |
| D-20 | `idempotency.interceptor.spec` (9), `idempotency.integration.spec` (12, two pools), `idempotency.e2e.integration.spec` (5, two app instances, two tenant DBs) | Phase 16 28/28 across two OS processes; the upgrade rehearsal on migrated data | PROD-PATH |
| D-3 | ICAP protocol and adapter unit specs, config and selection specs, the local-copy race spec; `icap-antivirus.integration.spec` (10) and `antivirus.e2e.integration.spec` (14), both against real ClamAV/c-icap | live probe 8/8; Phase 4 and 14 reruns with no substitution (§8) | REAL-SCANNER, PROD-PATH |

## 7. Deferred / recorded findings

**Deferred or recorded. None of these is a release blocker.** Each needs a release note.

| ID | Classification | Release note |
| --- | --- | --- |
| D-1 | Deferred (operability) | Provision tenants one at a time in single-tenant form until catalogue-mode provisioning exists |
| D-4 | Recorded | Approved documents are published by a controller (`POST /documents/:id/publish`); automatic publish on approval is not applied |
| D-9 | Recorded (compliance) | Do not use `ON_ARCHIVE` / `ON_SUPERSEDE` retention triggers; they never schedule |
| D-10 | Recorded | Malformed identifiers can answer 500; no data is disclosed |
| D-14 | Recorded | During a Redis outage the API answers 500 and sign-in answers 429 (fail-closed) |
| D-15 | Recorded (architecture) | Work queued but not yet processed when Redis loses its data is not replayed; search can be rebuilt |
| D-21 | Recorded (data quality) | The duplicate-content warning can be raced by simultaneous creates; overridable warning, no security impact |

**Deployment-window note (release note, not a blocker): idempotency replay records across the D-20 upgrade.**
- Before `584e555`, replay records lived in Redis. After it they live in PostgreSQL, and the Redis records are not migrated.
- Observed in the upgrade rehearsal: a request completed under a key before the upgrade, retried under the same key after it, was performed again and created a second document (**PROD-PATH**, `p18-upgrade.out`).
- Exposure is limited to retries, across the deploy, of requests that had already completed, within the old 24-hour window.
- Recommendation: drain client traffic briefly across the migration, and state the behaviour in the release notes.

**LOW hardening and consistency observations.** None of these is a blocker.

| Observation | Label |
| --- | --- |
| The API sends `X-Powered-By: Express` in production (`p18-prod-config.out`) | ARCH |
| The web container image declares no `HEALTHCHECK` (the API image does) | ARCH |
| Workflow submit or decision on the wrong state answers `422 VALIDATION_FAILED` (field `status`), where document transitions answer `409 INVALID_TRANSITION`. The same answer is given sequentially, so it is not a race artefact | POLICY |

**Other recorded observations:**

| Observation | Label |
| --- | --- |
| `keepOriginal=true` with `ALL` escalation semantics | POLICY |
| The duplicate-refusal detail is dropped by the error filter | ARCH |
| The quarantine message says "still being checked" for content that will never be checked | ARCH, wording |
| An UNREADABLE blob re-records its incident on every sweep | ARCH |
| The bulk body parser runs before authentication | ARCH |
| Schema-model drift is intentional hand-written SQL (partial indexes, FKs, defaults): tenant databases must only ever be migrated with `migrate deploy` via `migrate-tenants.mjs`, never `db push` or `migrate dev` | POLICY |
| The sign-in identity bucket is keyed on the submitted address without the tenant, because sign-in has no tenant context before authentication: the same e-mail in two tenants shares one identity bucket. This is D-2's unchanged "identity dimension" | POLICY |

## 8. D-3: the release blocker, and its fix

**Status: FIXED** in `06ab302`, `84ed9ad` and `a560bb0`, and validated against a real scanner. At the
gate this was the only release blocker.

### 8.1 What was wrong at the gate (original findings, unchanged)

1. **Production accepted `AV_DRIVER=ICAP` or `HOSTED`.** Configuration validation refused only `NONE` in production (`configuration.ts`, "must name a real provider"). A production configuration with `AV_DRIVER=ICAP` booted and reported ready (**PROD-PATH**, `p18-prod-config.out`).
2. **The scanner was actually unconfigured.** `InfrastructureModule` bound `ANTIVIRUS_PORT` to `UnconfiguredAntivirusAdapter` unconditionally, whatever `AV_DRIVER` said. No ICAP or hosted adapter existed in the build.
3. **Uploaded content could not receive a real CLEAN verdict.** Under that production configuration a real upload completed through S3 as `scanStatus=SKIPPED` with `scanner=null`, and was still SKIPPED eight seconds later. Across every acceptance database, no CLEAN verdict existed from any scanner other than the test-only substitution (`d3-ledger-audit.out`).
4. **Uploads therefore returned `CONTENT_NOT_SCANNED`.** Filing that upload answered `409 CONTENT_NOT_SCANNED`. The same refusal held in the web upload dialog (Phase 15) and inside bulk upload (Phase 14).
5. **The test CLEAN substitutions were not antivirus validation.**
   - All 246 substitutions are ledgered in `d3-substitutions.log`: 246 × `SKIPPED→CLEAN`, including 2 on the restored DR cluster in Phase 19. Each is marked `scanner='TEST-ONLY-D3-SUBSTITUTION'`.
   - They let every content-dependent phase run (preview, search, signing, retention, bulk, restore). They say nothing about scanning.
   - **The restored-cluster D-3 test in Phase 19 used this documented test-only substitution. It is not real antivirus validation.** It was not rerun after the fix (see §8.7).

### 8.2 What was built

The existing antivirus port, file record and scan lifecycle are unchanged in shape. There is no new
scanning architecture. The scan still runs where it always ran, at upload completion, inside the
same transaction as the file record, its audit event and its outbox events.

- **`IcapAntivirusAdapter`** (`infrastructure/providers/icap/`), selected by `AV_DRIVER=ICAP`.
  - **Protocol.** ICAP `RESPMOD` (RFC 3507) with an empty preview: the scanner must answer `100 Continue` before any content is sent.
  - **What it sends.** The stored bytes, read through the tenant-scoped store. It sends neither the filename nor the declared type, so nothing is skipped on a MIME type or an extension.
  - **How a verdict is read.**
    - `204` after the whole body is **CLEAN**; a `204` before the scanner has the content is not a verdict.
    - `200` naming a threat is **INFECTED**. The threat is taken from `X-Infection-Found`, `X-Violations-Found` or `X-Virus-ID`.
    - Anything else is no verdict: unreachable, a timeout, an ICAP error, a `200` naming no threat, a malformed answer, content over `AV_ICAP_MAX_BYTES`, or bytes that do not hash to the recorded digest. It is recorded **FAILED**.
- **Storage service.**
  - `FAILED` is used for a configured scanner that gave no verdict. `SKIPPED` still means that no scanner is configured. Neither status is reachable.
  - Under ICAP, an upload larger than the scan limit is refused before any byte is stored.
  - A `FAILED` or `SKIPPED` blob is scanned again when its bytes are uploaded again. The write is a compare-and-set (`recordScan`) from those two states only, so a verdict is never re-marked and racing re-uploads keep one verdict.
  - The client response carries the status only. The threat name goes to the audit record and the `storage.file-quarantined` event.
- **Configuration.**
  - `AV_ICAP_URL` is required by `ICAP` and validated at boot. `icaps://`, a missing service and credentials in the URL are all refused.
  - `HOSTED` is refused in every environment, because it has no adapter.
  - A scanner URL without `AV_DRIVER=ICAP` is refused.
  - New settings: `AV_ICAP_MAX_BYTES` (default 128 MiB) and `AV_SCAN_TIMEOUT_MS` (default 120 s).
- **Health.** `/api/health` lists `antivirus` under ICAP. The check is a real scan of harmless bytes, because c-icap answers `OPTIONS` with its engine dead. A failure shows as `DEGRADED`.
- **Scanner infrastructure.**
  - `infra/antivirus/` holds a hardened c-icap and ClamAV configuration, a development image with a compose service, and `probe.mjs`, which requires clean passed **and** EICAR blocked.
  - CI's integration job installs and starts that scanner with official signatures, and fails before any test if the probe fails.
- **Documentation.** `deployment.md` §3.2 (scanner requirements, readiness, recovery), `.env.example`, `11-storage-architecture.md` §4, `02-backend-architecture.md`, and the storage module README.
- **The test-only substitution** was never in the repository, and a regression spec now checks that it stays out. That spec scans more than 500 production source, script, SQL, Prisma and workflow files for the marker, and checks that no `AV_DRIVER` value selects anything but the ICAP adapter or the refusal.

### 8.3 The real scanner environment (ENV)

| Component | Version |
| --- | --- |
| ClamAV (`clamd`) | 1.5.4 (Ubuntu 24.04 `clamav-daemon` 1.5.4+dfsg-0ubuntu0.24.04.1) |
| Signatures | official, via `freshclam`: main.cvd 63 (3,287,027 signatures), daily.cvd 28137, bytecode.cvd 339 |
| ICAP server | c-icap 0.5.10 with `virus_scan` 0.5.5 (`libc-icap-mod-virus-scan`), `mode=simple`, all type groups, `MaxObjectSize 2048M`, `PassOnError off` |
| ClamAV limits | 2048M, `AlertExceedsMax yes` |
| Where | the validation container, as native processes (configuration from `infra/antivirus/`); the same configuration in the development image, 10/10 against it; CI's integration job on `ubuntu-latest` |
| Test file | EICAR, the industry's harmless standard test file, assembled at run time |

**Found while setting it up.** c-icap's shipped configuration answers `204`, which is clean, without scanning in three cases:
- objects over 5 MB;
- type groups not listed in `ScanFileTypes`;
- (as `200` with no verdict) large objects in its default streaming mode.

The repository configuration closes all three. `deployment.md` §3.2 makes them requirements for any production scanner. **POLICY**

### 8.4 Evidence (at `a560bb0`)

| What | Result | Label |
| --- | --- | --- |
| Clean file: upload through the API → scanner contacted → `204` → CLEAN (scanner `ICAP C-ICAP/0.5.10 ISTag=…`) → document created (201) → download returns the same bytes; one `FILE_UPLOADED` audit with `scanStatus: CLEAN`; one `storage.scan-completed` event; `document.created` published | pass (`antivirus.e2e`, and live on S3/MinIO) | REAL-SCANNER, PROD-PATH |
| EICAR (plain file, in a deflated zip, and inside an 8 MiB archive): INFECTED with threat `Eicar-Test-Signature`; `storage.file-quarantined` raised; filing refused `409 CONTENT_NOT_SCANNED`; no document and no reference; the database trigger refuses to attach it to a revision; refused inside bulk upload; the refusal names neither threat nor scanner | pass | REAL-SCANNER, PROD-PATH |
| Scanner unreachable (an application instance pointed at a closed port): FAILED with audit `scanFailure: UNREACHABLE`; filing refused 409; health `antivirus: DEGRADED` | pass | PROD-PATH (a real closed socket) |
| EICAR uploaded while the scanner is down: FAILED, not INFECTED and not CLEAN; re-uploaded when it is back: INFECTED and quarantined | pass | REAL-SCANNER |
| Scanner hung (accepts, never answers), 1 s timeout: FAILED `TIMEOUT` within the bound; filing refused | pass | PROD-PATH (a real silent socket) |
| Scanner error: c-icap's own `404` for an unknown service, and `500` with clamd stopped (probed by hand) | no verdict, recorded FAILED | REAL-SCANNER |
| Recovery: a FAILED clean file re-uploaded, by either route, becomes CLEAN and is filed | pass | REAL-SCANNER |
| Concurrency, across two application instances: 6 simultaneous uploads of one clean file give 1 blob and 1 verdict; 6 of one infected file are INFECTED for all and filed by none (5 simultaneous filings, all 409); 5 simultaneous re-uploads of a FAILED file give one re-scan and one kept verdict; 5 simultaneous filings under one key give 1 document | pass; the real-scanner suites passed 5 consecutive runs | REAL-SCANNER |
| Tenant isolation: each tenant's copy of the same bytes is scanned separately, from its own storage prefix, into its own database; another tenant's clean or infected blob cannot be filed, and the refusal is identical to one for a nonexistent id | pass | REAL-SCANNER |
| Nothing substituted: every CLEAN or INFECTED row the suite wrote carries the real scanner's name and `ISTag`; the substitution ledger stayed at 246 through every rerun | pass | REAL-SCANNER |
| Live probe on the RC API (S3/MinIO, `AV_DRIVER=ICAP`) | **8/8** (`d3-live.out`) | REAL-SCANNER, PROD-PATH |
| Phase 4 and 14 reruns with no substitution | 81/83 and 34/36; every miss is an RC probe that asserted the D-3 defect (§4) | REAL-SCANNER |
| Protocol and adapter behaviour: verdict rules against captured c-icap bytes; unreachable, timeout, drop, garbage, oversized head, early `204`, digest mismatch | unit | scripted loopback servers, **not** scanner evidence |

### 8.5 Found during validation, fixed: a race that could make an infected upload CLEAN

CI's real-scanner suite caught it. In CI run 543, six simultaneous uploads of an EICAR archive did not all come back INFECTED.

- **Cause.** The local storage driver's `copy` used `copyFile` straight onto the content key, and `copyFile` truncates before it writes. Two uploads of the same bytes copy onto the same key, and each then reads it back to scan it. A read in between got zero bytes: measured, 11 of 3,000 reads made during a copy. A real ClamAV behind c-icap passes an empty body as clean.
- **Fix, `a560bb0`, in two layers:**
  - the local copy now lands on a unique temporary name and is renamed into place, as every other write in that adapter already was;
  - every scan request carries the content digest, and the adapter refuses to send bytes that do not hash to it (FAILED), whatever the storage driver.
- **Tests.** A copy/read race spec fails on the old code and passes on the new one. Adapter cases cover an empty and a short read.
- **Scope.** The S3 driver's server-side copy replaces objects atomically and was not affected. **PROD-PATH**

### 8.6 Limits and observations

- **Memory and upload size.** The adapter reads a whole object into memory before sending it, because `StoragePort` has no streaming read. `AV_ICAP_MAX_BYTES` bounds this, and under ICAP it is also the effective upload limit: 128 MiB by default, where the upload ceiling was 2 GiB. A deployment that needs larger files raises it and provisions the memory. **ARCH**
- **No ICAP over TLS.** `icaps://` is refused, so the scanner must sit on the private network. **ARCH**
- **Validated with one scanner.** Only ClamAV behind c-icap was validated. Another ICAP scanner must be checked with `probe.mjs` and must meet §3.2 of `deployment.md`. **ENV**
- **Stale display in the web dialog.** When an upload deduplicates before transfer, the web upload dialog shows the file as clean without asking. Filing is still refused by the server if it is not. This is display only, and not changed in this fix. **ARCH**
- **Synchronous scan.** The scan still runs inside the upload-completion request, the Phase 3 shape. The worker-fed scan described in `11-storage-architecture.md` §4 is not built. **ARCH**

### 8.7 Not rerun without substitution

- Phase 19's restored-deployment check still carries its two TEST-ONLY substitutions from the gate.
- The content-dependent phases (5, 8, 9, 11, 16) were not rerun after the fix. Their content reached CLEAN by substitution at the gate. The scanning itself is now validated above, but those phases' own evidence is unchanged. **TEST-ONLY** as labelled in §4.

## 9. Deployment / migration considerations

- **Upgrade path, rehearsed** (**PROD-PATH**, `p18-upgrade.out`).
  - The baseline `f1d9385` was built in its own worktree and created real data through its own API: numbered, checked-out, revised, deleted and keyed documents.
  - It was then upgraded in place with the RC's `migrate-tenants.mjs`, which applied exactly `20260927120000_file_object_live_uniqueness` and `20260928100000_idempotency_claim` to both tenants and re-applied the four post-migrate scripts, in 23 s.
  - Everything read back row for row. Tokens issued before the upgrade still worked, and in-flight check-out and deletion were finished.
  - Numbering continued without reuse, the outbox was dispatched, search worked, and the audit chain verified in both tenants.
- **Re-running migrations is a no-op** ("No pending migrations"; the post-migrate scripts are idempotent).
- **D-12's migration** recreates two unique indexes on `file_object` as partial indexes, without `CONCURRENTLY`. On a large table this holds a write lock for the duration of the index build. Plan it inside the migration window. **ARCH**
- **D-20's migration** alters an empty table; no data is converted.
- **Idempotency replay window** across the D-20 upgrade: drain traffic briefly (§7).
- **Proxy trust (D-2):** `TRUST_PROXY` must name every hop in front of the API, including the web tier, and `WEB_TRUST_PROXY` the hops in front of the web server. Nothing is trusted by default. `deployment.md` §3.1.
- **Production configuration** refuses every placeholder and every insecure setting at boot (13-case matrix, **PROD-PATH**). **D-3 update:** `AV_DRIVER=ICAP` now needs `AV_ICAP_URL` and binds the real adapter; `HOSTED` and an unwired scanner address are refused at boot. The scanner itself must be configured to fail closed (`deployment.md` §3.2).
- **Images:** three targets built by CI from one commit, on `node:22-bookworm-slim`, running as `node` under `dumb-init` with `NODE_ENV=production`; the API image has a HEALTHCHECK. The images were not run locally (**ENV**).

## 10. Backup / restore / DR evidence

All of this is **PROD-PATH** except where marked TEST-ONLY.

- **Database.** `scripts/dr-rehearsal.mjs` ran the documented procedure on the upgraded tenants into an empty PostgreSQL 16 cluster (`p19-dr.json`).
  - 79 tables in each of 2 tenants: **zero row-count differences**.
  - On the restored cluster: row-level security enabled and forced on 77/77 tables with 77 policies; `edms_app` and `edms_owner` neither superuser nor BYPASSRLS; the audit table not updatable.
  - Timing: restore 19.9 s, whole rehearsal 23.4 s.
- **Object storage.** `scripts/storage-backup.mjs`: 196 objects (44,794 bytes) backed up with a SHA-256 manifest, verified, and restored into a fresh bucket: 196/196.
- **The restored deployment**, the RC API on the DR cluster, the restored bucket and an empty Redis (`p19.out`, `p19-rearm.out`):
  - every document field-identical to the source;
  - both audit chains end on the source's last sequence and hash;
  - existing credentials sign in, in both tenants;
  - downloads return the original bytes, from the restored bucket;
  - search works;
  - new work gets a number after every restored one. The content for that new work was made CLEAN by the **TEST-ONLY** substitution.
  - The audit chain verification job passes on the restored deployment.
  - **Queue-state rebuild:** from an empty Redis, 26 cron schedules and the one armable timer were rebuilt from PostgreSQL. The scripted run showed 9/10, because the check compared timers created after boot with timers re-armed at boot; a controlled restart then gave armable 1 = re-armed 1.
- The CI recovery shard, `recovery.e2e`, passes in CI run 539 and in the final gate.
- Not rehearsed (**ENV**): point-in-time recovery through WAL archiving, and bucket versioning or cross-region replication. Both are properties of production infrastructure.

## 11. Tenant-isolation evidence

All of this is **PROD-PATH**: two tenants in two databases (ADR-0015), one API.

- **Identifiers (Phase 17).**
  - 19 kinds of the other tenant's identifiers (document, content, preview, revisions, workflow, edit, delete, check-out, blob duplicates, task decision, audit timeline, user administration, folders, upload sessions, signatures) are refused in both directions.
  - Every refusal is **identical to the answer for an identifier that exists nowhere**, so there is no existence oracle.
  - Beta's attempts left nothing of alpha's changed. Each tenant audits the attempts made against it, attributed to its own users.
- **Lists and search.** Nine lists and searches from both sides show nothing of the other tenant. The negative search runs only after each tenant's own search has indexed its own document.
- **Tampered credentials.**
  - A token with its tenant claim rewritten (re-signed, or `alg:none`) is refused 401.
  - Tenant headers and a foreign `Host` change nothing.
  - One tenant's credentials presented to the other are refused exactly like a wrong password.
- **Storage.** Objects sit under per-tenant prefixes only. A signed URL re-pointed at the other tenant's object is refused by the store (403).
- **Database.** The application role on one tenant's database, claiming the other tenant, reads nothing. Writing a foreign-tenant row is refused by row-level security. No foreign-tenant row exists in documents, outbox, audit or idempotency.
- **Bulk (D-16)** and **idempotency (D-20)**: the other tenant's objects and keys are independent scopes.

## 12. Security / authentication evidence

**D-2 final revalidation: PASS**, against the exact acceptance criteria set when it was fixed (`a328dd7`). The evidence, all **PROD-PATH**:
- the resolver, 27/27;
- config refusal, 2/2;
- the web reader's guard, 4/4;
- real sockets from distinct loopback addresses, with a real forwarding hop and two tenants, 10/10 (`d2-final-api.log`);
- the real `/login` flow in Chromium through per-person relays, 3/3 (`d2-final-web-e2e.log`);
- a live gate driver against the running RC, 14/14 (`d2-final-live.out`). It used the production web build behind `server.mjs` with the API trusting only loopback, plus two more API processes of the same build: one trusting nothing, one trusting exactly one proxy address behind a real forwarding proxy.

| # | Criterion | Result |
| --- | --- | --- |
| 1 | Different clients authenticate independently | 11 people at 11 addresses signed in through the web form; 11 clients behind one trusted proxy signed in |
| 2 | Same client limited after the threshold | through the web and behind the proxy: 10 rejections, then the 11th, with correct credentials, refused (web: "Sign-in is unavailable"; API: 429 `RATE_LIMITED`) |
| 3 | Different tenants do not share a client's bucket | while one client was exhausted, a different client in the other tenant signed in (web and proxy). The same address stays limited across tenants by design: the per-address dimension is deployment-wide, unchanged by D-2 |
| 4 | A forged forwarding header cannot bypass the limit when the proxy is untrusted | a direct deployment ignored a new forged `X-Forwarded-For` on each of 10 attempts, then 429; browsers sending forged `X-Forwarded-For` / `X-Munaxa-Client-Address` bought nothing and were recorded at their real address; a client writing the header the trusted proxy appends to, or bypassing that proxy, could not choose its address |
| 5 | A trusted proxy's forwarded address is used | `session_family.ip_address` equals each client's own address, behind the web tier and behind the proxy; never the proxy's |
| 6 | The real web login path behaves correctly | the criteria above passed through the real `/login` server action in Chromium |
| 7 | Exact D-2 acceptance | all a328dd7 suites green; the rule is still `auth.login` = 10 per 300 s by [ip, identity] |

Other security evidence, all **PROD-PATH**:

| Finding | Evidence |
| --- | --- |
| D-18 | A refused session is cleared only on the API's own `UNAUTHENTICATED`; an unavailable API keeps the session and renders a bounded state (1 document request, not the measured loop of 273 navigations and 3,014 requests) |
| D-19 | No login `next` can leave the origin: 15 Chromium cases, requests to foreign hosts fenced; on the old build Chromium requested `http://evil.example/` |
| D-16 | Bulk refusals are indistinguishable from nonexistence |
| D-11 | Tampered or lost content is refused before any URL is signed |

The production configuration refuses a missing witness, sealing or checkpoint secret, the explorer, insecure outbound HTTP and plaintext SMTP, and sends CSP, HSTS, `nosniff` and `DENY`.

## 13. Concurrency / integrity evidence

All of this is **PROD-PATH**. Phase 16 ran 28/28 on a clean reset, with 0 server errors across 123 concurrent responses, split across two separate API OS processes (`p16-after-d20.out`):

- **Idempotency (D-20).** Six simultaneous retries under one key, ×3 rounds: one document, one event and one blob reference each time; the rest `409 REQUEST_IN_PROGRESS`; the retry replays. The same key with two different bodies: each performed once, never crossed. The same key in two tenants: independent. Owner failure: the key is released and the retry succeeds. Same-key submission: one instance, one reservation.
- **If-Match.** 10 edits: 1 applied, 9 `VERSION_CONFLICT`, one change audited.
- **Check-out and check-in.** 10 check-outs by two people give 1 lock; 5 check-ins give 1 revision; ordinals stay unique.
- **Workflow.** 5 submissions give 1 instance and 1 reservation; 5 approvals give 1 decision and 1 number; 5 publications give 1 published revision.
- **Numbering.** 12 simultaneous approvals give 12 distinct, contiguous numbers.
- **Uploads.** 8 identical uploads give 1 live blob; 5 documents filed from one blob give ref_count 5.
- **Delete and restore.** 5 at once give 1 applied each; the version moves once.
- **Overlapping bulk.** No lost update.
- **Invariants after the races.** No double lock, no duplicate ordinal, blob, number or reservation, no under-counted blob, at most one PUBLISHED revision.
- **Content.** Filed content reached CLEAN via the **TEST-ONLY** substitution; the races themselves are PROD-PATH. **D-3 update:** upload and scan races with the real scanner are in §8.4, all **REAL-SCANNER**.

## 14. Known environment limitations (ENV)

- **Antivirus (D-3 update).**
  - At the gate there was no ICAP/ClamAV scanner and no adapter, so every content-dependent path beyond upload was **TEST-ONLY**.
  - Now ClamAV 1.5.4 behind c-icap 0.5.10, with official signatures, runs in the validation container and in CI (§8.3).
  - The signatures were fetched through this environment's egress proxy. The development image's own `freshclam` could not verify that proxy's certificate here, so its test used the same downloaded signatures.
- **Test-only clock moves.** The retention due dates in Phase 11 were moved by 53 ledgered updates (`time-travel.log`).
- **MinIO from source.** MinIO was built from pinned source rather than a release image, as CI does; the S3 API is exercised through the product's adapter.
- **One host.** All "clients" are distinct loopback source addresses on one host, and "processes" are separate OS processes on one host.
- **Not live-testable here:** webhook delivery to external endpoints, WAL archiving and point-in-time recovery, bucket versioning and replication, and Sentry/OTLP exporters (absent from the build and refused by config).
- **Container images** were built and checked by CI only, not run locally.
- **Local database gaps.** The local rival CI and E2E databases had missed the D-12 migration until migrated at this gate. CI migrates every tenant on every run and was green throughout.
- **Local owner role.** On the local source cluster `edms_owner` is a superuser, a convenience of local setup. The application role and the restored cluster have the documented posture.
- **Redis persistence.** The RC Redis ran without AOF. D-13 makes loss recoverable; the D-15 window remains.

## 15. Exact production prerequisites before release

1. **A production malware scanner** (D-3 is fixed in the product; this is the deployment's half).
   - Run an ICAP antivirus service on the private network.
   - Configure it to fail closed (`deployment.md` §3.2): every type scanned, whole objects up to `AV_ICAP_MAX_BYTES`, the verdict after the whole object, engine errors as errors. Keep its signatures updated.
   - Set `AV_DRIVER=ICAP` and `AV_ICAP_URL`, and size `AV_ICAP_MAX_BYTES` to the largest file you accept.
   - Before opening traffic, `node infra/antivirus/probe.mjs <AV_ICAP_URL>` must exit 0, and `/api/health` must show `antivirus: UP`.
   - Alert on `antivirus: DEGRADED`.
2. **Production configuration**, which the boot validation enforces:
   - `NODE_ENV=production`;
   - real `STORAGE_DRIVER` with bucket and key pair, and `MAIL_DRIVER` with `MAIL_FROM_ADDRESS` over STARTTLS or TLS with certificate validation;
   - `SIGNATURE_WITNESS_SECRET`, `MFA_TOTP_SEALING_KEY` and `AUDIT_CHECKPOINT_SECRET`;
   - `OPENAPI_ENABLED` off;
   - `METRICS_SCRAPE_TOKEN` if metrics are enabled;
   - no `SENTRY_DSN` or `OTEL_EXPORTER_OTLP_ENDPOINT`.
3. **Proxy trust:** `TRUST_PROXY` naming every hop in front of the API, the web tier included, and `WEB_TRUST_PROXY` for hops in front of the web server (D-2).
4. **Migrations:** run `scripts/migrate-tenants.mjs`, which includes the post-migrate SQL, for every tenant before rolling out the new build. Plan D-12's index rebuild into the window, and drain client traffic briefly for the idempotency replay window.
5. **Production DR mechanisms:** WAL archiving for point-in-time recovery, and bucket versioning plus replication. The rehearsal tooling proves restorability but does not replace them.
6. **Release notes** for D-1, D-4, D-9, D-10, D-14, D-15 and D-21, and for the idempotency upgrade window.

## 16. Final release recommendation

**D-3 is fixed and validated against a real antivirus scanner (ClamAV behind c-icap): CLEAN is
fileable and downloadable, EICAR is INFECTED and never fileable or downloadable, and an unavailable,
hung or erroring scanner never yields CLEAN. No release blocker remains open, and the release
candidate may proceed to final production-readiness validation.**

This is not a declaration that the product is production-ready. That decision still needs:
- the production prerequisites in §15, a correctly configured scanner among them;
- the release notes for the deferred findings (§7);
- the checks this report labels TEST-ONLY or ENV (§8.7, §14).

*Superseded recommendation, from the gate:* "RC validation is complete, but production release
remains blocked until D-3 is resolved and real antivirus CLEAN/INFECTED behavior is validated."

---

### Evidence index

Evidence was produced in the validation container under `/tmp/claude-0/rc/`. That container is ephemeral; the figures above are transcribed from these files.

| Evidence | Path |
| --- | --- |
| Final-gate suites | `evidence/final-suites.log`, `final-unit.log`, `final-e2e.log`, `final-integration.log` |
| D-2 | `evidence/d2-final-live.out`, `d2-final-api.log`, `d2-final-web-e2e.log` |
| D-3 ledger | `acc/d3-substitutions.log`, `evidence/d3-ledger-audit.out` |
| D-3 fix | `evidence/d3/suites.log`, `integration3.log`, `e2e-a560bb0.log`, `d3-live.out`, `p4-real-scanner.out`, `p14-real-scanner.out`; `acc/d3-real-scanner.log` (real-scanner checks, no substitution); `acc/probe-d3-live.mjs` |
| Time travel | `acc/time-travel.log` |
| Phases 4–17 | `evidence/p4-after-d11-d12.out`, `p6-after-d11-d12.out`, `p7-after-d13.out`, `p11-after-d11-d12.out`, `p12-after-d11-d12.out`, `p13-after-d13.out`, `p14-after-d16-d17.out`, `p15-after-d18-d19.out` (with `p15/` screenshots), `p16-after-d20.out`, `p17.out` |
| Phases 18–19 | `evidence/p18-upgrade.out`, `p18-prod-config.out`, `p19-dr.json`, `p19.out`, `p19-rearm.out` |
| Acceptance drivers | `acc/*.mjs` |
