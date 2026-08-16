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

# 2. Every tenant database, using the same runner and the same catalogue the API reads.
TENANT_CATALOGUE_PATH=/etc/munaxa/tenants.json node scripts/migrate-tenants.mjs

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
| `OUTBOUND_HTTP_ALLOWLIST` | Not required, and **empty means nothing is reachable** — webhooks, federation and audit push are all inert until an operator names a host |

Two variables are refused outright: `SENTRY_DSN` and `OTEL_EXPORTER_OTLP_ENDPOINT`. Neither has an
exporter in this build, and a variable that is accepted and ignored is worse than one that is
refused — an operator who sets it believes errors are being exported and finds out otherwise during
the incident it was set for. Metrics are served at `/api/metrics` under `METRICS_DRIVER=PROMETHEUS`;
errors are on the structured log stream.

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
| `GET /api/health` | Which dependency is unhappy | The same, with detail. Carries no tenant data and no connection string |
| `GET /api/metrics` | The scrape body | Nothing. Requires `METRICS_SCRAPE_TOKEN` as a bearer token |

## 6. Going back

**A rollback is a deployment of the previous images, not a reversal of the migration.** Every
migration in this product is expand-only until the release after the one that stopped needing the
old shape, which is precisely what makes the previous images safe to run against the new schema. A
migration that cannot be written that way documents why in its own SQL, and a release containing one
is a release with a maintenance window rather than a rollback.

What a rollback does **not** undo: rows written by the new code. That is not a defect to be
engineered away — it is why data backfills are jobs rather than migrations (20 §4), so a partial
backfill is a resumable job rather than a schema somebody has to reverse.

## 7. The release checklist

Everything below is a gate. A failing gate is never skipped to go green.

- [ ] CI green on the commit: `format:check`, `lint`, `typecheck`, `test`, `test:integration` against **two** real tenant databases, `build`, and the product-isolation job
- [ ] The three images built from that commit, tagged with it
- [ ] `scripts/migrate-tenants.mjs` run against staging's catalogue; the post-migration gate passed
- [ ] Staging smoke: sign in, open a document, run a search, and confirm the audit chain verifies
- [ ] `infra/loadtest/run.mjs` against staging, and the table it prints attached to the release —
      see the caveat in `scenarios.mjs`: no phase has yet recorded a baseline, so the first run
      *is* the baseline rather than a comparison
- [ ] The backup restore test is within its quarter ([backup-and-restore.md](./backup-and-restore.md))
- [ ] Production migration from a checkout at the release commit, then API, then web — see §1 on
      why the worker image is not part of an ordinary deployment
- [ ] `/api/health/ready` answering **200** on every instance before the load balancer is opened.
      It answers 503 while any dependency is DOWN, so the status code is the gate and the body names
      which dependency; before Phase 9.2 it answered 200 whatever it found
