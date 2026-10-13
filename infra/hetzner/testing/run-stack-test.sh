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
#   KEEP_STACK=1       leave the stack and its config running for inspection
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$(cd "$here/.." && pwd)"

: "${DOCS_API_IMAGE:?set DOCS_API_IMAGE}"
: "${DOCS_WEB_IMAGE:?set DOCS_WEB_IMAGE}"
: "${DOCS_ANTIVIRUS_IMAGE:?set DOCS_ANTIVIRUS_IMAGE}"
export DOCS_API_IMAGE DOCS_WEB_IMAGE DOCS_ANTIVIRUS_IMAGE
export DOCS_PROJECT_NAME="${DOCS_PROJECT_NAME:-munaxa-docs-stacktest}"

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
  if [ "${KEEP_STACK:-}" = "1" ]; then
    echo "KEEP_STACK=1: stack left running; config in $config"
  else
    compose --profile ops --profile test down --volumes --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$config"
  fi
  exit "$status"
}
trap cleanup EXIT

step() { printf '\n=== %s\n' "$*"; }
secret() { openssl rand -hex 32; }

# --- Throwaway configuration ---------------------------------------------------------------------
step "Generating a throwaway configuration (values never printed)"
umask 077
owner_pw="$(secret)" app_pw="$(secret)" backup_pw="$(secret)" redis_pw="$(secret)"
minio_user="stacktest-$(openssl rand -hex 4)" minio_pw="$(secret)" admin_pw="Sm0ke-$(secret)"
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

cat > "$config/minio.env" <<EOF
MINIO_ROOT_USER=$minio_user
MINIO_ROOT_PASSWORD=$minio_pw
EOF

storage='"storage":{"driver":"S3","container":"munaxa-docs-test","prefixTemplate":"tenants/{slug}"},"search":{"indexTemplate":"docs-{slug}"}'
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
STORAGE_DRIVER=S3
STORAGE_BUCKET=munaxa-docs-test
STORAGE_REGION=us-east-1
STORAGE_ENDPOINT=http://storage:9000
STORAGE_FORCE_PATH_STYLE=true
STORAGE_ACCESS_KEY_ID=$minio_user
STORAGE_SECRET_ACCESS_KEY=$minio_pw
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
EOF

# --- Validate --------------------------------------------------------------------------------------
step "Validating the Compose configuration"
# `-q` only: the rendered configuration inlines env_file values, so it is never printed.
compose --profile ops --profile test config -q
echo "compose.yaml + testing/compose.test.yaml: valid"

# --- Stateful services ---------------------------------------------------------------------------
step "Building the test-only object store"
compose build storage

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

step "migrate (the repository's runner, from the API image)"
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

step "Smoke test"
compose --profile test run --rm smoke

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
for value in "$owner_pw" "$app_pw" "$backup_pw" "$redis_pw" "$minio_pw" "$admin_pw"; do
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

step "All stack checks passed"
