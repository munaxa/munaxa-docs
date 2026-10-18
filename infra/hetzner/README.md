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
| `compose.yaml` | The production-shaped stack: proxy, web, api, antivirus, postgres, db-backup, redis, plus the one-off `ops` commands (`offsite` among them) |
| `compose.tls.yaml`, `Caddyfile.tls` | Direct TLS on the host: automatic HTTPS, ports 80/443, a volume for certificates (§9). Not used until D-2 |
| `Caddyfile`, `caddy/routes.caddy` | The plain-HTTP entry point, and ADR-0024's routing rule shared by both Caddyfiles |
| `deploy.env.example`, `deploy.test.env.example` | Which images and which secret directory one environment uses (not secret); the second is the TEST environment's, with direct TLS |
| `offsite/offsite.sh` | The off-server backup copy and its recovery (`fetch`) (§7) |
| `config/*.example` | Placeholder versions of every secret file. **Real copies never go in git** (`.gitignore` refuses them) |
| `ops/db-admin.sh` | Database bootstrap and tenant-database creation (go-live-runbook.md §6) |
| `ops/pnpm` | The `pnpm exec` stand-in the migration runner needs inside the API image (ADR-0026 §8) |
| `ops/host-check.sh`, `ops/monitor.sh` | The server's own check, and its delivery: the dead-man's-switch ping or the findings (§8) |
| `ops/check-deploy-env.sh` | Checks a `deploy.env` (and, with `--on-host`, the server's files) before anything starts |
| `ops/systemd/` | The timers: host check every 5 minutes, off-server copy every 15 |
| `postgres/` | PostgreSQL 16.10 plus `age` and the backup scripts: WAL archiving, `munaxa-backup`, `pg_hba.conf` (§7); `verify-image.sh` accepts a build before it is published |
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
| `backup.env` | db-backup | `PGPASSWORD` of `edms_backup` (the same value as in `operator.env`) |
| `offsite.env` | offsite | The off-server bucket and its no-delete credential (§7) |
| `monitoring.env` | ops/monitor.sh (host) | The heartbeat URL, optional alert URLs, and who is paged (§8) |

**Ownership.** The `*.env` files are read by Docker Compose on the host: owner `root`, mode `0600`.
The two catalogues are bind-mounted into containers that run as the image's unprivileged `node`
user (uid 1000), so they must be readable by that user and nobody else:
`chown 1000:1000 tenants.json operator-tenants.json && chmod 0400 tenants.json operator-tenants.json`.
(Found by the stack test: with root-only files the migration runner stops with `EACCES`.)

Then a `deploy.env` from `deploy.env.example` (TEST: `deploy.test.env.example`), naming the release
digests, and `ops/check-deploy-env.sh deploy.env --on-host` until it reports nothing wrong.

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

Measured locally (ADR-0026 §10):
- 128 MiB: first byte after 1.5 s.
- 8 × 128 MiB at once: about 15 s each, with 1 GiB staged.
- The API process's own memory stays near 200 MiB. The page cache of the staged files counts
  against the container's limit; size the server for it.

Report, audit and bulk exports use the same verified links (ADR-0026 §10, "Exports moved onto
verified delivery"). Since R-9 nothing in the API signs a store URL for reading at all: the preview
pipeline reads its sources on the port and checks their digests too.

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
| 2026-10-14 | `api` built locally from `296b131` (verified downloads, verifier and file-name fixes), `web` with the F-1 fix, `antivirus` local | **All passed**, Phase A included: tampered, deleted and unavailable objects deliver no file bytes; outage not quarantined; staging left empty; 8 × 128 MiB downloads at once in about 15 s with the API's own memory at 202 MiB (cgroup 1266 MiB with page cache); no credential in 1732 log lines. ADR-0026 §10 has the record |

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

**Storage readiness for Hetzner Object Storage (prepared, not run: no bucket exists).**
`testing/storage/run-storage-readiness.sh` asks the store, through the product's own adapter, what
the verified reads, quarantine and recovery depend on: private access, upload and download
integrity (size and SHA-256), the refusal of mismatched bytes, missing objects, server-side
multipart, an aborted multipart leaving nothing, overwritten bytes being what a read returns,
versioning (list, read, restore a prior version, undo a delete), Object Lock (an early delete
refused, a late one allowed), credential scope (another bucket refused) and cleanup of every
version. Against MinIO it passes 30 of 30 with versioning and Object Lock on, and reports those two
as UNSUPPORTED — or FAIL when expected — on a bucket without them. The same file format as
`EXTERNAL_STORAGE_ENV`, plus `STORAGE_TEST_EXPECT_VERSIONING=1`, `STORAGE_TEST_EXPECT_OBJECT_LOCK=1`
and `STORAGE_TEST_OTHER_BUCKET`, runs it against the real bucket; with the stack test against that
bucket (above) it is gate P-1 for Hetzner Object Storage. End-to-end downloads, quarantine of a
swapped or vanished file and the store-outage case run in a browser in Phase B, against MinIO only.

**What a pass will and will not prove.** It proves the single-PUT upload path, checksum confirmation,
tampered-byte refusal and scanner read-back on that provider. It does not exercise server-side
multipart writes (used for large internal objects such as audit evidence exports), object versioning
(which ADR-0026 §6 asks for; Cloudflare R2 does not offer S3 object versioning — its S3 API
documents `PutBucketVersioning` as not implemented), or
downloads in a real browser.

## 7. Backups (R-1)

What runs, in plain terms:

- **PostgreSQL archives every WAL segment** as it completes, at most `DOCS_WAL_ARCHIVE_TIMEOUT`
  (300 s) after a write, encrypted with `age` to the public keys in `DOCS_BACKUP_AGE_RECIPIENTS`,
  onto `DOCS_BACKUP_DIR/wal`. A failure keeps the segment in `pg_wal` and retries; nothing is lost
  while it fails, but `pg_wal` grows (monitoring M9).
- **`db-backup` takes a base backup and one dump per tenant database** every night at
  `DOCS_BACKUP_AT` (UTC), and one at its first start. Both are encrypted the same way.
  - The base backup is `pg_basebackup -Ft` with the WAL inside and a SHA-256 manifest.
  - The dumps are `pg_dump --format=custom` as `edms_backup`, plus the role definitions without
    passwords.
  - Then it prunes: base backups and their WAL after `DOCS_BACKUP_RETENTION_DAYS` (35), dumps
    after `DOCS_BACKUP_DUMP_RETENTION_DAYS` (35), always keeping the newest two.
  - It writes `status/backup.prom` for monitoring.
- **The server cannot read its own backups.** It holds only public keys. Both containers refuse to
  run beside a private key, and refuse a backup directory on the database's own filesystem.

| Property | Value | Where |
| --- | --- | --- |
| RPO (cluster, point in time) | ≤ 5 min of committed writes plus whatever had not left the server when it was lost | `archive_timeout`; but see the off-server copy below |
| RTO | Not measured at production scale; the local drill's numbers are in the readiness report | backup-and-restore.md §5 |
| Encryption | `age` X25519, public-key; identities offline with two holders (key-rotation.md §5) | `postgres/` scripts |
| Integrity | SHA-256 of every encrypted file at write; of every WAL segment's plaintext; the base backup's own manifest checked by `pg_verifybackup` on restore | `munaxa-backup decrypt`, `restore-base`, `munaxa-restore-wal` |
| Access | Backup volume owned by uid 70, mode 0700; `db-backup` has no network but the private `data` one; `edms_backup` may replicate only from that network | compose.yaml, `postgres/pg_hba.conf` |

### Setting it up on a server

1. Attach a volume that is **not** the root disk (a Hetzner Volume, for example), mount it, for
   example at `/mnt/munaxa-backup`, then `chown 70:70` and `chmod 0700` it, and create `wal/`
   inside it the same way.
2. Generate **two** age identities **offline** (`age-keygen`, on the owner's and a second holder's
   machines). Put only the two public keys in `DOCS_BACKUP_AGE_RECIPIENTS`; record the identities
   in the escrow (key-rotation.md §5). Never copy an identity to the server.
3. Write `backup.env`, run `db-admin bootstrap` (it grants `edms_backup` REPLICATION), then
   `$C up -d`.
4. Check: `$C exec db-backup munaxa-backup list` shows a base backup and a dump set;
   `$C exec db-backup munaxa-backup health` exits 0.

### Copying it off the server

The volume is on the same server and the same provider as the database, so a lost server or a lost
Hetzner account loses both. ADR-0026 §9 requires an encrypted copy **at a different provider**.
That is the `offsite` service (`offsite/offsite.sh`, profile `ops`), run every 15 minutes by
`ops/systemd/munaxa-offsite.timer`:

- it copies the volume's files — already ciphertext — to a bucket at another provider, mounting the
  volume **read-only**, holding no key that can decrypt them;
- it **never deletes or overwrites** anything on the remote, and its credential should not be able
  to either;
- it reads back every new file (size, the provider's MD5 when it has one, and the SHA-256 of the
  downloaded bytes) and only then records it; a base backup or dump set is a recovery point on the
  remote only once its `COMPLETE` marker is written, after all its files verified;
- `offsite fetch` recovers onto a new host from the remote alone, checking every byte.

Procedure, retention and failure handling: backup-and-restore.md §5.5.

**Setting it up** (after the provider account exists — not yet the case):

1. In the provider's console: a private bucket in an EU region, versioning on, Object Lock if
   offered, a lifecycle rule (versions ≥ 45 days; abort unfinished uploads after 1 day), and a key
   limited to that bucket that can list, read and write but not delete.
2. `config/offsite.env.example` → `${DOCS_CONFIG_DIR}/offsite.env`, mode 0600.
3. `mkdir -p /var/lib/munaxa-docs/offsite && chown 70:70 … && chmod 0700 …` (`DOCS_OFFSITE_STATE_DIR`).
4. `$C --profile ops run --rm offsite validate`, then `… offsite sync` once by hand.
5. Install and enable `ops/systemd/munaxa-offsite.{service,timer}`.

**Tested:** `testing/offsite/test-offsite.sh` against MinIO (outage, interrupted and duplicate
runs, foreign objects, fetch and decrypt, a refused delete), and the drill recovers a cluster from
the fetched copy. **Not tested:** any real provider; Backblaze B2 and Scaleway are proposals whose
EU region and Object Lock must be confirmed in the console.

### Restoring

[backup-and-restore.md §5](../../docs/operations/backup-and-restore.md) has the procedures: a whole
cluster to a point in time, and one tenant from its dump. They are what
`testing/backup/backup-drill.sh` runs.

### Tests

- `testing/backup/test-backup-scripts.sh`: the scripts alone. It covers encryption, idempotent and
  never-overwriting archiving, digest checks, every configuration refusal, base backups, dumps,
  retention, status and failure reporting, and `restore-base`. Negative control: removing the
  same-device and no-overwrite guards fails 3 checks.
- `testing/backup/backup-drill.sh` (as `EXTRA_CHECKS`): point-in-time recovery and a tenant
  restore from the real stack's data, with the audit chain, RLS and tenant-isolation checks.
- `testing/run-stack-test.sh` itself checks, on every run, that the first backup exists, that WAL
  is archived with no failures, that nothing on the volume is plaintext, and that the off-server
  copy to the stand-in bucket verifies.
- `testing/offsite/test-offsite.sh`: the off-server copy's failure paths (above).

## 8. Monitoring

[docs/operations/monitoring.md](../../docs/operations/monitoring.md). In short:

- `ops/host-check.sh` checks disks, memory, every container and its health, PostgreSQL, backups and
  WAL archiving, the off-server copy, readiness, the object store, integrity/audit/scanner log
  signals, signature age and — with direct TLS — the certificate. Counts and ages only.
- `ops/monitor.sh` runs it every 5 minutes (`ops/systemd/munaxa-host-check.{service,timer}`) and
  pings a dead-man's switch when all is well, or sends the finding lines to an optional failure
  endpoint and webhook. Configuration: `config/monitoring.env.example`, whose recipients and URLs
  are **required placeholders** until the owner supplies them.

**Tested:** the host check in the stack test (healthy; a crossed limit; a stopped object store, a
failed copy and stale signatures, each named and then cleared); delivery against a local receiver
(`testing/monitoring/test-monitor.sh`). **Not tested:** a real heartbeat service, phone or e-mail
delivery, the timers on a server.

## 9. Direct TLS on the host (TEST recommendation, not yet chosen)

`compose.tls.yaml` with `Caddyfile.tls` (routes shared through `caddy/routes.caddy`): Caddy obtains
and renews a Let's Encrypt certificate for `DOCS_PUBLIC_HOSTNAME`, redirects HTTP to HTTPS, sends
HSTS, publishes only 80 and 443, and keeps its certificates on a volume. PostgreSQL, Redis and the
scanner still publish nothing.

```bash
C="docker compose --env-file deploy.env -f infra/hetzner/compose.yaml -f infra/hetzner/compose.tls.yaml"
infra/hetzner/ops/check-deploy-env.sh deploy.env --on-host   # refuses a missing or example host name
```

**Before the first start:** the A record points at the server's IPv4 (DNS only, not proxied; no
AAAA, because the overlay publishes on IPv4 only), ports 80 and 443 are open in
the Hetzner Cloud Firewall, and — for the first issuance — `DOCS_ACME_CA` names Let's Encrypt's
staging directory (`deploy.test.env.example`). **Tested** without any certificate authority or DNS:
`testing/tls/test-tls.sh` (configuration, rendered ports and networks, routing, redirect, HSTS, the
certificate's name, the token kept out of the log, and the certificate surviving a restart because
`/data` persists). **Not tested:** a real issuance or renewal.
