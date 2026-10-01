# Deployment

**Purpose:** building the images, migrating every tenant, releasing, and going back.
**Audience:** release engineers.

## 1. What a release is

A release is **three images built from one commit, every tenant database migrated, then a rolling
replacement**. The order is not negotiable and the reason is 20 §4's expand → migrate → contract
rule: old and new code coexist during a rolling deploy, so the schema has to be compatible with
both, which means the migration goes first and every migration is additive until the release after
the one that stopped using the old shape.

```bash
# 1. The images. One commit, three targets, one tag.
export TAG="$(git rev-parse --short HEAD)"
for target in api web worker; do
  docker build --target "$target" \
    --secret id=npmrc,src="$HOME/.npmrc" \
    -t "munaxa-docs-$target:$TAG" .
done

# 2. Every tenant database, using the same runner and the same tenant list the API reads — from the
#    operator catalogue, which adds the owner (migration) URLs the running API never holds (ADR-0021 §3).
TENANT_CATALOGUE_PATH=/etc/munaxa/operator-catalogue.json node scripts/migrate-tenants.mjs

# 3. The rolling replacement, in this order.
#    Workers first: they drain, and a worker running old code against a migrated schema is the
#    case expand-only migrations exist for. API second. Web last, because it calls the API.
```

`--secret` rather than `--build-arg` for the registry token: a build argument is recorded in the
image's history and readable by anybody who can run `docker history`, which is the ordinary way a
token leaks.

**Step 2 runs from a checkout, not from an image.** `scripts/migrate-tenants.mjs` shells out to
`pnpm exec prisma`, and the runtime images carry neither pnpm nor the Prisma CLI — running it inside
one fails with `spawnSync pnpm ENOENT`. It is written for a release engineer's working copy at the
release commit, or a CI job on the same commit, with `DATABASE_MIGRATION_URL` and the tenant
catalogue in its environment. Phase 9.2 discovered this by trying the obvious thing first; the
alternative — a migration image that carries the CLI — is a real option and is not what ships today.

**The worker image starts, prints one line and exits 0.** Every consumer this product has runs in
the API process, gated on `QUEUE_CONSUMERS_ENABLED`, and `apps/worker/src/main.ts` exists as the
seam for the day that changes rather than as a consumer today. So step 3's "workers first, they
drain" is describing a process that currently drains nothing, and an orchestrator that expects a
long-running container will read the clean exit as a crash loop. Until that seam is composed, deploy
the worker image only if you have set `QUEUE_CONSUMERS_ENABLED=false` on the API — and know that in
that configuration nothing consumes the queues at all. The ordinary deployment is API and web.

**The full order for a production release**, with what the RC's final production-readiness gate
added (`docs/reports/release-candidate-final-validation.md`):

1. **Back up** every tenant database and the object store, immediately before the migration
   ([backup-and-restore.md](./backup-and-restore.md)). A rollback is new images, not a reversed
   migration (§6), so this backup is what a failed release falls back to.
2. **Drain client traffic**, when the release requires it. **The release that introduces the
   PostgreSQL idempotency claim (D-20) does.** Before it, `Idempotency-Key` replay records lived in
   Redis. After it they live in each tenant's `idempotency_key` table, and the Redis records are not
   imported. A request that completed before the upgrade and is retried under the same key after it
   is **performed again**. Stop new client writes and let in-flight retries settle before the
   migration. Exposure ends 24 hours after the last pre-upgrade request, the old replay window.
   Releases after that one need no drain for this reason.
3. **Migrate** every tenant database (step 2 above).
4. **Deploy the malware scanner first, then probe it.** `node infra/antivirus/probe.mjs <AV_ICAP_URL>`
   must exit 0 before an API instance that uses it takes traffic (§3.2).
5. **Deploy the API**, then the web (step 3 above). The worker image only as described below.
6. **Verify health.** `/api/health/ready` answers 200 on every instance, and `/api/health` shows
   `antivirus: UP`.
7. **Smoke test** before reopening traffic: sign in, upload and file a document, download it,
   search for it, and confirm the audit chain verifies.
8. **Rollback** is §6: the previous images against the migrated schema. This release's migrations
   are additive or relaxing, and the previous build does not read the new idempotency columns.
   **Rolling back below the D-3 antivirus fix is prohibited:** such a build has no real scanning
   (every upload is recorded `SKIPPED`). Permitted targets and the database rule (never restore over
   the live database) are in the go-live runbook §20.

**Worker images are built per deployment shape.** `--build-arg WITH_LIBREOFFICE=true` and
`--build-arg WITH_TESSERACT=true` decide whether the binaries are *present*; `OFFICE_DRIVER` and
`OCR_DRIVER` decide whether they are *called*. Both, because an image without LibreOffice cannot be
configured into having it and an image with it should not be paying 600 MB in a deployment that
previews nothing but PDFs.

## 2. The order the migration runner enforces, and why it fails loudly

`scripts/migrate-tenants.mjs` applies, per tenant, in this order: the per-database grants, the
Prisma migrations, then the post-migration SQL. It stops on the first tenant that fails and **names
it**, and every step is idempotent, so the re-run continues rather than restarting.

That is deliberate and it is the opposite of the usual instinct. A runner that carried on past a
failure would leave a release in which some customers' databases match the code and some do not,
which is 20 §4's own worst case — "half the customers running against a schema the code no longer
matches is worse than none of them migrated".

The post-migration SQL is where row-level security is applied, and it **discovers** the tables it
protects rather than listing them: every table in `public` with a `tenant_id` column gets `FORCE ROW
LEVEL SECURITY` and the `tenant_isolation` policy, and the script raises rather than finishing if it
finds one without. A phase that adds a tenant-scoped table therefore gets isolation without
remembering to ask for it.

## 3. Configuration

Every value is an environment variable validated at boot by a typed schema, and **an invalid or
missing production value fails startup**. `.env.example` documents every variable with a
placeholder. The ones a production deployment cannot omit:

| Variable | Why production refuses without it |
| --- | --- |
| `DATABASE_URL` | The restricted, `NOBYPASSRLS` application role |
| `DATABASE_MIGRATION_URL` | The owner role. Pipeline only — never in a running process's environment |
| `REDIS_URL` | Queues, cache and locks. Not optional since Phase 4 |
| `JWT_ACCESS_SECRET` | 32 characters minimum |
| `AUDIT_CHECKPOINT_SECRET` | Without it the daily pass verifies and records nothing an auditor can hold against a later reading |
| `SIGNATURE_WITNESS_SECRET` | A signature nothing witnessed is a row that looks identical to one that was |
| `MFA_TOTP_SEALING_KEY` | Phase 18. Its own key, so rotating the token secret does not make every enrolled authenticator unreadable — [ADR-0020](../architecture/adr/0020-key-management-and-rotation.md) |
| `STORAGE_DRIVER`, `MAIL_DRIVER`, `AV_DRIVER` | None may be `NONE`. An unconfigured driver in production is a silent outage waiting for its first upload |
| `AV_ICAP_URL` | Required by `AV_DRIVER=ICAP`, the only antivirus driver with an adapter (§3.2). `HOSTED` is refused in every environment |
| `OUTBOUND_HTTP_ALLOWLIST` | Not required, and **empty means nothing is reachable** — webhooks, federation and audit push are all inert until an operator names a host |
| `TRUST_PROXY` | Not required, and **empty means no hop is believed** — including the web server, so every browser signs in from its address and shares one allowance. Name the web servers and any load balancer (§3.1) |

Two variables are refused outright: `SENTRY_DSN` and `OTEL_EXPORTER_OTLP_ENDPOINT`. Neither has an
exporter in this build, and a variable that is accepted and ignored is worse than one that is
refused — an operator who sets it believes errors are being exported and finds out otherwise during
the incident it was set for. Metrics are served at `/api/metrics` under `METRICS_DRIVER=PROMETHEUS`;
errors are on the structured log stream.

### 3.1 Who may say who the client is — `TRUST_PROXY` and `WEB_TRUST_PROXY`

The sign-in rate limit is ten attempts per five minutes **per client address** (and, separately, per
identity). A process only sees the address of whatever connected to it, so every hop in front of it —
a load balancer, a reverse proxy, and **the web server itself**, because sign-in is a server action —
must be *named* before the address it reports is believed. Until it is, all of its clients share one
address and one allowance: the eleventh person to sign in within five minutes, in any tenant, is
refused. That was the release candidate's D-2.

Both variables take the same values and default to trusting nothing:

| Value | Meaning |
| --- | --- |
| *(empty)*, `false`, `0` | Trust no hop. The client is the connection; `X-Forwarded-For` is ignored |
| `10.0.4.0/24,10.0.9.7` | Trust hops whose own address is in these ranges. `loopback`, `linklocal` and `uniquelocal` name the usual private ranges |
| `1`, `2`, … | Trust exactly that many hops. **Only** if every request reaches the process through exactly that many — a client that can connect directly would have its own header believed |
| `true`, `*` | Refused at boot. Trusting everyone lets any client write its own address, which is a rate-limit bypass |

`TRUST_PROXY` is the API's; an invalid value fails startup. `WEB_TRUST_PROXY` is read by
`apps/web/server.mjs`, the web image's entry point, which resolves the browser's address from its own
socket and forwards it on the sign-in call; an invalid value stops the web server from starting. The
address is read from `X-Forwarded-For` from its right-hand end, and the walk stops at the first hop
that is not trusted — so an address a browser wrote for itself is never reached.

Configure it for the topology you run:

- **One server, no proxy (on-premise).** `TRUST_PROXY=loopback` (the web server calls the API over
  loopback). `WEB_TRUST_PROXY` empty.
- **Load balancer → web and API.** `TRUST_PROXY` = the web servers' range and the load balancer's
  range; `WEB_TRUST_PROXY` = the load balancer's range. Prefer ranges to hop counts here: browsers
  reach the API directly through the balancer and the web server reaches it with one more hop, so no
  single count is right for both paths.
- **API-only integrations, no web tier.** `TRUST_PROXY` = the balancer's range, or empty if clients
  connect directly.

Run the web image's own entry point (`node server.mjs`), not `next start`: under `next start` nothing
resolves the browser's address, so the sign-in action forwards none and every browser is the web
server again — safe, but back to one allowance for everybody.

### 3.2 The malware scanner — `AV_DRIVER=ICAP`

Every uploaded file is scanned before anything can use it, and only a scanner's own clean verdict
makes it usable. The API speaks ICAP (RFC 3507) `RESPMOD` to one scanning service. What CI and the
release candidate validate against is c-icap's `virus_scan` service in front of ClamAV's `clamd`,
with ClamAV's official signatures; any ICAP antivirus service that meets the requirements below will
do. Until RC D-3 the port was bound to the unconfigured adapter whatever `AV_DRIVER` said, so a
deployment could boot on `ICAP` and scan nothing.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AV_DRIVER` | `NONE` | `ICAP` in production. `NONE` is refused in production, and `HOSTED` everywhere — it has no adapter |
| `AV_ICAP_URL` | — | `icap://host[:port]/service`, e.g. `icap://scanner.internal:1344/avscan`. Required by `ICAP`, and refused when `AV_DRIVER` is not `ICAP`. Plain ICAP only: `icaps://` is refused rather than silently spoken unencrypted, so put the scanner on the private network beside the API |
| `AV_ICAP_MAX_BYTES` | 128 MiB | The largest file sent to the scanner. The API reads the whole object into memory to send it, so this is a memory bound too. Under `ICAP` the upload policy refuses anything larger **before it is stored**, so it is also the effective upload limit |
| `AV_SCAN_TIMEOUT_MS` | 120000 | How long one scan may take |

**What each outcome means.**

| Scanner answer | File status | Usable? |
| --- | --- | --- |
| `204` after receiving the whole file | `CLEAN` | Yes |
| `200` naming a threat (`X-Infection-Found`, `X-Violations-Found`, `X-Virus-ID`) | `INFECTED` — quarantined, `storage.file-quarantined` raised, audited with the threat | Never |
| Unreachable, timed out, an ICAP error, `204` before it had the file, or `200` naming no threat | `FAILED` | No |
| No scanner configured (`AV_DRIVER=NONE`, development only) | `SKIPPED` | No |

The client is told only the status. The threat name is in the audit record and the quarantine
event, and the scanner's name and signature tag (ICAP `ISTag`) are on the file row.

**The scanner must be configured to fail closed.** An ICAP server decides what it scans, and the
common defaults wave some files through as clean without scanning them — an answer the API cannot
tell apart from a real `204`. Whatever you run must hold these four properties. The c-icap and
ClamAV configurations in `infra/antivirus/` hold them, marked `REQUIRED`:

1. **Every file type is scanned.** c-icap passes type groups missing from `virus_scan.ScanFileTypes`
   as clean.
2. **Files up to `AV_ICAP_MAX_BYTES` are scanned whole.** c-icap's shipped `MaxObjectSize` is 5 MB and
   it passes larger objects as clean. ClamAV needs `AlertExceedsMax yes`, or a file past its own
   limits is reported clean unread.
3. **The verdict comes after the whole file.** c-icap's default for large objects streams them back
   with `200` before the scan finishes. The API records that as `FAILED`, which is safe but makes
   every large upload unusable; `mode=simple` on the service alias avoids it.
4. **An engine error is an error.** `virus_scan.PassOnError off`: with clamd down, c-icap must answer
   `500`, never `204`.

Check a scanner before pointing production at it. `node infra/antivirus/probe.mjs
icap://scanner.internal:1344/avscan` exits 0 only when a harmless payload comes back `204` **and** the
EICAR test file comes back blocked. A scanner that passes everything fails the second check.

**Keep the signatures fresh.** ClamAV's `freshclam` belongs on the scanner host, on its own schedule.
The `ISTag` recorded on each file changes when the signature set does.

**Readiness.** `/api/health` lists an `antivirus` dependency when `AV_DRIVER=ICAP`. The check is a
real scan of a few harmless bytes, not an ICAP `OPTIONS`, because c-icap answers `OPTIONS` perfectly
well with clamd dead. A failing scanner reports **`DEGRADED`, not `DOWN`**. Every instance shares
the scanner, so pulling instances out of rotation would fix nothing and would stop reads that do not
need it. Alert on it: while it lasts, every upload is recorded `FAILED` and cannot be used.

**Recovering from an outage.** Nothing is lost and nothing needs replaying. A file recorded `FAILED`
— or `SKIPPED` from before a scanner was configured — is scanned again the next time anybody uploads
the same bytes. Re-uploading is what a person does when a file is refused, and the new verdict
replaces the old one only if the file still has none. A file that already has a verdict is never
rescanned into a different one. Unused files are reclaimed by the usual blob grace period.

## 4. Secrets

They come from the platform's secret store — a KMS, a sealed secret, a mounted file, a vault agent,
or on a single on-premise server an environment file with `0600` on it. They are never committed and
never logged; `logger.ts` redacts at the logger rather than at each call site precisely so that a
future call site cannot forget.

Rotation is per key and the keys have deliberately different clocks
([ADR-0020](../architecture/adr/0020-key-management-and-rotation.md)):

| Key | Rotating it costs | Procedure |
| --- | --- | --- |
| `JWT_ACCESS_SECRET` | Every live session ends | Roll it, accept the sign-ins |
| `MFA_TOTP_SEALING_KEY` | Nothing visible | Set the new key; enrolments re-seal as people next prove a code. Keep the old value out of the environment only once every active enrolment has been used — a row sealed under a key you have removed is one nothing can read, and the error names the variable |
| `AUDIT_CHECKPOINT_SECRET` | Old checkpoints stop verifying under the new key | Roll it after a verification pass has caught up, and keep the old key with the archived checkpoints |
| `SIGNATURE_WITNESS_SECRET` | **The expensive one.** A signature must go on verifying for the record's retention period — seven years, often more | Do not roll it casually. The key identifier is derived from the key, so signatures made under the old one keep naming it; a deployment that rolls it must keep every prior key for as long as it keeps the records |

## 5. Health, and what each probe is for

| Probe | Answers | Touches |
| --- | --- | --- |
| `GET /api/health/live` | Is the process running? | Nothing. Deliberately — a liveness probe that failed during a database incident would restart every pod and turn a degradation into an outage |
| `GET /api/health/ready` | May this instance receive traffic? | Every tenant database it holds a placement for (sampled past `DATABASE_MAX_TENANT_CLIENTS`), and Redis |
| `GET /api/health` | Which dependency is unhappy | The same, with detail, plus the malware scanner under `AV_DRIVER=ICAP` (§3.2) — `DEGRADED` when it cannot scan. Carries no tenant data and no connection string |
| `GET /api/metrics` | The scrape body | Nothing. Requires `METRICS_SCRAPE_TOKEN` as a bearer token |

## 6. Going back

**A rollback is a deployment of the previous images, not a reversal of the migration.** Every
migration in this product is expand-only until the release after the one that stopped needing the
old shape, which is precisely what makes the previous images safe to run against the new schema. A
migration that cannot be written that way documents why in its own SQL, and a release containing one
is a release with a maintenance window rather than a rollback.

**Never roll back below the D-3 antivirus fix, and never restore a backup over the live database.**
A database that must be abandoned is restored into a new database and the catalogue repointed (go-live
runbook §20, backup-and-restore.md §2).

What a rollback does **not** undo: rows written by the new code. That is not a defect to be
engineered away — it is why data backfills are jobs rather than migrations (20 §4), so a partial
backfill is a resumable job rather than a schema somebody has to reverse.

## 7. The release checklist

Everything below is a gate. A failing gate is never skipped to go green.

For the first production deployment of the validated RC, the step-by-step procedure with its
Go/No-Go checklist is [`go-live-runbook.md`](./go-live-runbook.md).

- [ ] CI green on the commit: `format:check`, `lint`, `typecheck`, `test`, `test:integration` against **two** real tenant databases, `build`, and the product-isolation job
- [ ] The three images built from that commit, tagged with it
- [ ] `scripts/migrate-tenants.mjs` run against staging's catalogue; the post-migration gate passed
- [ ] A backup of every tenant database and the object store, taken immediately before the
      production migration
- [ ] Client traffic drained across the migration when the release requires it — the release that
      introduces the PostgreSQL idempotency claim (D-20) does (§1)
- [ ] `node infra/antivirus/probe.mjs <AV_ICAP_URL>` exits 0 against the production scanner — clean
      passed *and* EICAR blocked (§3.2) — and `/api/health` lists `antivirus` as `UP`
- [ ] Staging smoke: sign in, open a document, run a search, and confirm the audit chain verifies
- [ ] `infra/loadtest/run.mjs` against staging with many test identities (`--tokens-file`), and the
      table it prints attached to the release — see the caveat in `scenarios.mjs`: no phase has yet
      recorded a baseline, so the first run *is* the baseline rather than a comparison. A run with
      more than 1% failures or 429s is not a baseline
- [ ] The backup restore test is within its quarter ([backup-and-restore.md](./backup-and-restore.md))
- [ ] Production migration from a checkout at the release commit, then API, then web — see §1 on
      why the worker image is not part of an ordinary deployment
- [ ] `/api/health/ready` answering **200** on every instance before the load balancer is opened.
      It answers 503 while any dependency is DOWN, so the status code is the gate and the body names
      which dependency; before Phase 9.2 it answered 200 whatever it found
