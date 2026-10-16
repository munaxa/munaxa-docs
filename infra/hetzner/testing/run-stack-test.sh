#!/usr/bin/env bash
# Runs the Hetzner template end to end in a disposable local/CI stack (infra/hetzner/README.md §5).
#
#   DOCS_API_IMAGE=… DOCS_WEB_IMAGE=… DOCS_ANTIVIRUS_IMAGE=… infra/hetzner/testing/run-stack-test.sh
#
# The three images are the ones under test: locally built tags, or the digests a release published.
# Every credential is generated for this run into a private temporary directory, is never printed,
# and is deleted with the stack at the end. Nothing here contacts Hetzner, Cloudflare or AWS.
#
# Optional:
#   CLAMAV_SEED_DIR    a directory of ClamAV signatures to seed the scanner volume with (CI caches
#                      one a day, as ci.yml does, because ClamAV's mirrors throttle repeat downloads)
#   CLAMAV_EXPORT_DIR  copy the scanner's signatures here after the run, for that cache
#   EXTRA_COMPOSE_FILE one more overlay, for an environment's own plumbing (never a product setting)
#   EXTERNAL_STORAGE_ENV  a file naming a REAL S3-compatible bucket (Cloudflare R2, Hetzner Object
#                      Storage) to run the same upload checks against instead of MinIO — gate P-1
#                      (README.md §6). Parsed, never executed; its values are never printed. Only
#                      these keys are read: STORAGE_DRIVER, STORAGE_BUCKET, STORAGE_REGION,
#                      STORAGE_ENDPOINT, STORAGE_FORCE_PATH_STYLE, STORAGE_ACCESS_KEY_ID,
#                      STORAGE_SECRET_ACCESS_KEY, and optionally STORAGE_TEST_CORS_ORIGIN (the web
#                      origin the bucket's CORS rule admits, for a browser preflight check).
#                      Each run writes under its own prefix and deletes what it wrote afterwards.
#   STACKTEST_BACKUP_DIR  the backup volume to use (default: a new temporary directory). Point it
#                      at a separate filesystem (a tmpfs, a second disk) to run with the backup
#                      scripts' same-device refusal ON, as production does; with the default
#                      directory the refusal is relaxed for the test (compose.test.yaml), because a
#                      CI runner has one disk.
#   KEEP_STACK=1       leave the stack and its config running for inspection
#   EXTRA_CHECKS       a script SOURCED after the standard checks, with this script's functions and
#                      values in scope (compose, step, tenant_sql, $config, $run_prefix, $admin_pw).
#                      Used by testing/phase-a/phase-a.sh. It may define `extra_cleanup`, which runs
#                      before the stack is torn down, whether or not the run passed, and set
#                      `extra_failures`, which fails the run after the remaining checks.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$(cd "$here/.." && pwd)"

: "${DOCS_API_IMAGE:?set DOCS_API_IMAGE}"
: "${DOCS_WEB_IMAGE:?set DOCS_WEB_IMAGE}"
: "${DOCS_ANTIVIRUS_IMAGE:?set DOCS_ANTIVIRUS_IMAGE}"
export DOCS_API_IMAGE DOCS_WEB_IMAGE DOCS_ANTIVIRUS_IMAGE
export DOCS_PROJECT_NAME="${DOCS_PROJECT_NAME:-munaxa-docs-stacktest}"
# PostgreSQL with the backup scripts (postgres/Dockerfile): built from this checkout unless an
# image under this name already exists (a CI build step, or a local build).
export DOCS_POSTGRES_IMAGE="${DOCS_POSTGRES_IMAGE:-munaxa-docs-postgres:stacktest}"

config="$(mktemp -d)"
chmod 700 "$config"
export DOCS_CONFIG_DIR="$config"

files=(-f "$template/compose.yaml" -f "$here/compose.test.yaml")
if [ -n "${EXTRA_COMPOSE_FILE:-}" ]; then
  files+=(-f "$EXTRA_COMPOSE_FILE")
fi
compose() { docker compose "${files[@]}" "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- stack state at failure"
    compose ps -a || true
    for service in api web proxy antivirus postgres redis storage; do
      echo "--- last log lines: $service"
      compose logs --no-color --tail 40 "$service" 2>/dev/null || true
    done
  fi
  # An external bucket keeps what it is given, the EICAR test file included, so this run removes
  # everything under its own prefix — through the product's own S3 adapter, as
  # scripts/storage-backup.mjs does, with the API's own configuration — whether or not it passed.
  if [ -n "${EXTERNAL_STORAGE_ENV:-}" ] && [ -f "$config/api.env" ]; then
    echo "--- removing this run's objects (prefix $run_prefix/) from the external bucket"
    # shellcheck disable=SC2016 # the single-quoted text is JavaScript, read by node, not the shell
    compose run --rm --no-deps -T -e "RUN_PREFIX=$run_prefix/" --entrypoint node api -e '
      const { S3StorageAdapter } = require("/app/apps/api/dist/infrastructure/storage/s3.adapter.js");
      const e = process.env;
      const storage = new S3StorageAdapter({
        driver: e.STORAGE_DRIVER, bucket: e.STORAGE_BUCKET, region: e.STORAGE_REGION,
        endpoint: e.STORAGE_ENDPOINT, forcePathStyle: e.STORAGE_FORCE_PATH_STYLE === "true",
        credentials: { accessKeyId: e.STORAGE_ACCESS_KEY_ID, secretAccessKey: e.STORAGE_SECRET_ACCESS_KEY },
        now: () => new Date(),
      });
      (async () => {
        const keys = await storage.list(e.RUN_PREFIX);
        for (const key of keys) await storage.delete(key);
        const left = await storage.list(e.RUN_PREFIX);
        console.log(`removed ${keys.length} object(s); ${left.length} left under the run prefix`);
        process.exit(left.length === 0 ? 0 : 1);
      })().catch((error) => { console.error(`cleanup failed: ${error.message}`); process.exit(1); });
    ' || echo "WARNING: could not remove every test object; delete prefix $run_prefix/ by hand"
  fi
  if declare -F extra_cleanup >/dev/null; then
    extra_cleanup || echo "WARNING: the extra checks' own cleanup did not complete"
  fi
  if [ "${KEEP_STACK:-}" = "1" ]; then
    echo "KEEP_STACK=1: stack left running; config in $config, backups in ${DOCS_BACKUP_DIR:-}"
  else
    compose --profile ops --profile test down --volumes --remove-orphans >/dev/null 2>&1 || true
    # The backup files belong to the image's postgres user, so they are removed from a container.
    if [ -n "${DOCS_BACKUP_DIR:-}" ] && [ -d "$DOCS_BACKUP_DIR" ]; then
      docker run --rm --entrypoint sh -v "$DOCS_BACKUP_DIR:/b" "$DOCS_POSTGRES_IMAGE" \
        -c 'rm -rf /b/* /b/.[!.]* 2>/dev/null; true' >/dev/null 2>&1 || true
      [ -n "${STACKTEST_BACKUP_DIR:-}" ] || rmdir "$DOCS_BACKUP_DIR" 2>/dev/null || true
    fi
    if [ -n "${DOCS_OFFSITE_STATE_DIR:-}" ] && [ -d "$DOCS_OFFSITE_STATE_DIR" ]; then
      docker run --rm --entrypoint sh -v "$DOCS_OFFSITE_STATE_DIR:/s" "$DOCS_POSTGRES_IMAGE" \
        -c 'rm -rf /s/* /s/.[!.]* 2>/dev/null; true' >/dev/null 2>&1 || true
      rmdir "$DOCS_OFFSITE_STATE_DIR" 2>/dev/null || true
    fi
    rm -rf "$config"
  fi
  exit "$status"
}
trap cleanup EXIT

step() { printf '\n=== %s\n' "$*"; }

# One value from EXTERNAL_STORAGE_ENV, by exact key, without executing the file.
external() {
  local line
  line="$(grep -E "^$1=" "$EXTERNAL_STORAGE_ENV" | tail -n 1 || true)"
  printf '%s' "${line#*=}"
}
secret() { openssl rand -hex 32; }

# --- Throwaway configuration ---------------------------------------------------------------------
step "Generating a throwaway configuration (values never printed)"
umask 077
owner_pw="$(secret)" app_pw="$(secret)" backup_pw="$(secret)" redis_pw="$(secret)"
minio_user="stacktest-$(openssl rand -hex 4)" minio_pw="$(secret)" admin_pw="Sm0ke-$(secret)"
offsite_key_id="offsite-$(openssl rand -hex 4)" offsite_secret="$(secret)"
acme_id="$(node -e 'console.log(crypto.randomUUID())' 2>/dev/null || cat /proc/sys/kernel/random/uuid)"
rival_id="$(node -e 'console.log(crypto.randomUUID())' 2>/dev/null || cat /proc/sys/kernel/random/uuid)"

cat > "$config/postgres.env" <<EOF
POSTGRES_USER=postgres
POSTGRES_PASSWORD=$(secret)
EOF

cat > "$config/redis.env" <<EOF
REDIS_PASSWORD=$redis_pw
EOF

cat > "$config/operator.env" <<EOF
EDMS_OWNER_PASSWORD=$owner_pw
EDMS_APP_PASSWORD=$app_pw
EDMS_BACKUP_PASSWORD=$backup_pw
EOF

cat > "$config/backup.env" <<EOF
PGPASSWORD=$backup_pw
EOF

cat > "$config/minio.env" <<EOF
MINIO_ROOT_USER=$minio_user
MINIO_ROOT_PASSWORD=$minio_pw
OFFSITE_TEST_KEY_ID=$offsite_key_id
OFFSITE_TEST_SECRET=$offsite_secret
EOF

# The off-server copy (README.md §7) to a stand-in bucket on the test MinIO, with a credential that
# cannot delete (compose.test.yaml, storage-init). Plain http only because MinIO here has no TLS.
cat > "$config/offsite.env" <<EOF
RCLONE_CONFIG_OFFSITE_TYPE=s3
RCLONE_CONFIG_OFFSITE_PROVIDER=Minio
RCLONE_CONFIG_OFFSITE_ENDPOINT=http://storage:9000
RCLONE_CONFIG_OFFSITE_REGION=us-east-1
RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=$offsite_key_id
RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=$offsite_secret
OFFSITE_BUCKET=munaxa-docs-offsite-test
OFFSITE_PREFIX=stacktest
OFFSITE_ALLOW_INSECURE_ENDPOINT=1
EOF

# Object storage: the test MinIO, or the external bucket under test (gate P-1).
run_prefix="stacktest-$(openssl rand -hex 6)"
if [ -n "${EXTERNAL_STORAGE_ENV:-}" ]; then
  [ -r "$EXTERNAL_STORAGE_ENV" ] || { echo "EXTERNAL_STORAGE_ENV is not a readable file"; exit 1; }
  s_driver="$(external STORAGE_DRIVER)" s_bucket="$(external STORAGE_BUCKET)"
  s_region="$(external STORAGE_REGION)" s_endpoint="$(external STORAGE_ENDPOINT)"
  s_path_style="$(external STORAGE_FORCE_PATH_STYLE)" s_key_id="$(external STORAGE_ACCESS_KEY_ID)"
  s_secret="$(external STORAGE_SECRET_ACCESS_KEY)" s_cors="$(external STORAGE_TEST_CORS_ORIGIN)"
  for pair in "STORAGE_DRIVER:$s_driver" "STORAGE_BUCKET:$s_bucket" "STORAGE_REGION:$s_region" \
    "STORAGE_ENDPOINT:$s_endpoint" "STORAGE_ACCESS_KEY_ID:$s_key_id" \
    "STORAGE_SECRET_ACCESS_KEY:$s_secret"; do
    [ -n "${pair#*:}" ] || { echo "EXTERNAL_STORAGE_ENV does not set ${pair%%:*}"; exit 1; }
  done
  case "$s_driver" in S3 | R2) ;; *) echo "STORAGE_DRIVER must be S3 or R2"; exit 1 ;; esac
  case "$s_endpoint" in https://*) ;; *) echo "STORAGE_ENDPOINT must be https://"; exit 1 ;; esac
  echo "Object storage under test: EXTERNAL ($s_driver, bucket and endpoint from EXTERNAL_STORAGE_ENV)"
else
  s_driver=S3 s_bucket=munaxa-docs-test s_region=us-east-1 s_endpoint=http://storage:9000
  s_path_style=true s_key_id="$minio_user" s_secret="$minio_pw" s_cors=''
  echo "Object storage under test: the test MinIO"
fi
storage="\"storage\":{\"driver\":\"$s_driver\",\"container\":\"$s_bucket\",\"prefixTemplate\":\"$run_prefix/tenants/{slug}\"},\"search\":{\"indexTemplate\":\"docs-{slug}\"}"
tenants="\"tenants\":[{\"id\":\"$acme_id\",\"slug\":\"acme\"},{\"id\":\"$rival_id\",\"slug\":\"rival\"}]"
cat > "$config/tenants.json" <<EOF
{"defaults":{"databaseUrlTemplate":"postgresql://edms_app:$app_pw@postgres:5432/edms_{slug}",$storage},$tenants}
EOF
cat > "$config/operator-tenants.json" <<EOF
{"defaults":{"migrationUrlTemplate":"postgresql://edms_owner:$owner_pw@postgres:5432/edms_{slug}",$storage},$tenants}
EOF

# The two catalogues are bind-mounted files read by the API image's own user (`node`, uid 1000), so
# they belong to that uid, read-only (README.md §3). The env files are read by Compose on the host
# and stay owned by whoever runs this.
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }
as_root chown 1000:1000 "$config/tenants.json" "$config/operator-tenants.json"
as_root chmod 0400 "$config/tenants.json" "$config/operator-tenants.json"

# Production values throughout: NODE_ENV=production is set by compose.yaml, and nothing here relaxes
# what it validates. Mail names an SMTP relay under the reserved `.invalid` domain with STARTTLS and
# certificate validation: boot validation is satisfied honestly and no message can leave the stack.
cat > "$config/api.env" <<EOF
LOG_LEVEL=info
DATABASE_URL=postgresql://edms_app:$app_pw@postgres:5432/edms_acme
DATABASE_POOL_SIZE=5
REDIS_URL=redis://:$redis_pw@redis:6379
JWT_ACCESS_SECRET=$(secret)
SIGNATURE_WITNESS_SECRET=$(secret)
AUDIT_CHECKPOINT_SECRET=$(secret)
MFA_TOTP_SEALING_KEY=$(secret)
CORS_ORIGINS=http://localhost:8080
WEB_BASE_URL=http://localhost:8080
STORAGE_DRIVER=$s_driver
STORAGE_BUCKET=$s_bucket
STORAGE_REGION=$s_region
STORAGE_ENDPOINT=$s_endpoint
STORAGE_FORCE_PATH_STYLE=${s_path_style:-false}
STORAGE_ACCESS_KEY_ID=$s_key_id
STORAGE_SECRET_ACCESS_KEY=$s_secret
STORAGE_PUBLIC_URL=http://localhost:8080
MAIL_DRIVER=SMTP
MAIL_SMTP_HOST=smtp.invalid
MAIL_SMTP_PORT=587
MAIL_SMTP_SECURITY=STARTTLS
MAIL_FROM_ADDRESS=no-reply@docs.invalid
EOF

cat > "$config/provision.env" <<EOF
TENANT_ID=$acme_id
TENANT_SLUG=acme
TENANT_NAME=Stack Test Acme
ADMIN_EMAIL=admin@acme.invalid
ADMIN_NAME=Stack Test Administrator
ADMIN_PASSWORD=$admin_pw
DATABASE_URL=postgresql://edms_app:$app_pw@postgres:5432/edms_acme
EOF

cat > "$config/smoke.env" <<EOF
SMOKE_TENANT=acme
SMOKE_ADMIN_EMAIL=admin@acme.invalid
SMOKE_ADMIN_PASSWORD=$admin_pw
SMOKE_CORS_ORIGIN=$s_cors
EOF

# --- Backups: a volume, and a key pair for this run only -------------------------------------------
step "Preparing the backup volume and this run's backup key pair"
if ! docker image inspect "$DOCS_POSTGRES_IMAGE" >/dev/null 2>&1; then
  compose build postgres
fi
if [ -n "${STACKTEST_BACKUP_DIR:-}" ]; then
  export DOCS_BACKUP_DIR="$STACKTEST_BACKUP_DIR"
  export STACKTEST_BACKUP_ALLOW_SAME_DEVICE="${STACKTEST_BACKUP_ALLOW_SAME_DEVICE:-0}"
else
  DOCS_BACKUP_DIR="$(mktemp -d)"
  export DOCS_BACKUP_DIR
  export STACKTEST_BACKUP_ALLOW_SAME_DEVICE="${STACKTEST_BACKUP_ALLOW_SAME_DEVICE:-1}"
fi
as_root mkdir -p "$DOCS_BACKUP_DIR/wal"
as_root chown -R 70:70 "$DOCS_BACKUP_DIR"
as_root chmod 0700 "$DOCS_BACKUP_DIR"
# The off-server copy job's own state (status file, lock), uid 70 like the volume it reads.
DOCS_OFFSITE_STATE_DIR="$(mktemp -d)"
export DOCS_OFFSITE_STATE_DIR
as_root chown 70:70 "$DOCS_OFFSITE_STATE_DIR"
as_root chmod 0700 "$DOCS_OFFSITE_STATE_DIR"
# The identity (private key) exists for this run only, in the private config directory, because the
# drill restores from what it backs up. A deployment never has it on the server (README.md §7).
docker run --rm --entrypoint age-keygen "$DOCS_POSTGRES_IMAGE" >"$config/backup-identity.txt" 2>/dev/null
backup_identity_secret="$(grep -o 'AGE-SECRET-KEY-[A-Z0-9]*' "$config/backup-identity.txt")"
DOCS_BACKUP_AGE_RECIPIENTS="$(grep -o 'age1[a-z0-9]*' "$config/backup-identity.txt")"
export DOCS_BACKUP_AGE_RECIPIENTS
if [ "$STACKTEST_BACKUP_ALLOW_SAME_DEVICE" = 1 ]; then
  echo "backup volume ready; the same-device refusal is relaxed for this test"
else
  echo "backup volume ready; the same-device refusal is ON"
fi

# --- Validate --------------------------------------------------------------------------------------
step "Validating the Compose configuration"
# `-q` only: the rendered configuration inlines env_file values, so it is never printed.
compose --profile ops --profile test config -q
echo "compose.yaml + testing/compose.test.yaml: valid"

# --- Stateful services ---------------------------------------------------------------------------
step "Building the test-only object store"
# Built from pinned source; an existing image of that name is reused (a CI runner has none).
if docker image inspect munaxa-docs-test-minio:local >/dev/null 2>&1; then
  echo "munaxa-docs-test-minio:local already present; not rebuilt"
else
  compose build storage
fi

if [ -n "${CLAMAV_SEED_DIR:-}" ] && ls "$CLAMAV_SEED_DIR"/main.c?d >/dev/null 2>&1; then
  step "Seeding the scanner's signatures from $CLAMAV_SEED_DIR"
  compose run --rm --no-deps --user 0 --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --entrypoint sh -v "$CLAMAV_SEED_DIR:/seed:ro" antivirus \
    -c 'cp -a /seed/. /var/lib/clamav/ && chown -R 101:102 /var/lib/clamav'
fi

step "Starting PostgreSQL, Redis, the scanner and the object store"
compose up -d --wait --wait-timeout 120 postgres redis storage
compose up -d antivirus
compose --profile test run --rm storage-init

# --- Database: runbook §6, by the template's own operator commands ------------------------------
step "db-admin bootstrap (roles, credentials, backup role)"
compose --profile ops run --rm db-admin bootstrap
step "db-admin bootstrap again (must be idempotent)"
compose --profile ops run --rm db-admin bootstrap
step "db-admin create-tenant acme / rival"
compose --profile ops run --rm db-admin create-tenant acme
compose --profile ops run --rm db-admin create-tenant rival

# --- Backups: R-1 (README.md §7) -----------------------------------------------------------------
step "db-backup: configuration valid, first base backup and tenant dumps taken at start"
compose up -d db-backup
backup() { compose exec -T db-backup munaxa-backup "$@"; }
for _ in $(seq 1 60); do
  backup health >/dev/null 2>&1 && break
  sleep 5
done
backup health
backup list
for database in edms_acme edms_rival; do
  if ! compose exec -T db-backup sh -c "ls /backup/dumps/*/$database.dump.age" >/dev/null 2>&1; then
    echo "FAIL  no encrypted dump of $database"
    exit 1
  fi
done
# shellcheck disable=SC2016 # expanded inside the container, from postgres.env
compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -tA -c "SELECT pg_switch_wal()"' >/dev/null
sleep 3
# shellcheck disable=SC2016 # expanded inside the container, from postgres.env
archiver="$(compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -tA -F " " -c "SELECT archived_count, failed_count FROM pg_stat_archiver"')"
archived="${archiver%% *}" archive_failures="${archiver##* }"
echo "pg_stat_archiver: archived $archived, failed $archive_failures"
if [ "$archived" -lt 1 ] || [ "$archive_failures" -ne 0 ]; then
  echo "FAIL  WAL archiving is not working"
  exit 1
fi
# A custom-format dump starts with PGDMP and a base backup's tar holds PG_VERSION in clear; neither
# may appear in anything on the volume.
if compose exec -T db-backup sh -c 'grep -rlE "PGDMP|PG_VERSION" /backup/base /backup/dumps /backup/wal' 2>/dev/null | grep -q .; then
  echo "FAIL  an unencrypted backup file is on the backup volume"
  exit 1
fi
echo "PASS  base backup, two encrypted tenant dumps, WAL archived with no failures, nothing in plaintext"

# ADR-0026 finding F-1. `migrate` runs on the internal `data` network only, so an image without the
# schema engine its runtime needs fails there (trying to download one) — this names the cause first.
# The same question ci.yml asks about the query engine, asked of both engines.
step "The API image carries the Prisma engines its own runtime needs"
docker run --rm --entrypoint sh "$DOCS_API_IMAGE" -eu -c '
  ssl=$(ls /usr/lib/x86_64-linux-gnu/libssl.so.* 2>/dev/null | sed -n "s/.*libssl\.so\.\([0-9]\).*/\1/p" | head -1)
  case "${ssl:-}" in
    3) want=debian-openssl-3.0.x ;;
    1) want=debian-openssl-1.1.x ;;
    *) echo "Could not determine the runtime OpenSSL major version."; exit 1 ;;
  esac
  echo "This runtime requires: $want"
  for engine in "libquery_engine-$want.so.node" "schema-engine-$want"; do
    if find /app/node_modules -name "$engine" | grep -q .; then
      echo "OK    $engine"
    else
      echo "FAIL  no $engine in this image"
      exit 1
    fi
  done
'

step "migrate (the repository's runner, from the API image, no network egress)"
compose --profile ops run --rm migrate
step "migrate again (nothing may be pending)"
second="$(compose --profile ops run --rm migrate 2>&1)"
printf '%s\n' "$second" | grep -E 'Migrat|No pending|applying' || true
printf '%s\n' "$second" | grep -q 'No pending migrations to apply' || {
  echo "the second migration run was not a no-op"
  exit 1
}

step "provision acme's first administrator (D-1 procedure)"
compose --profile ops run --rm provision
rm -f "$config/provision.env"

# --- The application ----------------------------------------------------------------------------
step "Starting the API, the web server and the proxy"
compose up -d api web proxy

step "Waiting for the scanner to report healthy (first start downloads signatures)"
for _ in $(seq 1 80); do
  state="$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps -q antivirus)")"
  [ "$state" = "healthy" ] && break
  sleep 5
done
echo "antivirus: $state"
[ "$state" = "healthy" ]

step "Waiting for api, web and proxy to report healthy"
compose up -d --wait --wait-timeout 300 api web proxy
compose ps

if [ -n "${EXTERNAL_STORAGE_ENV:-}" ]; then
  # Diagnostic only (testing/storage-probe.cjs): what the external store does with each step of the
  # upload contract, through the product's own adapter. The smoke test below decides pass or fail.
  step "Storage contract probe (external bucket)"
  # The replay's sign-in values go by name (`-e NAME`): Compose copies them from this process's
  # environment, so no value appears on a command line. smoke.env itself is 0600 and unreadable to
  # the API image's user.
  SMOKE_TENANT=acme SMOKE_ADMIN_EMAIL=admin@acme.invalid SMOKE_ADMIN_PASSWORD="$admin_pw" \
    SMOKE_CORS_ORIGIN="$s_cors" compose run --rm --no-deps -T -e "RUN_PREFIX=$run_prefix/" \
    -e SMOKE_TENANT -e SMOKE_ADMIN_EMAIL -e SMOKE_ADMIN_PASSWORD -e SMOKE_CORS_ORIGIN \
    -v "$here/storage-probe.cjs:/probe/storage-probe.cjs:ro" --entrypoint node api \
    /probe/storage-probe.cjs || echo "probe: did not complete (see its last line)"
  # The same replay from the smoke runner's own container: the smoke test's network and environment,
  # no storage credentials (its API calls and PUTs only).
  compose --profile test run --rm --no-deps -T -e PROBE_MODE=replay-only \
    -v "$here/storage-probe.cjs:/probe/storage-probe.cjs:ro" --entrypoint node smoke \
    /probe/storage-probe.cjs || echo "probe (smoke container): did not complete (see its last line)"
fi

step "Smoke test"
compose --profile test run --rm smoke

# README.md §7: the timer's command, against the stand-in bucket. The volume is mounted read-only
# into the job; testing/offsite/test-offsite.sh covers its failure paths.
step "Off-server copy: the encrypted backups copied, read back and marked complete"
compose --profile ops run --rm offsite sync
compose --profile ops run --rm offsite list-remote
# The copy job's state directory is uid 70, mode 0700, exactly as on a server, where the host check
# reads it as root (ops/systemd/munaxa-host-check.service). This test's controller is an ordinary
# user on a CI runner, so the one status file is read through as_root — a `cat` of that file and
# nothing else — and judged here. Missing, unreadable, malformed or failed all fail the assertion.
offsite_status_ok() {
  local status
  status="$(as_root cat -- "$1" 2>/dev/null)" || return 1
  printf '%s\n' "$status" | grep -qx 'munaxa_offsite_last_run_success 1' || return 1
  printf '%s\n' "$status" | grep -qx 'munaxa_offsite_pending_files 0' || return 1
  printf '%s\n' "$status" | grep -Eqx 'munaxa_offsite_newest_base_created_timestamp_seconds [1-9][0-9]*'
}
if [ "$(as_root stat -c '%u %a' "$DOCS_OFFSITE_STATE_DIR")" != "70 700" ]; then
  echo "FAIL  the off-server copy's state directory is not uid 70, mode 0700"
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  if cat "$DOCS_OFFSITE_STATE_DIR/offsite.prom" >/dev/null 2>&1; then
    echo "FAIL  the test controller (uid $(id -u)) can read the protected state directory"
    exit 1
  fi
  echo "PASS  the state directory (uid 70, 0700) is unreadable to the test controller (uid $(id -u))"
else
  echo "NOTE  the controller runs as root, so the state directory's protection is not exercised here"
fi
if ! offsite_status_ok "$DOCS_OFFSITE_STATE_DIR/offsite.prom"; then
  echo "FAIL  the off-server copy did not record a successful, complete run"
  exit 1
fi
# The assertion itself must still fail on a missing file, a malformed one and a failed run.
as_root sh -c 'printf "%s\n" "not a status file" > "$1/bad.prom"; printf "%s\n" \
  "munaxa_offsite_last_run_success 0" "munaxa_offsite_pending_files 3" \
  "munaxa_offsite_newest_base_created_timestamp_seconds 1" > "$1/failed.prom"' sh "$DOCS_OFFSITE_STATE_DIR"
for case_file in missing.prom bad.prom failed.prom; do
  if offsite_status_ok "$DOCS_OFFSITE_STATE_DIR/$case_file"; then
    echo "FAIL  the status assertion accepted $case_file"
    exit 1
  fi
done
as_root rm -f -- "$DOCS_OFFSITE_STATE_DIR/bad.prom" "$DOCS_OFFSITE_STATE_DIR/failed.prom"
echo "PASS  every file on the backup volume is verified on the (stand-in) remote; a missing, malformed or failed status is refused"

# The check the server's timer runs (ops/host-check.sh; monitoring.md §3): all well on this stack,
# and a finding — a non-zero exit, which withholds the dead-man's-switch ping — when a limit is
# crossed.
step "Host check: all well on a healthy stack, a finding when a limit is crossed"
# As root, as the server's systemd unit runs it (it reads the copy job's 0700 state directory), with
# a clean environment holding only what it needs: the Compose files and the template's own
# non-secret settings. No credential is passed; they stay in the config files.
host_check() {
  local pass=(PATH="$PATH" HOME=/root COMPOSE_FILES="${files[*]}" DOCS_ENV_FILE=/nonexistent) name
  for name in DOCS_PROJECT_NAME DOCS_CONFIG_DIR DOCS_API_IMAGE DOCS_WEB_IMAGE DOCS_ANTIVIRUS_IMAGE \
    DOCS_POSTGRES_IMAGE DOCS_BACKUP_DIR DOCS_BACKUP_AGE_RECIPIENTS DOCS_OFFSITE_STATE_DIR \
    STACKTEST_BACKUP_ALLOW_SAME_DEVICE DISK_MAX_PERCENT; do
    if [ -n "${!name:-}" ]; then
      pass+=("$name=${!name}")
    fi
  done
  as_root env -i "${pass[@]}" "$template/ops/host-check.sh"
}
host_check
if host_check_output="$(DISK_MAX_PERCENT=0 host_check 2>&1)"; then
  echo "FAIL  host-check passed with a disk limit of 0%"
  exit 1
fi
printf '%s\n' "$host_check_output" | grep -q '^FINDING  disk: / is' || {
  echo "FAIL  host-check did not name the disk"
  exit 1
}
echo "PASS  host-check reports a crossed limit by exit status, naming what crossed it"

# Real failures, not thresholds: the object store stops (and an off-server copy run fails during
# the outage), and the scanner's signatures are made 100 h old. Each must be named, then clear.
step "Host check: an object-store outage, a failed off-server copy and stale signatures are named"
compose stop storage >/dev/null
if compose --profile ops run --rm -e OFFSITE_LOW_LEVEL_RETRIES=1 -e OFFSITE_RETRIES=1 offsite sync >/dev/null 2>&1; then
  echo "FAIL  the off-server copy reported success with the remote stopped"
  exit 1
fi
# shellcheck disable=SC2016 # expanded inside the scanner container
compose exec -T antivirus sh -c 'cp /var/lib/clamav/.munaxa-refreshed /tmp/refreshed.saved 2>/dev/null; echo $(( $(date +%s) - 100 * 3600 )) > /var/lib/clamav/.munaxa-refreshed'
outage_output="$(host_check 2>&1)" && {
  echo "FAIL  host-check passed during an object-store outage"
  exit 1
}
for expected in 'FINDING  storage: the object store does not answer' \
  'FINDING  offsite: the last copy run did not succeed' \
  'FINDING  scanner: signatures last known current 100 h ago'; do
  printf '%s\n' "$outage_output" | grep -qF "$expected" || {
    echo "FAIL  host-check did not report: $expected"
    printf '%s\n' "$outage_output" | grep FINDING
    exit 1
  }
done
echo "PASS  host-check named the storage outage, the failed copy and the stale signatures"
# shellcheck disable=SC2016 # expanded inside the scanner container
compose exec -T antivirus sh -c 'if [ -s /tmp/refreshed.saved ]; then cp /tmp/refreshed.saved /var/lib/clamav/.munaxa-refreshed; else rm -f /var/lib/clamav/.munaxa-refreshed; fi'
compose up -d --wait --wait-timeout 120 storage >/dev/null
compose --profile ops run --rm offsite sync >/dev/null
# The scanner's health status changes only at its next health-check run, so this waits for it.
cleared=0
for _ in $(seq 1 36); do
  if host_check >/dev/null 2>&1; then
    cleared=1
    break
  fi
  sleep 5
done
if [ "$cleared" -ne 1 ]; then
  echo "FAIL  host-check still reports findings after the store, the copy and the signatures recovered"
  host_check | grep FINDING
  exit 1
fi
echo "PASS  all findings cleared once the store was back, a copy succeeded and the signatures were current"

# An HTTP answer is the API's word for it. The scan verdicts are also recorded in the tenant's
# database with the scanner that gave them and, for an infected file, the signature that matched — a
# name only the scanner supplies. Read back over the server's local socket; no credential involved.
step "The scanner gave the verdicts (recorded scan results)"
# The variable is the container's own (from postgres.env), so it expands there, not here.
# shellcheck disable=SC2016
tenant_sql() {
  compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d edms_acme --no-psqlrc -tA -F " | "'
}
tenant_sql <<'SQL'
SELECT scan_status, coalesce(scanner, 'none'), coalesce(scan_threat, '-'), scanned_at IS NOT NULL,
       count(*)
  FROM file_object GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3;
SQL
scanned="$(tenant_sql <<'SQL'
SELECT EXISTS (SELECT 1 FROM file_object WHERE scan_status = 'INFECTED' AND scanner LIKE 'ICAP %'
                 AND scan_threat ILIKE '%eicar%' AND scanned_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM file_object WHERE scan_status = 'CLEAN' AND scanner LIKE 'ICAP %'
                 AND scanned_at IS NOT NULL);
SQL
)"
if [ "$scanned" != "t" ]; then
  echo "FAIL  no scanner-recorded INFECTED (EICAR signature) and CLEAN verdicts in the tenant database"
  exit 1
fi
echo "PASS  the ICAP scanner recorded an EICAR signature match (INFECTED) and a CLEAN verdict"

if [ -n "${EXTRA_CHECKS:-}" ]; then
  # shellcheck source=/dev/null
  . "$EXTRA_CHECKS"
fi

# --- Production validation is on ------------------------------------------------------------------
# Each case starts the real API image with the stack's own production configuration and ONE setting
# made unsafe, and must be refused at boot naming that setting. No case prints the configuration.
step "Production validation refuses unsafe settings"
refused() {
  local name="$1" expect="$2"
  shift 2
  local output code=0
  output="$(timeout 90 docker compose "${files[@]}" run --rm --no-deps -T "$@" api 2>&1)" || code=$?
  if [ "$code" -eq 0 ] || [ "$code" -eq 124 ]; then
    echo "FAIL  $name — the API started (exit $code)"
    return 1
  fi
  if printf '%s' "$output" | grep -q "$expect"; then
    echo "PASS  $name — refused, naming $expect"
  else
    echo "FAIL  $name — refused, but not for $expect"
    return 1
  fi
}
refused 'AV_DRIVER=NONE' AV_DRIVER -e AV_DRIVER=NONE
refused 'MAIL_DRIVER=NONE' MAIL_DRIVER -e MAIL_DRIVER=NONE
refused 'STORAGE_DRIVER=NONE' STORAGE_DRIVER -e STORAGE_DRIVER=NONE
refused 'OpenAPI explorer on' OPENAPI_ENABLED -e OPENAPI_ENABLED=true
refused 'unencrypted SMTP' MAIL_SMTP_SECURITY -e MAIL_SMTP_SECURITY=NONE
refused 'TRUST_PROXY=true' TRUST_PROXY -e TRUST_PROXY=true
refused 'local disk under the cloud profile' STORAGE_DRIVER -e STORAGE_DRIVER=LOCAL
refused 'no audit checkpoint key' AUDIT_CHECKPOINT_SECRET -e AUDIT_CHECKPOINT_SECRET=

step "No generated credential appears in any container log"
logs="$(compose logs --no-color 2>&1)"
leaked=0
for value in "$owner_pw" "$app_pw" "$backup_pw" "$redis_pw" "$minio_pw" "$admin_pw" "$s_secret" \
  "$backup_identity_secret" "$offsite_secret"; do
  if printf '%s' "$logs" | grep -qF "$value"; then
    leaked=1
  fi
done
if [ "$leaked" -ne 0 ]; then
  echo "FAIL  a generated credential appears in the container logs"
  exit 1
fi
echo "PASS  none of the generated credentials appears in $(printf '%s\n' "$logs" | wc -l) log lines"

if [ -n "${CLAMAV_EXPORT_DIR:-}" ]; then
  mkdir -p "$CLAMAV_EXPORT_DIR"
  compose cp antivirus:/var/lib/clamav/. "$CLAMAV_EXPORT_DIR/" >/dev/null
fi

if [ "${extra_failures:-0}" -ne 0 ]; then
  echo "FAIL  $extra_failures expectation(s) of the extra checks did not hold (see above)"
  exit 1
fi

step "All stack checks passed"
