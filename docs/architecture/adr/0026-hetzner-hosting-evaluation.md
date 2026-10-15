# ADR-0026 — Evaluate hosting Munaxa Docs on a Hetzner Cloud server with Docker Compose

- **Status:** **Proposed** — not accepted. Nothing in this record has been purchased, provisioned or
  deployed. One storage provider, Cloudflare R2, has passed the compatibility test for the
  behaviours that test covers (§10, gate P-1). That test is not production readiness, and gate P-1
  is not complete. Phase A's local upload and download checks passed after five application fixes
  (§10); that is local evidence only. Document downloads are now verified before any byte is sent
  (§10, local evidence only). Phase B (a real browser and the download resource limits, local MinIO
  only) has run: 82 checks passed and 4 genuine product findings were found (§10). Those four
  are fixed on a separate branch, awaiting review; Phase B on that branch passes 88 of 88, local
  MinIO only (§10).
- **Date:** 2026-10-13
- **Phase:** Hosting migration Phase 2 (foundation)
- **Builds on:** [ADR-0015](./0015-database-per-tenant.md), [ADR-0021](./0021-multi-tenant-hosted-launch.md),
  [ADR-0024](./0024-minimum-cost-first-customer-launch.md). If accepted, it would **supersede**
  [ADR-0022](./0022-hosted-platform-aws-ecs-fargate.md) (platform),
  [ADR-0023](./0023-initial-aws-region-eu-central-1.md) (region) and
  [ADR-0025](./0025-production-email-amazon-ses-smtp.md) (email), and replace ADR-0024's AWS
  topology while keeping every requirement ADR-0024 keeps. Until then those records stand.
- **Template:** [`infra/hetzner/`](../../../infra/hetzner/README.md)

Every statement below is one of: **[verified]** — checked in this repository or by the test run in
§10; **[estimate]** or **[assumption]** — stated, not checked; **[verify]** — a provider fact from
general knowledge that must be checked against the provider's current documentation and prices
before any decision relies on it.

## 1. Context

- **AWS access remains restricted**, so the AWS production path (ADR-0022/0024, Terraform under
  `infra/terraform/`, PR #131's service root, PR #134's CI/CD design) cannot be completed or operated.
- **The application is not tied to AWS.** [verified] It has no AWS SDK dependency. Storage is one
  S3-compatible adapter for AWS, MinIO and Cloudflare R2
  (`apps/api/src/infrastructure/storage/s3.adapter.ts`); the only AWS-specific code is the optional
  `STORAGE_CREDENTIALS_SOURCE=ECS_TASK_ROLE`, and the default is a plain key pair. Email is SMTP or
  Resend. The database is plain PostgreSQL 16 with no extensions.
- **AWS production holds no application data**, per the repository's own evidence
  (`docs/reports/production-data-apply-evidence.md`: no application database; the document bucket
  is empty). [verified from records; not re-checked in AWS, which this work must not access]
- **The goal is one maintainable, low-cost standard** that Munaxa Docs adopts first and Munaxa School
  and Munaxa Work can adopt later, each fully separate (§13).

## 2. Decision (proposed)

> **Evaluate** running each environment of Munaxa Docs as **one Docker Compose stack on one Hetzner
> Cloud server**, using the published `api`, `web` and `antivirus` images unchanged, PostgreSQL 16 and
> Redis 7 on the same server, an **external S3-compatible object store** and an **external mail
> provider**, behind **Cloudflare** for DNS and TLS. Adoption is gated: the provider gate P-1 (§10)
> and the owner decisions in §11 come first, and production is not created until TEST has passed the
> go-live checks.

It trades the managed database, managed backups and multi-zone options of AWS for a much lower and
more predictable cost, and moves operational responsibility to us (§9).

## 3. Server, network, entry point and TLS

**One server per product per environment** [proposal]: x86-64 (the images are built for `linux/amd64`
only; `publish-images.yml` sets no platform [verified]), in a German Hetzner location (Falkenstein or
Nuremberg), close to the previously chosen Frankfurt region [verify current locations].

**Containers and networks** (`infra/hetzner/compose.yaml`) [verified by the §10 test run]:

| Service | Image | Port | Networks |
| --- | --- | --- | --- |
| `proxy` | Caddy 2.10 | **8080, the only published port**, on `127.0.0.1` by default | `edge` |
| `web` | `munaxa-docs-web` (`node server.mjs`) | 3000 | `edge` |
| `api` | `munaxa-docs-api` — HTTP **and** every queue consumer and schedule | 3001 | `edge`, `data`, `scan` |
| `migrate` (one-off) | `munaxa-docs-api` running `scripts/migrate-tenants.mjs` | — | `data` only: downloads nothing (§8, F-1) |
| `antivirus` | `munaxa-docs-antivirus` (c-icap + ClamAV) | 1344 | `scan`, `scanner-egress` |
| `postgres` | PostgreSQL 16 | 5432 | `data` |
| `redis` | Redis 7.4 | 6379 | `data` |

- `data` and `scan` are **internal** Docker networks: no internet egress and nothing published.
  ICAP is plaintext and `icaps://` is refused by the API, so the scanner is reachable only by the API
  (go-live-runbook.md §9.8).
- The `worker` image is **not** deployed: it starts, logs that consumers run in the API process, and
  does nothing (`apps/worker/src/main.ts`), and it is not published [verified].

**Routing** — ADR-0024 §2.3's rule, implemented in `infra/hetzner/Caddyfile` [verified, §10]:

| Path | Goes to | Why |
| --- | --- | --- |
| `/api/v1/preview/stream*` | API | Browsers load previews from `STORAGE_PUBLIC_URL` + this path |
| any other `/api/*` | **404 at the proxy** | `/api/health` and `/api/health/ready` name every tenant; `/api/metrics` is operator-only |
| everything else | web | The web server calls the API server-side |

**TLS and DNS — the decision is open (§11, D-2).** The proxy does not terminate TLS, and its port
stays on `127.0.0.1` until one of these is chosen:

| Option | How | Trade-off |
| --- | --- | --- |
| **A. Cloudflare Tunnel** (recommended) | `cloudflared` on the server connects outward to Cloudflare; **no inbound port** is open at all | Nothing to scan or attack on the server's public IP; one more component; free [verify] |
| B. Cloudflare proxy + Origin CA certificate | Caddy serves 443 with a Cloudflare origin certificate ("Full (strict)"); the Hetzner firewall admits only Cloudflare's published IP ranges | No extra component; the firewall's IP list must be kept current |

Either way, the **client-address chain** must then be configured and tested: Caddy must trust exactly
the hop in front of it and take the browser's address from `CF-Connecting-IP`, or every browser
shares one sign-in rate-limit allowance and audit records the wrong address (gap G-5). Behind Caddy
the chain is fixed and tested: `WEB_TRUST_PROXY` names the proxy and `TRUST_PROXY` names the proxy
and the web server, by fixed addresses (`true`/`*` are refused by the API).

**Firewall** [proposal]: a Hetzner Cloud Firewall with no inbound rule except SSH from named
administrator addresses (option A), or SSH plus 443 from Cloudflare ranges (option B). SSH by key
only, no root login.

## 4. Service hardening

[verified as configured; behaviour under attack not tested]

- `api`, `web`, `proxy`: read-only root filesystem with a `/tmp` tmpfs (the API image documents this
  as supported). `api`, `web`, `proxy`, `antivirus`, `redis`: all Linux capabilities dropped and
  `no-new-privileges`, except that the proxy keeps `NET_BIND_SERVICE`: the official Caddy binary
  carries that file capability and the kernel will not execute it otherwise (found by the test run).
  PostgreSQL keeps its defaults (its entrypoint needs them).
- The two tenant catalogues are bind-mounted files read by the images' unprivileged `node` user
  (uid 1000), so they are owned by uid 1000 with mode `0400`; every other secret file is root-owned
  `0600` and read by Compose on the host (found by the test run: root-only catalogues gave `EACCES`).
- Memory limits: API 1.5 GB, web 768 MB, scanner 2.5 GB (clamd holds about 1 GB and roughly twice
  that during a signature reload — go-live-runbook.md §9.7), PostgreSQL 1.5 GB, Redis 384 MB, proxy
  128 MB.
- Health checks: API `/api/health/live` (image, touches no dependency); web `/login`; scanner a real
  scan through c-icap; PostgreSQL `pg_isready`; Redis authenticated `PING`; proxy a loopback-only
  listener. Restart policy `unless-stopped` everywhere.
- The API waits for PostgreSQL and Redis to be **healthy** but only for the scanner to be
  **started**: uploads fail closed while the scanner is down and reads continue
  (go-live-runbook.md §9.5), so waiting would turn a scanner outage into a full outage.
- Logs: `json-file`, 10 MB × 5 files per container, so no container can fill the disk.
- **Production validation stays on.** `NODE_ENV=production` is fixed in `compose.yaml`, not left to
  the env file, and nothing in the template relaxes a production rule (§10 shows eight unsafe settings
  refused at boot).

## 5. PostgreSQL and Redis

**PostgreSQL 16 in a container** with a named volume [proposal]. Hetzner Cloud offers no managed
PostgreSQL [verify], so this deployment owns the database: version upgrades, tuning, backups and
restores. Inside the server the connection is on an internal network without TLS
[assumption: acceptable because the traffic never leaves one host; ADR-0024 required `sslmode=require`
only because RDS crossed a network].

Roles follow `infra/sql/` and go-live-runbook.md §6 exactly, through `ops/db-admin.sh` [verified, §10]:
`01-roles.sql` verbatim; passwords for `edms_owner` and `edms_app` from the operator's secret file;
`edms_backup` with `BYPASSRLS` and `pg_read_all_data` (STG-2); one database per tenant owned by
`edms_owner`. The local-stack script `02-app-credentials.sh` is not used, as the runbook requires.

**Redis 7.4** beside the API: password, `appendonly yes`, `maxmemory-policy noeviction`, on the
internal network only. Unlike ADR-0024's loopback Redis it persists to a volume, so an API restart
does not empty the queues. The password is written into a config file inside the container rather
than passed as an argument, so it never appears in a process list.

## 6. Object storage

The CLOUD profile (more than one customer) **refuses local-disk storage** (`configuration.ts`
[verified]), and browsers upload **directly to the store** over a presigned URL
(`apps/web/src/features/documents/upload.ts` [verified]). The store must therefore be an S3-compatible
service reachable over HTTPS by both the API and the browser.

**The hard requirement** [verified in code]: the presigned PUT signs `x-amz-checksum-sha256`, the
store must reject bytes that do not match it, and must return the checksum on `HEAD` when asked with
`x-amz-checksum-mode: ENABLED`. If it does not, **every upload is refused** ("Storage could not confirm
the file's digest", `apps/api/src/modules/storage/application/storage.service.ts`).

| Candidate | Status |
| --- | --- |
| MinIO (test stack only) | **Verified in §10** — accepted, refused tampered bytes, returned the digest |
| AWS S3 | Verified earlier on Fargate (ADR-0024 evidence); not available |
| **Hetzner Object Storage** | **Not tested.** S3-compatible [verify]; checksum behaviour unknown |
| **Cloudflare R2** | **Compatible with the tested behaviours** (§10, 2026-10-14; test bucket in eastern US, ENAM): the signed checksum is enforced, the digest is returned on HEAD, tampered bytes are refused, and CORS works. It needed one application fix (`3216654`). **Not production-ready:** no S3 object versioning, and multipart writes, browser downloads and backup/restore are untested |
| Self-hosted MinIO in production | Not recommended: no maintained images any more (`ci.yml` builds it from source), and it would put the documents on the same machine as everything else |

The provider is chosen only after gate **P-1** (§10). Whichever is chosen, the bucket needs
versioning (R2 does not provide S3 object versioning, so choosing R2 would need an alternative to be
designed and tested — §10; this record does not change the requirement), CORS limited to the web
origin with `PUT`/`GET` and the `content-type` and `x-amz-checksum-sha256` headers (as the AWS bucket had), a key pair scoped to that bucket, and a
nightly copy to a **different** provider (§9).

## 7. Email

SES needs AWS, so ADR-0025's choice cannot be used now. Both alternatives are already built and need
no code change [verified]: `MAIL_DRIVER=RESEND` (HTTPS API) or `MAIL_DRIVER=SMTP` on **587 with
STARTTLS**. Hetzner blocks outbound ports 25 and 465 on new cloud servers by default [verify], which
rules out `MAIL_SMTP_SECURITY=TLS` on 465 unless unblocked. SPF, DKIM and DMARC for the sending domain
are set in Cloudflare DNS. Delivery has **not** been tested: the test stack names an SMTP relay under
the reserved `.invalid` domain, which satisfies production validation honestly and sends nothing.

## 8. Deployment, migrations, provisioning and rollback

- **Images:** the existing `publish-images.yml` (tag-triggered, digest-pinned, revision-label checked,
  scanner probed with EICAR, pulled back with the production pull identity) is reused unchanged. A
  deployment names images **by digest** only (`deploy.env`).
- **Migrations:** `scripts/migrate-tenants.mjs`, unmodified, run as the `migrate` service from the
  **release's own API image** against the operator catalogue (owner credentials), which the running
  API never holds (ADR-0021 §3). The runner calls `pnpm exec prisma …`, and the image has no `pnpm`
  but does contain the Prisma 6.19.3 CLI [verified]. `infra/hetzner/ops/pnpm` is a short stand-in
  that supports only `pnpm exec <bin>` and refuses anything else. **Discrepancy, recorded rather
  than hidden:** ADR-0024 ran migrations from an engineer's workstation; running them from the image
  is new to this template. It changes no application behaviour.
- **Finding F-1 — the image's Prisma schema engine was for the wrong OpenSSL. Fixed.** [verified]
  - *Cause.* `@prisma/engines` installs its schema engine — the binary `migrate deploy` and
    `db execute` run — for the platform it detects during `pnpm install`, by `openssl version` and
    then `ldconfig -p`. The Dockerfile's build stage (`node:22-bookworm-slim`) had no OpenSSL at all,
    so Prisma fell back to `debian-openssl-1.1.x` (seven "Prisma failed to detect the libssl/openssl
    version" warnings in the build log), while the runtime stage has OpenSSL 3 only. The query engine
    escaped because `binaryTargets` in `prisma/schema.prisma` names `debian-openssl-3.0.x`; nothing
    names it for the schema engine. Run from the image, a migration therefore downloaded the right
    engine from `binaries.prisma.sh` every time.
  - *Fix.* The build stage installs Debian's `openssl` (the same libssl3 as the runtime stage)
    before `pnpm install`, so Prisma detects the real platform. No Prisma or dependency upgrade, no
    build-time secret, no change to application code. The image now carries only OpenSSL 3 engines,
    including `schema-engine-debian-openssl-3.0.x`, and is about 76 MB smaller.
  - *Evidence.* The detection warning count went from 7 to 0. Migrations from the fixed image ran
    with no network egress across two tenant databases, then twice more with nothing pending. The
    pre-fix image, in the same offline setup, failed with `EAI_AGAIN binaries.prisma.sh`. The stack
    test now checks both engines before migrating, and `migrate` has no egress network.
- **Provisioning:** the documented D-1 procedure (go-live-runbook.md §1a): the `provision` service runs
  `provision.js` in single-tenant form for one tenant with a temporary `provision.env` that is deleted
  afterwards.
- **Release (proposed, not built):** GitHub Actions → the same digests to TEST automatically → approval
  in the existing `production` environment → a deploy job that takes a pre-deployment backup, runs
  `migrate`, then `docker compose up -d` with the new digests, and checks `/api/health/ready` from inside
  the server and `/login` through the public URL. The flow is the one PR #134 designed; its AWS parts
  are not used.
- **Rollback:** redeploy the previous release's digests. **Migrations are forward-only**; a migrated
  database that must be abandoned is restored from the pre-deployment backup into a new database,
  never over the live one (go-live-runbook.md §20).
- **Downtime:** a deploy restarts the API, so a short interruption is expected; the queue-drain step
  before a planned restart (ADR-0024 §2.6) still applies [assumption: acceptable for 1–2 tenants].

## 9. Operations: who does what, backups, monitoring

**What moves to us** compared with AWS managed services:

| Responsibility | On AWS (planned) | Here |
| --- | --- | --- |
| Operating-system security updates | AWS (Fargate) | Us: unattended security upgrades, monthly reboot window |
| PostgreSQL patching, backups, PITR | AWS RDS | Us (below) |
| Container base-image updates | Us | Us: monthly rebuilds of the images, digest bumps for third-party images |
| TLS certificates | ACM | Cloudflare |
| Server failure | ECS replaces the task | Us: rebuild the server from the template and restore (RTO hours, not minutes) |

**Backups that must exist before the first customer** [proposal]:

1. **PostgreSQL** — nightly logical dump of every tenant database as `edms_backup` plus the role
   definitions, **and** continuous WAL archiving (pgBackRest or WAL-G) for point-in-time recovery,
   encrypted, to storage **outside Hetzner** (the repository's targets: RPO 5 minutes, RTO 2 hours —
   `docs/operations/backup-and-restore.md` §1).
2. **Documents** (including audit checkpoints) — bucket versioning plus a nightly copy to a second
   provider; `scripts/storage-backup.mjs` already records a SHA-256 manifest to verify a restore.
3. **Secrets and configuration** — `DOCS_CONFIG_DIR` in a password manager plus an encrypted offsite
   copy, **keeping every old version** of `SIGNATURE_WITNESS_SECRET`, `AUDIT_CHECKPOINT_SECRET` and
   `MFA_TOTP_SEALING_KEY`: losing one makes past signatures, audit checkpoints or authenticators
   permanently unverifiable.
4. **Release digests** retained in GHCR (they are the rollback targets).
5. Hetzner's own server backups/snapshots are a convenience, **not** a backup: same provider, same
   account.

A restore counts only when `scripts/dr-rehearsal.mjs` passes and the audit hash chain verifies
(backup-and-restore.md §3), on TEST before go-live and quarterly after.

**Monitoring** [proposal, free tiers]: an external uptime check on `/login`; a dead-man's-switch ping
from every backup job; disk and memory alerts; optionally `METRICS_DRIVER=PROMETHEUS` scraped
privately. None of this is built yet.

## 10. What is verified, the gates, and failure scenarios

**Verified on 2026-10-13 by `infra/hetzner/testing/run-stack-test.sh`** in a disposable local
Docker stack, with the `api`, `web` and `antivirus` images built from `main` at `f838433` and ClamAV's
official signatures. Final clean run: **all checks passed**.

| Check | Result |
| --- | --- |
| Compose configuration valid (production file alone, and with the test overlay) | Pass |
| `db-admin bootstrap` twice (roles, credentials, backup role; idempotent) | Pass |
| Two tenant databases created; `migrate` across both; second run a no-op ("No pending migrations") | Pass |
| First administrator provisioned by the D-1 procedure | Pass |
| Every service healthy; `/api/health/ready` UP for both tenant databases, Redis and the scanner | Pass |
| Proxy: `/login` served; `/api/health`, `/api/health/ready`, `/api/health/live`, `/api/metrics` and other `/api/*` refused by the proxy itself; `/api/v1/preview/stream*` answered by the API | Pass |
| Sign-in with the provisioned administrator | Pass |
| Upload: target signs `x-amz-checksum-sha256`; PUT accepted; completion confirms the digest; scanned CLEAN | Pass (MinIO) |
| Same-size tampered bytes refused by the store (HTTP 400) | Pass (MinIO) |
| EICAR test file scanned INFECTED | Pass |
| Production validation refuses `AV_DRIVER=NONE`, `MAIL_DRIVER=NONE`, `STORAGE_DRIVER=NONE`, the OpenAPI explorer, unencrypted SMTP, `TRUST_PROXY=true`, local disk under the cloud profile, and a missing audit checkpoint key — each naming the setting | Pass (8 of 8) |
| None of the generated credentials appears in any container log (576 lines) | Pass |
| Only the proxy publishes a port, on `127.0.0.1`; `data` and `scan` are internal networks | Pass (static check) |

The test environment needed its own plumbing to reach the internet through the session's egress
proxy (base images with the proxy's CA, host networking for builds and for `migrate`, signatures
fetched once and seeded). That plumbing is not in the repository and changes no product setting.

A pass proves the template wires the real images together correctly **against MinIO**. It does not
prove anything about Hetzner, Cloudflare, R2, real mail, TLS, load, or recovery.

### Gate P-1 run against Cloudflare R2 (2026-10-14)

**Result: the compatibility test passed.** R2 is compatible with the storage behaviours this
test verifies. **R2 is not approved for production**, gate P-1 is not complete, and this ADR stays
Proposed.

- **Where:** GitHub Actions, workflow `hetzner-template.yml`, job `external-storage`:
  [run 38535100979](https://github.com/munaxa/munaxa-docs/actions/runs/38535100979), at commit
  `3216654`. The test images were built on the runner and never published.
- **Bucket:** the dedicated test bucket `munaxa-docs-p1-storage-test`.
  - Standard storage class, default jurisdiction, location **eastern US (ENAM)**.
  - Private (no public access).
  - One CORS rule: origin `https://p1-storage-test.munaxa.invalid`, method `PUT`, headers
    `content-type` and `x-amz-checksum-sha256`.
  - Accessed with an API token limited to that bucket.
- **Application fix:** `3216654`, found by earlier runs of this test.
  - R2 answers a HEAD request that allows gzip without `content-length` for text larger than a
    few dozen bytes. The S3 adapter read that missing size as 0, so completion refused a good
    upload with 415.
  - `head()` now asks for an uncompressed answer (`accept-encoding: identity`). It refuses a
    missing or malformed size as a storage failure instead of guessing.
  - The size and SHA-256 checks in completion are unchanged. Unit tests cover the change.

| Check | Result (R2) |
| --- | --- |
| The 14 standard smoke checks: readiness, proxy routing and private endpoints (8 together), sign-in, upload target with signed `x-amz-checksum-sha256`, browser-side PUT, completion, tampered bytes, EICAR | Pass, 14 of 14 |
| Browser CORS preflight from the test web origin | Pass (HTTP 204, origin allowed) |
| Upload completion: size and SHA-256 read back and confirmed, then scanned CLEAN | Pass (HTTP 201 CLEAN) |
| Same-size tampered bytes refused by R2 | Pass (HTTP 400) |
| EICAR test file detected | Pass (INFECTED). Confirmed in the tenant database, not only in the HTTP answer: the ICAP scanner's verdict was recorded with signature `Eicar-Test-Signature` |
| Text uploads of 24 bytes, 67–68 bytes and 4 KiB: size reported correctly | Pass. The 68-byte smoke content also completed CLEAN in three rounds from each of two containers |
| Production validation refuses unsafe settings | Pass (8 of 8) |
| No generated credential, and not the storage secret, in any container log (580 lines) | Pass |
| Cleanup of the run's objects under its own prefix | Pass: 33 objects removed, **0 left** under the run prefix |

**Other checks on `3216654`:**
- GitHub: the `CI` workflow and the MinIO `stack` job both passed.
- Locally: formatting, lint (0 errors), typecheck and the unit tests of every package passed.
- The full integration suite passed **56 of 56 files on its third full run**. In the two runs
  before, three test files that start the whole application (`auth.e2e`,
  `numbering-collision.e2e`, `request-size`) failed at start-up with a configuration error before
  any test ran. They passed 24 of 24 when run alone, and they run with object storage disabled.
  It is recorded here, not presented as a clean run. Phase A (below) traced it to the local test
  setup: `TENANT_CATALOGUE` was exported in the same shell as the tests, which the configuration
  refuses alongside a single-tenant setting. It was not a product defect.

**Not verified by this run, and needed before production:**
- Server-side **multipart** writes, used for large internal objects such as audit evidence exports.
- **Downloads in a real browser**.
- **Backup and restore** procedures, including the nightly copy to a second provider (§9, P-4).
- **Version history:** R2 does not provide the S3 object versioning that §6 requires, so an
  alternative must be designed and tested before R2 could hold production documents.
- **Data residency:** the test bucket is in the eastern US (ENAM). Nothing about EU location or
  EU jurisdiction has been verified.
- Hetzner Object Storage has not been tested at all.

Nothing was deployed, merged or published, no DNS record was changed, and AWS was not accessed.

### Phase A: local upload and download checks, and the fixes they led to (2026-10-14)

**Result: every Phase A expectation held on the local MinIO stack after five application fixes.**
This is **local evidence only**: it says nothing about R2, Hetzner, a real browser, TLS, or the
production server size. It is **not production readiness**, and this ADR stays Proposed.

- **Harness:** `infra/hetzner/testing/phase-a/` (`phase-a.sh`, sourced by `run-stack-test.sh` via
  `EXTRA_CHECKS`). It refuses to run against an external bucket. Every check is judged from the
  tenant database and the object store as well as from the HTTP answer.
- **First run** (`d438a86`, before the fixes): it recorded the findings below as evidence.
- **Fixes** (application code, each with unit or integration tests):

  | Commit | Fix |
  | --- | --- |
  | `fc4df79` | Scanning admits uploads within a byte budget (`AV_SCAN_BUDGET_BYTES`, default 256 MiB, per API process). A completion that waits longer than `AV_SCAN_QUEUE_TIMEOUT_MS` (default 60 s) is refused 503 "scanner busy", with its upload session and staged bytes kept so a retry succeeds. The S3 read preallocates the object's size instead of growing a buffer |
  | `1f46464` | Refused and expired uploads end in a final state (ABORTED, EXPIRED), or stay OPEN with "not received yet". Staged bytes are deleted only after the database has recorded the outcome |
  | `3beaa60` | Refusals name their real cause, in English and Arabic, at unchanged status codes, without internal detail |
  | `fcb9c6d` | a daily orphan sweep (`storage.sweep-orphaned-objects`) for staged uploads and content blobs that no record refers to |
  | `9496c9a` | Before a download link is signed, the stored object is checked (HEAD): missing, wrong size or wrong checksum is refused 409. The preview stream hashes what it serves |
  | `fc4cb94` | The real-scanner test suites check the scanner is ready once, and fail at once with a clear message instead of failing test by test |

- **Second run** (API image built from `0a7021d`, web image with the F-1 fix, local MinIO and
  ClamAV): the 14 standard smoke checks passed, Phase A passed in full, production validation
  refused 8 of 8 unsafe settings, and no generated credential appeared in 1562 log lines.

**Memory** (API container limit 1536 MiB; uploads of about 120 MiB each):

| Measurement | Before the fixes (`d438a86`) | After (`0a7021d`) |
| --- | --- | --- |
| Peak during step 1 (1 MiB, 127 MiB and 128 MiB uploads in turn) | 507 MiB | 292 MiB |
| 4 uploads completed at once | 1068 MiB peak; wall time 36 s | 424 MiB peak; all CLEAN; wall time 50 s |
| 8 uploads completed at once | 1509 MiB peak, then **killed by the kernel for running out of memory**; 8 sessions left OPEN | 550 MiB peak; all 8 CLEAN; no restart; 0 refused as busy; wall time 83 s |

The budget trades time for memory: concurrent completions wait their turn, so the wall time grew.
Scanning still holds each whole object in memory, and the budget is per process. These are
measurements on one local machine, not a sizing for the production server (G-7 stays open).

**Upload limits:** 1 MiB, 127 MiB and 128 MiB uploads completed CLEAN. 128 MiB + 1 byte was refused at
creation with "This file is too large. The limit for this kind of file is 128 MB." A text file of
32 MiB + 1 byte was refused naming 32 MB. Neither limit changed.

**Failed and interrupted uploads:**

| Case | Before the fixes | After |
| --- | --- | --- |
| Completed without a confirmable checksum | 415 "That file type is not accepted."; session left OPEN | 415 naming the unconfirmed fingerprint; session ABORTED; staged bytes removed; no file recorded |
| PUT after the link expired | Store refused (403); completion 503 "a service is unavailable" | Store refused (403); completion 422 "The upload link expired…"; session EXPIRED |
| Transfer started in time, finished after the link expired | 201 CLEAN | 201 CLEAN (unchanged; the store checks the link when the transfer starts) |
| Expiry sweep ran during the transfer | 422 "Some of the details are not valid."; staged object left with nothing to remove it | 422 "This upload has already been finished."; the orphan sweep removed the staged object |
| API killed (SIGKILL) during 4 completions | — (new step 7) | All 4 interrupted (2 had already copied their bytes). The 2 that had not were completed again: 201, one row each, no staged bytes |

**Orphan cleanup** (step 7; the sweep was run with a 240 s grace period in a test-only container,
because the product default is 24 hours):

- Dry run: reported 1 staged object and 2 blobs as orphaned (of 26 blobs listed, 24 referenced),
  and removed nothing.
- Real run: removed exactly those 3 objects.
- Second run: found nothing to remove (24 blobs listed, 24 referenced).
- Every live file record's object was still in the store, except the one step 6 deleted on purpose.
- At the end: 0 open upload sessions, 0 staged objects, 0 unfinished multipart uploads.
- The sweep checks age first and the database last, immediately before each delete, and logs keys
  and counts only. It never touches derived files or audit evidence exports. No bucket lifecycle rule
  was added or changed.

**Downloads and integrity** (step 6):

| Case | Before the fixes | After |
| --- | --- | --- |
| Object replaced with other bytes, before the integrity verifier ran | Link issued; **the other bytes were served** | Refused 409 "This file failed its integrity check…"; no link |
| Object deleted, before the verifier ran | Link issued; the store answered 404 | Refused 409; no link |
| The same objects after the verifier ran | Refused 409 | Refused 409; recorded MISMATCH and UNREADABLE |
| Open file; confidentiality level without download; reader without `document:download` | 201 attachment with identical bytes; 403; 403 | Unchanged |
| Link used after expiry; signature or path edited | Store refused 403 | Unchanged |
| Non-ASCII name `Résumé تقرير.txt` | Bytes identical; `Content-Disposition` carries raw UTF-8 that a client reads as mojibake | Unchanged — a Phase B item |

**Limits of the integrity fix:**
- The check runs when the link is signed. A link stays valid for its lifetime (300 s by default),
  so an object replaced in that window would still be served.
- Where the store holds no checksum for an object (streamed exports, objects restored by a plain
  write), only its size and its last-modified time are checked.
- Whether R2 keeps the SHA-256 checksum when it copies an object is unverified (Phase C). If it does
  not, uploads also fall back to the weaker check.
- Closing the window needs downloads that pass through the API; a design proposal is in
  [`docs/reports/hetzner-download-integrity-proposal.md`](../../reports/hetzner-download-integrity-proposal.md). It is
  not implemented.

**Scanner readiness:** the intermittent integration failures had two local causes, both in the local
test setup rather than the product:
- the scanner was used before ClamAV had loaded its signatures (CI waits with
  `probe.mjs --wait`; the local runs did not);
- `TENANT_CATALOGUE` was exported in the same shell as the tests, which the configuration refuses
  alongside a single-tenant setting.

The real-scanner suites now check readiness once (`fc4cb94`), with no fixed delays. With a ready
scanner the ICAP suite passed 10 of 10. With a scanner still starting, it failed with one clear
"not ready" message.

**Validation on `0a7021d`, local:**
- Format, lint, typecheck and unit tests all passed:

  | Package | Passed |
  | --- | --- |
  | API | 985 (1 skipped) |
  | Web | 508 |
  | Domain | 164 |
  | i18n | 80 |
  | Contracts | 63 |
  | Utils | 38 |
  | Worker | 2 |

- The integration suite passed **57 of 57 files (1218 of 1218 tests) on each of three consecutive
  runs**. The suite has 57 files now; it had 56 at `3216654`, and the orphan-sweep spec is the new
  one.
- On GitHub at `41bf8dd`, the `CI` workflow and the MinIO stack job passed. The stack job's first
  attempt failed while building the test MinIO, on a dropped download from the Go module proxy,
  before any test ran. Its single re-run passed. The R2 job did not run.

**Still open after Phase A:**
- Phase B: downloads in a real browser, including non-ASCII file names.
- Phase C: the same checks against R2, including multipart part sizes and checksum preservation on
  copy.
- The download-integrity window above.
- Scanning that streams instead of holding whole objects.
- Native review of the new Arabic messages.

Nothing was deployed or published, no cloud resource or DNS record was changed, and AWS was not
accessed.

### Verified downloads, and two fixes before Phase B (2026-10-14, local)

**Result:** document downloads are now served by the API only after the whole file has been read
and its SHA-256 matched the record. All stack checks and every Phase A expectation held on the
local MinIO stack. This is **local evidence only**. It is **not production readiness**, and this
ADR stays Proposed. Design and trade-offs:
[`docs/reports/hetzner-download-integrity-proposal.md`](../../reports/hetzner-download-integrity-proposal.md).

| Commit | Change |
| --- | --- |
| `6973984` | The integrity verifier quarantines only a finding: a digest mismatch, or an absence a HEAD confirms. A file over `STORAGE_INTEGRITY_MAX_BYTES`, or a read that failed (5xx, timeout, unreachable store), is recorded UNVERIFIED and never quarantined. A quarantine already in place is never released by a failed read. Before, both were quarantined as UNREADABLE (the defect present since `06ab302`) |
| `4b3677f` | Download file names follow RFC 6266/8187: `filename*=UTF-8''…` with an ASCII fallback. CR, LF, quotes and bidirectional overrides cannot reach the header |
| `5ce5185` | Verified downloads: an API link (`/api/v1/downloads?token=…`, 60 s) that re-authorizes the person when followed, then stages the object in an encrypted, unlinked file while hashing it, and sends nothing until it matches. Caddy route, staging volume, settings and README in the same commit |
| `cdc08ec` | A refused link answers in the interface's language (`edms_locale` cookie) |
| `750232a`, `a66c4b8`, `e64fc02`, `1d8e0ef`, `e605e46` | The Phase A harness for all of the above, and fixes to the harness found by running it |
| `296b131` | Phase B browser scripts: **prepared, not run** |

**Behaviour on the local stack** (API image built from `296b131`; final run, all checks passed, no
credential in 1732 log lines):

| Case | Result |
| --- | --- |
| Open document | Served by the API as an attachment, byte for byte |
| Object swapped after its link was issued (same size) | 409 integrity page of 480 bytes, containing **no byte of the original or the replacement**. Quarantined MISMATCH, with `INTEGRITY_MISMATCH` in the trail and no `FILE_DOWNLOAD_SERVED` |
| Object deleted after its link was issued | 409 and no file bytes; quarantined UNREADABLE after a confirming HEAD |
| Store stopped when the link was followed | 503 with `Retry-After: 30`, no file bytes, nothing quarantined. Once the store was back, the same file was served byte for byte, with `FILE_DOWNLOAD_SERVED` recorded |
| Quarantined, unscanned, confidential, no `document:download` | Refused as before; no link issued |
| Link after 30 s (test-only lifetime); token signature or payload edited | 404 page in the interface's language; no file |
| `Résumé تقرير.txt` | `filename*` decodes to the exact name; the ASCII fallback is `Resume _.txt` |
| A link followed with no session | Served (FINDING): a link is a bearer link for its 60 s lifetime, re-checked against its person when followed |
| Staging after every step | No file in the directory and none held open |

**Measured on the local stack** (4 CPUs, local MinIO, API limit 1536 MiB; final run). These are
local figures, not a sizing for the production server:

| Downloads | Time to first byte | Total | API cgroup peak | of which the process's own (anonymous) | Peak staged |
| --- | --- | --- | --- | --- | --- |
| 1 MiB | 85 ms | 104 ms | 327 MiB | 318 MiB | — |
| 32 MiB | 603 ms | 941 ms | 327 MiB | 319 MiB | 32 MiB |
| 128 MiB | 1.5 s | 2.4 s | 317 MiB | 185 MiB | 128 MiB |
| 8 × 128 MiB at once | 8.0–11.0 s | 14.7–15.6 s | 1266 MiB | 202 MiB | 1024 MiB |
| 12 × 128 MiB at once (limit 8) | 8.4–10.5 s; the 4 that waited 17.9–18.4 s | up to 20.8 s | 1269 MiB | 220 MiB | 1024 MiB (never more than 8 staged) |

- **Memory:** the process's own memory hardly moves with downloads. What grows is the page cache of
  the staging files the API writes, and the container's cgroup counts it. The kernel reclaims it,
  and in five runs the API was never restarted. In one run, though, the cgroup reached
  1535 MiB of 1536 MiB, so cache pressure on the container limit is a real risk to size for.
- **Time to first byte:** it grows with the file, because the whole file is read and checked first.
  That is the cost of the design.
- **Concurrency:** above `DOWNLOAD_MAX_CONCURRENT` downloads wait their turn rather than fail.
- **Uploads,** same run: 4 and 8 concurrent ~120 MiB uploads peaked at 417 and 486 MiB (anonymous
  408 and 476 MiB). No restart.

**Other validation on these commits:**
- Format, lint, typecheck, and every package's unit tests passed locally:

  | Package | Passed |
  | --- | --- |
  | API | 1020 (1 skipped) |
  | Web | 508 |
  | Domain | 164 |
  | i18n | 80 |
  | Contracts | 63 |
  | Utils | 48 |
  | Worker | 2 |

- The integration suite passed **58 of 58 files (1250 of 1250 tests) on each of three runs**.
- Against the previous code, 7 of the 9 new verifier tests fail. Without the digest comparison,
  the two content-tamper delivery tests fail.
- On GitHub at `296b131`, `CI` and the MinIO stack job passed.

**Still open:**
- **Phase C** (R2) has not been run. Phase B has; see below.
- **Exports:** report, bulk and audit exports still use signed store URLs (300 s), outside the
  verified path.
- **Bearer links:** a verified link can be followed by whoever holds it for 60 s, though each use
  re-checks its person.
- **Downloads go through the API:** every one now crosses the server twice, and time to first byte
  grows with the file. Bandwidth and latency to a real store (R2 in the eastern US) are not
  measured.
- **Staging limits:** they are per API process, and the page cache counts against the container's
  memory.
- **Scanning** still holds each object whole in memory.
- **Arabic text** needs native review.

**Observed, not changed:** F-2 — API responses carry `X-Powered-By: Express`. Minor information
disclosure, pre-existing, independent of hosting; noted for a later application change.

### Phase B: a real browser and the download limits, local MinIO (2026-10-14)

Chromium 1.62.1 (the official Playwright image) drove the real web app through the proxy, against
the stack test's local MinIO. The test-only API ran with 30 s links; the product default stays
60 s. Harness: `infra/hetzner/testing/phase-b/` (`aa9b067`, `ccf5046`, `0183485`). Images:
the API with verified downloads (`5ce5185`), the web app as built for `4b3677f`. No R2, no AWS,
no Cloudflare.

**Runs.**
- **Run 1** (development, kept stack) found harness defects, now fixed.
- **Run 2:** the integrity links expired before they were followed. The follow step signed in
  again and the product's sign-in rate limit held it for about 3 minutes, past the 30 s lifetime.
  This was a harness defect. The API answered correctly ("expired"), saved no bytes and
  quarantined nothing. Fixed in `0183485`.
- **Run 3**, the run of record: **82 passed, 4 failed. All 4 are product findings, not harness
  faults.** Teardown left no container, volume or sign-in state. None of the generated credentials
  appears in 2329 log lines.

**Passed (run 3).**
- **Upload and download.**
  - An upload through the dialog was filed and scanned CLEAN, and the recorded digest equals the
    browser's own.
  - Downloads were byte-for-byte identical in every case: text, PDF, 5 MiB binary, 120 MiB, the
    uploaded file, the library row action and the revision panel.
- **File names.** `تقرير الربع الأول.txt`, `Résumé café.txt`, `Résumé تقرير.txt` and a name with
  quotes are all saved by Chromium under their own names (`filename*=UTF-8''`, ASCII fallback).
- **Attachment versus inline.** An attachment is saved, not rendered. Plain text renders inline. A
  PDF preview paints in pdf.js. HTML cannot be uploaded (422), so no inline HTML exists to run.
- **Links.**
  - An expired link: served inside 30 s, then a 404 page and no file.
  - An edited token: 404, no file.
- **Access.**
  - A viewer without `document:download` has no button.
  - The confidentiality level refuses with "You do not have permission".
  - An unknown document id is not found.
  - Signed out returns the person to sign-in.
- **Integrity.**
  - A swapped object, a deleted object and a quarantined record each show the 409 integrity page,
    with **0 bytes saved**. The links were followed 1.4–3.6 s after issue, after the store change.
  - The swapped and deleted files were quarantined MISMATCH and UNREADABLE.
  - No `FILE_DOWNLOAD_SERVED` for any of them.
- **Outage.**
  - With the store stopped: no file, and not quarantined.
  - With the store back: the same button saves the exact file.
- **Arabic interface.** Right-to-left, and the download saves the same bytes.
- **Exports.** The report export (`documents.csv`) and the audit export (`events.jsonl`) save
  exactly what the store served, **through a direct signed store URL — not the verified path**
  ([export gap](../../reports/hetzner-export-download-gap.md)).
- **Resource limits** (no limit raised). Each answer was the exact file or a 503 with
  `Retry-After: 30` and "Downloads are busy right now…"; none was partial or corrupt.

  | Case | Result | API cgroup peak / anonymous / staged peak |
  | --- | --- | --- |
  | 8 × 128 MiB at once (within limits) | 8 served; slowest first byte 8.2 s, slowest whole 12.3 s | 1533 / 463 / 1024 MiB |
  | 40 × 128 MiB at once (concurrency 8, queue 30 s) | 24 served, 16 × 503; first byte ≤ 33.5 s | 1413 / 360 / 1024 MiB |
  | 24 × 128 MiB, test-only API with a 256 MiB staging budget | 18 served, 6 × 503 | 465 / 230 / 256 MiB |
  | 128 MiB on a 64 MiB disk, default reserve | 503 in 51 ms, nothing staged | — |
  | Left while verifying (150 ms) and while sending (4 MiB in) | Staging empty afterwards | — |
  | Store killed mid-verification | 503 + Retry-After, "File storage is temporarily unavailable"; first byte 0.8 s (run 3) to 71 s (runs 1–2) | — |

  - The stack's API never restarted and was never OOM-killed.
  - Neither limits file was quarantined.
  - `FILE_DOWNLOAD_SERVED` is 50 for 50 downloads served in full, and none for a refused,
    interrupted or failed download.
  - Staging was empty at the end.

**Genuine findings (failed, not changed — application work for separate approval).**
1. **Upload dialog at 1280×720.** The "Add documents" submit button is at 754–790 px, below the
   window, in a dialog that does not scroll. It is unreachable at common laptop sizes. The upload
   was proven at 1920×1080.
2. **The staging disk filling part-way answers 500, not 503.** Two 48 MiB downloads on a 64 MiB
   disk with no reserve were both refused "Something went wrong on our side", with no Retry-After.
   No bytes were sent, the API kept running, staging was freed and nothing was quarantined. The
   failure is safe but not reported as retryable.
3. **Store down: no retry advice in the interface.** The web shows "A service this action needs is
   unavailable." `toActionResult` (`apps/web/src/lib/admin/action-result.ts:39`) keeps only the
   error code, so the API's "temporarily unavailable, try again" sentence is lost.
4. **A quarantined file, refused before a link is issued, shows the malware-scan sentence.** In
   Arabic: "ما زال يجري فحص هذا الملف…"; in English, "This file is still being checked for
   malware". The page shows no quarantine warning, and its Download button stays enabled. When the
   refusal comes after the link is followed, the 409 page has the right sentence (runs 2 and 3).

**Recorded findings and limitations (not failures).**
- A followed link downloads in a fresh context with no session: a bearer link for its lifetime,
  re-checked against its person.
- No read timeout on the store stream: a killed store took up to 71 s to answer 503.
- The cgroup reaches its 1536 MiB limit through page cache (anonymous memory ≤ 463 MiB). It was not
  OOM-killed.
- The busy sentence is also used when the disk reserve refuses.
- Not covered:
  - another tenant's real document (a random id was used; tenants are separate databases);
  - inline HTML or SVG (not accepted at upload);
  - bulk links in the browser.
- Console errors are the expected 404s of the expired and edited links.
- The Arabic wording still needs native review.
- All of this is local MinIO only. It shows nothing about R2 (Phase C, not run).

### Phase B findings fixed, awaiting review (2026-10-15, local)

These fixes are on branch `claude/amazing-turing-09vlks`. That branch is the Hetzner branch with
`main` merged in (Docs v2 design, #137, `@munaxa/platform` 1.7.0). **Not merged, not deployed.**

| Finding | Fix | Commit |
| --- | --- | --- |
| 1. The upload dialog's submit button cannot be reached at 1280×720 | `FormDialog` caps the panel at the window height and scrolls inside it (every form dialog) | `5f05333` |
| 2. A staging disk filling part-way answers 500 | `ENOSPC`/`EDQUOT` while staging answers `DOWNLOAD_BUSY` 503 + Retry-After. Nothing quarantined; other errors still propagate | `5bf578d` |
| 3. Store down: no retry advice in the interface | The API sends the stated `reason` beside `detail` (additive, optional). The web keeps it and translates it into the person's locale | `ad361b8`, `e3bfe61` |
| 4. A quarantined file shows the malware sentence and an enabled Download | `reachable` = scanned CLEAN **and** integrity servable (the download gate's own rule); a document file now carries `integrityStatus`. The page shows the integrity sentence | `ad361b8`, `97356d8` |

Authorization, integrity verification, audit events and every upload and download limit are
unchanged.

**Regression tests:**
- unit: domain `isReachableFile`; web `toActionResult`, `apiFetch` and the record page in English
  and Arabic; API exception filter;
- integration: five staging cases in `verified-download.integration.spec.ts`. On the old code, four
  of the five fail;
- end-to-end: `upload-dialog-viewport.e2e.spec.ts` at 1280×720, 1366×768 and 1280×720 in Arabic.
  It fails on the old dialog, where the panel sits 50–79 px above the window.

**Validation:**
- unit tests pass, including web 540 and API 1024;
- integration 58/58 files, 1255 tests;
- all five end-to-end shards locally, 237 tests;
- GitHub CI on `ca7ec10` (every code fix) and the Hetzner template workflow both pass.

**Phase B, run 5 of record** (local MinIO only), with images built locally from the branch:
- **88 passed, 0 failed.**
- The 1280×720 submit button sits at 643–679 px.
- Disk fills: two × 503 with Retry-After.
- Store down: "File storage is temporarily unavailable. Try again shortly."
- Quarantined file in Arabic: warned before any click, Download disabled.
- No restart and no out-of-memory kill.
- Memory peaks: 1535 / 493 MiB (8 × 128 MiB) and 1425 / 373 MiB (40 × 128 MiB).
- Staging stayed within its budgets.
- No credential in 2591 log lines.
- Teardown left nothing behind.

Run 4 failed only on three harness selectors that the redesign had changed. They were fixed in
`908518f`.

**Still open:**
- The export routes. Their design is in
  [`hetzner-export-verified-delivery-design.md`](../../reports/hetzner-export-verified-delivery-design.md).
  It records two authorization defects in the bulk link route: **E-1**, no confidentiality-level
  check; **E-2**, no check of the operation's kind or state.
- Bearer links.
- No read timeout on the store stream.
- Page cache against the container limit.
- Phase C (R2), which has not been run.

### Exports moved onto verified delivery (2026-10-15, local)

On branch `claude/amazing-turing-09vlks` (`88af7a8`–`2c07ee7`). **Not merged, not deployed.**
Design and deviations: [`hetzner-export-verified-delivery-design.md`](../../reports/hetzner-export-verified-delivery-design.md)
§13.

**What changed:**
- **No person receives a store-signed URL any more.** Report exports, audit (evidence) artefacts,
  bulk-exported documents and the bulk manifest are verified links (`/api/v1/downloads`, 60 s), each
  with its own kind and a redeemer that re-asks its module's questions when the link is followed.
- A test fails the build if anything but the preview pipeline signs a store URL.
- The bulk list carries no URL and has no item ceiling. Links are issued per click.
- Audit bundles are issued all or nothing.
- The audit export streams in bounded memory.
- Too-large files are marked on screen.
- Tokens are redacted from the proxy's access log.
- Link redemption is rate-limited by address.

**Validation:**
- **Integration (real PostgreSQL, stored bytes):** 58 files, 1,287 tests, on freshly migrated
  databases. The baseline at `c9dc887` was 1,264.
- **API unit:** 1,056 tests. **Web:** 555 tests.
- Typecheck and lint pass on all 20 tasks; formatting passes.
- **Negative controls:** seven mutations, each reintroducing one defect. Each was caught by its test:
  - manifest per-document check;
  - bulk confidentiality at redemption;
  - report permission at redemption;
  - audit artefact media-type binding;
  - audit atomicity;
  - in-memory audit generation;
  - process-wide registry.
- **Independent security review:** no cross-tenant access, authorization performed only at issuance,
  confidentiality bypass, XSS or signed-URL leak was found. One medium defect (D-1, an unbounded
  manifest check on an unthrottled public route) was fixed in `2c07ee7`.
- **Full integration run:** a regression since `88af7a8` was found and fixed in `2c07ee7`. The
  registry was shared across applications in one process, so suites that boot twice failed.

**Phase B, run 7 of record** (local MinIO only), with images built from `2c07ee7`:
- **92 passed, 0 failed.**
- Report and audit exports save the verified file through `/api/v1/downloads` with no popup.
- **Bulk export, at 1280×720:**
  - the list contains no URL;
  - a released document downloads byte for byte through its own link;
  - a quarantined one is withheld, with its integrity reason;
  - the manifest downloads through a verified link, with counts and no links.
- No restart and no out-of-memory kill.
- Memory peaks: 1535 / 481 MiB (8 × 128 MiB) and 1421 / 367 MiB (40 × 128 MiB).
- No credential in 2,635 log lines.
- Teardown left nothing behind.

**Still open:**
- **E-10:** recovering a quarantined deduplicated export.
- The preview pipeline's internal reads do not verify the digest.
- A link remains a bearer link for its 60 s lifetime (re-checked per person).
- Phase C (R2) has not been run.
- The readiness picture is in
  [`hetzner-test-deployment-readiness.md`](../../reports/hetzner-test-deployment-readiness.md).

**Gates before adoption:**

| Gate | What must pass | Status |
| --- | --- | --- |
| **P-1 Provider storage** | The smoke test's upload checks (signed checksum accepted, digest returned on HEAD, tampered bytes refused, scanner read-back) and a CORS preflight from the web origin, against a **real** Hetzner Object Storage and/or R2 bucket. Not covered by that run, and still to check: server-side multipart writes, versioning, a download in a real browser | **Partly passed — still open.** **Cloudflare R2:** the upload checks and CORS passed on 2026-10-14 (above; run 38535100979, fix `3216654`). Still open: multipart writes, a browser download, and the versioning alternative. Hetzner Object Storage is not tested. Harness: `run-stack-test.sh` with `EXTERNAL_STORAGE_ENV` ([README §6](../../../infra/hetzner/README.md)) |
| P-2 TLS + client address | The chosen TLS option end to end; sign-in rate limit keyed on the real browser address | Open |
| P-3 Mail | A real notification delivered with SPF/DKIM/DMARC passing | Open |
| P-4 Backup + restore | WAL + dump + document copy restored on TEST; audit chain verifies | Open |
| P-5 Go-live checks | go-live-runbook.md §14–17 on TEST | Open |

**Known gaps (not tested):** G-1 Hetzner Object Storage behaviour, and for R2 multipart writes,
browser downloads, versioning and EU data residency (R2's upload path is tested, above); G-2 TLS
termination; G-3 email delivery;
G-4 backups and restore; G-5 client-address chain behind Cloudflare; G-6 host hardening (firewall,
SSH, updates); G-7 behaviour under load and memory pressure on the chosen server size (Phase A measured the API locally under 4 and 8 concurrent ~120 MiB uploads, below; the production size is still untested); G-8 the
deployment workflow itself (not written yet).

**Failure scenarios:**

| Failure | Effect | Recovery |
| --- | --- | --- |
| Server lost | Full outage; documents safe in the external store | Rebuild from the template, restore PostgreSQL from offsite backups, restore secrets |
| PostgreSQL volume corrupted | Full outage | Point-in-time restore (needs §9 item 1 in place) |
| Scanner down / signatures unavailable | Uploads recorded FAILED and refused; reads continue | Restart; signatures persist in a volume |
| Scanner busy (more bytes waiting than `AV_SCAN_BUDGET_BYTES` admits for 60 s) | Completion refused 503 "scanner busy"; session and bytes kept | The user retries; nothing is lost (Phase A, below) |
| Redis lost | Queued but unconsumed jobs lost (notifications, previews); schedules and timers rebuilt automatically | None needed beyond restart (backup-and-restore.md §1) |
| Object store unavailable | Uploads and downloads fail | Provider-dependent; the second-provider copy is the last resort |
| Secrets lost | Signatures/MFA/checkpoints unverifiable — **irreversible** | Only the offsite secret copy prevents this |
| Disk full | Writes fail, possible outage | Log limits are set; alerting and image pruning still to build |
| Bad migration | Release fails | Restore the pre-deployment backup into a new database; redeploy the previous digests |

## 11. Decisions requiring the owner's approval

| # | Decision | Recommendation |
| --- | --- | --- |
| D-1 | Accept Hetzner as the hosting direction (this ADR → Accepted) | After P-1 passes |
| D-2 | TLS option (§3) | A: Cloudflare Tunnel |
| D-3 | Object storage provider (§6) | Decide after P-1; Hetzner Object Storage or R2, with the backup copy at the other |
| D-4 | Mail provider (§7) | Resend, or an EU SMTP provider on 587 |
| D-5 | Offsite backup target (§9) | A provider other than the one holding the live data |
| D-6 | Spending approval for gate P-1 (a test bucket) and later for TEST | — |
| D-7 | Server size and location | 4 vCPU / 8 GB x86 in Germany to start |
| D-8 | Domain names (e.g. `docs.munaxa.com`, `test.docs.munaxa.com`) in the existing Cloudflare zone | — |
| D-9 | What happens to AWS: billing for resources that still exist there, PR #131 and PR #134 | Settle with the AWS account owner; this work does not touch AWS |
| D-10 | ~~Fix finding F-1 in the Dockerfile~~ — **done** (§8). Remaining: publish a release whose images carry the fix, when a release is next approved | — |

## 12. TEST and production

Two completely separate environments [proposal]:

- **separate Hetzner Cloud projects** (each with its own API tokens, firewall, servers and billing
  view), separate buckets with separate keys, separate secret directories, separate databases;
- **the same template and the same image digests**, so what was tested is what ships;
- TEST: smaller server, `MAIL_DRIVER` pointing at a sink or a restricted sender, data disposable, may
  be switched off when idle (Hetzner bills by the hour [verify]);
- production: backups, monitoring and approval-gated deploys; no TEST credential works against it.

## 13. Reuse for Munaxa School and Munaxa Work

The **standard** is shared; nothing **operational** is shared:

| Shared (the standard) | Never shared |
| --- | --- |
| The template's shape: one Compose stack per environment, edge/data/scan networks, Caddy entry point, hardening, logging limits | Servers, Hetzner projects and API tokens |
| The ops conventions: `db-admin`, `migrate`, `provision`, digest-pinned releases | Databases, Redis instances, volumes |
| The backup, monitoring and release patterns | Buckets and storage keys |
| The Cloudflare account (separate zones or records per product) | Application secrets and secret directories |
| | GitHub environments and deploy credentials (each product repository has its own) |

Each product keeps its own repository and copies the template, adapting service names and routes to
its own application. `DOCS_PROJECT_NAME` and per-product subnets mean two stacks could even share a
host without sharing a volume or network, but **the recommendation is one server per product per
environment**, so an incident or a compromise in one product cannot reach another.

## 14. Preliminary monthly cost

**[estimate] — every figure must be checked against current Hetzner, Cloudflare and mail-provider
prices before approval.** EUR, before VAT, for Munaxa Docs only.

| Item | Estimate | Assumption |
| --- | --- | --- |
| Production server, 4 vCPU / 8 GB / 80 GB, x86 shared CPU | €7–10 | Hetzner CX-class [verify] |
| Hetzner server backups (+20%) — optional convenience | €1.5–2 | [verify] |
| Volume for PostgreSQL data, 40 GB (optional) | about €2 | [verify] |
| Primary IPv4 | about €0.5 | [verify]; may be avoidable with a tunnel and IPv6 |
| Object storage | €0–6 | R2 free tier up to ~10 GB, or Hetzner's base fee [verify] |
| Offsite backup target | €3–5 | Storage Box or a second bucket [verify] |
| TEST server | €0–8 | €0 when switched off between uses |
| Mail | €0–20 | Free tiers cover low volume [verify] |
| Cloudflare (DNS, TLS, Tunnel), uptime and backup monitors | €0 | Free plans [verify] |
| **Total** | **about €15–50** | Compared with ADR-0024's AWS estimate of about $102 for production alone |

The template itself introduces **no** cost: it adds no paid service. Costs that may continue
**outside** this plan: AWS resources already created (an RDS instance, KMS keys, CloudTrail, a backup
vault, and an older non-production stack recorded at about $100/month while idle) [verified from
records; current billing unknown] — decision D-9.

## 15. Consequences

- **Positive:** a fraction of the cost; no application change; one standard for three products;
  everything above the server is in this repository and reproducible.
- **Negative:** we operate the database and the server; a single server is a single point of failure
  (accepted for 1–2 tenants, as ADR-0024 accepted a single-AZ database); TLS, backups, monitoring and
  the deploy workflow are still to be built and proven.
- **Unchanged:** the application, the tenancy model (ADR-0015, ADR-0021), the security and audit
  requirements, the launch limitations WF-1, KEY-1 and D-1, and the rollback floor.
