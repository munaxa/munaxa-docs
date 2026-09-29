# Staging Deployment & Acceptance Gate — RC `a560bb0`

**Date:** 2026-09-29. **Procedure:** [`docs/operations/go-live-runbook.md`](../operations/go-live-runbook.md)
(runbook commit `ed6ec31`), executed in a production-like staging environment. **Application code
under test:** `a560bb0afd91504b09f7e64d235e78951c4bf877`, unchanged. No application code, runbook or
configuration in the repository was modified during this gate.

> **Verdict: STAGING NO-GO.** The gate stopped on **STG-1**. Upload completion runs the malware scan
> inside a PostgreSQL interactive transaction that Prisma closes after its default 5,000 ms. So:
>
> - A **clean file of about 40 MiB or more cannot be scanned or filed**: the request answers HTTP 500,
>   deterministically, with a healthy real scanner.
> - A slow, unreachable or hung scanner produces 500 instead of the documented `FAILED` verdict.
>
> This is a runbook NO-GO condition ("a clean document cannot be scanned, filed or downloaded
> intact"). It reproduces against the validated RC, and it is in the application code, not in
> staging configuration, procedure or infrastructure.
>
> Separately, the monitoring and alerting NO-GO condition could not be satisfied, because this staging
> environment has no monitoring system (an **environment blocker**).
>
> Per the gate's instructions, the defect is **reported, not fixed**. No code change has been made.

Every result below is classified **PASS**, **FAIL**, **BLOCKED — ENVIRONMENT** or **NOT
APPLICABLE**. A result obtained only after correcting the test harness is stated as such, with the
correction.

---

## 1. Release identity

| Item | Value |
| --- | --- |
| Application commit | `a560bb0afd91504b09f7e64d235e78951c4bf877`, a clean detached checkout (`git status --porcelain` empty) |
| Validated by | CI run 544 on `a560bb0`, 9/9 green (RC report Part II) |
| Images built from it | `munaxa-docs-api:a560bb0` `sha256:4b9e2667…f4f3` · `munaxa-docs-web:a560bb0` `sha256:76d7f59e…5fa1` · `munaxa-docs-worker:a560bb0` `sha256:6ce3822f…283b` · `munaxa-antivirus:a560bb0` `sha256:d85d959e…e854`. Each carries the label `org.opencontainers.image.revision=a560bb0afd91…` |
| Registry digests | NOT APPLICABLE. There is no registry: CI builds and does not push, so images were built locally from the checkout (see §2, build accommodation) |
| Previous release (upgrade source) | `f1d9385` (the RC baseline), images `munaxa-docs-{api,web}:f1d9385` built the same way |
| Configuration version | The staging configuration set of 2026-09-29, held in a mode-0700 secrets directory standing in for a secret store. Configuration versioning is **[PRODUCTION-SPECIFIC]** |
| Migration state after upgrade | Both tenants: 30 migrations applied, last `20260928100000_idempotency_claim`, 0 unfinished, 0 rolled back |
| Later development commit deployed? | No. The running containers were `munaxa-docs-api:a560bb0` and `munaxa-docs-web:a560bb0` (verified with `docker inspect`) |

## 2. Environment

A single-host, container-based staging environment built for this gate. It is disposable.

| Component | Staging | Matches the documented architecture? |
| --- | --- | --- |
| PostgreSQL | 16.15, one cluster; **one database per tenant** (`stg_edms_alpha`, `stg_edms_beta`); roles from `infra/sql/cluster/01-roles.sql`, both **non-superuser** and non-`BYPASSRLS`, with scram-authenticated passwords; WAL archiving on | Yes (single cluster, no replica) |
| Redis | 7 (`redis:7-alpine`), `--appendonly yes`, password | Yes |
| Object storage | S3 API: MinIO (the pinned binary) in a container, one bucket `munaxa-docs-staging`, **versioning Enabled**, path-style, **plain HTTP** | Partly: no TLS to the store, no replication; MinIO does not enforce bucket CORS, so the CORS policy (runbook §7) is untested |
| Malware scanner | `munaxa-antivirus:a560bb0` built from `infra/antivirus/`: ClamAV 1.5.4 + c-icap 0.5.10, official signatures, on the private network at `icap://172.30.0.13:1344/avscan`, no host port | Yes, but the network is **flat**: the web container can also reach 1344 (§8) |
| API | The `api` image, `NODE_ENV=production`, read-only root filesystem, user `node`, 1.5 GiB memory limit, consumers and schedules in-process | Yes |
| Web | The `web` image (`dumb-init -- node server.mjs`), read-only root filesystem, `NEXT_PUBLIC_API_URL` set at runtime only | Yes |
| Worker | The `worker` image prints one line and exits 0; not deployed (runbook §11) | Yes |
| Reverse proxy | nginx 1.27 terminating TLS on `https://172.30.0.5` (public listener, drainable to 503) plus an internal operator listener `:8443` for pre-traffic checks; `X-Forwarded-For` overwritten at the edge | Stand-in. **Self-signed certificate, IP-addressed, no DNS** |
| Secrets | Files in a mode-0700 directory, injected with `--env-file` and one read-only mounted catalogue file | Stand-in for a secret store |
| Mail | `MAIL_DRIVER=SMTP` to `smtp.staging.invalid:465` (TLS). **No relay exists**; e-mail delivery fails (observed `ENOTFOUND`) | BLOCKED — ENVIRONMENT |
| Monitoring and alerting | **None.** Signals exist (health, readiness, `/api/metrics`, container health), but nothing polls, alerts or pages | BLOCKED — ENVIRONMENT |
| Clients | One test workstation (`172.30.0.1`) through the proxy; a real Chromium for the browser check | One source address, so the per-address sign-in limit is shared (§7) |

**Differences recorded rather than treated as equivalent:**

1. **Build accommodation.** The sandbox's egress proxy re-terminates TLS, so `docker build` could not
   fetch pnpm or packages. The images were built with an unchanged `Dockerfile` and application, but
   the `node:22-bookworm-slim` base was substituted (`--build-context`) by a one-layer image that adds
   the egress proxy's CA and `NODE_EXTRA_CA_CERTS`. The runtime images therefore also carry that CA
   and variable. The scanner's `ubuntu:24.04` base was pulled from `mirror.gcr.io` (Docker Hub
   answered 429).
2. **Signature download.** The scanner container on the private network cannot reach the egress
   proxy, so its start-time `freshclam` failed (TLS). The signatures were fetched by a **separate
   `freshclam` job from the same image**, which is the runbook §9.3 "update on a schedule" pattern,
   into the same volume. The scanner then started and its own `freshclam` reported the databases
   up to date.
3. **Previous-release data** has **no documents**. The previous release (`f1d9385`) predates D-3 and
   could not file any upload: every upload was recorded `SKIPPED`. This was observed, and it is not
   a staging artefact. Pre-upgrade state is therefore tenants, users, roles, ACLs, workflows,
   libraries, folders, audit, and idempotent requests held in Redis. No test-only CLEAN
   substitution was used anywhere.
4. **Tenant provisioning** used `node dist/provision.js` inside the previous release's image, in
   single-tenant form per tenant (known finding D-1).

## 3. Deployment procedure executed

The runbook §21 sequence, performed as an **upgrade** from `f1d9385` to `a560bb0`. All times are UTC,
2026-09-29.

| §21 step | What was done | Result |
| --- | --- | --- |
| 1 Release SHA and images | Verified checkout and image labels (§1) | PASS |
| 2 Change window, approver | No change-management system exists in staging | NOT APPLICABLE (staging); **[PRODUCTION-SPECIFIC]** for production |
| 3 Staging gate | This document *is* the staging gate | NOT APPLICABLE |
| 4 Scanner confirmed | `probe.mjs` exit 0 before the change (§5) | PASS |
| 5 Drain (§13) | 06:27:48 public listener switched to a 503 maintenance response. Every public request in the window got **503** (5 of 5 in the proxy log, including `POST /api/v1/auth/login`). Queues caught up: `edms_outbox_pending` 0, `edms_queue_depth` waiting+active 0; the only jobs left were durable *delayed* schedules. Old API and web stopped | PASS |
| 6 Backup and verify (§19.2) | **As written: FAIL (STG-2).** `pg_dump` as the tenant owner is refused by forced RLS. Repeated as the cluster superuser (a role that bypasses RLS). Two custom-format dumps (386 KB each; `pg_restore --list`: 237 table entries, 79 table-data entries each); `storage-backup.mjs backup` + `verify` → `intact: true`; bucket versioning Enabled; WAL archiving confirmed (`archived=4`) after correcting the staging archive volume's ownership (a staging setup error, not a product issue). Confirmed by the automated staging operator (this session) | PASS after the procedure correction; the procedure step itself FAIL (STG-2) |
| 7 Deploy release | Configuration and secrets set (§6); catalogue mounted readable by the image's `node` user | PASS |
| 8 Migrations from the checkout | `node scripts/migrate-tenants.mjs` from the `a560bb0` checkout (`pnpm install --frozen-lockfile`), 06:28:46–06:29:15. Applied `20260927120000_file_object_live_uniqueness` and `20260928100000_idempotency_claim` to **both** tenants, then all four `post-migrate` files. Re-run: "No pending migrations to apply" for each | PASS |
| 9 Workers | None to start; `QUEUE_CONSUMERS_ENABLED=true`; worker image exits 0 | PASS |
| 10–11 API, web | Started from `a560bb0` images; readiness 200; web `/login` 200 | PASS |
| 12 Probe from the API's network | `probe.mjs` run in the API container's network namespace, from the checkout (the API image does not contain `infra/`) → exit 0 | PASS |
| 13 Health checks | §6 | PASS |
| 14 Smoke tests | §7, on the operator listener while drained | PASS (22/22) |
| 15 Monitoring | §12 | BLOCKED — ENVIRONMENT |
| 16 Go/No-Go | §15 | NO-GO |
| 17 Restore traffic | 06:51:25 public listener reopened; public `/api/health/ready` 200, `/login` 200 | PASS (staging only) |
| 18 Monitor | Post-go-live smoke on tenant beta through the public listener: 22/22 | PASS |

The drain lasted 23 min 37 s. That includes investigating STG-2 and repeated smoke runs; the
migration itself took 29 s for two small tenants.

**Pre-upgrade state preserved:** users, departments, workflows and audit events 1–61 were present in
both tenants after the upgrade.

## 4. Migration results

| Check | alpha | beta |
| --- | --- | --- |
| `_prisma_migrations` | 30, last `20260928100000_idempotency_claim`, unfinished 0, rolled back 0 | same |
| Tables (excluding `_prisma_migrations`) | 78, of which 77 have RLS enabled and forced (the 78th is the global `tenant` table) | same |
| Policies | 77 | 77 |
| `idempotency_key` table | present, 0 rows immediately after migration (**no Redis replay record imported**) | same |
| Live-uniqueness indexes | `uq_file_object_checksum … WHERE (deleted_at IS NULL)`, `uq_file_object_key … WHERE (deleted_at IS NULL)` | same |
| Tenant databases vs catalogue | cluster `stg_edms_alpha,stg_edms_beta`; catalogue `alpha,beta` | — |
| `prisma db push` / `migrate dev` used | No | No |

**Idempotency across the migration (D-20)**, on the upgraded deployment, 7/7 PASS:

| # | Test | Result |
| --- | --- | --- |
| 1 | New request with `Idempotency-Key` → 201; its record is in the tenant's `idempotency_key` table | PASS |
| 2 | Retry, same key → the first answer replayed; one document | PASS |
| 3 | Six concurrent duplicates → one document, **one** creation audit; five `409 REQUEST_IN_PROGRESS` | PASS |
| 4 | Replay after completion → same status and id | PASS |
| 4b | Replay after an **API restart** → same id (the record is durable in PostgreSQL) | PASS |
| 5 | Same key, different body → not answered with the first body's result | PASS |
| — | **Deployment window:** a key completed on the *previous* release (record in Redis) was not imported, and its retry after the upgrade was **performed again** (answered `409 DUPLICATE` by the department's unique code, rather than replayed). This is the documented reason for the drain (§13, 24 h window) and matches the RC's observation | PASS (documented behaviour confirmed) |

One harness correction: the first run counted the creation audit by `action ILIKE '%CREATE%'`, but
creation is audited as `DOCUMENT_CHANGED` with `operation: CREATED`. The data was right, and the
rerun counted it correctly.

## 5. Scanner results

| Item | Value |
| --- | --- |
| ClamAV | 1.5.4 (`ClamAV 1.5.4/28137/Mon Sep 28 06:24:12 2026`) |
| c-icap | 0.5.10 |
| Signatures | main 63 (3,287,027 signatures), daily 28137 (355,678), bytecode 339 (80); dated 2026-09-28; ~110 MB in the volume |
| ISTag | `CI0001-vPD0LySzC+gUSwny8IR89gAA`, recorded on every scanned `file_object` row |
| Endpoint | `icap://172.30.0.13:1344/avscan`, private network, no published host port |
| Memory | `stg-antivirus` 1,003 MiB of a 2 GiB limit |
| `probe.mjs` (go-live, and again from the API's network) | `scanner icap://172.30.0.13:1344/avscan: clean passed (204), EICAR blocked (Eicar-Test-Signature)`, exit 0, both times |
| API health | `antivirus: UP` (a real scan each probe, ~45–53 ms) |
| Real verdicts | Clean PDFs → `CLEAN` by `ICAP C-ICAP/0.5.10`; EICAR (plain, and inside a deflated zip) → `INFECTED`, threat `Eicar-Test-Signature`; filing refused `409 CONTENT_NOT_SCANNED`; `storage.file-quarantined` raised |
| First start without egress | The container's own `freshclam` failed (TLS; no route to the egress proxy); with an empty volume it did not start scanning. That is the documented refusal, so the scanner never ran without signatures. Signatures came from the update job (§2) | BLOCKED — ENVIRONMENT (egress); behaviour as documented |

## 6. Health and readiness

On the upgraded deployment, before traffic:

```json
{"status":"UP","dependencies":[{"name":"database:alpha","status":"UP"},{"name":"database:beta","status":"UP"},
 {"name":"cache","status":"UP"},{"name":"antivirus","status":"UP","latencyMs":48}]}
```

- `/api/health/ready` 200 and `/api/health/live` 200; the container `HEALTHCHECK` is `healthy`.
- `/api/docs` returns 404 (OpenAPI off). Web `/login` returns 200.
- **Queue consumers** are running: previews rendered, search indexed and in-app notifications
  delivered within seconds during the smoke tests. `edms_outbox_pending` returned to 0.
- **Object storage is not a readiness entry**, as documented. See §9 for the consequence.

**Production-like configuration** (running values; secrets shown only as "set"):
`NODE_ENV=production`, `AV_DRIVER=ICAP`, `AV_ICAP_URL=icap://172.30.0.13:1344/avscan`,
`AV_ICAP_MAX_BYTES=134217728`, `AV_SCAN_TIMEOUT_MS=120000`, `TRUST_PROXY=172.30.0.5,172.30.0.21`,
`WEB_TRUST_PROXY=172.30.0.5`, `STORAGE_DRIVER=S3`, `STORAGE_PUBLIC_URL=https://172.30.0.5`,
`MAIL_DRIVER=SMTP` + `TLS`, `OPENAPI_ENABLED=false`, `METRICS_DRIVER=PROMETHEUS` with a token,
`QUEUE_CONSUMERS_ENABLED=true`, `TENANT_CATALOGUE_PATH` (mounted). All four signing and sealing
secrets and the JWT secret are set (48 characters each), and `REDIS_URL` and the storage key pair
are set. `DATABASE_MIGRATION_URL` and `AV_ICAP_TEST_URL` are **absent** from the running API.

**Invalid configuration is still rejected: 24/24 PASS.** Each case below makes the `a560bb0` API
image exit 1 at boot, naming the variable. The last one is on the web image.

- **Antivirus:** `AV_DRIVER=NONE`; `AV_DRIVER=HOSTED`; missing `AV_ICAP_URL`; `icaps://`; no service
  path; credentials in the URL; `AV_ICAP_MAX_BYTES=100`; `AV_SCAN_TIMEOUT_MS=500`.
- **Proxy and explorer:** `TRUST_PROXY=true`; `OPENAPI_ENABLED=true`.
- **Secrets:** missing witness, checkpoint or MFA sealing secret; a 5-character JWT secret.
- **Storage and mail:** `STORAGE_DRIVER=NONE`; half a storage key pair; `MAIL_DRIVER=NONE`;
  `MAIL_SMTP_SECURITY=NONE`.
- **Observability and outbound:** metrics without a token; `SENTRY_DSN` set;
  `OUTBOUND_HTTP_ALLOW_INSECURE=true`.
- **Connections:** missing `REDIS_URL`; missing `DATABASE_URL`.
- **Web:** an invalid `WEB_TRUST_PROXY` stops the web server.

## 7. Smoke tests (runbook §16)

**Pre-traffic, tenant alpha, operator listener: 22/22 PASS.**
**Post-go-live, tenant beta, public listener: 22/22 PASS.**

| # | Step | alpha | beta |
| --- | --- | --- | --- |
| 1–3b | Sign in (200 + token); `/auth/me` (right user); sign out 204, then the refresh token → 401; no token → 401 | PASS | PASS |
| 4 | Create a library and a folder | PASS | PASS |
| 5 | Clean PDF: presign → PUT to the store → complete → `CLEAN` by the real scanner | PASS | PASS |
| 6 | File as a document → 201 | PASS | PASS |
| 7 | Download; SHA-256 of the downloaded bytes = original | PASS | PASS |
| 8 | Preview `READY`, and the stream URL handed to the browser **serves the rendition through the proxy** (200, 615 bytes) | PASS (after STG-3 configuration) | PASS |
| 9 | Check out, upload a changed clean file (`CLEAN`), check in → revision 2; history shows both | PASS | PASS |
| 10 | EICAR → `INFECTED`, `Eicar-Test-Signature` | PASS | PASS (fresh scan) |
| 11 | Upload audited with the threat; `storage.file-quarantined` exists | PASS | PASS |
| 12 | Filing EICAR → `409 CONTENT_NOT_SCANNED`; no document of that title | PASS | PASS |
| 13 | EICAR check-in as a revision → `409 CONTENT_NOT_SCANNED`; no revision references it; `ref_count` 0 | PASS | PASS |
| 14–16 | Submit; the reviewer sees the task and the in-app notification; approve → `APPROVED`, numbered `SOP-000n`, then `PUBLISHED` | PASS | PASS |
| 17 | Search for a title and content word → found | PASS | PASS |
| 18 | Audit, each fact attributed to the right user: creation and submission on the DOCUMENT; upload and download issuance on the FILE; approval on the TASK | PASS | PASS |
| 19 | The author opens the document → 200 | PASS | PASS |
| 20 | A user without access: absent from lists and search; open and download answered **identically** to a nonexistent id (404/`NOT_FOUND`) | PASS | PASS |
| 21 | Bulk upload: clean `APPLIED`, EICAR `BLOCKED CONTENT_NOT_SCANNED`, no EICAR document | PASS | PASS |

**Browser (real Chromium, TLS proxy → web → API): PASS.**

- The browser signed in (303 → `/`), and the documents UI rendered the library tree.
- The session cookies `edms_at` and `edms_rt` are `HttpOnly`, `Secure` and `SameSite=Lax`, and
  `document.cookie` is empty.
- An early attempt ended on "Sign-in is unavailable" and was traced to the per-address sign-in limit
  (10 per 5 minutes), which my harness had exhausted from the single workstation address. A clean
  rerun after the window passed.
- The web log's `failed to get redirect response … ERR_SSL_WRONG_VERSION_NUMBER` is Next.js's
  internal redirect prefetch behind a TLS-terminating proxy. It falls back to the 303, and sign-in
  works. It is benign log noise.

**Harness corrections (not product behaviour).** The first smoke run had 19/22. Each failure was
traced before anything was changed:

- **Step 9:** a never-published draft cannot be checked out (`409 INVALID_TRANSITION`, as the RC's
  P4 established). Revision control was moved to after publication.
- **Step 18:** download and approval are audited on the FILE and TASK subjects, not on the DOCUMENT
  timeline (see STG-4).
- **Step 20:** my fixture denied only `document:view`. ACL resolution is **per permission**
  (architecture 08 §3), and the RC's isolation fixture (P6) hides a folder by denying *every*
  document permission. With the RC fixture the step passes.

## 8. Security tests (RC criteria): 14/14 PASS

| Check | Result |
| --- | --- |
| Authentication: wrong password 401; tampered access token 401; alpha credentials on tenant beta 401 | PASS |
| **D-2 trusted proxy:** `session_family.ip_address` = `172.30.0.1` (the browser), not the proxy (`.5`) or the web server (`.21`) | PASS |
| Authorization: a reader cannot create documents, administer users or check out (403/403/403) | PASS |
| **Tenant isolation:** beta's administrator gets exactly the nonexistent-id answer for alpha's document (open 404/404, download 404/404); it is absent from beta's search, lists and timeline; an alpha token cannot be pointed at beta | PASS |
| **Signed-URL isolation:** own URL 200. The same URL re-pointed at the other tenant's prefix, a forged `X-Amz-Signature`, or a lengthened `X-Amz-Expires` → 403. TTL 300 s | PASS (after correcting my expiry value to one in the valid range: an out-of-range one is refused with 400) |
| Preview stream: a tampered token is refused | PASS |
| **RLS:** forced on 77/77 tenant tables, 77 policies; `edms_app` and `edms_owner` are neither superuser nor `BYPASSRLS`. As `edms_app`: no tenant set → 0 rows; the other tenant's id → 0 rows; own tenant → rows | PASS |
| **Audit immutability:** `UPDATE audit_event` refused *for the schema owner*: "audit_event is append-only" | PASS |
| API headers: CSP; HSTS `max-age=63072000; includeSubDomains; preload`; `nosniff`; `X-Frame-Options: DENY`. `X-Powered-By: Express` is present (known, non-blocking) | PASS |
| OpenAPI explorer not served; `/api/metrics` 401 without the token, 200 with it | PASS |
| **Scanner isolation:** no published host port; not routed by the proxy; reachable from the API | PASS |
| Scanner reachable **only** from the API network | BLOCKED — ENVIRONMENT: the staging network is flat, so the web container also reaches 1344 |
| TLS with the production certificate and DNS | BLOCKED — ENVIRONMENT (self-signed, IP-addressed) |

## 9. Failure and recovery tests (runbook §24)

| Test | Result | Evidence |
| --- | --- | --- |
| **Scanner stopped** → `/api/health` `antivirus: DEGRADED`, readiness still 200 | PASS | detected within seconds |
| A clean upload during the outage is recorded `FAILED` (`scanFailure: UNREACHABLE`) | **FAIL (STG-1)**, intermittently | 1st run: `FAILED` / `UNREACHABLE` as documented. 2nd run: **HTTP 500** after 22.5 s (the stopped container's address took 22 s to fail and the transaction had expired). No row, so nothing can be filed |
| Filing it is refused | PASS | `409 CONTENT_NOT_SCANNED`, or no file object at all in the 500 case |
| EICAR archive during the outage → `FAILED`, never `CLEAN`; filing refused | PASS | `FAILED` |
| No unsafe document downloadable; existing CLEAN documents still download | PASS | 0 revisions reference a non-`CLEAN` blob |
| Scanner restarted → `probe.mjs` exit 0; health `UP` | PASS | |
| Re-upload of the same bytes → real verdict: clean → `CLEAN` → filed; EICAR → `INFECTED`, filing refused | PASS | the D-3 re-scan of a `FAILED` blob |
| **Hung scanner** (`docker pause`) → upload `FAILED` / `TIMEOUT` | **FAIL (STG-1)** | **HTTP 500** after 120 s: `Transaction not found`. Health `DEGRADED` |
| **Redis stopped** → readiness 503 `cache: DOWN`; authenticated request 500; sign-in 429 (D-14, documented) | PASS | |
| Redis restored → readiness 200 without restarting the API; upload `CLEAN` and filing work | PASS | |
| **Object store stopped** → readiness stays 200 (not a readiness entry, as documented); uploads fail at the PUT; downloads fail at fetch; nothing becomes `CLEAN` | PASS | `EHOSTUNREACH` |
| Staging monitoring detects the object-store failure | BLOCKED — ENVIRONMENT | there is no monitoring. The API does not detect it (by design), so this must come from the operator's store monitoring |
| Store restored → upload `CLEAN` → filed; existing document downloads with its original bytes | PASS | |
| **One tenant database refusing connections** (non-destructive: `ALLOW_CONNECTIONS false`) → readiness 503 naming `database:beta`; `database:alpha` stays UP and alpha keeps working | PASS | the primary was not stopped |
| Database back → readiness 200; beta serves again without an API restart | PASS | |
| **Large clean upload, healthy scanner** | **FAIL (STG-1)** | see below |

**STG-1 reproduction (healthy scanner, real ClamAV, tenant beta, one client, a PDF header plus
random bytes):**

```text
 5 MiB: CLEAN —  1,032 ms          30 MiB: CLEAN —  4,703 ms
20 MiB: CLEAN —  3,381 ms          40 MiB: HTTP 500 — 5,745 ms
50 MiB: HTTP 500 — 7,650 ms / 7,374 ms / 7,073 ms   (3 of 3)
API log each time: "Transaction API error: Transaction already closed: A query cannot be executed on an
expired transaction. The timeout for this transaction was 5000 ms, however 5115–6971 ms passed"
```

A failed completion leaves no `file_object` row, so the failure is closed. It does leave the upload
session `OPEN` and an unreferenced blob in the bucket (4 of them after these runs). A retry with
the same bytes fails the same way. A 100 MiB attempt was excluded: it needs a multipart upload,
which the harness does not implement.

## 10. Backup and restore (runbook §23)

| Step | Result |
| --- | --- |
| `dr-rehearsal.mjs --prepare-destination` **as documented** (dump source = tenant owner URL) | **FAIL (STG-2):** `pg_dump: error: query failed: ERROR: query would be affected by row-level security policy` |
| The same, with the dump source as the cluster superuser, into an **empty** DR cluster | PASS. **0 differences**; restore 26.9 s (total 31.5 s) |
| RLS posture of the restored cluster | PASS. Both tenants: RLS enabled and forced 77/77, 77 policies, both roles non-superuser and non-`BYPASSRLS`, audit not updatable |
| Storage: `backup` → `verify` (`intact`) → `restore` into an empty bucket | PASS. **72/72 objects**, 256.9 MB, 0 differences |
| Restored deployment: API on the restored databases, restored bucket, **empty Redis**, real scanner | PASS. Readiness 200, `antivirus: UP` |
| 1 Sign in with existing credentials, both tenants | PASS |
| 2 Read existing documents | PASS |
| 3 Download existing documents: SHA-256 equals the original, served from the **restored** bucket | PASS (after correcting my comparison: `/content` serves the current published revision, not the later draft) |
| 4–5 Upload a clean file → real ClamAV → `CLEAN` | PASS |
| 6 Create a document, review it, and number it after every restored number | PASS: `SOP-0004`, then `SOP-0005`, after `SOP-0001…0003`; no reuse |
| 7 EICAR (fresh bytes) → `INFECTED`; filing refused | PASS |
| Search over restored data | PASS (after correcting my query to the full title token) |
| Redis rebuild: "Queue state rebuilt from durable state after the broker lost it"; timers re-armed (0) = armable `SCHEDULED` timers (0) | PASS |
| Cron schedules on all six lanes (`audit.export` 1, `audit.stream` 1, `identity.delegation` 1, `notifications.deliver` 5, `retention.run` 4, `webhooks.deliver` 1) | PASS |
| Audit chain on the restored deployment (`dr-verify-chain.mjs`) | PASS: "The audit chain verified", alpha 317 events, beta 198, both checkpointed. The runbook says to read `intact`; the log has no such field (STG-4) |
| Point-in-time recovery through WAL; bucket replication failover | BLOCKED — ENVIRONMENT (not rehearsable from the repository, runbook §23). WAL archiving itself was running |

The DR tool connects to the restored roles without passwords (`destUrl` blanks the password), so
the rehearsal destination was run with trust authentication (STG-6).

## 11. Load baseline — a staging observation, not a production capacity certification

`node infra/loadtest/run.mjs` through the TLS proxy, 07:18:12–07:24:15 (6 min), one access token.

| Scenario | Concurrency × duration | Admitted | Refused | p50 / p95 / p99 of admitted |
| --- | --- | ---: | ---: | --- |
| Folder listing | 50 × 60 s | 0 | 32,082 (**404**: the route `/api/v1/folders/:id/documents` does not exist) | — |
| Document detail | 50 × 60 s | 323 | 26,449 (429) | 440 / 580 / 676 ms |
| Search | 100 × 120 s | 180 | 61,521 (429) | 723 / 1,372 / 1,436 ms |
| Presign a download | 25 × 60 s | 0 | 31,914 (**404**: `/api/v1/files/:id/download-url` does not exist) | — |
| Dashboard | 100 × 60 s | 357 | 28,146 (429) | 2,266 / 2,867 / 2,883 ms |

**Error rate:** 99.5% of requests were refused. Every refusal is explained by the harness, not by a
fault (STG-7):

- **Route drift:** two scenarios target routes that do not exist.
- **Single identity:** the harness drives one identity, so the API's per-identity limits (search
  60/min, default 300/min) refuse almost everything.

No 5xx was served during the window.

**Resources** (peaks from 5-second samples):

- **API:** 179% CPU (of 4 cores), 253 MiB of 1.5 GiB.
- **PostgreSQL:** 62% CPU; 18 connections, 6 active at peak; at most 5 briefly waiting on a lock.
- **Redis:** 9% CPU, 4 MiB used, ~620 ops/s, 0 rejected connections.
- **Other containers:** scanner idle at 998 MiB (no uploads in the scenarios); proxy 194% CPU; web
  and MinIO idle.

**Classification: FAIL (tooling, STG-7).** The repository's harness cannot produce a meaningful
baseline. The latencies above were measured while the API was rejecting ~30,000 requests a minute,
so they are **not** capacity figures and set no production expectation.

## 12. Monitoring

| Required monitor | Signal verified to exist in staging | Alert reaching a person |
| --- | --- | --- |
| API | `/api/health/ready` 200/503 (503 observed for Redis and database loss); `/api/health/live`; container `HEALTHCHECK` healthy | BLOCKED — ENVIRONMENT |
| Web | `/login` 200 (the image has no `HEALTHCHECK`) | BLOCKED — ENVIRONMENT |
| PostgreSQL | `database:<slug>` entries (DOWN observed per tenant) | BLOCKED — ENVIRONMENT |
| Redis | `cache` entry (DOWN observed) | BLOCKED — ENVIRONMENT |
| Workers and queues | `edms_queue_depth{queue,state}`, `edms_outbox_pending`, `edms_job_duration_milliseconds` at `/api/metrics` | BLOCKED — ENVIRONMENT |
| Object storage | **None from the API** (by design; observed) | BLOCKED — ENVIRONMENT; the operator must supply it |
| ICAP / c-icap / ClamAV | `probe.mjs` (exit 1 when down, observed); container state | BLOCKED — ENVIRONMENT |
| Signature freshness | `freshclam` output in the container log; ISTag on rows | BLOCKED — ENVIRONMENT |
| **Antivirus DEGRADED** | `/api/health` `antivirus: DEGRADED` (observed within seconds of stopping the scanner) | **BLOCKED — ENVIRONMENT: no alert channel, so it cannot be shown to reach a responsible person** |
| Backups | No backup system (only manual dumps) | BLOCKED — ENVIRONMENT |

No monitoring evidence was invented. The signals exist and behave as documented; the alerting path
does not exist in this environment.

## 13. Classification matrix

| Area | PASS | FAIL | BLOCKED — ENVIRONMENT | NOT APPLICABLE |
| --- | ---: | ---: | ---: | ---: |
| Release identity (commit, images, migration state) | 3 | 0 | 0 | 1 (registry digests) |
| Deployment procedure (§21 steps) | 13 | 1 (backup step as written, STG-2) | 1 (monitoring) | 2 (change window, staging gate) |
| Migration and schema | 6 | 0 | 0 | 0 |
| Idempotency (D-20) after deployment | 7 | 0 | 0 | 0 |
| Scanner go-live | 5 | 0 | 1 (first-start egress) | 0 |
| Configuration: running values + 24 invalid refused | 25 | 0 | 0 | 0 |
| Health and readiness | 5 | 0 | 0 | 0 |
| Smoke: alpha 22 + beta 22 + browser 1 | 45 | 0 | 0 | 0 |
| Security | 12 | 0 | 2 (network segmentation, production TLS) | 0 |
| Failure and recovery | 12 | 3 (STG-1: unreachable scanner 500, hung scanner 500, large clean upload 500) | 1 (store-failure monitoring) | 0 |
| Backup and restore / DR | 13 | 1 (DR command as written, STG-2) | 1 (PITR, replication failover) | 0 |
| Load baseline | 0 | 1 (tooling, STG-7) | 0 | 0 |
| Monitoring (10 monitors) | 0 | 0 | 10 | 0 |
| Mail delivery | 0 | 0 | 1 (no relay) | 0 |

## 14. Findings, and remaining production prerequisites

### VALIDATED (tested successfully in staging, on `a560bb0`)

- **Upgrade and migration:** the upgrade from the previous release with a real drain and a verified
  backup; `migrate-tenants.mjs` from the release checkout across both tenant databases; idempotent
  re-run; RLS forced 77/77; D-20 behaviour after the real migration, including the documented
  upgrade-window exposure.
- **Scanner:** the real ClamAV/c-icap scanner deployed from `infra/antivirus/` and probed from the
  private network and from the API's network; clean → `CLEAN` → filed → downloaded with identical
  bytes; EICAR (plain and archived) → `INFECTED` → quarantined → refused for filing, revision,
  download and preview.
- **Smoke:** the full §16 smoke test in two tenants, one before and one after traffic, plus a real
  browser through the TLS proxy.
- **Configuration:** the production configuration and all 24 invalid-configuration refusals.
- **Security:** tenant, permission and signed-URL isolation; RLS; audit immutability; D-2.
- **Outages and recovery:** scanner outage (fail-closed) and recovery by re-upload; Redis outage and
  recovery; object-store outage and recovery; single-tenant database outage and recovery.
- **DR:** zero-difference database restore, 72/72 object restore, and a restored deployment that
  signs in, reads, downloads, scans for real, numbers continuously, rebuilds Redis state, re-declares
  six cron lanes and verifies the audit chain.

### RELEASE BLOCKERS

**Application (validated code, reproducible). STOP-level:**

- **STG-1: the malware scan runs inside a 5-second database transaction.**
  - **Where:** `StorageService.completeUploadSession`
    (`apps/api/src/modules/storage/application/storage.service.ts`) runs the whole completion inside
    `writer.write(...)`. That covers the store copy and delete, reading the object back, and the
    ICAP scan. `TenantDatabase` opens it as `client.$transaction(async (tx) => …)`
    (`apps/api/src/core/prisma/tenant-database.ts:76`) with no `timeout`, so Prisma's default
    **5,000 ms** applies. `AV_SCAN_TIMEOUT_MS` (default 120,000) can never be reached.
  - **Effect:** any completion whose read and scan exceed 5 s answers **500 and records nothing**:
    - clean uploads of roughly **≥ 40 MiB** on this hardware, deterministically (the documented
      limit is 128 MiB);
    - an unreachable scanner host (22 s to fail) and a hung scanner (120 s).

    Both scanner cases return 500 where the runbook and RC promise a recorded `FAILED` with
    `scanFailure`. Fail-closed is preserved: nothing unscanned becomes `CLEAN` or fileable.
  - **Why the RC did not see it:** the RC's large-file scan test is 9 MiB at the adapter level,
    outside the transaction (`icap-antivirus.integration.spec.ts`). Its outage tests failed
    immediately (connection refused), well inside 5 s.
  - **Smallest fix, proposed and not implemented:** read, hash and scan the stored object **before**
    opening the write transaction. Open the transaction only to re-check deduplication and insert
    the row with the verdict, keeping the documented order "read, compare, scan, then write a row".
    The alternative, an explicit per-call `timeout` of at least `AV_SCAN_TIMEOUT_MS` plus the read
    time, would hold a pooled connection for up to two minutes per upload, so it is not preferred.
  - **Regression tests:**
    - an integration test with a scanner that answers after more than 5 s, expecting a recorded
      verdict rather than 500;
    - a hung-scanner test with a short `AV_SCAN_TIMEOUT_MS` above 5 s, expecting `FAILED`/`TIMEOUT`;
    - a large clean upload test through the service.

**Deployment procedure (documentation; the runbook fails if followed literally):**

- **STG-2: backups must be taken by a role that bypasses RLS.** In a production-shaped cluster the
  tenant owner (`edms_owner`, created non-superuser by `01-roles.sql`) cannot `pg_dump` through
  forced RLS.
  - **Affected:** runbook §19.2 and §23. `dr-rehearsal.mjs` documents "the first tenant's database,
    as its owner".
  - **Correction:** dump with the cluster superuser or a dedicated `BYPASSRLS` backup role. State
    that the backup product's role needs this.
- **STG-3: `STORAGE_PUBLIC_URL` is required for previews with every storage driver.**
  - **Affected:** runbook §5.1 and `.env.example` describe it as "LOCAL only". Without it the preview
    stream URL handed to browsers is `http://localhost:3001/...`, so previews are broken for every
    user (observed).
  - **Correction:** document it as required in production and set it to the public API origin. Also
    consider a production boot refusal when it is unset (a product decision).

### Runbook corrections (documentation, non-blocking)

- **STG-4:** §16 step 18. Upload and download issuance are audited on the FILE subject
  (`FILE_UPLOADED`, `FILE_DOWNLOAD_ISSUED`) and approval on the TASK subject, not on the document
  timeline. §23 step 4 says "read `intact`", but the log says "The audit chain verified" with
  `eventsVerified` and `checkpointed`.
- **STG-5:** §5.1 says `DATABASE_URL` is required "or via the catalogue". The schema requires it
  **even with a catalogue**, and the API refuses to start, naming it (observed). CI sets it to the
  first tenant's URL.
- **STG-6:** §23. `dr-rehearsal.mjs` connects to the destination roles without passwords, so the
  rehearsal destination needs trust (or password-less) authentication for `edms_owner`/`edms_app`.
- **STG-7:** §14 and §4. `infra/loadtest/scenarios.mjs` targets two routes that do not exist, and it
  drives one identity into the per-identity rate limits. The harness needs correcting before
  "the first run is the baseline" can hold.
- **Notes:**
  - A mounted catalogue secret must be readable by the image's `node` user (uid 1000); this
    was observed as `EACCES` with a root-only file.
  - `probe.mjs` is not in the API image; run it from a checkout on the API network.

### ENVIRONMENT BLOCKERS (not testable here; the operator must provide)

1. **Monitoring and alerting**, including an `antivirus: DEGRADED` page that reaches a responsible
   person, independent object-store monitoring, signature-freshness alerting and backup-failure
   alerting.
2. **A real TLS certificate and DNS** for the web and API origins.
3. **Network segmentation:** ICAP port 1344 reachable from the API only.
4. **An SMTP relay** (TLS/STARTTLS) for notification e-mail.
5. **Bucket CORS** on a provider that enforces it (MinIO does not), proven by a browser upload.
6. **PITR through WAL**, and **bucket replication failover**, rehearsed with the provider's tooling.
7. **Scanner egress** to `database.clamav.net` or a mirror, and **scheduled signature updates**.
8. **A multi-identity load run** once STG-7 is corrected.

### PRODUCTION PREREQUISITES (still to be supplied or configured)

- **Operator-supplied values** marked **[PRODUCTION-SPECIFIC]** in the runbook: hostnames,
  certificates, proxy ranges for `TRUST_PROXY` and `WEB_TRUST_PROXY`, the cluster, bucket and
  credentials, the secret store, memory limits, the registry, the change window and approver, and a
  named backup confirmer.
- **`STORAGE_PUBLIC_URL`** set to the public API origin (STG-3).
- **A backup role** able to read through RLS (STG-2).
- **Everything in the environment-blocker list above.**
- **A new release candidate** carrying the STG-1 fix, with CI green, and the affected staging
  sections repeated: §5 scanner, §7 smoke, §9 failure and recovery, the large-upload test, and §11
  load.

## 15. Go / No-Go

The runbook §25 NO-GO conditions, evaluated exactly:

| NO-GO condition | Staging |
| --- | --- |
| Scanner not `UP` | Not triggered: `UP` |
| `probe.mjs` fails | Not triggered: exit 0 |
| Migration failed | Not triggered: both tenants, re-run clean |
| Backup not verified or not confirmed | Not triggered in staging: verified and confirmed by the staging operator. It needed the STG-2 role correction. A **named human** confirmer is a production requirement |
| Readiness not 200, or anything DOWN | Not triggered |
| Consumers not running or queues not draining | Not triggered |
| Redis unavailable | Not triggered |
| Required configuration missing | Not triggered |
| Tenant or permission isolation fails | Not triggered |
| **A clean document cannot be scanned, filed or downloaded intact** | **TRIGGERED: STG-1** (clean files ≥ ~40 MiB → 500) |
| EICAR can be filed, downloaded or previewed, or is recorded as anything but INFECTED | Not triggered |
| **Monitoring not active, or DEGRADED does not reach a person** | **TRIGGERED: environment** (no monitoring in staging) |
| Traffic not drained across the migration | Not triggered: drained, evidenced by the proxy log |

No NO-GO condition was overridden. Evidence was captured under the staging session's working
directory and is not committed, because parts of it contain staging credentials. The outputs above
are transcribed from it.

**STAGING NO-GO: STG-1. `StorageService.completeUploadSession` runs the store read and the malware
scan inside a PostgreSQL transaction with Prisma's default 5,000 ms timeout. Clean uploads of roughly
40 MiB and above therefore fail with HTTP 500 and cannot be scanned or filed, reproducibly on the
validated RC `a560bb0`. In addition, the monitoring and alerting prerequisite (antivirus DEGRADED
reaching a person) is unmet in this staging environment.**
