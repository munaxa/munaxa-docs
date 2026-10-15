# shellcheck shell=bash
# shellcheck disable=SC2154 # config, acme_id, rival_id and backup_pw are run-stack-test.sh's own
# The backup-and-restore drill (R-1; backup-and-restore.md §3, §5) — SOURCED by run-stack-test.sh
# as EXTRA_CHECKS, after the stack's own checks, with its functions and values in scope:
#
#   STACKTEST_BACKUP_DIR=/mnt/separate-fs EXTRA_CHECKS=infra/hetzner/testing/backup/backup-drill.sh \
#     DOCS_API_IMAGE=… DOCS_WEB_IMAGE=… DOCS_ANTIVIRUS_IMAGE=… infra/hetzner/testing/run-stack-test.sh
#
# Disposable data only: the stack's own throwaway tenants, after the smoke test has written to them.
# Every recovery happens in a separate container on its own internal network, from the encrypted
# files on the backup volume, with the identity this run generated. Nothing is uploaded anywhere.
#
#  1. The application is stopped so the data stands still, and db-backup takes a base backup and
#     the per-tenant dumps.
#  2. Change A is committed in both tenant databases (after the base backup, so only the WAL holds
#     it); the target time is read; change B is committed; the WAL is switched and archived.
#  3. Point-in-time recovery to the target into a NEW container: A is present, B is not, the audit
#     hash chain verifies from genesis, row-level security is enabled and forced on every
#     tenant-scoped table, the application role cannot bypass it, and each database holds only its
#     own tenant's rows.
#  4. Recovery to the end of the archive: A and B are both present.
#  5. One tenant's encrypted dump is restored beside the others under a new name (§2.1) and holds
#     what the source held at the dump.
#  6. The off-server copy: the backups are copied to the stand-in remote (the test MinIO), fetched
#     back from the remote ALONE into an empty directory — as on a new host after the server is
#     lost — and point-in-time recovery to the same target runs from that copy, with every check of
#     step 3 (README.md §7; backup-and-restore.md §5.4).
#  Timings are printed; they are a laptop's, not an RTO.

drill_run="drill-$(openssl rand -hex 4)"
drill_net="$drill_run-net"
drill_failures=0

drill_check() {
  local name="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "PASS  $name"
  else
    echo "FAIL  $name — expected '$expected', got '$actual'"
    drill_failures=$((drill_failures + 1))
  fi
}

extra_cleanup() {
  docker rm -f "$drill_run-pitr" "$drill_run-latest" "$drill_run-offsite" >/dev/null 2>&1 || true
  docker volume rm "$drill_run-pitr" "$drill_run-latest" "$drill_run-offsite" "$drill_run-fetched" >/dev/null 2>&1 || true
  docker network rm "$drill_net" >/dev/null 2>&1 || true
}

# shellcheck disable=SC2016 # expanded inside the container, from postgres.env
live_sql() { compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d $1 --no-psqlrc -tA -v ON_ERROR_STOP=1"; }
recovered_sql() { docker exec -i "$1" psql -U postgres -d "$2" --no-psqlrc -tA -v ON_ERROR_STOP=1; }

# What a tenant database holds, as one comparable line: the trail's length, its last position and
# digest, and the counts of the tables the smoke test wrote to.
fingerprint_sql="SELECT concat_ws('/',
  (SELECT count(*) FROM audit_event), (SELECT coalesce(max(sequence), 0) FROM audit_event),
  (SELECT coalesce((SELECT hash FROM audit_event ORDER BY sequence DESC LIMIT 1), '-')),
  (SELECT count(*) FROM \"user\"), (SELECT count(*) FROM document), (SELECT count(*) FROM file_object))"

step "Backup drill: stopping the application so the data stands still"
compose stop proxy web api >/dev/null

step "Backup drill 1: base backup and per-tenant dumps"
compose exec -T db-backup munaxa-backup once
base_name="$(compose exec -T db-backup sh -c 'ls /backup/base | grep -v partial | sort | tail -n 1')"
dump_set="$(compose exec -T db-backup sh -c 'ls /backup/dumps | grep -v partial | sort | tail -n 1')"
echo "base backup $base_name, dump set $dump_set"
declare -A at_dump at_target
for db in edms_acme edms_rival; do
  at_dump[$db]="$(live_sql "$db" <<<"$fingerprint_sql")"
done

step "Backup drill 2: change A, the target time, change B, WAL archived"
for db in edms_acme edms_rival; do
  live_sql "$db" <<<"CREATE TABLE drill_change_a (note text); INSERT INTO drill_change_a VALUES ('after the base backup');" >/dev/null
done
sleep 1
target_time="$(live_sql postgres <<<"SELECT now()")"
for db in edms_acme edms_rival; do
  at_target[$db]="$(live_sql "$db" <<<"$fingerprint_sql")"
done
sleep 1
for db in edms_acme edms_rival; do
  live_sql "$db" <<<"CREATE TABLE drill_change_b (note text); INSERT INTO drill_change_b VALUES ('after the target');" >/dev/null
done
switched="$(live_sql postgres <<<"SELECT pg_walfile_name(pg_switch_wal())")"
for _ in $(seq 1 60); do
  archived="$(live_sql postgres <<<"SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver")"
  [ -n "$archived" ] && [ ! "$archived" \< "$switched" ] && break
  sleep 1
done
echo "target time $target_time; WAL archived through $archived (switched at $switched)"
drill_check "the WAL holding both changes is archived" "$([ ! "$archived" \< "$switched" ] && echo yes)" yes

# A recovered cluster in its own container, on its own internal network, from the backup volume —
# or from RECOVER_SOURCE (a directory or volume in the same layout, such as a fetched off-server copy).
docker network create --internal "$drill_net" >/dev/null
recover() {
  local name="$1" target="$2" started source="${RECOVER_SOURCE:-$DOCS_BACKUP_DIR}"
  started="$(date +%s)"
  docker volume create "$name" >/dev/null
  # As root only to read this run's identity and hand it to the postgres user inside the volume;
  # the identity never leaves this run's private config directory otherwise.
  docker run --rm --user 0 --network none -v "$name:/restore" -v "$source:/backup:ro" \
    -v "$config/backup-identity.txt:/run/identity:ro" --entrypoint sh "$DOCS_POSTGRES_IMAGE" -ec '
      install -o 70 -g 70 -m 0400 /run/identity /restore/identity
      chown 70:70 /restore'
  docker run --rm --user 70:70 --network none -v "$name:/restore" -v "$source:/backup:ro" \
    -e BACKUP_AGE_IDENTITY_FILE=/restore/identity "$DOCS_POSTGRES_IMAGE" \
    munaxa-backup restore-base "$base_name" /restore/data
  # Recovery settings. The archive is mounted read-only and archiving is off in the recovered
  # cluster (it was a command-line setting of the live one), so recovery cannot write to it.
  docker run --rm --user 70:70 --network none -v "$name:/restore" -e TARGET="$target" \
    --entrypoint sh "$DOCS_POSTGRES_IMAGE" -ec '
      {
        echo "restore_command = '"'"'BACKUP_AGE_IDENTITY_FILE=/restore/identity munaxa-restore-wal %f %p'"'"'"
        if [ -n "$TARGET" ]; then
          echo "recovery_target_time = '"'"'$TARGET'"'"'"
          echo "recovery_target_action = '"'"'promote'"'"'"
        fi
      } >> /restore/data/postgresql.auto.conf
      touch /restore/data/recovery.signal'
  docker run -d --name "$name" --user 70:70 --network "$drill_net" -v "$name:/restore" \
    -v "$source:/backup:ro" --entrypoint postgres "$DOCS_POSTGRES_IMAGE" \
    -D /restore/data >/dev/null
  for _ in $(seq 1 120); do
    [ "$(docker exec "$name" psql -U postgres -tAc 'SELECT pg_is_in_recovery()' 2>/dev/null)" = "f" ] && break
    sleep 1
  done
  echo "recovered $name in $(($(date +%s) - started)) s (decrypt, extract, verify, replay)"
}

tenant_tables_without_forced_rls_sql="SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity)"
tenant_tables_sql="SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)"

# The audit hash chain, recomputed from genesis with the product's own verifier (the API image's
# compiled hash-chain and row mapping), over the recovered rows, as the backup role.
verify_chain() {
  local container="$1" db="$2"
  # The URL holds a password, so it is passed through the environment, never as an argument.
  DATABASE_URL="postgresql://edms_backup:$backup_pw@$container:5432/$db" \
    docker run --rm --network "$drill_net" --entrypoint node -w /app/apps/api \
    -e DATABASE_URL "$DOCS_API_IMAGE" -e '
      require("reflect-metadata");
      const { PrismaClient } = require("@prisma/client");
      const { verifyChain, GENESIS_HASH } = require("./dist/core/audit/hash-chain.js");
      const { toChainLink } = require("./dist/modules/audit/application/audit-verification.service.js");
      (async () => {
        const prisma = new PrismaClient();
        const rows = await prisma.auditEvent.findMany({ orderBy: { sequence: "asc" } });
        await prisma.$disconnect();
        if (rows.length === 0) { console.log("intact=empty events=0"); return; }
        const result = verifyChain(rows.map(toChainLink), { from: GENESIS_HASH, fromSequence: rows[0].sequence });
        console.log(`intact=${result.intact} events=${rows.length} first=${rows[0].sequence}`);
      })().catch((error) => { console.log(`error=${error.message}`); process.exit(1); });
    '
}

check_recovered() {
  local container="$1" label="$2" expect_b="$3"
  for db in edms_acme edms_rival; do
    drill_check "$label: $db holds change A (replayed from the WAL)" \
      "$(recovered_sql "$container" "$db" <<<"SELECT to_regclass('drill_change_a') IS NOT NULL")" t
    drill_check "$label: $db $([ "$expect_b" = t ] && echo holds || echo does not hold) change B" \
      "$(recovered_sql "$container" "$db" <<<"SELECT to_regclass('drill_change_b') IS NOT NULL")" "$expect_b"
    drill_check "$label: $db is what it was at the target (trail, users, documents, files)" \
      "$(recovered_sql "$container" "$db" <<<"$fingerprint_sql")" "${at_target[$db]}"
    drill_check "$label: $db has row-level security enabled and forced on every tenant table" \
      "$(recovered_sql "$container" "$db" <<<"$tenant_tables_without_forced_rls_sql")" 0
  done
  drill_check "$label: tenant tables found to check" \
    "$([ "$(recovered_sql "$container" edms_acme <<<"$tenant_tables_sql")" -gt 50 ] && echo yes)" yes
  drill_check "$label: the application role is neither superuser nor BYPASSRLS" \
    "$(recovered_sql "$container" postgres <<<"SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'edms_app'")" f
  drill_check "$label: edms_acme holds no other tenant's users" \
    "$(recovered_sql "$container" edms_acme <<<"SELECT count(*) FROM \"user\" WHERE tenant_id <> '$acme_id'")" 0
  drill_check "$label: edms_rival holds no other tenant's users" \
    "$(recovered_sql "$container" edms_rival <<<"SELECT count(*) FROM \"user\" WHERE tenant_id <> '$rival_id'")" 0
  # As the application role, through its own policy: acme's users under acme's context, none under
  # rival's. Local socket: the role, not the password, is what is being tested.
  drill_check "$label: as edms_app, acme's context sees acme's users" \
    "$(docker exec -i "$container" psql -U edms_app -d edms_acme --no-psqlrc -qtA <<<"BEGIN; SELECT set_config('app.tenant_id', '$acme_id', true) IS NOT NULL; SELECT count(*) > 0 FROM \"user\"; COMMIT;" | tail -n 1)" t
  drill_check "$label: as edms_app, rival's context sees none of acme's rows" \
    "$(docker exec -i "$container" psql -U edms_app -d edms_acme --no-psqlrc -qtA <<<"BEGIN; SELECT set_config('app.tenant_id', '$rival_id', true) IS NOT NULL; SELECT count(*) FROM \"user\"; COMMIT;" | tail -n 1)" 0
  drill_check "$label: the audit hash chain of edms_acme verifies from genesis" \
    "$(verify_chain "$container" edms_acme | sed -n 's/^intact=\([a-z]*\).*/\1/p')" true
  verify_chain "$container" edms_acme
}

step "Backup drill 3: point-in-time recovery to the target, in a new container"
recover "$drill_run-pitr" "$target_time"
docker logs "$drill_run-pitr" 2>&1 | grep -E 'recovery stopping|recovery target|selected new timeline|archive recovery complete' | sed 's/^/  /' || true
check_recovered "$drill_run-pitr" "PITR to the target" f

step "Backup drill 4: recovery to the end of the archive"
recover "$drill_run-latest" ""
drill_check "latest: edms_acme holds change B" \
  "$(recovered_sql "$drill_run-latest" edms_acme <<<"SELECT to_regclass('drill_change_b') IS NOT NULL")" t
drill_check "latest: edms_rival holds change B" \
  "$(recovered_sql "$drill_run-latest" edms_rival <<<"SELECT to_regclass('drill_change_b') IS NOT NULL")" t

step "Backup drill 5: one tenant's encrypted dump restored beside the others (§2.1)"
PGPASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$config/postgres.env")" \
  docker run --rm --user 0 --network "$drill_net" -v "$DOCS_BACKUP_DIR:/backup:ro" \
  -v "$config/backup-identity.txt:/run/identity:ro" -e BACKUP_AGE_IDENTITY_FILE=/run/identity \
  -e PGHOST="$drill_run-pitr" -e PGUSER=postgres -e PGPASSWORD \
  --entrypoint sh "$DOCS_POSTGRES_IMAGE" -ec "
    munaxa-backup decrypt /backup/dumps/$dump_set/edms_acme.dump.age > /tmp/acme.dump
    psql -d postgres -qc 'CREATE DATABASE edms_acme_restored OWNER edms_owner'
    pg_restore --exit-on-error --dbname=edms_acme_restored /tmp/acme.dump
    rm -f /tmp/acme.dump"
drill_check "dump: the restored copy holds what edms_acme held at the dump" \
  "$(recovered_sql "$drill_run-pitr" edms_acme_restored <<<"$fingerprint_sql")" "${at_dump[edms_acme]}"
drill_check "dump: the restored copy keeps row-level security forced on every tenant table" \
  "$(recovered_sql "$drill_run-pitr" edms_acme_restored <<<"$tenant_tables_without_forced_rls_sql")" 0
drill_check "dump: the audit hash chain of the restored copy verifies from genesis" \
  "$(verify_chain "$drill_run-pitr" edms_acme_restored | sed -n 's/^intact=\([a-z]*\).*/\1/p')" true

step "Backup drill 6: recovery from the off-server copy alone"
# The copy job as the host timer runs it, now that step 1's base backup and step 2's WAL exist.
compose --profile ops run --rm offsite sync
# The fetch is what a new host does: the rclone image, the copy credential and the remote — no
# backup volume mounted at all. Every byte it writes is checked against the digests recorded when
# the file was verified on the remote.
docker volume create "$drill_run-fetched" >/dev/null
docker run --rm --user 0 --network none -v "$drill_run-fetched:/restore" --entrypoint sh \
  "$DOCS_POSTGRES_IMAGE" -c 'chown 70:70 /restore && chmod 0700 /restore'
offsite_image="$(sed -n 's/.*DOCS_OFFSITE_IMAGE:-\([^}]*\)}.*/\1/p' "$template/compose.yaml")"
fetch_started="$(date +%s)"
docker run --rm --user 70:70 --read-only --tmpfs /tmp --network "${DOCS_PROJECT_NAME}_ci-storage" \
  --env-file "$config/offsite.env" -e HOME=/tmp -v "$template/offsite/offsite.sh:/opt/munaxa/offsite.sh:ro" \
  -v "$drill_run-fetched:/restore" --entrypoint /bin/sh "$offsite_image" \
  /opt/munaxa/offsite.sh fetch /restore "$base_name"
echo "fetched in $(($(date +%s) - fetch_started)) s"
RECOVER_SOURCE="$drill_run-fetched" recover "$drill_run-offsite" "$target_time"
check_recovered "$drill_run-offsite" "PITR from the off-server copy" f

if [ "$drill_failures" -eq 0 ]; then
  echo "PASS  backup drill: every expectation held"
else
  echo "FAIL  backup drill: $drill_failures expectation(s) did not hold"
fi
extra_failures=$((${extra_failures:-0} + drill_failures))
