# Munaxa Docs Production Deployment & Go-Live Runbook

**Purpose:** the procedure an administrator follows, step by step, to deploy the validated release
candidate to production and put it live. **Audience:** the deployment operator and the change
approver. **Status:** written 2026-09-29 for the RC at `a560bb0`; release identity updated to `f5d5bb2` after the staging gate, then to the release candidate `c87519e`, then to `27a8daa` with the WEB-1 and NUM-1 fixes (2026-09-30). A living document, like everything
in `docs/operations/`.

**This runbook has not yet been executed against a production environment.** Every step comes
from the repository and from the RC validation
([release-candidate-final-validation.md](../reports/release-candidate-final-validation.md), Part II).
The first production run is the first time this sequence is performed end to end on real
infrastructure, so it must be rehearsed in staging first (§14, §25).

**Legend.** Anything marked **[PRODUCTION-SPECIFIC]** is a *PRODUCTION-SPECIFIC VALUE — must be
supplied by the deployment operator*. The repository does not determine it, and this runbook does not
invent it.

Companion runbooks, which this one references rather than repeats:
[deployment.md](./deployment.md) (configuration detail, the scanner requirements in §3.2, secrets
rotation), [backup-and-restore.md](./backup-and-restore.md) and
[disaster-recovery.md](./disaster-recovery.md).

---

## 1. Scope and release identity

| Item | Value |
| --- | --- |
| Application code to deploy | **`27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5`** (`27a8daa`) — the application release candidate |
| Validated by | CI run 554 on `27a8daa`, 9/9 jobs green (lint, typecheck, test and build; integration with a real ClamAV/c-icap scanner, a real object store and two tenant databases; five end-to-end shards; visual regression; three container images; product isolation), plus the local gate and the staging smoke in [production-release-package-27a8daa.md](../reports/production-release-package-27a8daa.md) |
| Staging gate | The full gate passed on `416ca94` ([staging-acceptance-gate-e94c295.md](../reports/staging-acceptance-gate-e94c295.md)); `f5d5bb2` added the web image's brand artwork (STG-12); `c87519e` added the tenant-resolution and TOTP-enrolment fixes; `27a8daa` adds the web sign-out revocation (WEB-1) and numbering-collision (NUM-1) fixes and repeats the §16 smoke ((pending)) on its own images |
| Branch | `claude/docs-release-rc2` |

**Build the images from `27a8daa` and run the migrations from a checkout of `27a8daa`.** Relative to
`f5d5bb2` it changes application code in exactly four commits — `6f135e5` (TOTP enrolment),
`14311c2` (tenant resolution), `efcb955` (web sign-out revokes the session, WEB-1) and `27a8daa`
(numbering collisions answer 409, NUM-1) — and adds the image-publishing workflow (`.github/`,
outside the image build context). No migration, no SQL and no scanner source changed. Commits after it on the branch
change documentation only. The release record must name `27a8daa`. Never use a documentation
commit's SHA as the application SHA.

**Release lineage.** Five commits matter, and only one of them is deployed:

| Role | Commit | Status |
| --- | --- | --- |
| Historical RC baseline | `a560bb0` | Validated by the RC gate ([release-candidate-final-validation.md](../reports/release-candidate-final-validation.md)). **Staging NO-GO** (STG-1, [staging-acceptance-gate-a560bb0.md](../reports/staging-acceptance-gate-a560bb0.md)). **Never deploy it** |
| Functional staging baseline | `416ca946f6afaee8bcea7fcf94c9705af800c5a8` (`416ca94`) | Passed the full staging gate (CI run 548). Not deployable: its web image lacks the brand artwork (STG-12) |
| Previous production baseline (historical) | `f5d5bb28146c57ab7937eff90cebd7621a28c9f2` (`f5d5bb2`) | `416ca94` plus STG-12, CI run 550 ([production-release-package-f5d5bb2.md](../reports/production-release-package-f5d5bb2.md)). **Superseded — do not deploy**: a blank organisation field is resolved from the hostname (a sign-in at `docs.munaxa.com` could reach a tenant slugged `docs`), and TOTP enrolment answers 500 |
| Superseded release candidate | `c87519eeade4392ab656d9bfef5ff694b9c4c594` (`c87519e`) | `f5d5bb2` plus `6f135e5` and `14311c2`, CI run 552, staging smoke 27/27 ([production-release-package-c87519e.md](../reports/production-release-package-c87519e.md)). **Superseded — do not deploy**: web sign-out does not revoke the session at the API (WEB-1), and colliding numbering rules answer 500 (NUM-1) |
| **Application release candidate** | **`27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5`** (`27a8daa`) | `c87519e` plus `efcb955` (WEB-1) and `27a8daa` (NUM-1), CI run 554, staging smoke (pending). **Deploy this** ([production-release-package-27a8daa.md](../reports/production-release-package-27a8daa.md)) |

| Scanner | Value |
| --- | --- |
| Image validated in the staging gate | `munaxa-antivirus:7442853`, local image `sha256:805574b9640df49959b82d4f42ad56280db07cc9dcb2efccc63f91b56b2cf8e4`: **ClamAV 1.5.4, c-icap 0.5.10** |
| Its sources | `infra/antivirus/`, unchanged from `7442853` to `27a8daa` |
| Version pinning | **None.** The Dockerfile is `FROM ubuntu:24.04` with unpinned `apt-get install clamav-daemon clamav-freshclam c-icap …`. A rebuild can therefore carry different ClamAV or c-icap versions |
| Production rule | Publish and deploy the validated image by digest. If it has to be rebuilt, record the versions (`clamd --version`, `c-icap -V`) and pass `probe.mjs` (§9.6) before any traffic; a different version must be recorded in the change record |

**Images are deployed by registry digest (§10).** Any rebuild of `27a8daa` is a new artifact. Before
it replaces the validated one, it must pass the release package's targeted checks: the scanner probe,
the §16 smoke test, and the brand artwork being served.

The prerequisites still to be satisfied are listed in
[production-prerequisites-checklist.md](./production-prerequisites-checklist.md).

**In scope:** the API, the web application, the malware scanner, tenant databases, object storage and
Redis for a new production deployment, or an upgrade of an existing one to release `27a8daa`.
**Out of scope:** choosing an infrastructure provider, an orchestrator or a monitoring product. The
repository mandates none of them.

### 1a. Accepted launch limitations

Two known behaviours of `27a8daa` are **accepted for launch** by the release owner. They are not
defects to work around in production, and neither is changed by this release. Confirm both in the
change record (§25).

**WF-1 — built-in role keys cannot be workflow participants.** A workflow `ROLE` participant takes a
configuration key (`configurationKeySchema`: lower-case letters, digits and hyphens), and the
built-in roles are seeded with upper-case keys (`APPROVER`, `AUTHOR`, `READER`, …). A workflow
definition therefore cannot name a built-in role directly; saving one that does is refused as a
validation error. Route approvals by any of these instead:

- a **custom role** with a lower-case key (for example `approvers`) holding the permissions needed,
  assigned to the approvers;
- an **approval group**;
- a **department**;
- the **manager route**.

**KEY-1 — API keys are supported on single-tenant deployments only.** An API key names no tenant,
and the API never reads one from the host. The key is resolved only where the deployment's tenant
catalogue has **exactly one** tenant; with more than one, every API-key request is refused with 401.
This is intentional: the behaviour **fails closed**, so a key can never reach another tenant.

- **Multi-tenant API-key access is not supported at launch.**
- On a **multi-tenant production deployment** (such as `docs.munaxa.com`), administrators must
  **not create or offer API-key integrations**. Integrations there use a user sign-in instead.
- API keys are supported on **single-tenant deployments** only.

## 2. Target production architecture

Deployment-agnostic: the repository ships container images and does not prescribe AWS, Azure,
Kubernetes or any other platform.

```text
                         Browsers
                            │ HTTPS
                  ┌─────────▼──────────┐
                  │ Reverse proxy / LB  │  TLS termination  [PRODUCTION-SPECIFIC]
                  └──┬──────────────┬──┘
          /  (web)   │              │  /api  (browsers also call the API directly)
        ┌────────────▼───┐    ┌─────▼─────────────────────────────┐
        │ web  :3000     │───▶│ api  :3001                         │
        │ node server.mjs│    │ node apps/api/dist/main.js         │
        │ (Next.js)      │    │ HTTP + queue consumers + schedules  │
        └────────────────┘    └──┬──────────┬──────────┬───────────┬┘
                                 │          │          │           │ ICAP (private network, plain)
                ┌────────────────▼┐  ┌──────▼─────┐ ┌──▼────────┐ ┌▼──────────────────────────┐
                │ PostgreSQL 16   │  │ Redis 7    │ │ Object    │ │ c-icap :1344 /avscan      │
                │ one database    │  │ queues,    │ │ storage   │ │   └─ clamd :3310 (ClamAV) │
                │ per tenant      │  │ cache,     │ │ S3 / R2   │ │      official signatures  │
                │ (RLS forced)    │  │ locks      │ │ (or LOCAL)│ └───────────────────────────┘
                └─────────────────┘  └────────────┘ └─────▲─────┘
                                                          │ presigned PUT/GET, direct from browsers
                                                     Browsers
```

| Component | What it is in this repository | Notes |
| --- | --- | --- |
| **web** | `Dockerfile` target `web`: `node server.mjs` on port 3000 | Server-renders pages and calls the API server-side. `server.mjs` resolves the browser's address under `WEB_TRUST_PROXY`. The image declares no `HEALTHCHECK` (§18) |
| **api** | target `api`: `node apps/api/dist/main.js` on port 3001 (`PORT`) | Serves `/api/*`, runs **every queue consumer and cron schedule in-process** (`QUEUE_CONSUMERS_ENABLED=true`, the default), and scans uploads. `HEALTHCHECK` on `/api/health/live` |
| **worker** | target `worker`: prints one line and **exits 0** | Not a long-running process in this release (§11) |
| **PostgreSQL 16** | one database per tenant (ADR-0015), roles `edms_owner` (migrations) and `edms_app` (runtime, `NOBYPASSRLS`) | Row-level security is forced on every tenant table by `infra/sql/post-migrate` |
| **Redis 7** | queues (BullMQ), the ACL cache, rate limits, locks | Holds no records; schedules and timers are rebuilt from PostgreSQL (D-13) |
| **Object storage** | `STORAGE_DRIVER=S3` or `R2` (one S3 adapter), or `LOCAL` on premise | Browsers upload and download directly with presigned URLs. `AZURE_BLOB` and `GCS` are accepted by configuration but have **no adapter**, and fail at first use: do not select them |
| **Malware scanner** | ICAP → c-icap 0.5.10 `virus_scan` → ClamAV 1.5.4 `clamd`, built from `infra/antivirus/` | The only validated scanner. Private network, plain ICAP (no TLS) |
| **Health** | `/api/health/live`, `/api/health/ready`, `/api/health`, and `/api/metrics` under `METRICS_DRIVER=PROMETHEUS` | §18 |

## 3. Prerequisites

Every row is a gate for go-live. "Deployment-specific" means **[PRODUCTION-SPECIFIC]**.

| Area | Requirement | Deployment-specific |
| --- | --- | --- |
| DNS | A name for the web application and a route to the API. The browser reaches both: `NEXT_PUBLIC_API_URL`, `CORS_ORIGINS`, `WEB_BASE_URL` | hostnames |
| TLS / reverse proxy | TLS terminated at a proxy or load balancer in front of web and API. Its addresses are named in `TRUST_PROXY` and `WEB_TRUST_PROXY` (§5) | certificates, proxy product, its address ranges |
| PostgreSQL | PostgreSQL 16, one database per tenant, the roles in `infra/sql/cluster/01-roles.sql`, WAL archiving for PITR (§19) | cluster, sizing, credentials |
| Redis | Redis 7, persistence recommended (`--appendonly yes`, as `infra/docker-compose.yml` runs it) | instance, sizing |
| Object storage | An S3-compatible bucket (S3 or R2), versioning and replication (§19), CORS for browser PUT/GET from the web origin (§7) | bucket, region, endpoint, credentials, CORS policy |
| Application runtime | A container runtime for the `api` and `web` images (`node:22-bookworm-slim` base, user `node`, `dumb-init`), able to run a read-only root filesystem | orchestrator, replicas, CPU and memory limits |
| Worker runtime | None needed in this release: consumers run inside the API (§11) | — |
| Antivirus | A host or container for c-icap + ClamAV on the private network: **about 1 GB RAM for `clamd`**, plus headroom for signature reloads; about 110 MB disk for signatures (§9) | host, scheduling, alerting |
| API memory | The scan reads a whole upload into memory: the API must hold `AV_ICAP_MAX_BYTES` × the number of concurrent upload completions on top of its normal heap (§9.7) | memory limit, `NODE_OPTIONS` |
| Build | Docker with BuildKit, and a registry token for the `@munaxa/*` packages, passed as a build secret (`--secret id=npmrc,...`) | registry and token |
| Release engineer workstation | A checkout of `27a8daa` with Node 22 and pnpm 10.33, network access to every tenant database as `edms_owner` (§12) | host |
| Backups | Base backups plus WAL archiving; bucket versioning and replication; a place to keep the pre-migration backup (§6, §19) | tooling, retention location |
| Monitoring | Something that polls health endpoints and scrapes `/api/metrics`, and alerts a human (§18) | monitoring product, thresholds, on-call |
| Secrets | A secret store that injects environment variables. Never in files committed to git (§5) | secret store |
| Firewall | See the matrix below | rules |

**Network access matrix.** Anything not listed should be closed.

| From | To | Port | Why |
| --- | --- | --- | --- |
| Internet | reverse proxy | 443 | Users |
| reverse proxy | web | 3000 | Pages |
| reverse proxy | api | 3001 | `/api/*` |
| web | api | 3001 | Server-side API calls (`NEXT_PUBLIC_API_URL`) |
| api | PostgreSQL | 5432 **[PRODUCTION-SPECIFIC]** | Tenant databases (`edms_app`) |
| release engineer | PostgreSQL | 5432 **[PRODUCTION-SPECIFIC]** | Migrations (`edms_owner`) |
| api | Redis | 6379 **[PRODUCTION-SPECIFIC]** | Queues, cache |
| api | object storage | 443 **[PRODUCTION-SPECIFIC]** | Server-side storage calls |
| **browsers** | object storage | 443 | Presigned uploads and downloads |
| api | c-icap | **1344**, private network only | Scanning |
| c-icap | clamd | 3310, loopback in the validated configuration | Scanning engine |
| scanner host | `database.clamav.net` (or a mirror **[PRODUCTION-SPECIFIC]**) | 443 | Signature updates |
| api | mail relay | `MAIL_SMTP_PORT` | Notifications |
| monitoring | api | 3001 | `/api/health*`, `/api/metrics` |

## 4. Required infrastructure

| Component | Version in the validated RC | Provisioned by |
| --- | --- | --- |
| PostgreSQL | 16 (validated on 16.15) | the operator |
| Redis | 7 (validated on 7.4.11) | the operator |
| Object storage | S3 API (validated against MinIO over S3) | the operator |
| ClamAV + c-icap | 1.5.4 + 0.5.10 (`infra/antivirus/Dockerfile`, Ubuntu 24.04 packages) | the operator, from this repository |
| Node | 22, inside the images | the images |
| Mail | an SMTP relay over TLS or STARTTLS, or Resend | the operator |

Capacity figures (CPU, replica counts, database sizes, storage growth) are **[PRODUCTION-SPECIFIC]**.
The repository records no production load baseline: `infra/loadtest/run.mjs` against staging
produces the first one (§14), run with many test identities.

## 5. Environment variables and secrets

Sources: the API's schema `apps/api/src/core/config/configuration.ts` (validated at boot; **an
invalid production value stops the process and names the variable**), `apps/web/server.mjs` and
`apps/web/src/lib/api-client.ts` for the web, and `.env.example`, which documents every API variable
with a placeholder. **Secrets come from the secret store. Never put a real value in a file in git.**

### 5.1 API — required or restricted in production

| Variable | Purpose | Required | Format | Secret | Production restriction |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | Turns on production validation | yes | `production` (the image sets it) | no | Must be `production` |
| `PORT` | Listen port | no (3001) | integer | no | — |
| `DATABASE_URL` | Runtime connection. **Required even with a tenant catalogue**: the configuration schema refuses to start without it (staging finding STG-5). With a catalogue, set it to one tenant's `edms_app` URL, as CI does with its first tenant | **yes, always** | `postgresql://edms_app@host:5432/db` | **yes** | The restricted `edms_app` role (`NOBYPASSRLS`) |
| `DATABASE_MIGRATION_URL` | Owner connection, **migrations only** | only where migrations run | `postgresql://edms_owner@…` | **yes** | Never in a running API's environment (deployment.md §3) |
| `DEPLOYMENT_PROFILE` | `ON_PREMISE` or `CLOUD` | no (`ON_PREMISE`) | enum | no | `CLOUD` requires a tenant catalogue and remote storage |
| `TENANT_ID` + `TENANT_SLUG` | Single-tenant install | one of these **or** a catalogue | UUID, slug | no | Cannot be combined with a catalogue |
| `TENANT_CATALOGUE` or `TENANT_CATALOGUE_PATH` | Multi-tenant: every tenant's database and storage prefix | as above | JSON, or a path to a mounted JSON file | **yes** (it holds connection strings) | Inline **or** file, not both |
| `REDIS_URL` | Queues, cache, locks | yes | `redis://…` | yes if it has a password | — |
| `JWT_ACCESS_SECRET` | Signs access tokens | yes | ≥ 32 characters | **yes** | Rotating it ends every session (deployment.md §4) |
| `SIGNATURE_WITNESS_SECRET` | Witnesses electronic signatures | **yes in production** | ≥ 32 characters | **yes** | Keep every prior key for as long as records are retained (deployment.md §4) |
| `AUDIT_CHECKPOINT_SECRET` | Signs audit checkpoints | **yes in production** | ≥ 32 characters | **yes** | — |
| `MFA_TOTP_SEALING_KEY` | Seals authenticator secrets | **yes in production** | ≥ 32 characters | **yes** | — |
| `CORS_ORIGINS` | Browser origins allowed to call the API | yes | comma-separated URLs | no | The production web origin(s) **[PRODUCTION-SPECIFIC]** |
| `WEB_BASE_URL` | Deep links in notifications | yes | URL | no | The production web URL **[PRODUCTION-SPECIFIC]** |
| `TRUST_PROXY` | Which hops may report the client address (sign-in rate limit, audit) | no (trusts nothing) | `loopback`, addresses, CIDR ranges or a hop count; `true`/`*` refused | no | **Name every hop in front of the API, including the web servers** (deployment.md §3.1) **[PRODUCTION-SPECIFIC]** |
| `STORAGE_DRIVER` | Object store | **yes in production** | `S3`, `R2` or `LOCAL` | no | `NONE` refused. `AZURE_BLOB`/`GCS` have no adapter — do not use. `CLOUD` refuses `LOCAL` |
| `STORAGE_BUCKET` | Bucket, or root directory | yes for S3/R2 | name | no | **[PRODUCTION-SPECIFIC]** |
| `STORAGE_REGION` / `STORAGE_ENDPOINT` | Region, custom endpoint | as the provider needs | region; URL | no | **[PRODUCTION-SPECIFIC]** |
| `STORAGE_ACCESS_KEY_ID` + `STORAGE_SECRET_ACCESS_KEY` (+ `STORAGE_SESSION_TOKEN`) | Store credentials | both or neither (neither = instance role) | — | **yes** | Half a pair is refused |
| `STORAGE_FORCE_PATH_STYLE` | Path-style addressing (MinIO and most S3-compatibles) | no (`false`) | `true`/`false` | no | — |
| `STORAGE_LOCAL_ROOT` | `LOCAL` driver only: the directory | with `LOCAL` | path | no | `LOCAL` needs a mounted volume |
| `STORAGE_PUBLIC_URL` | The public origin at which browsers reach the API. It is the base of the **preview stream URLs** handed to browsers under **every** storage driver, and of `LOCAL`'s transfer URLs | **yes in production, with every driver** | URL, e.g. `https://docs.example.com` | no | Unset, it defaults to `http://localhost:<PORT>` and every preview is broken for every user (staging finding STG-3). Set it to the origin the browser uses for `/api` **[PRODUCTION-SPECIFIC]** |
| `STORAGE_MAX_UPLOAD_BYTES` | Deployment upload ceiling | no (2 GiB) | integer | no | Under ICAP the effective limit is `min(this, AV_ICAP_MAX_BYTES)` |
| `MAIL_DRIVER` | Mail | **yes in production** | `SMTP` or `RESEND` | no | `NONE` refused |
| `MAIL_FROM_ADDRESS` | Sender | yes with a mail driver | email | no | **[PRODUCTION-SPECIFIC]** |
| `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_SECURITY` | Relay | with SMTP | host; port; `TLS`/`STARTTLS` | no | `NONE` security refused in production; certificate validation required |
| `MAIL_SMTP_USERNAME` + `MAIL_SMTP_PASSWORD` | Relay credentials | both or neither | — | **yes** | Refused over an unencrypted channel |
| `MAIL_RESEND_API_KEY` | Resend | with `RESEND` | — | **yes** | — |
| **`AV_DRIVER`** | Malware scanner | **yes in production** | **`ICAP`** | no | `NONE` refused in production; `HOSTED` refused everywhere (no adapter) |
| **`AV_ICAP_URL`** | Scanner address | **yes with ICAP** | `icap://host[:1344]/avscan` | no | `icaps://`, no service path, or credentials in the URL are refused; so is a URL without `AV_DRIVER=ICAP` |
| **`AV_ICAP_MAX_BYTES`** | Largest file sent to the scanner; also the effective upload limit | no (134217728 = 128 MiB) | integer ≥ 1024 | no | Size to the largest accepted file; drives API memory (§9.7) |
| **`AV_SCAN_TIMEOUT_MS`** | Longest a scan may take | no (120000) | 1000–600000 | no | A scan past it is recorded FAILED |
| `OPENAPI_ENABLED` | API explorer | set `false` | `true`/`false` | no | **Must be `false`**: `true` is refused in production |
| `OUTBOUND_HTTP_ALLOWLIST` | Hosts that webhooks, federation and audit push may reach | no (empty = nothing reachable) | hostnames | no | https-only in production (`OUTBOUND_HTTP_ALLOW_INSECURE` refused) **[PRODUCTION-SPECIFIC]** |
| `METRICS_DRIVER` + `METRICS_SCRAPE_TOKEN` | Prometheus exposition at `/api/metrics` | recommended | `PROMETHEUS`; ≥ 32 chars | token **yes** | A driver without a token is refused |
| `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT` | — | **must be unset** | — | — | Refused: no exporter in this build |
| `QUEUE_CONSUMERS_ENABLED` | Runs consumers and schedules in the API | leave `true` | — | no | `false` means **nothing consumes the queues** (§11) |
| `NODE_OPTIONS` | Heap size | image default `--max-old-space-size=768` | — | no | Raise with the container memory limit (§9.7) |

Every other variable in `.env.example` has a documented default and may be left unset. That covers
tuning of pools, timeouts, preview caps, rate limits, OCR, office conversion, search, audit batches and
reporting limits. `OCR_DRIVER=TESSERACT` and `OFFICE_DRIVER=LIBREOFFICE` need those binaries **in the
API image**, which does not carry them. Leave both `NONE` unless you build an image that does:
degraded, not misconfigured, per `.env.example`.

### 5.2 Web

| Variable | Purpose | Required | Secret | Restriction |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | The API's base URL, used by the web **server** | yes | no | Set in the **runtime** environment of the web container, reachable from it **[PRODUCTION-SPECIFIC]**. Do not set it during the image build: Next.js inlines `NEXT_PUBLIC_*` values present at build time, which would bake it into the image |
| `WEB_TRUST_PROXY` | Which hops in front of the web server may report the browser's address | no (trusts nothing) | no | Name the load balancer's range (deployment.md §3.1) **[PRODUCTION-SPECIFIC]**. An invalid value stops the web server |
| `PORT` | Listen port | no (3000) | no | — |

Run the image's own entry point (`node server.mjs`), never `next start`. Under `next start` every
browser signs in from the web server's address and shares one rate-limit allowance (D-2).

### 5.3 Operator commands (not the running services)

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_MIGRATION_URL`, `TENANT_CATALOGUE` / `TENANT_CATALOGUE_PATH` | `scripts/migrate-tenants.mjs` | The same catalogue the API reads |
| `TENANT_SLUG`, `TENANT_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` (+ the API's database variables) | `node dist/provision.js`, from `apps/api` (a new tenant's first administrator) | From the environment, never from arguments. `ADMIN_PASSWORD` is **secret** |
| `REDIS_URL` | `scripts/dr-verify-chain.mjs`, `scripts/run-schedule.mjs` | Enqueue a schedule now |
| `STORAGE_*` | `scripts/storage-backup.mjs` | Backup, verify, restore |
| A **backup role** URL (`edms_backup`, §6 step 1b) | `pg_dump` (§19.2), and as `DATABASE_MIGRATION_URL`/`SECOND_DATABASE_MIGRATION_URL` for `scripts/dr-rehearsal.mjs` (§23) | Must read through forced row-level security (STG-2). **Secret** |
| `DATABASE_MIGRATION_URL`, `SECOND_DATABASE_MIGRATION_URL`, `DATABASE_URL`, `SECOND_DATABASE_URL`, `DR_DEST_ADMIN_URL`, `DR_BACKUP_DIR` | `scripts/dr-rehearsal.mjs` | DR rehearsal into an empty cluster |
| `AV_ICAP_TEST_URL` | the integration suite only | **Never** set in production |

## 6. Database preparation

Once per cluster, then once per tenant database. Order from `infra/sql/README.md`:

1. **Roles, once per cluster**, as a superuser:
   `psql "<admin URL>" -f infra/sql/cluster/01-roles.sql`. This creates `edms_owner` and `edms_app`,
   and `edms_app` gets no password. Issue its credential from your secret store
   **[PRODUCTION-SPECIFIC]**. Do not use `02-app-credentials.sh` in production: it exists for the
   local compose stack.

   **1b. A backup role, once per cluster** (staging finding STG-2). Row-level security is **forced**
   on every tenant table, so it applies to the table owner too: `pg_dump` as `edms_owner` fails with
   *"query would be affected by row-level security policy"*. A logical backup needs a role that
   bypasses row-level security and can read everything, and nothing else:

   ```sql
   CREATE ROLE edms_backup LOGIN BYPASSRLS PASSWORD '<from the secret store>';
   GRANT pg_read_all_data TO edms_backup;   -- PostgreSQL 14+: read access, no write
   ```

   Or use the cluster superuser, or your backup product's own role if it already bypasses
   row-level security. **Never** grant `BYPASSRLS` to `edms_owner` or `edms_app`, and never weaken
   or disable the policies to take a backup. Physical backups (base backup + WAL) are not affected.
2. **One empty database per tenant**, owned by `edms_owner`, with names that match the catalogue
   **[PRODUCTION-SPECIFIC]**.
3. **The catalogue.** List every tenant's `id`, `slug`, database URLs and storage prefix, in
   `TENANT_CATALOGUE_PATH` (a mounted secret) or `TENANT_CATALOGUE`. A single-tenant install uses
   `TENANT_ID` and `TENANT_SLUG` instead. The CI workflow's catalogue shows the shape
   (`.github/workflows/ci.yml`, "Migrate every tenant database").
4. **Schema, grants and security** for every tenant: `scripts/migrate-tenants.mjs` (§12). It applies
   `infra/sql/database/*.sql`, then `prisma migrate deploy`, then `infra/sql/post-migrate/*.sql`.
5. **A new tenant's first administrator:** from `apps/api` of the release,
   `TENANT_SLUG=… TENANT_NAME=… ADMIN_EMAIL=… ADMIN_PASSWORD=… ADMIN_NAME=… node dist/provision.js`,
   with the API's database variables in the environment. For multi-tenant (catalogue) installs, see
   known finding **D-1**: provision each tenant in single-tenant form (`TENANT_ID`/`TENANT_SLUG` for that
   tenant), because the script cannot run beside a catalogue.

**Never** run `prisma db push` or `prisma migrate dev` (`pnpm prisma:migrate`) against production.
Several constraints are hand-written SQL, such as partial indexes and triggers, and those commands
would "repair" them away (RC report §7). The only production migration command is
`scripts/migrate-tenants.mjs` (`pnpm prisma:deploy`).

## 7. Object storage preparation

| Requirement | Detail |
| --- | --- |
| Connectivity | The API reaches the store server-side. **Browsers reach it too**: uploads are presigned PUTs straight to the store, and downloads are presigned GETs |
| Credentials | A key pair (`STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY`) or an instance role (both unset). Scope it to the bucket **[PRODUCTION-SPECIFIC]** |
| Bucket | One bucket (`STORAGE_BUCKET`); each tenant writes under its catalogue prefix. `STORAGE_FORCE_PATH_STYLE=true` for MinIO and most S3-compatibles |
| CORS | The bucket must accept cross-origin `PUT` and `GET` from the web origin, carrying the headers the presigned target specifies. **The repository documents no CORS policy.** Write it for your provider **[PRODUCTION-SPECIFIC]** and prove it with the smoke test's upload (§16). Validation used MinIO, which does not require one |
| Versioning | On (backup-and-restore.md §1) |
| Replication | Cross-region, per backup-and-restore.md §1 **[PRODUCTION-SPECIFIC]** |
| Capacity | Grows with retained documents, previews, exports and audit evidence **[PRODUCTION-SPECIFIC]** |
| Monitoring | **Required independently of the API.** Object storage is not an API readiness entry: in the RC, a stalled store left readiness at 200 UP while transfers hung (RC report Part II §10). Watch the store's own health and error rates (§18) |
| Backup | Versioning and replication are the production mechanism. `scripts/storage-backup.mjs backup|verify|restore` is a verifiable copy for rehearsals and pre-migration snapshots (§19) |

## 8. Redis preparation

- Redis 7, reachable from every API instance at `REDIS_URL`.
- **Persistence on** (`--appendonly yes`, as `infra/docker-compose.yml` runs it). Nothing in Redis is
  a record, but work enqueued and not yet consumed is lost with the data (known finding **D-15**).
- No backup is required (backup-and-restore.md §1). After data loss, the API rebuilds cron schedules
  and pending workflow timers from PostgreSQL, at boot and within `QUEUE_RECOVERY_INTERVAL_MS`.
- While Redis is unreachable, `/api/health/ready` answers **503** (`cache: DOWN`). That was observed in
  the RC. Authenticated requests answer 500 and sign-in fails closed with 429 (known finding **D-14**).

## 9. Antivirus / ICAP / ClamAV deployment

### 9.1 Architecture

```text
api ──ICAP RESPMOD (Preview: 0), plain TCP, private network──▶ c-icap :1344, service "avscan"
                                                                └─ virus_scan (mode=simple) ──▶ clamd :3310 (ClamAV)
                                                                                                  └─ official signatures (freshclam)
```

The API reads the stored bytes back through the tenant-scoped store, checks they hash to the recorded
digest, and sends them to the scanner. Only the scanner's `204`, returned after it has received the
whole body, is recorded **CLEAN**. A `200` naming a threat is **INFECTED**. Anything else is
**FAILED**: unreachable, timeout, an ICAP error, an early `204`, or a `200` naming no threat
(deployment.md §3.2).

### 9.2 Starting it

Use `infra/antivirus/`. Its image is validated in the RC gate, and its `c-icap.conf` and `clamd.conf`
carry the four fail-closed properties marked `REQUIRED`.

Prefer the image validated in staging (`munaxa-antivirus:7442853`, ClamAV 1.5.4 / c-icap 0.5.10,
§1), pushed to your registry and deployed by digest. If you build it, the packages are unpinned (§1).
Record `clamd --version` and `c-icap -V`, and treat a version change as a new artifact that must pass
§9.6.

```bash
# Only if building: from a checkout of 27a8daa (infra/antivirus is unchanged since 7442853).
docker build -t munaxa-antivirus:27a8daa infra/antivirus
docker run --rm --entrypoint sh munaxa-antivirus:27a8daa -c 'clamd --version; c-icap -V'

# One volume for the signatures, so a restart does not re-download them.
docker run -d --name munaxa-antivirus --restart unless-stopped \
  -p <private-address>:1344:1344 \
  -v munaxa-antivirus-signatures:/var/lib/clamav \
  <registry>/munaxa-antivirus@sha256:<digest>
```

`<private-address>`, the orchestration and the restart policy are **[PRODUCTION-SPECIFIC]**. Inside
the image c-icap listens on `0.0.0.0:1344`; publish it **only** on the private network the API uses.

### 9.3 Signatures: first start and updates

- **First start.** The entrypoint runs `freshclam` before starting `clamd`. With an empty volume it
  downloads the official databases. In the RC gate that was main 63 (3,287,027 signatures), daily
  28137 and bytecode 339. If `freshclam` fails and the volume has no signatures, the container
  **refuses to start**. If it fails and older signatures exist, it starts with those and logs that it
  did.
- **Updates.** The image runs `freshclam` **only when it starts**. Production must refresh signatures
  on a schedule: restart the container, or run `freshclam` inside it, from a scheduler
  **[PRODUCTION-SPECIFIC]**. After an update `clamd` picks up the new database at its self-check (every
  600 seconds by default; the container logs "Self checking every 600 seconds").
- **Freshness.** Each file row records the scanner's `ISTag`, which changes when the signatures do.
  Alert when the daily database stops advancing (§18).
- **Egress.** The scanner host needs HTTPS to `database.clamav.net`, or to an internal mirror
  **[PRODUCTION-SPECIFIC]**.

### 9.4 Connecting the application

Set, on every API instance: `AV_DRIVER=ICAP`, `AV_ICAP_URL=icap://<scanner private address>:1344/avscan`,
and optionally `AV_ICAP_MAX_BYTES` and `AV_SCAN_TIMEOUT_MS` (§5.1). The API refuses to start with a
missing or malformed URL.

### 9.5 Fail-closed behaviour, and what the operator sees

| Scanner state | `/api/health` `antivirus` | Readiness | New uploads | Filing |
| --- | --- | --- | --- | --- |
| Up and scanning | `UP` (a real scan of harmless bytes each probe) | 200 | CLEAN or INFECTED | CLEAN files only |
| Unreachable, hung, engine down, erroring | **`DEGRADED`** | **200** — reads keep working | **FAILED** (audit records `scanFailure`: `UNREACHABLE`, `TIMEOUT`, …) | **refused** `409 CONTENT_NOT_SCANNED` |
| Back up | `UP` | 200 | normal | a FAILED file becomes CLEAN or INFECTED when its bytes are **uploaded again** |

A scanner outage **cannot produce a false CLEAN**. This was demonstrated in production mode in the RC
gate (Part II §4). `DEGRADED` is not `DOWN` on purpose: every instance shares the scanner, so pulling
instances out of rotation fixes nothing. **Alert on `DEGRADED` (§18)**: while it lasts, no new upload
can be filed.

### 9.6 The go-live probe

```bash
# From any host on the private network, with Node 22 and a checkout of 27a8daa:
node infra/antivirus/probe.mjs icap://<scanner private address>:1344/avscan
# exit 0: "clean passed (204), EICAR blocked (Eicar-Test-Signature)"
# add --wait 300 on a first start, while freshclam is downloading
```

It must pass **both** checks: a harmless payload answered `204`, **and** the EICAR test file blocked
with a named threat. A scanner that passes everything fails the second check. It exits 1 for an
unreachable scanner or a wrong service. **No test-only scanner and no CLEAN substitution exist in
production code or configuration**; the RC's regression spec enforces that.

### 9.7 Memory

- **Scanner:** `clamd` held about **1.0 GB** RSS with the full official signatures in the RC gate, and
  c-icap about 5 MB. ClamAV's default concurrent reload briefly holds old and new databases together,
  so allow roughly double during an update (ClamAV's documented behaviour, not measured here). The
  memory limit is **[PRODUCTION-SPECIFIC]**.
- **API:** each upload completion reads the whole object, up to `AV_ICAP_MAX_BYTES`, into memory.
  Budget heap for `AV_ICAP_MAX_BYTES` × the number of concurrent completions per instance, on top of
  normal use. The image's default heap is `--max-old-space-size=768` (`NODE_OPTIONS`); raise it with the
  container limit if you raise `AV_ICAP_MAX_BYTES` **[PRODUCTION-SPECIFIC]**.

### 9.8 Limitation: no ICAP over TLS

The validated configuration is **plain ICAP on a private network**. `icaps://` is refused at boot.
Keep the scanner on a network only the API can reach, and do not route ICAP over an untrusted network.

## 10. Application deployment

**Build**, once, from `27a8daa` (deployment.md §1):

```bash
git checkout 27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5
export TAG=27a8daa
for target in api web worker; do
  docker build --target "$target" --secret id=npmrc,src="$HOME/.npmrc" -t "munaxa-docs-$target:$TAG" .
done
```

CI run 554 built the same three targets from `27a8daa`, and asserted that the web image serves its
brand artwork. **CI does not push**, and the repository has no image registry or publishing
process.

**Publish, then deploy by digest.**

- Push the API, web and scanner images to an immutable registry **[PRODUCTION-SPECIFIC]**. Record each
  digest (`docker buildx imagetools inspect <ref>` or the registry's own record) in the change record.
- Deploy with `image@sha256:…`, never with a mutable tag.
- Before go-live, verify that the published API and web images carry the label
  `org.opencontainers.image.revision=27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5`.
- Before go-live, verify that the published web image serves `/branding/docs/favicon/favicon-32.png`
  (the CI step "The web image serves the brand artwork its pages reference").
- Keep the previous production images, by digest, available for rollback (§20).

**Order**, which §21 turns into the go-live steps:

1. infrastructure (§3, §4);
2. database: backup (§19), drain (§13), migrate (§12);
3. scanner, then its probe (§9);
4. API;
5. worker (§11: nothing to start in this release);
6. web;
7. health validation (§14, §15);
8. smoke tests (§16);
9. traffic restoration (§21).

**The scanner must pass `probe.mjs` before any API instance takes production traffic.**

Run the API with the environment in §5.1 and the web with §5.2. Both images run as the unprivileged
`node` user and support a read-only root filesystem (only `STORAGE_DRIVER=LOCAL` writes, to its mounted
volume). The API image's `HEALTHCHECK` probes `/api/health/live`. Probe the web container from the
orchestrator (§18).

## 11. Worker deployment

**In this release there is no worker process to deploy.** Every consumer and every cron schedule runs
**inside the API process**, gated on `QUEUE_CONSUMERS_ENABLED` (default `true`). The `worker` image
starts, prints one line and **exits 0**, and an orchestrator expecting a long-running container would
read that as a crash loop (deployment.md §1).

- **Deploy:** API and web only. Leave `QUEUE_CONSUMERS_ENABLED` unset or `true` on the API.
- **Do not** set `QUEUE_CONSUMERS_ENABLED=false` unless you intend nothing to consume the queues.
- **"Workers running"** in the checks below therefore means: the API instances are up with consumers
  enabled, and the queue metrics move (`queue.depth`, `outbox.pending`; §18).

## 12. Database migration procedure

From a **checkout of `27a8daa`** on the release engineer's workstation. Never from inside an image:
the runtime images carry neither pnpm nor the Prisma CLI (deployment.md §1).

1. **Backup** every tenant database and the object store, immediately before this step (§19). Record
   the backup identifiers.
2. **Verify the backup** (§19.2) and record who confirmed it.
3. **Drain traffic** (§13). Required for this release.
4. **Prepare the checkout:**
   ```bash
   git checkout 27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5
   pnpm install --frozen-lockfile
   ```
5. **Run the tenant migrations**, with the owner role and the production catalogue:
   ```bash
   export DATABASE_MIGRATION_URL='<edms_owner URL>'            # single-tenant installs
   export TENANT_CATALOGUE_PATH=/path/to/production-catalogue.json   # multi-tenant installs
   node scripts/migrate-tenants.mjs          # equivalently: pnpm prisma:deploy
   ```
   It visits every tenant sequentially and applies `infra/sql/database`, `prisma migrate deploy`, then
   `infra/sql/post-migrate`. It stops at the first failure and names the tenant. Every step is
   idempotent, so **re-running continues** from where it stopped (deployment.md §2).
6. **Verify:** the command ended without error for every tenant. A second run reports
   "No pending migrations" for each. `post-migrate/01-tenant-isolation.sql` raises if any tenant table
   lacks row-level security, so a clean run means isolation was applied.
   - **Upgrade from the RC baseline** (`f1d9385`): this release applies
     `20260927120000_file_object_live_uniqueness` and `20260928100000_idempotency_claim`. The first
     rebuilds two unique indexes on `file_object` **without `CONCURRENTLY`**, holding a write lock for
     the duration. Plan it inside the window.
   - **Fresh install:** all 30 migrations.
7. **Start the application** (§21 steps 8–10).
8. **Health check** (§14, §15).
9. **Smoke tests** (§16).

Unset `DATABASE_MIGRATION_URL` from any environment that runs the API.

## 13. Traffic-drain procedure

**Required for this release** when upgrading a deployment that has served traffic.

- **Why.** Before D-20, `Idempotency-Key` replay records lived in Redis. This release keeps them in
  each tenant's `idempotency_key` table, and **the Redis records are not imported**. A request completed
  before the upgrade and retried under the same key after it is **performed again**. The RC's upgrade
  rehearsal observed exactly that.
- **How long.** The exposure ends 24 hours after the last pre-upgrade request, the old replay
  window. Draining across the migration and deploy removes it.

Procedure. The mechanism is your proxy or load balancer **[PRODUCTION-SPECIFIC]**.

1. Announce the change window to users **[PRODUCTION-SPECIFIC]**.
2. Stop admitting new client writes at the reverse proxy or load balancer: a maintenance response,
   or removing the API and web from rotation.
3. Let in-flight requests and client retries finish. The repository defines no drain duration;
   choose one **[PRODUCTION-SPECIFIC]**.
4. Confirm the queues are caught up: `outbox.pending` and `queue.depth` (waiting, active) at or near
   zero (§18), so no enqueued work is lost if Redis restarts during the deploy (D-15).
5. Stop the old API instances.
6. Proceed with the backup and migration (§12).

A fresh installation with no prior traffic needs no drain.

## 14. Pre-go-live validation

Run after deploying, **before restoring traffic**. Every item is required.

| # | Check | How |
| --- | --- | --- |
| 1 | Database reachable | `/api/health` lists every `database:<slug>` as `UP` |
| 2 | Migrations successful | §12 step 6 recorded |
| 3 | Redis healthy | `/api/health` `cache: UP` |
| 4 | Object storage reachable | The smoke test's upload and download succeed (§16). **Not** covered by readiness |
| 5 | Scanner healthy | `probe.mjs` exits 0 (§15) |
| 6 | `/api/health/ready` | **200** on every API instance |
| 7 | `/api/health` | `status` is `UP`, and `antivirus: UP` |
| 8 | "Workers" running | API instances up with `QUEUE_CONSUMERS_ENABLED` not `false`; after the smoke test, `outbox.pending` returns to about 0 |
| 9 | Queues healthy | `queue.depth{state="failed"}` not growing; `job.failures` not rising (§18) |
| 10 | Secrets loaded | The API started. It refuses to start without the production secrets and names the missing one |
| 11 | Trusted proxy correct | Sign in through the real proxy, then read `session_family.ip_address` for that session: it is the **browser's** address, not the proxy's or web server's (the D-2 acceptance) |
| 12 | TLS / reverse proxy | The web and API URLs serve over HTTPS with the production certificate; HSTS is present (the API sends it in production) |
| 13 | Monitoring active | The alerts in §18 exist, and one test alert reached a human |
| 14 | Backup verified | §19.2 recorded, with the confirming person |
| 15 | OpenAPI off | `/api/docs` (the explorer) is not served |

**Staging gate, required before any production go-live.** Staging must pass every item below. Its
results are attached to the change record.

| Staging check | Procedure |
| --- | --- |
| Migration rehearsal | §12 against a copy of production-shaped data |
| Application smoke test | §16 in full |
| Real scanner test | §15 and the §16 antivirus block |
| EICAR test | §16 antivirus block |
| Scanner outage and recovery | §24.1 |
| Redis outage and recovery | §24.2 |
| Object storage and database outage | §24.3, §24.4 |
| Backup and restore | §23: a DR rehearsal into an empty environment, ending with a real-scanner smoke test |
| Tenant isolation | Two tenants: tenant B cannot open, list, search or download tenant A's documents, and gets the same answer as for an identifier that does not exist |
| Load-test baseline | `infra/loadtest/run.mjs` against staging, with the table it prints attached. The first run *is* the baseline (deployment.md §7). Run it with **many test identities** (`--tokens-file`, one access token per line, at least the largest scenario's concurrency). Each virtual user keeps to its identity's API rate limit, and 429s are reported in their own column. A run whose 429 or failure column exceeds 1% of requests is not a baseline (STG-7). Sign the identities in from several client addresses: sign-in is limited per address |
| Monitoring verification | Every alert in §18 fired once, by provoking it in staging |

**Do not declare production ready until this staging gate passes.**

## 15. Antivirus go-live validation

1. `node infra/antivirus/probe.mjs icap://<scanner>:1344/avscan` → **exit 0**, printing
   "clean passed (204), EICAR blocked (…)". Record the output.
2. On every API instance, `GET /api/health` shows `antivirus` with `status: UP`.
3. The smoke test's antivirus block (§16) passes. That is a real clean upload recorded CLEAN, and a
   real EICAR upload recorded INFECTED and refused.
4. The scanner's signature date is current. Check the `freshclam` output in the container log.

Any failure is **NO-GO** (§25).

## 16. Application smoke tests

Run in the web application with a tenant administrator and two test users **[PRODUCTION-SPECIFIC]**:
an author, and a user without access to the test folder. Record each result. The API routes are
given for operators who prefer them; all are under `/api/v1`. Delete the test folder's contents
afterwards, per your data policy.

**Authentication**

1. Sign in: `POST /auth/login` with `{email, password, tenant}` → 200 with an access token.
2. Session validation: `GET /auth/me` with the token → 200, the right user.
3. Sign out: `POST /auth/logout` with `{refreshToken, tenant}` → the refresh token no longer works.
   Signing out through the web does the same: since `efcb955` (WEB-1) the web keeps the tenant in an
   httpOnly cookie and sends it with the refresh token, so a refresh token copied before a web
   sign-out is refused afterwards.

**Documents**

4. Create a library and folder: Administration, or `POST /admin/libraries`, `POST /admin/folders`.
5. Upload a small **clean** PDF in the upload dialog, or `POST /uploads`, `PUT` to the presigned URL,
   `POST /uploads/:id/complete` → `scanStatus: CLEAN`.
6. File it as a document: `POST /documents` → 201.
7. Download it: `POST /documents/:id/content` → a URL. The downloaded file's SHA-256 equals the
   original's (`sha256sum`).
8. Preview: the document page shows its preview (`POST /documents/:id/preview/content` → READY).
9. Revision: check out, upload a changed clean file, check in (`POST /documents/:id/checkout`,
   `/checkin`) → revision 2; the history shows both.

**Antivirus**

10. Upload the **EICAR test file** (68 bytes, `.txt`) → `scanStatus: INFECTED`. Create it only on the
    test workstation, and expect local antivirus to flag it.
11. Quarantine: the audit timeline of that file records the upload as INFECTED with the threat, and a
    `storage.file-quarantined` event exists (in `outbox_message`, or the security notification
    **[PRODUCTION-SPECIFIC]**).
12. No document: filing it is refused `409 CONTENT_NOT_SCANNED`, and no document of that title exists.
13. Not downloadable or previewable: no document exists to download or preview. The database trigger
    also refuses to attach it to any revision, as validated in the RC.

**Workflow**

14. Submit the document from step 6 (`POST /documents/:id/submit`).
15. The reviewer sees the task in the inbox (`GET /approval-tasks`) and receives the notification.
16. Approve it (`POST /approval-tasks/:id/decision` with `APPROVED`): the document is APPROVED and
    numbered. Known finding **D-4**: publishing is a separate action (`POST /documents/:id/publish`).

**Search**

17. Search for a word from the document's title or content (`GET /search?q=…`) → found, typically
    within seconds.

**Audit**

18. The audit trail records each step on **its own subject**, attributed to the right user (staging
    finding STG-4):
    - the document's timeline (`GET /audit/timeline/DOCUMENT/:id`): creation (`DOCUMENT_CHANGED`,
      operation `CREATED`) and submission (`SUBMITTED`);
    - the file's timeline (`GET /audit/timeline/FILE/:fileObjectId`): the upload (`FILE_UPLOADED`)
      and the download link issued (`FILE_DOWNLOAD_ISSUED`);
    - the approval task's timeline (`GET /audit/timeline/TASK/:taskId`): the decision (`APPROVED`).

**Permissions**

19. The author opens the document → 200.
20. The user without access → the document is absent from lists and search, and opening it by
    identifier is refused the same way as a nonexistent identifier.

**Bulk**

21. Bulk upload one clean file and the EICAR file into the test folder
    (`POST /documents/bulk/upload`) → the clean one APPLIED, the EICAR one BLOCKED
    `CONTENT_NOT_SCANNED`.

Any failure in steps 5–7, 10–12, 19–20 or 21 is **NO-GO**.

## 17. Security checks

| Check | Expected |
| --- | --- |
| Production configuration | The API started under `NODE_ENV=production`, so every refusal in RC Part II §3 was enforced |
| OpenAPI explorer | Not served |
| Response headers (API) | CSP, HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`. `X-Powered-By: Express` is also present, a known non-blocking item: strip it at the proxy if policy requires **[PRODUCTION-SPECIFIC]** |
| Proxy trust | §14 item 11 |
| Scanner network | `1344` reachable from the API network only |
| Database roles | `edms_app` neither superuser nor `BYPASSRLS`. The DR rehearsal's posture check reports this; see §23 |
| `DATABASE_MIGRATION_URL` | Absent from every running API's environment |
| Outbound HTTP | `OUTBOUND_HTTP_ALLOWLIST` names only intended hosts, https only |
| Secrets | From the secret store; none in images, repository or logs (the logger redacts) |
| Metrics | `/api/metrics` requires `METRICS_SCRAPE_TOKEN` |
| Test tooling | `AV_ICAP_TEST_URL` and every acceptance or fixture script are absent from production |

## 18. Monitoring and alerting

The repository defines the signals, but **no numeric thresholds**. Every threshold below is operator
configuration **[PRODUCTION-SPECIFIC]**.

| Monitor | Source | Operator response when it fires |
| --- | --- | --- |
| API health | `GET /api/health/ready` — 200 / **503** | 503: `/api/health` names the dependency that is DOWN |
| API liveness | `GET /api/health/live`; the image `HEALTHCHECK` | Restart the instance |
| **Web health** | The web image has **no `HEALTHCHECK`**. Probe HTTP on port 3000, e.g. `/login` → 200, from the orchestrator or monitor | Restart the web instance |
| PostgreSQL | `database:<slug>` entries in `/api/health`; the cluster's own monitoring | Per tenant; see disaster-recovery.md |
| Redis | `cache` entry; Redis's own monitoring | Readiness 503 while down; the API rebuilds queue state on return |
| **Object storage** | **Not in API readiness.** The provider's health and error metrics, plus a synthetic presign-and-fetch if possible **[PRODUCTION-SPECIFIC]** | Uploads and downloads fail while it is down; nothing can be marked CLEAN without it |
| Queues ("workers") | `queue.depth` by queue and state; `job.failures`; `job.duration` | A growing `failed` count or rising failures: read the API log for the lane |
| Outbox | `outbox.pending`; `outbox.dispatch.failures` | Growth means events are not being dispatched: check Redis and the API log |
| Notifications | `notification.delivery.failures` | Check the mail relay |
| **Antivirus DEGRADED** | `/api/health` → `antivirus` not `UP` | **Page someone.** New uploads cannot be filed. Restore the scanner, then confirm `probe.mjs` exits 0 |
| ICAP / c-icap / ClamAV | Container liveness; `probe.mjs` on a schedule (exit 1 = alert) **[PRODUCTION-SPECIFIC]** | Restart the scanner; check `clamd` memory |
| Signature freshness | The scanner log's `freshclam` result, and the `ISTag` recorded on new file rows changing over time | Update signatures (§9.3) |
| CPU, memory, disk | Host or container metrics, including `clamd` (≈1 GB) and API heap (§9.7) | Scale or raise limits |
| Storage capacity | Bucket size; the database disk | Plan capacity |
| HTTP 5xx | `http.request.duration`, labelled by status | Correlate with health |
| Authentication failures | Rate-limit refusals (429) on sign-in; `authorization.denied` | Possible attack or proxy-trust misconfiguration (§14 item 11) |
| Audit chain | `audit.chain.verified`; the nightly `audit.verify-chain` result in the log | A failure is a security incident (disaster-recovery.md §0) |
| Backup failures | The backup system's own reporting **[PRODUCTION-SPECIFIC]** | Fix before the next change window |

## 19. Backup and recovery requirements

### 19.1 Standing production requirements (backup-and-restore.md §1)

| Asset | Mechanism | Retention |
| --- | --- | --- |
| Each tenant database | Continuous **WAL archiving (PITR)** + nightly base backup | 35 days PITR, monthly for 12 months |
| Object storage | **Versioning + cross-region replication** | The tenant's retention policy |
| Redis, search index | none (rebuilt) | — |
| Audit checkpoints | A store the database cannot reach | 7 years |

The tooling (WAL archiver, backup product, replication) is **[PRODUCTION-SPECIFIC]**.

### 19.2 The pre-deployment backup (immediately before §12)

1. **Databases:** a base backup of **every** tenant database, e.g. `pg_dump -Fc` per tenant, which is
   the format `scripts/dr-rehearsal.mjs` uses, or your backup product's snapshot. Store it outside the
   production cluster **[PRODUCTION-SPECIFIC]**. Run the dump **as the backup role** (§6 step 1b),
   not as `edms_owner`, which forced row-level security refuses:
   ```bash
   pg_dump --format=custom --file <dir>/<database>.dump "postgresql://edms_backup@<host>:5432/<database>"
   ```
2. **Object storage:** confirm versioning is on, and record the time, so the pre-deployment state is
   addressable. Optionally take a verifiable copy:
   `node scripts/storage-backup.mjs backup --dir <path>`, then `verify --dir <path>`.
3. **Verify** before continuing:
   - every tenant's dump exists and lists its tables (`pg_restore --list <dump>`);
   - `storage-backup.mjs verify` exits 0 if used;
   - the last nightly base backup and the WAL archive are current.
4. **Retention:** keep the pre-deployment backup at least until the release is accepted, and within
   your policy **[PRODUCTION-SPECIFIC]**.
5. **Restoration location:** into a **new** database beside the live one, never over it
   (backup-and-restore.md §2, disaster-recovery.md §0).
6. **Confirmation:** a named person confirms the backup and verification in the change record
   **[PRODUCTION-SPECIFIC]**. A deployment without that confirmation is **NO-GO**.

## 20. Rollback procedure

**Migrations are forward-only.** The repository has no down-migrations, and Prisma does not roll them
back. An application rollback is **earlier images against the migrated schema**, never a reversal of
the schema (deployment.md §6).

**The rollback floor: never roll back below the D-3 antivirus fix.** A build without it (for example
`f1d9385` or anything older) has no working ICAP adapter. It records every upload SKIPPED, so real
malware scanning is gone. That is prohibited, not merely an outage.

**A rollback target is the immutable registry digest of a validated release that has already run in
this production environment**, recorded in that release's change record. Nothing else is a
rollback target. In particular, none of these is:

- a tag;
- a rebuild;
- a commit that never ran here;
- a release below the D-3 floor.

`a560bb0` is only the **historical RC and the D-3 floor**: the oldest code that scans for real. It is
never a rollback target. It and `e94c295` carry defects that `f5d5bb2` fixes (STG-1: large uploads
fail with a 500; STG-10: uploads above 64 MiB are refused on S3), and neither ever ran in production.
`416ca94` has the same application code as `f5d5bb2` without the brand artwork, so rolling back to it
gains nothing.

- **First production deployment (`27a8daa`):** there is **no application rollback target**. On a
  failed deployment, fix forward within the window, or keep traffic drained and restore the database
  as below if the migrated database must be abandoned. Record "no rollback target — first
  deployment" in the change record before go-live.
- **Later releases:** the rollback target is the previous production release's digest, for example
  `27a8daa`'s once it has run here, provided it is at or above the D-3 floor.

| Layer | Procedure |
| --- | --- |
| API | Redeploy the previous permitted `munaxa-docs-api` image **by digest**. Schema compatibility: every release on this line from `a560bb0` to `27a8daa` has the same 30 migrations. `a560bb0`'s two additions (partial unique indexes and an idempotency table) are relaxing, so a build from that line runs against this schema |
| Web | Redeploy the previous permitted `munaxa-docs-web` image by digest, with the matching API |
| Worker | Nothing to roll back (§11) |
| Scanner | Keep it running. It does no harm to an earlier build, and every permitted target needs it |
| Database | **Never reverse migrations, and never restore over the live database.** If the migrated database itself must be abandoned, **restore** the pre-deployment backup (or PITR) **into a new database**, verify it (backup-and-restore.md §2 and §3: row counts, RLS posture, audit chain), then repoint the catalogue to it. This **discards every write since the backup** and needs its own recorded decision by the change approver. The original database is kept untouched until the incident is closed |
| Object storage | Objects written by the new release stay. Earlier builds ignore what they do not reference, and versioning keeps the previous state addressable. Never delete objects as part of a rollback |
| Traffic | Restore traffic only after §14 items 1–7 pass on the rolled-back build **and** `probe.mjs` passes from the API's network |

Rollback decision points:

- a failed migration: it is idempotent, so fix and re-run it, or restore as above;
- a failed health check or smoke test after the deploy;
- a NO-GO condition (§25) that cannot be fixed in the window.

## 21. Go-live procedure

Execute in order. Record each step's result, time and operator in the change record.

1. **Confirm the final release SHA:** `27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5`. Confirm the API,
   web and scanner images by **registry digest** (§1, §10); the API and web carry
   `org.opencontainers.image.revision=27a8daa…`. Not `a560bb0`, not `416ca94`, and not `f5d5bb2`.
2. **Confirm the production change window** and the approver **[PRODUCTION-SPECIFIC]**. The
   repository defines no downtime duration: the approved window sets it.
3. **Confirm the staging gate:**
   - [staging-acceptance-gate-e94c295.md](../reports/staging-acceptance-gate-e94c295.md): the full gate
     passed on `416ca94`;
   - §14 of that report: STG-12 on `f5d5bb2`; the release candidate `27a8daa` repeated the §16 smoke on its own images (release package §4);
   - the [release package](../reports/production-release-package-27a8daa.md).
4. **Confirm the production prerequisites:** the readiness gate (§D) of
   [production-infrastructure-implementation.md](./production-infrastructure-implementation.md) is
   complete and signed, and every item in
   [production-prerequisites-checklist.md](./production-prerequisites-checklist.md) is READY, with
   evidence.
5. **Confirm the scanner:**
   - deployed on the private network (§9.2), with its image digest and versions recorded;
   - signatures current (§9.3);
   - `probe.mjs` exit 0 (§9.6).
6. **Drain traffic** (§13).
7. **Take the backup** (§19.2), as `edms_backup`.
8. **Verify the backup:** `pg_restore --list` per tenant and `storage-backup.mjs verify` → `intact`.
9. **A named person confirms the backup** (identifiers recorded).
10. **Deploy the release:**
    - images by digest available to the runtime;
    - configuration and secrets set for the API (§5.1) and the web (§5.2).
11. **Run the tenant migrations from a checkout of `27a8daa`** (§12 steps 4–6). A re-run must report
    nothing pending. There are no separate workers in this release: the API runs the consumers (§11).
12. **Start the API** instances.
13. **Start the web** instances.
14. **Probe the scanner from the API's network** (§15 step 1).
15. **Run the health checks** (§14 items 1–15, §15 step 2).
16. **Run the smoke tests** (§16).
17. **Confirm monitoring** is active, and that alerts reach the production on-call (§18).
18. **Go / No-Go** (§25). On NO-GO: roll back (§20) or fix within the window.
19. **Restore traffic** at the proxy or load balancer.
20. **Monitor** (§22).
21. **Record the result** in the change record:
    - release SHA and image digests;
    - times;
    - backup identifiers and who confirmed them;
    - probe output and smoke results;
    - the go/no-go table;
    - the operator names.

## 22. Post-go-live verification

- Within the first hour: `/api/health` stays `UP` with `antivirus: UP`; no rise in 5xx or
  `job.failures`; `outbox.pending` and `queue.depth` return to steady state.
- Uploads made by real users are recorded CLEAN; no unexpected FAILED (FAILED means the scanner was
  unreachable at that moment).
- The first nightly jobs run: audit chain verification, integrity sweep and retention. Check their
  results in the log the next morning. `scripts/dr-verify-chain.mjs` fires the chain verification on
  demand (`REDIS_URL=… node scripts/dr-verify-chain.mjs`).
- The nightly backup and WAL archiving continue.
- Signatures update on their schedule (§9.3).
- 24 hours after the drain, the idempotency replay window from the old release is closed (§13).

## 23. Disaster-recovery verification

Validated in the RC (Phase 19 and Part II §9, PROD-PATH and REAL-SCANNER). Repeat it **quarterly and
in the staging gate**. The test passes only if the audit chain verifies (backup-and-restore.md §3).

1. **Database restoration** into an **empty** cluster with the repository tooling:
   ```bash
   DATABASE_MIGRATION_URL=<tenant 1 URL as the backup role> DATABASE_URL=<tenant 1 app URL> \
   SECOND_DATABASE_MIGRATION_URL=<tenant 2 URL as the backup role> SECOND_DATABASE_URL=<tenant 2 app URL> \
   DR_DEST_ADMIN_URL=<superuser URL on the empty DR cluster> DR_BACKUP_DIR=<path> \
     node scripts/dr-rehearsal.mjs --prepare-destination > dr.json
   ```
   Two requirements of the tooling as it stands:
   - **The dump source** (`DATABASE_MIGRATION_URL`, `SECOND_DATABASE_MIGRATION_URL`) must be a role
     that reads through forced row-level security: the backup role (§6 step 1b) or a superuser.
     The tenant owner fails (STG-2). The script uses these URLs only to dump.
   - **The destination cluster must accept password-less connections** for `edms_owner` and
     `edms_app`: the script connects to the restored databases with those role names and **no
     password** (it blanks the password in the destination URLs). Give the rehearsal cluster
     `trust` authentication for those two roles, restricted to the rehearsal host's address in
     `pg_hba.conf`, and keep that cluster off every other network (staging finding STG-6). This is a
     property of the rehearsal destination only. A production restore uses the production cluster's
     own authentication and credentials (backup-and-restore.md §2).
   It covers two tenants per run and prints the evidence as JSON. In the RC gate: zero differences
   across 79 tables per tenant, restore about 24 s.
2. **RLS verification:** `dr.json` `posture`: RLS enabled and **forced** on every tenant table, one
   policy each, both roles non-superuser and not `BYPASSRLS`, the audit table not updatable.
3. **Storage restoration:** `node scripts/storage-backup.mjs backup|verify --dir <path>`, then
   `restore --dir <path> --bucket <empty bucket>`. The count restored must equal the manifest
   (182/182 in the RC gate).
4. **Audit-chain verification:** `dr.json` shows the restored chain ending on the source's last
   sequence and hash. Run `audit.verify-chain` on the restored deployment
   (`REDIS_URL=… node scripts/dr-verify-chain.mjs`). The deployment's log then says
   **"The audit chain verified"** for each tenant, with `eventsVerified` and `checkpointed`. A break
   logs **"The audit chain failed verification"**. The metric `audit.chain.verified` carries
   `intact="true"` or `intact="false"` (STG-4).
5. **Redis rebuild:** start the API against the restored databases with an **empty** Redis. It logs
   "Queue state rebuilt from durable state after the broker lost it".
6. **Cron schedules:** present afterwards on all six lanes: `audit.export`, `audit.stream`,
   `identity.delegation`, `notifications.deliver`, `retention.run`, `webhooks.deliver`.
7. **Pending timers:** re-armed at boot = armable `SCHEDULED` timers on running instances in the
   restored data.
8. **Numbering continuity:** a new document on the restored deployment is numbered after every
   restored number, with no reuse.
9. **Real antivirus after restoration:** point the restored API at the real scanner
   (`AV_DRIVER=ICAP`). Run §15 and the §16 documents and antivirus blocks: a clean upload is CLEAN and
   filed, and EICAR is INFECTED and refused. **No substitution** of any kind.

Not rehearsable from the repository: point-in-time recovery through WAL, and bucket versioning or
replication failover. Test those with your provider's tooling **[PRODUCTION-SPECIFIC]**.

## 24. Troubleshooting

### 24.1 Scanner (staging failure test, and production diagnosis)

Staging test: stop the scanner container, then check:

- `/api/health` → `antivirus: DEGRADED` (`detail: AntivirusScanError`), and readiness still 200;
- a new clean upload is recorded **FAILED**, and its audit record shows `scanFailure: UNREACHABLE`;
- filing it is refused `409 CONTENT_NOT_SCANNED`;
- an EICAR upload is also FAILED, never CLEAN.

Start the scanner, pass `probe.mjs`, and check that `antivirus: UP` returns. **Upload the same
files again**: the clean one becomes CLEAN and can be filed, and the EICAR one becomes INFECTED and is
quarantined. The RC gate demonstrated exactly this in production mode (Part II §4).

| Symptom | Likely cause | Action |
| --- | --- | --- |
| API refuses to start, naming `AV_ICAP_URL` | Missing or malformed URL, `icaps://`, or no service path | Fix the value (§5.1) |
| `probe.mjs`: `ECONNREFUSED` | Scanner down, or port not published on the API's network | Start it; check the network |
| `probe.mjs`: `404 Service not found` | Wrong service name in the URL | Use `/avscan` |
| `probe.mjs`: "EICAR was not blocked" | Scanner not scanning: engine down, no signatures, or not the repository configuration | Check the container log, `freshclam`, and the `REQUIRED` settings |
| Container exits at start: "no signatures" | `freshclam` failed with an empty volume | Fix egress to the signature mirror |
| All uploads FAILED, health `DEGRADED` | Scanner unreachable or erroring | Restore the scanner; users re-upload affected files |
| Large uploads refused before transfer | Above `AV_ICAP_MAX_BYTES` | Raise it and the API memory (§9.7), or accept the limit |
| A user sees "clean" in the upload dialog, then filing is refused | Known limitation: the dialog's display after deduplication | The server's refusal is authoritative; re-upload after the scanner is healthy |

### 24.2 Redis unavailable (staging test)

Stop or pause Redis: readiness → **503** with `cache: DOWN`; authenticated requests answer 500; sign-in
fails closed with 429 (D-14). Restore Redis: readiness returns to 200, and schedules and timers rebuild
automatically. Work enqueued but unconsumed at the moment of loss is not replayed (D-15).

### 24.3 Object storage unavailable (staging test)

Readiness does **not** change: the store is not a readiness entry. Uploads and downloads fail. With
a stalled store in the RC, a client's transfer hung until its own HTTP timeout (300 s). The API's S3
calls set no explicit timeout of their own. Diagnose from the store's monitoring (§18). Nothing is
recorded CLEAN without the store.

### 24.4 Database unavailable (staging test)

Readiness → **503**, and the `database:<slug>` entry names the tenant. Other tenants' databases stay
`UP`. Follow disaster-recovery.md §1.

### 24.5 Other

| Symptom | Action |
| --- | --- |
| API refuses to start | The log lists every invalid variable by name, never its value (§5.1) |
| Migration stopped at a tenant | Fix the cause, re-run `migrate-tenants.mjs` (idempotent). Never `db push` |
| Every browser shares one sign-in allowance (429s) | `TRUST_PROXY` does not name the web servers or proxy, or the web runs `next start` instead of `node server.mjs` |
| Browser uploads fail with CORS errors | Bucket CORS (§7) |
| Worker container "crash-looping" | Expected: it exits 0 (§11). Do not deploy it |
| Web cannot reach the API | `NEXT_PUBLIC_API_URL` in the web container's runtime environment (§5.2) |

## 25. Final Go/No-Go checklist

Fill in during go-live. **Required** items are all NO-GO if they fail.

| Check | Required | Result | Evidence | Operator |
| --- | --- | --- | --- | --- |
| Release SHA is `27a8daa`; API, web and scanner images deployed **by registry digest** | yes | | digests, image labels | |
| Staging gate passed (`416ca94` full gate; `f5d5bb2` STG-12 regression; `27a8daa` §16 smoke (pending) on its own images), results attached | yes | | staging report, release package | |
| Every production prerequisite READY with evidence ([checklist](./production-prerequisites-checklist.md)) | yes | | checklist | |
| Production DNS and a publicly trusted TLS certificate for the web origin (and the store endpoint) | yes | | certificate chain, HTTPS check | |
| SMTP relay configured and verified (TLS/STARTTLS, SPF/DKIM/DMARC) | yes | | relay test, DNS records | |
| Object storage: versioning, replication, CORS for the production origin, independent monitoring | yes | | bucket settings, probe | |
| PITR / WAL archiving and the recovery procedure in place (`edms_backup`, scheduled backups, backup alerts) | yes | | archiver status, backup job, alert | |
| Production capacity/load requirements established and met where required | yes | | load baseline on production-sized infrastructure | |
| Change window approved | yes | | change record | |
| Accepted launch limitations WF-1 and KEY-1 (§1a) acknowledged by the release owner; **no API-key integration offered on a multi-tenant deployment** | yes | | change record | |
| Backup taken **and verified** immediately before migration, confirmed by a named person | yes | | backup IDs, `pg_restore --list`, storage verify | |
| Traffic drained (this release) | yes | | proxy state, `outbox.pending` ≈ 0 | |
| All required secrets present (API started under `NODE_ENV=production`) | yes | | API start log | |
| Migrations succeeded for every tenant; re-run reports nothing pending | yes | | `migrate-tenants.mjs` output | |
| Scanner deployed on the private network; signatures current | yes | | container log | |
| `probe.mjs` exit 0 (clean passed **and** EICAR blocked) | yes | | probe output | |
| `/api/health/ready` 200 on every API instance | yes | | responses | |
| `/api/health`: every database `UP`, `cache: UP`, `antivirus: UP` | yes | | response | |
| API running with consumers enabled; queues draining; no rising failures | yes | | `queue.depth`, `job.failures` | |
| Redis reachable | yes | | `cache: UP` | |
| Object storage reachable from API **and browsers** (upload and download work) | yes | | smoke steps 5–7 | |
| Clean document uploaded → CLEAN → filed → downloaded with equal bytes | yes | | smoke steps 5–7, hashes | |
| EICAR → INFECTED → quarantined → refused, not downloadable or previewable | yes | | smoke steps 10–13 | |
| Bulk: clean applied, EICAR blocked | yes | | smoke step 21 | |
| Workflow submit/approve, search, audit timeline | yes | | smoke steps 14–18 | |
| Tenant and permission isolation (unauthorized user refused as if nonexistent) | yes | | smoke steps 19–20; staging isolation test | |
| Trusted proxy: session records the browser's address | yes | | `session_family.ip_address` | |
| TLS and security headers; OpenAPI explorer off | yes | | response headers | |
| Monitoring active: readiness, web probe, `antivirus` DEGRADED, object store, queues, backups | yes | | test alert received **by the production on-call** | |
| Rollback path confirmed: the previous production release's image digest (validated, at or above the D-3 floor), or "no rollback target — first deployment" recorded; restore-into-a-new-database procedure known | yes | | registry, runbook §20 | |

**NO-GO if any of the following is true:**

- the scanner is not `UP` in `/api/health`;
- `probe.mjs` fails (either check);
- migrations failed for any tenant;
- the backup cannot be verified, or nobody has confirmed it;
- `/api/health/ready` is not 200, or `/api/health` shows anything DOWN;
- the API's consumers ("workers") are not running or the queues are not draining;
- Redis is unavailable;
- a required secret or setting is missing (the API will not start);
- tenant or permission isolation fails;
- a clean document cannot be scanned, filed or downloaded intact;
- EICAR can be filed, downloaded or previewed, or is recorded anything but INFECTED;
- monitoring is not active, or the `antivirus: DEGRADED` alert does not reach the **production**
  on-call (a staging mailbox does not count);
- the traffic drain was not performed for this release;
- the migration procedure is not ready (no checkout of `27a8daa`, no migration URL, or no verified
  backup to fall back on);
- production DNS or a publicly trusted TLS certificate is missing;
- SMTP is missing or unverified where notifications are required;
- object-storage protection (versioning, replication, CORS) or its independent monitoring is missing;
- PITR or the recovery requirements are not satisfied;
- immutable release images are not available by digest;
- production load or capacity requirements have not been established where they are required.

**The state this runbook establishes:** Munaxa Docs has a documented, executable production
deployment and go-live procedure for release `27a8daa`. Production deployment remains dependent on the
operator-supplied infrastructure and staging prerequisites.
