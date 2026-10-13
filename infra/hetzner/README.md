# Munaxa Docs on Hetzner — deployment template

**Status: a tested template, not a deployment.** It has run only in a disposable local stack with
MinIO standing in for object storage (§5). Nothing here has run on Hetzner, and whether Hetzner Object
Storage or Cloudflare R2 meet the product's upload contract is an open gate (ADR-0026 §10, P-1).
The decision record is [ADR-0026](../../docs/architecture/adr/0026-hetzner-hosting-evaluation.md).

## 1. What is here

| Path | What it is |
| --- | --- |
| `compose.yaml` | The production-shaped stack: proxy, web, api, antivirus, postgres, redis, plus the one-off `ops` commands |
| `Caddyfile` | The single entry point and ADR-0024's routing rule |
| `deploy.env.example` | Which images and which secret directory one environment uses (not secret) |
| `config/*.example` | Placeholder versions of every secret file. **Real copies never go in git** (`.gitignore` refuses them) |
| `ops/db-admin.sh` | Database bootstrap and tenant-database creation (go-live-runbook.md §6) |
| `ops/pnpm` | The `pnpm exec` stand-in the migration runner needs inside the API image (ADR-0026 §8) |
| `testing/` | The test-only overlay (MinIO + smoke runner), the smoke test and the stack test. **Never deployed** |

## 2. How it works, in plain terms

- The **proxy** is the only door. It sends preview downloads to the API, refuses every other `/api/…`
  address (so health and metrics pages stay private), and sends everything else to the **web** app.
- The **web** app talks to the **API** inside the server. The API talks to **PostgreSQL** (one
  database per customer), **Redis** (queues), the **antivirus** scanner, and — over the internet — the
  object store and the mail provider.
- PostgreSQL, Redis and the scanner sit on private networks with no route to the internet (the scanner
  has a separate one only for downloading virus signatures).
- Every password and key lives in files in one protected directory on the server
  (`DOCS_CONFIG_DIR`), never in this repository.

## 3. Files an environment needs

Create `DOCS_CONFIG_DIR` (for example `/etc/munaxa-docs`, mode `0700`, root-owned) and copy each
example into it without the `.example` suffix, mode `0600`:

| File | Read by | Holds |
| --- | --- | --- |
| `api.env` | api, provision | Keys, database and Redis URLs, storage and mail credentials |
| `tenants.json` | api | Every tenant's database (as `edms_app`) and storage prefix |
| `operator-tenants.json` | migrate | The same tenants, with the **owner** credential. The API never sees it |
| `operator.env` | db-admin | The three role passwords |
| `postgres.env` | postgres, db-admin | The superuser password |
| `redis.env` | redis | The Redis password (also inside `api.env`'s `REDIS_URL`) |
| `provision.env` | provision | One tenant's first administrator — **delete after use** |

**Ownership.** The `*.env` files are read by Docker Compose on the host: owner `root`, mode `0600`.
The two catalogues are bind-mounted into containers that run as the image's unprivileged `node`
user (uid 1000), so they must be readable by that user and nobody else:
`chown 1000:1000 tenants.json operator-tenants.json && chmod 0400 tenants.json operator-tenants.json`.
(Found by the stack test: with root-only files the migration runner stops with `EACCES`.)

Then a `deploy.env` from `deploy.env.example`, naming the release digests.

## 4. Operating it

All commands from the repository checkout of the release, with
`C="docker compose --env-file deploy.env -f infra/hetzner/compose.yaml"`.

```bash
# First time, once per server
$C up -d postgres redis antivirus
$C --profile ops run --rm db-admin bootstrap          # roles, passwords, backup role (idempotent)

# Each new tenant (go-live-runbook.md §1a D-1)
$C --profile ops run --rm db-admin create-tenant acme  # empty database edms_acme
#   …add the tenant to tenants.json AND operator-tenants.json
$C --profile ops run --rm migrate                      # every tenant, sequential, fail-fast
$C up -d                                               # (re)start; the catalogue is read at start-up
#   …write provision.env for that tenant, then:
$C --profile ops run --rm provision && rm "$DOCS_CONFIG_DIR/provision.env"

# A release: back up first (go-live-runbook.md §19.2), then
#   …put the new digests in deploy.env
$C --profile ops run --rm migrate
$C up -d

# Readiness, from inside the server only (it names every tenant, so it is never public)
$C exec api node -e "fetch('http://127.0.0.1:3001/api/health/ready').then(r=>r.text()).then(console.log)"
```

Rollback is the previous release's digests in `deploy.env` and `$C up -d`; migrations are never
reversed (go-live-runbook.md §20).

## 5. Testing the template

```bash
DOCS_API_IMAGE=… DOCS_WEB_IMAGE=… DOCS_ANTIVIRUS_IMAGE=… infra/hetzner/testing/run-stack-test.sh
```

It generates a throwaway configuration (random values, never printed), builds the test MinIO from
the pinned source CI uses, bootstraps the database twice (idempotence), creates two tenant databases,
checks the API image carries the Prisma engines its own OpenSSL needs, migrates both databases twice
with no network egress (the second run must be a no-op), provisions an administrator by the D-1
procedure, starts the stack, waits for every health check, runs `testing/smoke.mjs`, checks that
production validation refuses unsafe settings, checks that no generated credential appears in any
container log, and removes everything.

Migrations run on the internal `data` network only and download nothing. Images built before the
F-1 fix (ADR-0026 §8) carry Prisma's schema engine for the wrong OpenSSL and fail there, trying to
download one — the engine check names that cause first.

**What a pass proves:** the real images, wired by this template, start in production mode; routing
and endpoint privacy are as designed; sign-in works; the upload → checksum → scan contract holds
**against MinIO**. **What it does not prove:** anything about Hetzner, Cloudflare R2, TLS, real email,
backups, load, or recovery.

### Run record

| Date | Images | Result |
| --- | --- | --- |
| 2026-10-13 | `api`, `web`, `antivirus` built locally from `main` at `f838433` | **All passed** — smoke 14/14, unsafe settings refused 8/8, no credential in logs. Details: ADR-0026 §10 |
| 2026-10-13 | `api`, `web` rebuilt with the F-1 Dockerfile fix; `antivirus` unchanged | **All passed** — both engines present for OpenSSL 3; migrations offline, second run a no-op; smoke 14/14; 8/8; no credential in logs. Negative control: the pre-fix image fails the same offline migration (`EAI_AGAIN binaries.prisma.sh`) |

## 6. Gate P-1: the same checks against a real bucket (not yet run)

**Not run, and not yet approved: it needs a real bucket.** Until it passes, no provider is known to
work with this product (ADR-0026 §10).

The stack test takes an external bucket in place of MinIO; nothing else changes. It runs the same
smoke checks — the API issues a presigned PUT that signs `x-amz-checksum-sha256`, the store must
accept the bytes, completion must read the SHA-256 back (`HEAD` with `x-amz-checksum-mode: ENABLED`),
the store must refuse same-size tampered bytes, and the scanner must read the object back — plus a
browser CORS preflight when a web origin is given. Each run writes under its own prefix and deletes
what it wrote afterwards, the EICAR test file included.

```bash
# A file OUTSIDE the repository, mode 0600. Never commit it, never paste it into an issue or a log.
#   STORAGE_DRIVER=R2                       (or S3 for Hetzner Object Storage)
#   STORAGE_BUCKET=<a bucket used only for this test>
#   STORAGE_REGION=auto                     (R2; Hetzner: its location, e.g. fsn1 — verify)
#   STORAGE_ENDPOINT=https://<account id>.r2.cloudflarestorage.com   (https only)
#   STORAGE_FORCE_PATH_STYLE=<true|false>   (per provider; try the provider's documented style)
#   STORAGE_ACCESS_KEY_ID=…
#   STORAGE_SECRET_ACCESS_KEY=…
#   STORAGE_TEST_CORS_ORIGIN=https://<web origin the bucket's CORS rule admits>   (optional)
EXTERNAL_STORAGE_ENV=/secure/path/storage-under-test.env DOCS_API_IMAGE=… DOCS_WEB_IMAGE=… \
  DOCS_ANTIVIRUS_IMAGE=… infra/hetzner/testing/run-stack-test.sh
```

The file is parsed, never executed; only the keys above are read; values are never printed, and the
log check also looks for the storage secret. A plain-`http` endpoint, a missing key or a driver other
than `S3`/`R2` is refused before anything starts.

**What the bucket and key need** — derived from the operations the product's S3 adapter performs
(`apps/api/src/infrastructure/storage/s3.adapter.ts`):

| Need | Why |
| --- | --- |
| A **dedicated, empty test bucket**, public access **off** | Presigned URLs need no public access; a dedicated bucket keeps a test key away from real documents |
| An access key **scoped to that one bucket** with object read, write, list and delete (Cloudflare R2: an API token with *Object Read & Write* limited to the bucket — verify the current permission names) | PUT (presigned uploads, copies, multipart parts), GET/HEAD (completion, scanning, downloads), list (cleanup, backup, integrity checks), DELETE (staging and cleanup), multipart create/complete/abort (server-side streams) |
| A **CORS rule** on the bucket admitting the web origin for `PUT` and `GET`, with headers `content-type` and `x-amz-checksum-sha256` | Browsers upload straight to the store; set by an account administrator, not by the test key |
| A **lifecycle rule** expiring objects after a day (recommended) | A safety net if a run is interrupted before its cleanup |
| For Hetzner Object Storage: a **separate Hetzner project** for the test | Its S3 credentials are understood to reach every bucket in their project (verify) |

**What a pass will and will not prove.** It proves the single-PUT upload path, checksum confirmation,
tampered-byte refusal and scanner read-back on that provider. It does not exercise server-side
multipart writes (used for large internal objects such as audit evidence exports), object versioning
(which ADR-0026 §6 asks for; Cloudflare R2 is understood not to offer S3 versioning — verify), or
downloads in a real browser.
