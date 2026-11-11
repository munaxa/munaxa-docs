#!/usr/bin/env bash
# The migration path, end to end, on disposable local databases (DC-01).
#
#   MIGRATE_IMAGE  the `migrate` target of ./Dockerfile
#   API_IMAGE      the `api` target, built from the same commit
#   POSTGRES_IMAGE REDIS_IMAGE   optional; default postgres:16-alpine and redis:7-alpine
#
# Run from the repository root of that commit. It starts its own PostgreSQL (password
# authentication, a random password per role, nothing shared with any other environment) and Redis
# on 127.0.0.1, and removes them on exit. Nothing here reaches a registry, AWS or any real database.
#
# What it proves, in the order the hosted Docs runs things (docs-migrate, docs-provision, docs-api):
#
#   I-1..I-6  the images: the Prisma CLI and the schema engine the runtime asks for are in the
#             migration image; its schema, migrations and SQL are byte-identical to this commit's; it
#             runs as uid 1000 with no shell, no registry token and no baked-in database URL; the API
#             image gained none of it
#   M-1..M-9  migrations: a fresh database migrates (exit 0); a re-run is a no-op (exit 0); a
#             failing migration exits 1 and stays failed on every re-run (never skipped, never reset);
#             wrong credentials exit 1; no URL exits 2; two runs at once never both "succeed" into a
#             broken state; every run is read-only-root, capability-free
#   P-1..P-5  provisioning: refused (exit 3, nothing written) on an unmigrated database, on a failed
#             migration, and on a database whose post-migration SQL did not run; succeeds after the
#             migration (exit 0); a re-run changes nothing (exit 4)
#   P-6..P-7  provisioning refused, for the post-migration reason, when only 01-tenant-isolation.sql applied
#   P-8..P-9  provisioning refused when a migration was applied after the last post-migration run,
#             and while a newer run is unfinished
#   A-1..A-3  the API refuses to start on an unmigrated or partly post-migrated database and starts on a
#             migrated one
#   C-1       no password and no connection string appears in any output
#
# Exit 0 only if every check passed.
set -euo pipefail

: "${MIGRATE_IMAGE:?}" "${API_IMAGE:?}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
REDIS_IMAGE="${REDIS_IMAGE:-redis:7-alpine}"
PG_PORT="${PG_PORT:-55432}"
REDIS_PORT="${REDIS_PORT:-56379}"

work="$(mktemp -d)"
containers=(dc01-postgres dc01-redis dc01-api)
failures=0
cleanup() {
  local code=$?
  docker rm -f "${containers[@]}" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$code"
}
trap cleanup EXIT

secret() { openssl rand -hex 24; }
ok() { echo "OK   $*"; }
bad() { echo "FAIL $*"; failures=$((failures + 1)); }
hardened=(--network host --read-only --cap-drop ALL --security-opt no-new-privileges)

superuser_password="$(secret)"
# A password with characters that must be percent-encoded, so redaction is tested on both forms.
owner_password="own%$(secret)@x"
owner_encoded="${owner_password//%/%25}"
owner_encoded="${owner_encoded//@/%40}"
app_password="$(secret)"
redis_password="$(secret)"
owner_url() { echo "postgresql://edms_owner:${owner_encoded}@127.0.0.1:${PG_PORT}/$1"; }
app_url() { echo "postgresql://edms_app:${app_password}@127.0.0.1:${PG_PORT}/$1"; }

# --- Images, before anything runs ----------------------------------------------------------------

echo "== Image checks"
listing() {
  local cid
  cid=$(docker create "$1")
  docker export "$cid" | tar -tf -
  docker rm "$cid" >/dev/null
}
migrate_files=$(listing "$MIGRATE_IMAGE")
api_files=$(listing "$API_IMAGE")

lock_prisma=$(sed -n 's/^  prisma@\([0-9.]*\).*/\1/p' pnpm-lock.yaml | head -n 1)
image_prisma=$(docker run --rm "${hardened[@]}" --entrypoint node "$MIGRATE_IMAGE" \
  node_modules/prisma/build/index.js --version 2>/dev/null | sed -n 's/^prisma *: *//p')
[ -n "$lock_prisma" ] && [ "$image_prisma" = "$lock_prisma" ] \
  && ok "I-1 the migration image runs the Prisma CLI the lockfile pins ($image_prisma)" \
  || bad "I-1 Prisma CLI in the image is '$image_prisma', the lockfile pins '$lock_prisma'"

grep -q 'schema-engine-debian-openssl-3\.0\.x$' <<<"$migrate_files" \
  && grep -q '^usr/lib/x86_64-linux-gnu/libssl\.so\.3' <<<"$migrate_files" \
  && ok "I-2 the migration image carries the schema engine its own OpenSSL 3 runtime asks for" \
  || bad "I-2 no schema-engine-debian-openssl-3.0.x (or no libssl3) in the migration image"

image_digest=$(docker run --rm "${hardened[@]}" --entrypoint node "$MIGRATE_IMAGE" -e '
  const { createHash } = require("node:crypto"); const fs = require("node:fs"); const p = require("node:path");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(p.join(d, e.name)) : [p.join(d, e.name)]);
  const files = ["prisma", "infra/sql"].flatMap(walk).sort();
  const h = createHash("sha256");
  for (const f of files) h.update(f + "\0" + createHash("sha256").update(fs.readFileSync(f)).digest("hex") + "\n");
  process.stdout.write(h.digest("hex"));')
repo_digest=$(node -e '
  const { createHash } = require("node:crypto"); const fs = require("node:fs"); const p = require("node:path");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(p.join(d, e.name)) : [p.join(d, e.name)]);
  const files = ["prisma", "infra/sql"].flatMap(walk).sort();
  const h = createHash("sha256");
  for (const f of files) h.update(f + "\0" + createHash("sha256").update(fs.readFileSync(f)).digest("hex") + "\n");
  process.stdout.write(h.digest("hex"));')
migrations=$(find prisma/migrations -name migration.sql | wc -l)
[ "$image_digest" = "$repo_digest" ] \
  && ok "I-3 prisma/ ($migrations migrations) and infra/sql/ in the image are byte-identical to this commit" \
  || bad "I-3 the image's prisma/ or infra/sql/ differs from this commit"

user=$(docker inspect --format '{{.Config.User}}' "$MIGRATE_IMAGE")
env_keys=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$MIGRATE_IMAGE" | cut -d= -f1 | tr '\n' ' ')
if [ "$user" = "node" ] || [ "${user%%:*}" = "1000" ]; then
  ok "I-4 the migration image runs as '$user' (uid 1000), not root"
else
  bad "I-4 the migration image declares USER '$user'"
fi
if grep -qE '^(bin|usr/bin)/(sh|bash|dash)$' <<<"$migrate_files"; then bad "I-5 the migration image carries a shell"; else
  if grep -qE 'DATABASE|TENANT_CATALOGUE|PASSWORD|TOKEN' <<<"$env_keys" || grep -qE '(^|/)\.npmrc$|(^|/)\.env$' <<<"$migrate_files"; then
    bad "I-5 the migration image carries a database variable, an .npmrc or an .env ($env_keys)"
  else
    ok "I-5 no shell, no .npmrc, no .env and no database variable baked into the migration image"
  fi
fi
if grep -q 'schema-engine-debian-openssl-3\.0\.x$' <<<"$api_files" || grep -qE '^(bin|usr/bin)/(sh|bash)$' <<<"$api_files"; then
  bad "I-6 the API image gained the migration image's tooling or a shell"
else
  ok "I-6 the API image is unchanged by the migration target (no extra schema engine, no shell)"
fi

# --- A disposable PostgreSQL and Redis -----------------------------------------------------------

echo "== Disposable PostgreSQL ($POSTGRES_IMAGE) and Redis ($REDIS_IMAGE)"
docker run -d --name dc01-postgres -p "127.0.0.1:${PG_PORT}:5432" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$superuser_password" -e POSTGRES_DB=postgres \
  "$POSTGRES_IMAGE" >/dev/null
docker run -d --name dc01-redis -p "127.0.0.1:${REDIS_PORT}:6379" "$REDIS_IMAGE" \
  redis-server --requirepass "$redis_password" --save '' >/dev/null
for attempt in $(seq 1 60); do
  docker exec dc01-postgres pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  [ "$attempt" -lt 60 ] || { echo "FAIL PostgreSQL never accepted connections"; exit 1; }
  sleep 1
done
sleep 2 # the image restarts its server once after initialisation
pg() { docker exec -i -e PGPASSWORD="$superuser_password" dc01-postgres psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q -t -A "$@"; }
pg -d postgres <infra/sql/cluster/01-roles.sql
pg -d postgres -c "ALTER ROLE edms_owner PASSWORD '${owner_password//\'/\'\'}'" -c "ALTER ROLE edms_app PASSWORD '$app_password'"
for db in fresh failing partial nopost rlsonly upgrade race; do pg -d postgres -c "CREATE DATABASE dc01_$db OWNER edms_owner"; done
# `failing`: a type the second migration creates, so migration 1 applies and migration 2 fails.
failing_type=$(grep -m1 -o 'CREATE TYPE "[a-z_]*"' prisma/migrations/20260803162912_identity/migration.sql | cut -d'"' -f2)
pg -d dc01_failing -c "SET ROLE edms_owner; CREATE TYPE \"$failing_type\" AS ENUM ('X');"

run_migrate() { # db log [extra docker args...]
  local db="$1" log="$2"
  shift 2
  set +e
  docker run --rm "${hardened[@]}" "$@" -e DATABASE_MIGRATION_URL="$(owner_url "$db")" "$MIGRATE_IMAGE" >"$log" 2>&1
  local code=$?
  set -e
  return "$code"
}
code_of() { "$@" && echo 0 || echo $?; }

echo "== Migrations (the migration image, read-only root, no capabilities)"
c=$(code_of run_migrate dc01_fresh "$work/m1.log")
[ "$c" = 0 ] && grep -q 'Migrated 1 tenant database' "$work/m1.log" \
  && ok "M-1 a fresh database migrates (exit 0)" || bad "M-1 fresh migration exited $c"
applied=$(pg -d dc01_fresh -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
[ "$applied" = "$migrations" ] && ok "M-2 all $migrations migrations recorded as finished, in order" \
  || bad "M-2 $applied of $migrations migrations finished"
c=$(code_of run_migrate dc01_fresh "$work/m2.log")
[ "$c" = 0 ] && grep -q 'No pending migrations to apply' "$work/m2.log" \
  && ok "M-3 a re-run on a migrated database is a no-op (exit 0, no pending migrations)" || bad "M-3 re-run exited $c"

c=$(code_of run_migrate dc01_failing "$work/f1.log")
[ "$c" = 1 ] && grep -q 'P3018' "$work/f1.log" && grep -q 'MIGRATION FAILED' "$work/f1.log" \
  && ok "M-4 a failing migration exits 1 (P3018) and says MIGRATION FAILED" || bad "M-4 failing migration exited $c"
c=$(code_of run_migrate dc01_failing "$work/f2.log")
state=$(pg -d dc01_failing -c "SELECT count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) FROM _prisma_migrations")
[ "$c" = 1 ] && grep -q 'P3009' "$work/f2.log" && [ "$state" = 1 ] \
  && ok "M-5 the re-run refuses too (P3009): the failed migration is never skipped, reset or rewritten" \
  || bad "M-5 re-run after failure exited $c, failed rows $state"

set +e
docker run --rm "${hardened[@]}" -e DATABASE_MIGRATION_URL="postgresql://edms_owner:wrong-${owner_encoded}@127.0.0.1:${PG_PORT}/dc01_fresh" \
  "$MIGRATE_IMAGE" >"$work/w.log" 2>&1
c=$?
docker run --rm "${hardened[@]}" "$MIGRATE_IMAGE" >"$work/n.log" 2>&1
n=$?
set -e
[ "$c" = 1 ] && grep -q 'P1000' "$work/w.log" && ok "M-6 wrong credentials exit 1 (P1000)" || bad "M-6 wrong credentials exited $c"
[ "$n" = 2 ] && grep -q 'DATABASE_MIGRATION_URL is not set' "$work/n.log" \
  && ok "M-7 no migration URL exits 2 (configuration), touching nothing" || bad "M-7 missing URL exited $n"

# Two runs at once on one fresh database: Prisma's advisory lock serialises the migrations; the SQL
# around them is idempotent. Neither may report success over a broken database.
set +e
run_migrate dc01_race "$work/r1.log" &
p1=$!
run_migrate dc01_race "$work/r2.log" &
p2=$!
wait "$p1"; r1=$?
wait "$p2"; r2=$?
set -e
c=$(code_of run_migrate dc01_race "$work/r3.log")
dupes=$(pg -d dc01_race -c "SELECT count(*) - count(DISTINCT migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
if { [ "$r1" = 0 ] || [ "$r2" = 0 ]; } && [ "$c" = 0 ] && [ "$dupes" = 0 ] && grep -q 'No pending migrations' "$work/r3.log"; then
  ok "M-8 two concurrent runs (exit $r1 and $r2): at least one succeeded, no migration applied twice, a third run finds nothing to do"
  for log in "$work/r1.log" "$work/r2.log"; do
    if grep -q 'MIGRATION FAILED' "$log"; then
      echo "       the other run failed loudly: $(grep -m1 -oE "(P[0-9]{4}|deadlock detected|advisory lock|already exists)[^.]*" "$log" || echo 'see its log')"
    fi
  done
else
  bad "M-8 concurrent runs exited $r1/$r2, follow-up $c, duplicates $dupes"
fi
grep -hE 'EROFS|read-only file system' "$work"/m*.log "$work"/r*.log && bad "M-9 a migration wrote to its read-only root" \
  || ok "M-9 every migration ran on a read-only root filesystem with no capabilities"

# `nopost`: the migrations without the post-migration SQL — the state a runner that skipped it leaves.
docker run --rm "${hardened[@]}" -e DATABASE_URL="$(owner_url dc01_nopost)" --entrypoint node "$MIGRATE_IMAGE" \
  node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma >"$work/np.log" 2>&1
# `rlsonly`: the migrations and 01-tenant-isolation.sql only — what a run that failed in 02, 03 or 04
# leaves: row-level security in place, the audit and integrity triggers missing.
for step in "db execute --file infra/sql/database/01-grants.sql" "migrate deploy" \
  "db execute --file infra/sql/post-migrate/01-tenant-isolation.sql"; do
  # shellcheck disable=SC2086
  docker run --rm "${hardened[@]}" -e DATABASE_URL="$(owner_url dc01_rlsonly)" --entrypoint node "$MIGRATE_IMAGE" \
    node_modules/prisma/build/index.js $step --schema prisma/schema.prisma >>"$work/rl.log" 2>&1 \
    || { sed 's/^/    /' "$work/rl.log"; echo "setting up the rlsonly database failed at: $step"; exit 1; }
done
# `upgrade`: fully migrated by this build, then a later migration applied with no post-migration run
# after it (release N+1 whose run failed in 02-04, or was skipped): every file version still matches.
c=$(code_of run_migrate dc01_upgrade "$work/up.log")
[ "$c" = 0 ] || bad "setting up the upgrade database: migration exited $c"
pg -d dc01_upgrade -c "SET ROLE edms_owner; INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at, applied_steps_count) VALUES ('dc01-upgrade', 'x', '20990101000000_next_release', now(), 1)"

# --- Provisioning (the API image's provision.js, as the docs-provision task runs it) ------------

echo "== Provisioning gate"
provision() { # db log
  set +e
  docker run --rm "${hardened[@]}" \
    -e NODE_ENV=development -e DEPLOYMENT_PROFILE=ON_PREMISE -e QUEUE_CONSUMERS_ENABLED=false \
    -e STORAGE_DRIVER=NONE -e LICENSING_MODE=NONE -e LOG_LEVEL=warn \
    -e REDIS_URL="redis://:${redis_password}@127.0.0.1:${REDIS_PORT}" \
    -e JWT_ACCESS_SECRET="$(secret)" \
    -e DATABASE_URL="$(app_url "$1")" \
    -e TENANT_ID=019489f0-0000-7000-8000-0000000000a1 -e TENANT_SLUG=acme -e TENANT_NAME="Acme Test" \
    -e ADMIN_EMAIL=admin@acme.test -e ADMIN_NAME="Ada Admin" -e ADMIN_PASSWORD="Correct-Horse-Battery-$(secret)" \
    --entrypoint node "$API_IMAGE" apps/api/dist/provision.js >"$2" 2>&1
  local code=$?
  set -e
  return "$code"
}
tenants() {
  if [ "$(pg -d "$1" -c "SELECT to_regclass('public.tenant') IS NOT NULL")" = t ]; then
    pg -d "$1" -c "SELECT count(*) FROM tenant"
  else
    echo 0
  fi
}
for case in "partial:P-1:an unmigrated database" "failing:P-2:a database with a failed migration" "nopost:P-3:a database whose post-migration SQL did not run" "rlsonly:P-6:a database where only the row-level security file applied"; do
  db="${case%%:*}"; rest="${case#*:}"; id="${rest%%:*}"; what="${rest#*:}"
  c=$(code_of provision "dc01_$db" "$work/p-$db.log")
  rows=$(tenants "dc01_$db")
  [ "$c" = 3 ] && grep -q 'PROVISIONING REFUSED' "$work/p-$db.log" && [ "$rows" = 0 ] \
    && ok "$id provisioning refused on $what (exit 3, nothing written)" \
    || bad "$id provisioning on $what exited $c with $rows tenant row(s)"
done
grep -q 'post-migration SQL is not recorded as applied' "$work/p-rlsonly.log" \
  && ok "P-7 the refusal says the post-migration SQL did not finish, though row-level security is in place" \
  || bad "P-7 the refusal did not give the post-migration reason"
c=$(code_of provision dc01_upgrade "$work/p-upgrade.log")
[ "$c" = 3 ] && grep -q 'post-migration SQL has not completed since 1 migration' "$work/p-upgrade.log" && [ "$(tenants dc01_upgrade)" = 0 ] \
  && ok "P-8 provisioning refused when a migration was applied after the last post-migration run (exit 3)" \
  || bad "P-8 provisioning after an unfinished upgrade exited $c"
# A run opened after the last closed one and never closed: what a run that failed or was stopped in
# 02-04 leaves behind, whatever file versions earlier runs recorded.
pg -d dc01_upgrade -c "SET ROLE edms_owner; INSERT INTO munaxa_meta.post_migrate_run (run, files, migrations) VALUES (gen_random_uuid(), '{}', '{}')"
c=$(code_of provision dc01_upgrade "$work/p-open.log")
[ "$c" = 3 ] && grep -q 'newer than the last completed one did not complete' "$work/p-open.log" \
  && ok "P-9 provisioning refused while a newer post-migration run is unfinished (exit 3)" \
  || bad "P-9 provisioning with an unfinished run exited $c"
c=$(code_of provision dc01_fresh "$work/p-ok.log")
[ "$c" = 0 ] && grep -q "Provisioned 'acme'" "$work/p-ok.log" && [ "$(tenants dc01_fresh)" = 1 ] \
  && ok "P-4 provisioning succeeds after the migration (exit 0, one tenant)" || bad "P-4 provisioning exited $c"
c=$(code_of provision dc01_fresh "$work/p-again.log")
[ "$c" = 4 ] && [ "$(tenants dc01_fresh)" = 1 ] \
  && ok "P-5 a re-run changes nothing (exit 4, still one tenant)" || bad "P-5 re-run exited $c"

# --- API start-up ---------------------------------------------------------------------------------

echo "== API start-up gate"
api_env=(-e NODE_ENV=development -e DEPLOYMENT_PROFILE=ON_PREMISE -e QUEUE_CONSUMERS_ENABLED=false
  -e STORAGE_DRIVER=NONE -e LICENSING_MODE=NONE -e PORT=39991
  -e REDIS_URL="redis://:${redis_password}@127.0.0.1:${REDIS_PORT}" -e JWT_ACCESS_SECRET="$(secret)"
  -e TENANT_ID=019489f0-0000-7000-8000-0000000000a1 -e TENANT_SLUG=acme)
set +e
timeout 60 docker run --rm "${hardened[@]}" "${api_env[@]}" -e DATABASE_URL="$(app_url dc01_partial)" "$API_IMAGE" >"$work/a1.log" 2>&1
c=$?
set -e
[ "$c" != 0 ] && [ "$c" != 124 ] && grep -q 'API start-up refused' "$work/a1.log" \
  && ok "A-1 the API refuses to start on an unmigrated database (exit $c, before listening)" || bad "A-1 API on an unmigrated database: exit $c"
set +e
timeout 60 docker run --rm "${hardened[@]}" "${api_env[@]}" -e DATABASE_URL="$(app_url dc01_rlsonly)" "$API_IMAGE" >"$work/a3.log" 2>&1
c=$?
set -e
[ "$c" != 0 ] && [ "$c" != 124 ] && grep -q 'API start-up refused' "$work/a3.log" \
  && ok "A-3 the API refuses to start when only the row-level security file applied (exit $c)" || bad "A-3 API on rlsonly: exit $c"
docker run -d --name dc01-api "${hardened[@]}" "${api_env[@]}" -e DATABASE_URL="$(app_url dc01_fresh)" "$API_IMAGE" >/dev/null
up=""
for _ in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:39991/api/health/live && { up=1; break; }; sleep 1; done
docker logs dc01-api >"$work/a2.log" 2>&1 || true
[ -n "$up" ] && ok "A-2 the API starts and is live on the migrated database" || bad "A-2 the API did not become live"

# --- Credentials ---------------------------------------------------------------------------------

echo "== Credentials in output"
leaks=$(grep -lF -e "$owner_password" -e "$owner_encoded" -e "$app_password" -e "$superuser_password" "$work"/*.log || true)
urls=$(grep -lE 'postgres(ql)?://[^*[:space:]]' "$work"/*.log || true)
[ -z "$leaks" ] && [ -z "$urls" ] && ok "C-1 no password and no connection string in any of $(ls "$work"/*.log | wc -l) logs" \
  || bad "C-1 credentials or URLs found in: $leaks $urls"

echo
if [ "$failures" -eq 0 ]; then echo "All migration-path checks passed."; else echo "$failures check(s) failed."; exit 1; fi
