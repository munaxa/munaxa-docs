# Munaxa Docs on Hetzner — deployment template

**Status: a tested template, not a deployment.** It has run in disposable stacks: locally and in CI
against MinIO (§5), and in CI against a dedicated Cloudflare R2 test bucket (§6). Nothing here has run
on Hetzner. R2 passed the upload-contract checks, but it is **not approved for production**. Gate P-1
stays open for multipart writes, browser downloads and versioning, and Hetzner Object Storage is
untested (ADR-0026 §10).
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

### Verified downloads (ADR-0026 §10)

A document download no longer sends the browser to the object store.
- The API issues a link to `/api/v1/downloads?token=…` on `STORAGE_PUBLIC_URL`, valid for 60 s.
  Caddy routes that path to the API, as it does the preview stream.
- When the link is followed, the API checks the person again: permission version, permissions,
  the document's access rules, its confidentiality level, and that the file is still current.
- It then reads the object whole into an encrypted, already-unlinked staging file on the
  `api-download-staging` volume, hashing it as it goes.
- It sends the file only when the size and SHA-256 equal the record. A mismatch sends no file bytes
  and quarantines the file (409). A store that fails or flickers answers 503 with `Retry-After`,
  and nothing is quarantined.
- Each staging file's key exists only in the API's memory. The volume needs no backup, and the
  API empties it at start-up.
- Settings: `config/api.env.example`, *Verified downloads*. Design and trade-offs:
  [`docs/reports/hetzner-download-integrity-proposal.md`](../../docs/reports/hetzner-download-integrity-proposal.md).

Report, bulk and audit exports still use signed store URLs. Moving them is a separate decision.

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
| 2026-10-14 | All three built in CI from `3216654` ([run 38535100979](https://github.com/munaxa/munaxa-docs/actions/runs/38535100979)) | **All passed** — the MinIO job, and the Cloudflare R2 test bucket job (§6): smoke 14/14 plus CORS; scanner verdicts confirmed in the database; 8/8; no credential in logs; 0 objects left |
| 2026-10-14 | `api` built locally from `0a7021d` (the five Phase A fixes), `web` with the F-1 fix, `antivirus` local | **All passed**, with Phase A (below): smoke 14/14; Phase A every expectation held; 8/8; no credential in 1562 log lines. On GitHub at `41bf8dd`: `CI` and the MinIO job passed (the job's first attempt failed on a Go module download before any test; its one re-run passed) |

### Phase A: local upload and download checks

```bash
EXTRA_CHECKS=infra/hetzner/testing/phase-a/phase-a.sh DOCS_API_IMAGE=… DOCS_WEB_IMAGE=… \
  DOCS_ANTIVIRUS_IMAGE=… infra/hetzner/testing/run-stack-test.sh
```

**Local MinIO only.** It refuses to run with `EXTERNAL_STORAGE_ENV`. After the standard checks it
runs seven steps, judged from the database and the store as well as from HTTP answers:
1. upload sizes and limits;
2. an upload without a confirmable checksum;
3. expired and slow upload links;
4. server-side multipart writes;
5. 4 and 8 uploads completed at once, with memory measured;
6. downloads: authorization, expired and edited links, and tampered and missing objects;
7. the API killed mid-completion, then the orphan sweep (dry run, real run, second run).

**Result on 2026-10-14** (API from `0a7021d`): every expectation held. ADR-0026 §10 has the full
record; in short:

| Area | Result |
| --- | --- |
| Memory, API limit 1536 MiB | 8 uploads of ~120 MiB at once: **550 MiB** peak, all CLEAN, no restart (before the fixes: 1509 MiB, then killed for running out of memory). 4 at once: 424 MiB (before: 1068 MiB). Slower: 83 s and 50 s wall time |
| Limits | 128 MiB accepted, 128 MiB + 1 refused naming "128 MB"; text over 32 MiB refused naming "32 MB" |
| Failed uploads | Each ends ABORTED, EXPIRED or still OPEN, with a message naming the cause; uploads interrupted by a killed API completed on retry |
| Orphan sweep | Dry run reported 3 orphaned objects and removed nothing; the real run removed those 3; a second run found 0; every live record's object was still present |
| Download integrity | Tampered and missing objects refused 409 before the verifier ran (before the fixes, the tampered bytes were served); authorization and link checks unchanged |
| Non-ASCII file names | Bytes correct, but the file name header is raw UTF-8 — for Phase B |

**Not production readiness.** Still open:
- a signed link is valid for 300 s after the integrity check, and objects with no stored checksum
  get only a size and age check (proposal:
  [`docs/reports/hetzner-download-integrity-proposal.md`](../../docs/reports/hetzner-download-integrity-proposal.md));
- scanning still holds each whole object in memory, and the scan budget is per process;
- browser downloads (Phase B) and every R2 behaviour beyond gate P-1 (Phase C);
- native review of the new Arabic messages.

The orphan sweep's grace period is 24 hours by default (`STORAGE_ORPHAN_GRACE_SECONDS`), and
`STORAGE_ORPHAN_SWEEP_DRY_RUN=true` makes it report without deleting. It never touches derived files
or audit evidence exports, and no bucket lifecycle rule is needed for it.

## 6. Gate P-1: the same checks against a real bucket

**Run against Cloudflare R2 on 2026-10-14: the compatibility test passed.** R2 is compatible with
the storage behaviours this test verifies. That is **not production readiness**: see *Still
unverified* below. Hetzner Object Storage has not been tested.

| | |
| --- | --- |
| Run | [GitHub Actions run 38535100979](https://github.com/munaxa/munaxa-docs/actions/runs/38535100979), job `external-storage`, at commit `3216654` |
| Bucket | `munaxa-docs-p1-storage-test`: Standard storage class, default jurisdiction, **eastern US (ENAM)**, private. Accessed with a token limited to that bucket. One CORS rule: origin `https://p1-storage-test.munaxa.invalid`, `PUT`, headers `content-type` and `x-amz-checksum-sha256` |
| Application fix | `3216654`: the S3 adapter's `head()` asks for an uncompressed answer. R2 omits `content-length` from a HEAD that allows gzip for text larger than a few dozen bytes, and the adapter had read that as size 0 (completion answered 415). A missing size is now refused, never guessed |
| Smoke checks | **14 of 14 standard checks passed, plus the browser CORS preflight (HTTP 204)**: completion with size and SHA-256 confirmed and scanned CLEAN, same-size tampered bytes refused (400), EICAR detected INFECTED |
| Scanner evidence | The tenant database records the ICAP scanner's verdicts, including the EICAR file as INFECTED with signature `Eicar-Test-Signature` (a stack-test step, not only the HTTP answer) |
| Cleanup | 33 objects removed, **0 left** under the run prefix |
| Credentials | None of the generated credentials, nor the storage secret, appears in the 580 container log lines. The storage file was deleted at the end of the job |
| Other checks on `3216654` | GitHub `CI` and the MinIO `stack` job passed. Locally: format, lint, typecheck and unit tests passed. The full integration suite passed 56 of 56 files **on its third run**. The two earlier runs each had three application-starting test files fail at start-up with a configuration error; those files passed when run alone |

**Still unverified, and needed before R2 could hold production documents:**
- Server-side **multipart** writes, used for large internal objects.
- **Downloads in a real browser**.
- **Backup and restore**.
- **Version history:** R2 has no S3 object versioning, so the version history ADR-0026 §6 requires
  needs an alternative to be designed and tested.
- **EU data residency:** the test bucket is in the eastern US, so no EU location or jurisdiction
  has been verified.

Nothing was deployed, merged or published, no DNS record was changed, and AWS was not accessed.

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

**On GitHub (how P-1 is run for Cloudflare R2).** The `external-storage` job of
`.github/workflows/hetzner-template.yml` writes that file from three secrets of the GitHub
environment `r2-storage-test` (`R2_TEST_ENDPOINT`, `R2_TEST_ACCESS_KEY_ID`,
`R2_TEST_SECRET_ACCESS_KEY`) and runs the same command against the test bucket
`munaxa-docs-p1-storage-test`, with the CORS origin `https://p1-storage-test.munaxa.invalid`. It runs
only for a pushed tag `storage-test/<name>` or a push whose head commit message contains
`[storage-test]` (on a ref the environment's deployment rules allow), and the file is deleted when
the job ends.

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
(which ADR-0026 §6 asks for; Cloudflare R2 does not offer S3 object versioning — its S3 API
documents `PutBucketVersioning` as not implemented), or
downloads in a real browser.
