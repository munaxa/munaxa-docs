#!/usr/bin/env bash
# Release smoke: starts a staging-shaped stack from three image references and runs smoke.mjs.
#
#   API_IMAGE  WEB_IMAGE  AV_IMAGE   image references (a digest in the publishing workflow)
#   EXPECTED_REVISION                the commit the images must be labelled with
#   OBJECT_STORE_BIN                 a directory holding the `minio` and `mc` binaries
#   POSTGRES_IMAGE  REDIS_IMAGE      optional; default postgres:16-alpine and redis:7-alpine, the
#                                    images the CI integration job uses (pre-pull them where a
#                                    registry login is available, as ci.yml does)
#
# Run from the repository root of that commit, after `pnpm install --frozen-lockfile` (the tenant
# migrations use the repository's own runner, scripts/migrate-tenants.mjs).
#
# The stack is the production shape on one host: NODE_ENV=production, DEPLOYMENT_PROFILE=CLOUD, two
# tenants in two databases (acme, and a decoy slugged `docs`), the S3 driver against an object
# store, AV_DRIVER=ICAP on the release scanner, MAIL_DRIVER=RESEND against a local capture endpoint
# (no real provider, no key). Every secret is generated for the run and never printed. Nothing here
# reaches AWS: the images are already local when this starts.
#
# Exit 0 only if every image check and every blocking smoke check passed.
set -euo pipefail

: "${API_IMAGE:?}" "${WEB_IMAGE:?}" "${AV_IMAGE:?}" "${EXPECTED_REVISION:?}" "${OBJECT_STORE_BIN:?}"

work="$(mktemp -d)"
containers=(smoke-postgres smoke-redis smoke-scanner smoke-api smoke-web)
pids=()

cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "::group::Container logs (failure)"
    for c in "${containers[@]}"; do
      echo "--- $c"
      docker logs --tail 80 "$c" 2>&1 || true
    done
    echo "--- object store"
    tail -40 "$work/minio.log" 2>/dev/null || true
    echo "::endgroup::"
  fi
  docker rm -f "${containers[@]}" >/dev/null 2>&1 || true
  docker volume rm smoke-av-signatures >/dev/null 2>&1 || true
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
  exit "$code"
}
trap cleanup EXIT

secret() { openssl rand -hex 32; }

POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
REDIS_IMAGE="${REDIS_IMAGE:-redis:7-alpine}"

# Pulls with a few retries: anonymous registry pulls from shared runners are rate limited.
pull() {
  local ref="$1"
  docker image inspect "$ref" >/dev/null 2>&1 && return 0
  for attempt in 1 2 3 4 5; do
    docker pull -q "$ref" >/dev/null && return 0
    echo "pull of $ref failed (attempt $attempt); retrying"
    sleep $((attempt * 10))
  done
  echo "FAIL - could not pull $ref"
  return 1
}

# --- Image properties, before anything runs -----------------------------------------------------

echo "== Image checks"
for ref in "$API_IMAGE" "$WEB_IMAGE" "$AV_IMAGE"; do
  revision=$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$ref")
  [ "$revision" = "$EXPECTED_REVISION" ] || { echo "FAIL - $ref is labelled $revision"; exit 1; }
  user=$(docker inspect --format '{{.Config.User}}' "$ref")
  case "${user%%:*}" in '' | 0 | root) echo "FAIL - $ref declares no non-root USER"; exit 1 ;; esac
  echo "OK   $ref: revision $revision, USER $user"
done
for ref in "$API_IMAGE" "$WEB_IMAGE"; do
  left=$(docker run --rm --entrypoint sh "$ref" -c 'find / -xdev -type f -perm /6000 2>/dev/null' || true)
  [ -z "$left" ] || { echo "FAIL - $ref carries setuid/setgid files:"; echo "$left"; exit 1; }
  echo "OK   $ref: no setuid or setgid file"
done

# --- Dependencies -------------------------------------------------------------------------------

echo "== PostgreSQL, Redis, object store"
pull "$POSTGRES_IMAGE"
pull "$REDIS_IMAGE"
docker run -d --name smoke-postgres --network host \
  -e POSTGRES_USER=edms_owner -e POSTGRES_PASSWORD="$(secret)" -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=postgres "$POSTGRES_IMAGE" >/dev/null
redis_password="$(secret)"
docker run -d --name smoke-redis --network host "$REDIS_IMAGE" \
  redis-server --bind 127.0.0.1 --port 6379 --requirepass "$redis_password" --save '' >/dev/null

store_password="$(secret)"
MINIO_ROOT_USER=smoke MINIO_ROOT_PASSWORD="$store_password" nohup "$OBJECT_STORE_BIN/minio" server \
  "$work/store" --address 127.0.0.1:9000 --console-address 127.0.0.1:9001 >"$work/minio.log" 2>&1 &
pids+=($!)

# Over TCP, not the socket: the image's entrypoint first runs a socket-only server to initialise
# the cluster and then restarts it, so a socket check can pass against the temporary server and the
# next command land in the restart. Only the final server listens on 127.0.0.1.
for attempt in $(seq 1 60); do
  docker exec smoke-postgres pg_isready -h 127.0.0.1 -U edms_owner -d postgres >/dev/null 2>&1 && break
  [ "$attempt" -lt 60 ] || { echo "FAIL - PostgreSQL never accepted TCP connections"; exit 1; }
  sleep 1
done
pg() { docker exec -i smoke-postgres psql -h 127.0.0.1 -U edms_owner -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
pg -c 'CREATE DATABASE smoke_edms_acme OWNER edms_owner' \
  -c 'CREATE DATABASE smoke_edms_docs OWNER edms_owner'
pg <infra/sql/cluster/01-roles.sql

export MC_HOST_smoke="http://smoke:$store_password@127.0.0.1:9000"
for attempt in $(seq 1 40); do
  "$OBJECT_STORE_BIN/mc" ls smoke >/dev/null 2>&1 && break
  [ "$attempt" -lt 40 ] || { echo "FAIL - the object store never accepted a connection"; exit 1; }
  sleep 1
done
"$OBJECT_STORE_BIN/mc" mb --ignore-existing smoke/munaxa-docs >/dev/null
unset MC_HOST_smoke

acme_id=$(cat /proc/sys/kernel/random/uuid)
docs_id=$(cat /proc/sys/kernel/random/uuid)
catalogue=$(cat <<JSON
{"defaults":{"databaseUrlTemplate":"postgresql://edms_app@127.0.0.1:5432/smoke_edms_{slug}",
"migrationUrlTemplate":"postgresql://edms_owner@127.0.0.1:5432/smoke_edms_{slug}",
"storage":{"driver":"S3","container":"munaxa-docs","region":"us-east-1","prefixTemplate":"{slug}"},
"search":{"indexTemplate":"{slug}"}},
"tenants":[{"id":"$acme_id","slug":"acme","name":"Acme"},{"id":"$docs_id","slug":"docs","name":"Decoy"}]}
JSON
)

echo "== Tenant migrations (scripts/migrate-tenants.mjs), run twice"
TENANT_CATALOGUE="$catalogue" node scripts/migrate-tenants.mjs >"$work/migrate-1.log"
TENANT_CATALOGUE="$catalogue" node scripts/migrate-tenants.mjs | tee "$work/migrate-2.log"

echo "== Scanner (release image)"
docker volume create smoke-av-signatures >/dev/null
docker run -d --name smoke-scanner --network host -v smoke-av-signatures:/var/lib/clamav "$AV_IMAGE" >/dev/null
node infra/antivirus/probe.mjs icap://127.0.0.1:1344/avscan --wait 600

echo "== Mail capture (stands in for Resend; no key, nothing leaves the host)"
node scripts/release-smoke/mail-capture.mjs 127.0.0.1 8025 "$work/mail.jsonl" &
pids+=($!)

# --- The API, configured as Production is ------------------------------------------------------

admin_email="smoke-admin@acme.test"
admin_password="$(secret)"
api_env="$work/api.env"
umask 077
cat >"$api_env" <<ENV
NODE_ENV=production
PORT=3001
LOG_LEVEL=info
DEPLOYMENT_PROFILE=CLOUD
TENANT_CATALOGUE=$(printf '%s' "$catalogue" | tr -d '\n')
DATABASE_URL=postgresql://edms_app@127.0.0.1:5432/smoke_edms_acme
DATABASE_POOL_SIZE=5
REDIS_URL=redis://:$redis_password@127.0.0.1:6379
QUEUE_CONSUMERS_ENABLED=true
CORS_ORIGINS=http://127.0.0.1:3000
WEB_BASE_URL=http://127.0.0.1:3000
STORAGE_DRIVER=S3
STORAGE_BUCKET=munaxa-docs
STORAGE_REGION=us-east-1
STORAGE_ENDPOINT=http://127.0.0.1:9000
STORAGE_FORCE_PATH_STYLE=true
STORAGE_CREDENTIALS_SOURCE=STATIC
STORAGE_ACCESS_KEY_ID=smoke
STORAGE_SECRET_ACCESS_KEY=$store_password
MAIL_DRIVER=RESEND
MAIL_RESEND_API_KEY=smoke-not-a-key
MAIL_RESEND_ENDPOINT=http://127.0.0.1:8025/emails
MAIL_FROM_ADDRESS=smoke@acme.test
AV_DRIVER=ICAP
AV_ICAP_URL=icap://127.0.0.1:1344/avscan
OPENAPI_ENABLED=false
METRICS_DRIVER=PROMETHEUS
METRICS_SCRAPE_TOKEN=$(secret)
JWT_ACCESS_SECRET=$(secret)
SIGNATURE_WITNESS_SECRET=$(secret)
AUDIT_CHECKPOINT_SECRET=$(secret)
MFA_TOTP_SEALING_KEY=$(secret)
ENV

echo "== First administrator (the image's provision.js)"
# Single-tenant form, as the Production ops-provision task runs it (finding D-1: provision.js cannot
# run beside a catalogue): the same configuration without TENANT_CATALOGUE, the ON_PREMISE profile,
# and acme's catalogue id, so the API finds the tenant it provisions. Prefix and index derive from
# the slug either way.
provision_env="$work/provision.env"
grep -v -E '^(TENANT_CATALOGUE|DEPLOYMENT_PROFILE)=' "$api_env" >"$provision_env"
docker run --rm --network host --env-file "$provision_env" \
  -e DEPLOYMENT_PROFILE=ON_PREMISE -e QUEUE_CONSUMERS_ENABLED=false \
  -e TENANT_ID="$acme_id" -e TENANT_SLUG=acme -e TENANT_NAME=Acme \
  -e ADMIN_EMAIL="$admin_email" -e ADMIN_NAME="Smoke Admin" -e ADMIN_PASSWORD="$admin_password" \
  --entrypoint node "$API_IMAGE" apps/api/dist/provision.js

echo "== API and web (release images)"
docker run -d --name smoke-api --network host --env-file "$api_env" "$API_IMAGE" >/dev/null
docker run -d --name smoke-web --network host \
  -e NODE_ENV=production -e PORT=3000 -e NEXT_PUBLIC_API_URL=http://127.0.0.1:3001 "$WEB_IMAGE" >/dev/null
for _ in $(seq 1 120); do
  curl -sf -o /dev/null http://127.0.0.1:3001/api/health/live \
    && curl -sf -o /dev/null http://127.0.0.1:3000/login && break
  sleep 1
done

echo "== Smoke"
SMOKE_API_URL=http://127.0.0.1:3001 SMOKE_WEB_URL=http://127.0.0.1:3000 \
  SMOKE_TENANT=acme SMOKE_DECOY_TENANT=docs \
  SMOKE_ADMIN_EMAIL="$admin_email" SMOKE_ADMIN_PASSWORD="$admin_password" \
  node scripts/release-smoke/smoke.mjs
