# Staging Deployment & Acceptance Gate — repeated, from `e94c295`

**Date:** 2026-09-29. **Procedure:** [`docs/operations/go-live-runbook.md`](../operations/go-live-runbook.md)
as corrected in `ced2101` (STG-2 to STG-7). **Gate requested against:** application commit
`e94c29585a6aa18b5a7a27ecebb2320d5b59f75a` (the STG-1 fix). The historical NO-GO for `a560bb0` stays
in [staging-acceptance-gate-a560bb0.md](./staging-acceptance-gate-a560bb0.md) unchanged.

> **Verdict: `e94c295` did not pass. Its fix, `416ca94`, passed the full gate.**
>
> - The repeated gate found **STG-10** on `e94c295`: every upload above 64 MiB was refused on the S3
>   storage driver (fail-closed). This is a release-blocking application defect, new, and not a
>   regression. It was present since multipart targets were introduced, and the earlier gate never
>   reached it.
> - Following the gate's defect procedure, it got the smallest fix with regression tests and CI, and
>   the gate went back to deployment:
>   **`416ca946f6afaee8bcea7fcf94c9705af800c5a8`** (CI run 548, 9/9 green).
> - Every gate item was then run against `416ca94` deployed by the runbook, except the
>   application-independent infrastructure checks (PITR, TLS, scanner isolation). Every item is
>   **PASS**.
> - Nothing here is a production-readiness claim. §12 lists the production prerequisites.

Every result is **PASS**, **FAIL**, **BLOCKED — ENVIRONMENT** or **NOT APPLICABLE**. A result obtained
only after correcting the test harness says so, with the correction.

---

## 1. Result matrix (application `416ca94`, scanner image `7442853`)

| Area | Result | Evidence (sections below) |
| --- | --- | --- |
| Release identity | **PASS** | Clean checkouts; images labelled with their commit; CI 545 (`e94c295`), 546, 547, **548 (`416ca94`)** all 9/9 green (§2) |
| Deployment | **PASS** | Runbook order: confirm release → prerequisites → scanner probe → drain → queues empty → stop → backup as `edms_backup` → migrate → API → web → probe → health → smoke → traffic. Drain 11:26:40–11:28:27; public 443 answered only 503 in the window (§3) |
| Database / migrations | **PASS** | Both tenants: "No pending migrations", 30 applied, last `20260928100000_idempotency_claim`, 0 unfinished or rolled back; RLS forced 77/77, 77 policies (§3) |
| Idempotency | **PASS** | D-20 7/7 on `e94c295` and 7/7 on `416ca94`, including a restart mid-flight (§4) |
| Antivirus | **PASS** | Real ClamAV 1.5.4 / c-icap 0.5.10. `probe.mjs` passes. Clean files of **5/20/30/40/50/60/120 MiB** are CLEAN, filed and downloaded byte-identical. Fresh EICAR is INFECTED and refused. A browser upload of 70 MiB is CLEAN. 128 MiB + 1 byte is refused before storage (§5) |
| Smoke | **PASS** | §16: 22/22 in alpha (operator listener, before traffic) and 22/22 in beta (public listener, after traffic), on both SHAs. Real Chromium 8/8 (§6) |
| Security | **PASS** | 15/15 on `416ca94`: authentication, authorization, tenant isolation, signed URLs, RLS, audit immutability, headers, metrics token, upload ceiling (§7) |
| Scanner outage | **PASS** | Unreachable → FAILED/UNREACHABLE. Hung → FAILED/TIMEOUT at 122 s. Engine killed → FAILED/SCANNER_ERROR. Filing refused each time; recovery clean. The D-3 re-scan of FAILED bytes gives CLEAN (§8) |
| Redis outage | **PASS** | Readiness 503 with `cache: DOWN`; sign-in fails closed; recovers without an API restart (§8) |
| Storage | **PASS** | Store outage: uploads and downloads fail, nothing CLEAN, recovery clean. TLS store with bucket CORS proven in a browser. Previews through `STORAGE_PUBLIC_URL`. Restore 160/160 objects. Replica failover passes (§8, §9) |
| DR | **PASS** | Empty cluster, backup-role dump: **0 differences**, 79 tables × 2 tenants. RLS posture intact. Audit tail equal (after STG-11). Restored deployment 10/10 with real AV. PITR to a timestamp exact (§9) |
| Load baseline | **PASS** (baseline recorded; no capacity claim) | 100 identities from 12 addresses, 5 scenarios, 29,551 requests, **0 failures, 0 429**. The harness's latency targets were **not met** on this single host (§10) |
| Monitoring | **PASS** | **Scanner stopped → `AntivirusDegraded` FIRING e-mail to `oncall@staging.test` about 1 min later.** 10 alert types FIRING and RESOLVED end to end (§11) |
| TLS / network | **PASS** | TLS 1.2/1.3 only; certificate valid for `docs.staging.test`; HSTS; 80→443; scanner reachable only from the API (§5.3, §6) |
| SMTP | **PASS** | Application e-mail (approval needed, approved, published) and alert e-mail delivered through a STARTTLS-required relay (§11) |

**Application defects found in this gate:** STG-10 (release-blocking, fixed), STG-11 (DR tooling,
fixed), STG-12 (cosmetic, non-blocking; fixed afterwards in `f5d5bb2`, §14). See §12.

---

## 2. Release identity

| Item | Value |
| --- | --- |
| Gate requested for | `e94c29585a6aa18b5a7a27ecebb2320d5b59f75a`; CI run 545 9/9. `73cc0a1` (docs only) is present on the branch |
| Commits added during this gate | `ced2101`: runbook and load-harness corrections STG-2 to STG-7 (docs and tooling; CI 546 9/9). `7442853`: scanner image entrypoint, STG-8/STG-9 (infra; CI 547 9/9). **`416ca94`: STG-10, application (CI 548 9/9)**. The report commit also fixes STG-11 in `scripts/dr-rehearsal.mjs` (operator tooling, run from a checkout) |
| Application code `e94c295..416ca94` | Exactly one non-test file: `apps/api/src/modules/storage/application/storage.service.ts` |
| Images (built from clean checkouts; no registry: CI builds and does not push) | `munaxa-docs-api:416ca94` `sha256:763450f5c127…d188` · `munaxa-docs-web:416ca94` `sha256:e4cfd9b9af21…7654` · `munaxa-antivirus:7442853` `sha256:805574b9640d…f8e4`. Each carries `org.opencontainers.image.revision=<full SHA>`. First deployment of this gate: `munaxa-docs-api:e94c295` `sha256:bb316f7013e1…1099`, `munaxa-docs-web:e94c295` `sha256:eee780406c4c…e725` |
| Running at the end | `stg-api` = `munaxa-docs-api:416ca94`, `stg-web` = `munaxa-docs-web:416ca94`, `stg-antivirus` = `munaxa-antivirus:7442853`; 0 restarts (`docker inspect`) |

## 3. Deployments (runbook §21)

Two real deployments, each in runbook order. Both logs are UTC-stamped.

- **`e94c295`** (10:58–11:04). This also replaced the scanner with `7442853` on the isolated network.
  With no egress, the start-time freshclam failed and the image scanned with its volume's signatures
  (the STG-8 path). Drain 10:59:41.
- **`416ca94`** (11:26:35–11:28:27), after STG-10:

| Step | Result |
| --- | --- |
| Release identity | Checkout `416ca94…` clean; image labels match; the running images were `e94c295` before |
| Prerequisites | Prometheus 12/12 targets up; Alertmanager ready; mail relay up; backup and signature schedulers up; store and replica on TLS |
| Scanner probe before drain | `clean passed (204), EICAR blocked (Eicar-Test-Signature)` |
| Drain | Public ready, login POST and `/login` → 503. Proxy log for the window: 46 × 503 on 443 and nothing else. The operator listener (8443) carried smoke and D-20; its 3 × 502 are D-20's deliberate API restart |
| Queues | `outbox_pending=0`, waiting+active 0 |
| Backup (as `edms_backup`, corrected §6 step 1b) | Both dumps 79/79 table data. Storage backup 129 objects, `verify intact`. Versioning Enabled. WAL archiving archived=6 failed=0. Replication online, 0 errors, source 129 = replica 129 (the log line "0 rule(s)" is a grep artefact of my script, noted in the log) |
| Migrations from the `416ca94` checkout | "No pending migrations to apply" ×2, post-migrate SQL applied |
| Schema per tenant | 30 migrations, last `20260928100000_idempotency_claim`, 0 unfinished, 0 rolled back; 78 tables, RLS enabled and forced 77/77 (non-RLS: `tenant`), 77 policies |
| API, web | API on the application and scanner networks, web on the application network only. `DATABASE_MIGRATION_URL` and `AV_ICAP_TEST_URL` absent from the API environment |
| Probe from the API's namespace; web → scanner | Probe passes; web → scanner unreachable (timeout) |
| Health (operator listener, public still drained) | `UP`: `database:alpha`, `database:beta`, `cache`, `antivirus` all UP; ready 200, public 503 |
| Smoke, then traffic | Smoke 22/22 and D-20 7/7 on the operator listener; traffic restored 11:28:27; public ready 200 |
| Post-go-live | Beta smoke 22/22 on the public listener |

## 4. Idempotency (D-20)

7/7 on `e94c295` and 7/7 on `416ca94`, against the migrated databases: atomic claims, replay,
conflicting bodies, and a restart mid-flight.

## 5. Antivirus

### 5.1 Scanner

ClamAV 1.5.4, signatures daily 28138, main 63, bytecode 339; c-icap 0.5.10.

- `probe.mjs` passes from the API's network namespace, and from the exporter every 60 s.
- The scheduled signature update runs every 30 min through the egress proxy into the scanner's volume.
  It ran 5 times, last at 12:09:05, "up-to-date". clamd picks new databases up at SelfCheck.

### 5.2 Large clean files (S3 + real scanner, `416ca94`)

Each file was CLEAN, filed, downloaded byte-identical, with a COMPLETED session, one row, and events
`file-created` + `scan-completed`.

| Size | 5 | 20 | 30 | 40 | 50 | 60 | **120 MiB** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Upload → CLEAN | 1.3 s | 3.7 s | 5.7 s | 8.4 s | 9.5 s | 11.2 s | **21.0 s** |

On `e94c295` the same run gave 6/7. The 120 MiB file was refused `415` at completion (STG-10, §12).
EICAR: fresh bytes (a zip with a random member name) → INFECTED `Eicar-Test-Signature`, filing
refused `409 CONTENT_NOT_SCANNED`, in both tenants and on the restored deployment.

### 5.3 Scanner isolation

| Path | Result |
| --- | --- |
| Scanner networks | Only `stg-scan` (Docker `internal=true`), no published ports |
| API → scanner :1344 | reachable |
| Web, proxy, object store → scanner | unreachable |
| Scanner → internet (1.1.1.1:443), scanner → PostgreSQL | unreachable |

## 6. Smoke, browser, TLS

- **§16 smoke:** 22/22 four times.
  - `e94c295`: alpha on the operator listener, beta on the public listener.
  - `416ca94`: the same.
  - The run covers sign-in and sign-out, create, upload CLEAN, file, download SHA-256 equal, preview
    through `https://docs.staging.test/api/v1/preview/stream…` → 200, EICAR, quarantine, revision,
    submit, approve, numbering, search, audit per subject, access denial and bulk.
- **Real Chromium** (`--host-resolver-rules` maps `docs.staging.test`; the staging certificate is
  pinned by SPKI): 8/8.
  - TLS 1.3, issuer "Munaxa Staging CA".
  - Sign-in through the web; cookies `edms_at`/`edms_rt` Secure, HttpOnly, SameSite=Lax.
  - **A 70 MiB file through the product's own upload dialog:** a cross-origin PUT from the page to
    `https://172.30.0.12:9000` → 200 (bucket CORS), real scan, filed. The document's file has the
    browser's SHA-256 and is CLEAN.
  - The bucket accepts the product origin. A page on a foreign origin is blocked by the browser.
  - *Harness correction:* my first filing check joined on `current_revision_id`, which a DRAFT does
    not have. Rerun with the right join: PASS.
  - *Earlier attempt:* the browser's sign-in was refused `RATE_LIMITED`, because my harness had used
    up the per-address limit (10 per 5 min). The limiter was working correctly; a rerun after the
    window passed.
- **TLS and network** (`openssl s_client`, curl):
  - The chain verifies to the staging CA; SAN `DNS:docs.staging.test, IP:172.30.0.5`.
  - TLS 1.0 and 1.1 refused, 1.2 and 1.3 accepted.
  - A client without the staging CA is refused.
  - Port 80 → 301 `https://docs.staging.test/…`.
  - HSTS `max-age=63072000; includeSubDomains; preload`, `X-Frame-Options: DENY`, nosniff,
    `Referrer-Policy`.
  - The object store serves TLS with the staging CA.

## 7. Security (`416ca94`): 15/15 PASS

- Wrong password → 401; tampered token → 401; alpha credentials on beta → 401.
- D-2: `session_family.ip_address` is the browser (172.30.0.1), not the proxy or the web tier.
- A reader is refused create, user administration and check-out (403).
- Tenant isolation:
  - another tenant's document answers exactly as a nonexistent id (404/404) and is absent from
    search and lists;
  - a token is bound to its tenant.
- Presigned URLs: re-pointed at another tenant's prefix, forged, or with a lengthened expiry → 403
  from the store. TTL 300 s.
- A tampered preview token is refused.
- RLS:
  - forced on every tenant table; `edms_app` and `edms_owner` are not superuser or `BYPASSRLS`;
  - no tenant → 0 rows; another tenant → 0 rows; own tenant → rows.
- `UPDATE audit_event` is refused even for the owner ("append-only").
- CSP, HSTS, nosniff, `X-Frame-Options: DENY`; OpenAPI not served; `/api/metrics` 401 without the
  token.
- **New:** 128 MiB + 1 byte → `415` before any target is issued; exactly 128 MiB → one signed PUT,
  `parts: null`.

Observation (not a failing criterion): the API still sends `X-Powered-By: Express`.

## 8. Failure and recovery (`416ca94`)

Each outage was held until its alert e-mail reached `oncall@staging.test`.

| Test | Result |
| --- | --- |
| **Scanner stopped** | `/api/health` antivirus DEGRADED, readiness 200. Clean upload → FAILED `UNREACHABLE`; filing 409; EICAR → FAILED; an existing CLEAN document still downloads with its bytes. **`AntivirusDegraded` e-mail 11:45:05** (stopped about 11:44); `ScannerProbeFailing` 11:47:20 |
| Scanner restarted | `probe.mjs` passes; UP. Clean → CLEAN, filed. EICAR → INFECTED, refused. **The FAILED bytes uploaded again → re-scanned → CLEAN** (D-3) |
| **Scanner hung** (`docker pause`) | Answered after **122 s**, recorded FAILED `TIMEOUT` (`AV_SCAN_TIMEOUT_MS=120000`); DEGRADED. Unpaused → CLEAN |
| **Scanner error** (clamd killed; c-icap still answering) | FAILED `SCANNER_ERROR`, never CLEAN; filing 409; DEGRADED. `AntivirusDegraded` 12:10:50 and `ScannerProbeFailing` 12:13:05 e-mails. `docker restart` → UP, CLEAN (STG-9 PID cleanup, 0 restarts) |
| **Redis stopped** | Readiness 503 with `cache: DOWN`; sign-in fails closed (429); an authenticated request 500 (D-14, documented). `RedisDown` e-mail 11:57:50. Restored: 200 **without an API restart**; upload CLEAN and filing work |
| **Object store stopped** | Uploads fail at PUT and downloads fail; nothing CLEAN; readiness unchanged (storage is not a readiness entry, as documented). **`ObjectStoreDown` e-mail** 12:16:35. Restored: CLEAN, filed, existing bytes identical |
| **Tenant database refusing connections** (beta) | Readiness 503 naming `database:beta`; alpha UP and serving. `DatabaseDown` e-mail 12:18:05. Back: 200, beta serves again without an API restart |
| RESOLVED e-mails | `AntivirusDegraded`, `ScannerProbeFailing`, `RedisDown`, `ObjectStoreDown`, `DatabaseDown`: all received after recovery |

**Harness corrections (not product behaviour).** The first run gave 27/31.

- **3 checks:** the run outlived the 15-minute access token (`JWT_ACCESS_TTL_SECONDS=900`), and my
  harness did not re-sign in. Those phases were rerun with fresh sign-ins: PASS.
- **1 check** expected a second `AntivirusDegraded` e-mail for the engine kill. The stopped, hung and
  killed phases ran back to back, so the probe stayed 0 continuously from 11:44 to 11:56:45.
  Alertmanager rightly sent one FIRING e-mail and one RESOLVED (11:57:05). Repeated in isolation:
  its own FIRING and RESOLVED, PASS.

The rerun gave 15/15. Every API error-level log line since the deploy falls inside a provoked outage
window.

## 9. Backup, DR, PITR, replication

| Step (runbook §23) | Result |
| --- | --- |
| DR cluster | A new, empty PostgreSQL 16. `trust` only for `edms_owner`/`edms_app` from the rehearsal host and the restored API's address; scram for everything else (as the corrected runbook says, STG-6) |
| `dr-rehearsal.mjs --prepare-destination`, dump source `edms_backup` (STG-2 corrected) | **0 differences**, 79 tables × 2 tenants. Restore 27.8 s, total 33.0 s |
| RLS posture | Both tenants: RLS enabled and forced 77/77, 77 policies; both roles non-superuser and non-`BYPASSRLS`; audit not updatable |
| Audit tail | **STG-11:** the tool reported sequence 999 as the tail of alpha, which has 1,120 events. Verified directly: source and restore both end at **1120 `FILE_UPLOADED` 5ecdc5c9…**; beta **442 18a5df4e…**. The tool is fixed (§12) |
| Storage (`storage-backup.mjs` backup → verify → restore into an empty bucket) | **160/160** objects, 1.17 GB, `intact`, 0 differences. A first restore from the 11:26 backup (129/129) was superseded, so the bucket matches the 11:36 dump |
| Restored deployment | `416ca94` API on the restored databases, the restored bucket, an **empty** Redis, and the **real** scanner, behind its own TLS proxy. Readiness 200, all UP |
| Restored acceptance | **10/10**: sign in (both tenants); read; download byte-identical from the restored bucket; clean upload → **real CLEAN** → filed; numbered **SOP-0007** after SOP-0001…0006, no reuse; **EICAR → INFECTED**, refused; search |
| Redis rebuild, cron, timers | "Queue state rebuilt from durable state after the broker lost it". Six cron lanes present (`audit.export` 1, `audit.stream` 1, `identity.delegation` 1, `notifications.deliver` 5, `retention.run` 4, `webhooks.deliver` 1). Timers re-armed 0 = armable SCHEDULED timers 0 |
| Audit chain on the restored deployment | "The audit chain verified": alpha 1138 events, beta 444 |
| **Replication failover** | The restored API pointed only at the replica store (`172.30.0.14`, the bucket replicated from the primary): existing document byte-identical; new upload CLEAN and filed |
| **PITR** | `pg_basebackup` 11:00:58 plus the WAL archive, restored to 11:20:04.907 in a new container. "recovery stopping before commit … 11:20:07". Marker `before-target` present, `after-target` absent; both tenant databases present, 30 migrations |

## 10. Load baseline — a staging observation, not a capacity certification

The corrected harness (STG-7), `--tokens-file` with **100 READER identities** signed in from **12
client addresses** (≤ 9 each, under the per-address limit). Run through the TLS proxy, 12:23:53 to
12:29:57, from the same 4-CPU host.

| Scenario | Users (identities) | Pace | Duration | Requests | Failures | 429 | p50 / p95 / p99 | Harness target p95 / p99 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Folder listing, 100 items | 50 (50) | 250 ms | 60 s | 3,844 | 0 | 0 | 777 / 936 / 1,017 ms | 200 / 500 ms |
| Document detail | 50 (50) | 250 ms | 60 s | 7,412 | 0 | 0 | 400 / 498 / 604 ms | 300 / 700 ms |
| Search, filtered | 100 (100) | 1,100 ms | 120 s | 10,995 | 0 | 0 | 539 / 842 / 1,084 ms | 800 / 1,500 ms |
| Presign a download | 25 (25) | 250 ms | 60 s | 4,383 | 0 | 0 | 337 / 422 / 468 ms | 150 / 400 ms |
| Dashboard | 100 (100) | 250 ms | 60 s | 2,917 | 0 | 0 | 2,072 / 2,520 / 2,812 ms | 500 / 1,200 ms |

**Successes: 29,551 of 29,551** (every response 200/201). API error-level logs in the window: 0.

**Resources, peak over 5 s samples:**

| Component | Peak |
| --- | --- |
| API | CPU 277%, memory 368 MiB (CPU-bound; it shares the host with the load generator and the whole stack) |
| PostgreSQL | CPU 88%, 262 MiB; 12 connections, 7 active, up to 6 briefly waiting on a lock |
| Redis | about 1,050 ops/s, 6.6 MB, 0 rejected connections |
| Scanner | idle (1% CPU, 967 MiB resident, 0 restarts) |
| Web | 6% |
| Proxy | 13% |

**Classification:** a valid baseline under the runbook's rule (≤ 1% failures or 429s). **The
harness's latency targets are not met here** (exit 1). They are stated for production-sized
infrastructure, and this is one API process on a shared 4-CPU host. **No capacity claim is made.** A
production baseline on production-sized infrastructure is a prerequisite (§13).

## 11. Monitoring, alerting, SMTP

- **Stack:**
  - Prometheus scrapes `/api/metrics` with a bearer token.
  - Blackbox probes cover API ready/live, `antivirus` UP in `/api/health`, database and cache
    health, web `/login`, the object store, and PostgreSQL/Redis TCP.
  - The scanner exporter runs `probe.mjs` every 60 s and publishes the `daily.cvd` age plus
    textfile metrics from the backup and signature jobs.
  - 14 rules, 12/12 targets up.
- **Delivery path:** Alertmanager → SMTP with STARTTLS required (the TLS relay verified against the
  staging CA) → `oncall@staging.test`.

**Scanner stopped → DEGRADED alert:** the requirement of this gate. `AntivirusDegraded` FIRING
reached `oncall@staging.test` at 11:45:05, about 1 minute after the stop, and RESOLVED followed after
recovery.

| Alert | Provoked by | FIRING / RESOLVED e-mail |
| --- | --- | --- |
| AntivirusDegraded | scanner stopped, hung, engine killed | yes / yes |
| ScannerProbeFailing | the same (exporter's `probe.mjs`) | yes / yes |
| RedisDown | Redis stopped | yes / yes |
| ObjectStoreDown | store stopped | yes / yes |
| DatabaseDown | beta refusing connections | yes / yes |
| ApiNotReady | Redis and database outages; both drains | yes / yes |
| ApiDown, WebDown | both deploy drains (public probe sees 503) | yes / yes |
| BackupFailed | `edms_backup` set `NOLOGIN`, scheduled backup run (then restored; next backup succeeded) | yes (12:10:50) / yes (12:11:50) |
| QueueFailuresGrowing | failed jobs during the outages | yes / yes |
| SignaturesStale, SignatureUpdateNotRunning, BackupStale, OutboxBacklog | **not provoked**: they need 2 days, 2 hours, 2 hours and 10 minutes above 100 pending respectively. Rules loaded and evaluating (`inactive`) | — |

**What "reaches a responsible person" means here:** the channel is the staging on-call mailbox on
the staging relay, read by the staging operator (this session). Wiring production alerts to the real
on-call rota (pager or e-mail) is a production prerequisite.

**SMTP:** application e-mail through the same STARTTLS-required relay, for example "Your approval
is needed", "Approved" and "Published" to the right users in both tenants, 14 since the `416ca94`
deploy.

## 12. Findings

### Application blockers

- **STG-10 — FIXED in `416ca94` (release-blocking, new defect, not a regression).**
  - **Symptom:** on `STORAGE_DRIVER=S3`/`R2`, every upload above 64 MiB was refused. Uploads up to
    the 128 MiB scan ceiling could not be stored. It failed closed: nothing was recorded.
  - **Cause:** above 64 MiB `createUploadSession` asked for a multipart target, and that could not
    complete, for two reasons:
    - A multipart object has no full-object SHA-256, only a composite ETag (`…-5`). `head()` read
      the digest as null, and completion refused with "Storage could not confirm the file's
      digest". Reproduced on staging MinIO at 70 and 120 MiB with every part PUT.
    - The web client ignores `parts`: it PUTs the whole file to the target URL (part 1) and completes
      with no parts.
  - **Fix:** one signed PUT at every size, with the SHA-256 in the signature. The store verifies the
    bytes and reports the digest completion needs. A single PUT is bounded by the store at 5 GiB,
    above the 2 GiB default ceiling. Sessions opened before the fix still complete as before.
  - **Tests:**
    - a unit case: a 120 MiB upload gets one PUT carrying the digest, no parts, and no multipart id
      (fails on `e94c295`);
    - a real-MinIO case storing a 70 MiB single signed PUT and reading its digest back.
  - **CI:** run 548, 9/9.
  - **Staging:** 120 MiB passes (§5.2); a browser upload of 70 MiB passes (§6); the ceiling holds
    (§7).

### Tooling defect (fixed with this report)

- **STG-11: `scripts/dr-rehearsal.mjs` compared the wrong audit tail.**
  - **Cause:** `SELECT sequence::text …` gives the text column the output name `sequence`, and
    PostgreSQL resolves `ORDER BY sequence` to that output column. Ordering is therefore textual, so
    from 1,000 events on "999" sorts last.
  - **Impact:** the restored tail equalled the source's, but on the wrong row. The row counts and the
    full chain verification were unaffected.
  - **Fix:** `ORDER BY audit_event.sequence`. Proven on staging: old query 999, fixed query 1120.

### Non-blocking defect (fixed after the gate, in `f5d5bb2`; see §14)

- **STG-12: the web image serves no brand artwork.**
  - **Cause:** `/branding/docs/…` (the logo lockups and favicons) answers 404. The Dockerfile's web
    stage copies no `public/`; its comment says the product serves no static assets. But
    `munaxa-sync-brand` generates `apps/web/public/branding/` at prebuild, and the pages reference
    those files.
  - **Impact:** the login page and the header show the logo's alt text and no favicon. There is no
    functional, security or data impact.
  - **History:** present in `a560bb0` too (not a regression).
  - **Recommendation:** fix before production (copy `apps/web/public` into the web image).

### Runbook and scanner corrections made at the start of this gate

- **STG-2 to STG-7** (`ced2101`): the backup role, `STORAGE_PUBLIC_URL`, audit wording, `DATABASE_URL`
  with a catalogue, a password-less DR destination, and the load harness.
- **STG-8 and STG-9** (`7442853`): the scanner image refused a `.cvd`-only volume, and restarted
  forever on a stale c-icap PID file.

Each was exercised in this gate.

### Environment blockers

**None remaining for staging.** Every item the previous gate classified BLOCKED — ENVIRONMENT now
exists in staging and was tested:

- monitoring and alerting, with a scanner-down alert reaching the on-call channel;
- TLS and DNS;
- scanner network isolation;
- SMTP;
- bucket CORS;
- PITR;
- replication failover;
- scheduled signature-update egress.

The staging forms of these differ from production:

- a private staging CA instead of a public CA;
- a static host mapping instead of DNS;
- Mailpit as the relay and mailbox;
- an on-call mailbox instead of a pager;
- a single host;
- signature egress through the build proxy;
- base images built with the egress proxy's CA (a build accommodation).

## 13. Production prerequisites (not part of this staging GO)

1. **Certificates and DNS:**
   - public-CA certificates for the web origin and the object-store endpoint;
   - DNS records;
   - `TRUST_PROXY` and `WEB_TRUST_PROXY` set to the real load-balancer ranges.
2. **Alert routing and silencing:**
   - production alert routing to the real on-call rota (pager or e-mail), with escalation;
   - Alertmanager silences for planned maintenance (both drains here paged ApiDown, WebDown and
     ApiNotReady, as they should without a silence).
3. **Production monitoring:** the same probes and rules (§11), including independent object-store
   monitoring. Storage is not a readiness entry.
4. **Mail:** a production SMTP relay (TLS or STARTTLS) with SPF, DKIM and DMARC for the sender
   domain.
5. **Scanner:**
   - on a private network reachable only from the API;
   - a signature-update path (a mirror or controlled egress) with its schedule;
   - about 1 GB RAM for clamd.
6. **Bucket and storage configuration:**
   - bucket CORS for the production web origin, with versioning and replication;
   - `STORAGE_PUBLIC_URL` set to the production origin (STG-3).
7. **Recovery:**
   - PITR (WAL archiving) and replication failover rehearsed with the provider's tooling;
   - the backup role `edms_backup` (BYPASSRLS + `pg_read_all_data`) created, with the scheduled
     backup and its alerts.
8. **Load:** a production load baseline on production-sized infrastructure. The harness's latency
   targets were not met on single-host staging (§10).
9. **Images:** an image registry with immutable digests (and signing, if required). This staging
   built images locally from the commit.
10. **Secrets:** a secret store and configuration versioning.
11. ~~**Artwork:** fix STG-12 (brand artwork) before production.~~ Done in `f5d5bb2` (§14).

## 14. After the gate — STG-12 fixed in `f5d5bb2` (targeted regression)

`416ca94` remains the commit the full gate passed. **`f5d5bb28146c57ab7937eff90cebd7621a28c9f2`**
changes only the `Dockerfile` (the web stage) and CI. No file under `apps/`, `packages/`, `prisma/`
or `infra/sql` differs from `416ca94`. The API's compiled output (`apps/api/dist`) is byte-identical
between the two images. Only the application's static artwork changed, so the full gate was not
repeated.

- **Cause:**
  - the pages reference the favicon and logos under `/branding/docs/…`;
  - `munaxa-sync-brand` (the web's `prebuild`) copies that artwork from `@munaxa/platform` into
    `apps/web/public/branding/` (git-ignored, never authored here);
  - the web stage of the Dockerfile copied no `public/`.
- **Fix:** the web stage copies `apps/web/public` from the build stage. It holds only the 14
  generated brand assets (1.8 MB). The image was built from a clean checkout with no `public/`, so
  the build generated the artwork itself ("branding: 14 docs assets").
- **CI guard:** the images job runs the web image, and every `/branding/` URL its own login page
  references must answer `200 image/*`. The guard fails on the `416ca94` image (404) and passes on
  `f5d5bb2`.
- **Staging, real Chromium, light and dark:**
  - before the fix, 3/10: every favicon and logo 404;
  - after the fix, 10/10: favicons (32, 512, apple-touch) and the logo lockups `200 image/png`, the
    visible logo loaded, no branding 404, login renders, the authenticated shell (`/documents`)
    renders with its logo;
  - the served files are byte-identical to `@munaxa/platform`'s `assets/docs` (14/14);
  - screenshots before and after differ only where the logo replaced its alt text.
- **Targeted regression on the final images** `munaxa-docs-{api,web}:f5d5bb2`: scanner probe passes
  from the API's network; §16 smoke 22/22; branding 10/10.
- **Checks:**
  - format, lint, typecheck and build pass;
  - web unit and accessibility tests pass 503/503;
  - the web visual suite passes except 14 Arabic right-to-left baselines. This container has no
    Arabic fonts, and the same 14 fail on the unchanged tree; CI's visual job is the reference.
  - CI run 550 on `f5d5bb2`.
