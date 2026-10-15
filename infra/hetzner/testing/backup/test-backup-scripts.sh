#!/usr/bin/env bash
# Tests for the backup scripts in infra/hetzner/postgres (R-1; backup-and-restore.md §5).
#
#   DOCS_POSTGRES_IMAGE=munaxa-docs-postgres:local infra/hetzner/testing/backup/test-backup-scripts.sh
#
# Runs every script inside the image it ships in, against a disposable PostgreSQL container on a
# private Docker network. Every key pair is generated here for this run and deleted with it; nothing
# leaves the machine. Each check prints PASS or FAIL; the exit status is the number of failures.
set -uo pipefail

image="${DOCS_POSTGRES_IMAGE:?set DOCS_POSTGRES_IMAGE to the image built from infra/hetzner/postgres}"
run_id="backup-test-$(openssl rand -hex 4)"
work="$(mktemp -d)"
network="$run_id"
database="$run_id-pg"
failures=0

cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$run_id-backup" "$run_id-data" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

pass() { echo "PASS  $*"; }
fail() {
  echo "FAIL  $*"
  failures=$((failures + 1))
}
# expect_fail NAME PATTERN -- COMMAND…: the command must exit non-zero with PATTERN in its output.
expect_fail() {
  local name="$1" pattern="$2"
  shift 3
  local output code=0
  output="$("$@" 2>&1)" || code=$?
  if [ "$code" -ne 0 ] && printf '%s' "$output" | grep -q -- "$pattern"; then
    pass "$name"
  else
    fail "$name (exit $code): $(printf '%s' "$output" | tail -n 2)"
  fi
}
expect_ok() {
  local name="$1"
  shift
  local output
  if output="$("$@" 2>&1)"; then
    pass "$name"
  else
    fail "$name: $(printf '%s' "$output" | tail -n 3)"
  fi
}

# Keys for this run. `other` is a second, unrelated identity.
docker run --rm --entrypoint age-keygen "$image" >"$work/identity" 2>/dev/null
docker run --rm --entrypoint age-keygen "$image" >"$work/other" 2>/dev/null
recipient="$(grep -o 'age1[a-z0-9]*' "$work/identity")"
# Readable by the image's postgres user (uid 70) through the bind mount; test keys only.
chmod 0755 "$work"
chmod 0644 "$work/identity" "$work/other"

# A container from the image with the backup volume on a tmpfs (a filesystem of its own, like a
# mounted Hetzner Volume) and the identities mounted for the recovery-side tests.
in_image() {
  docker run --rm -i --user 70:70 --tmpfs /backup:uid=70,gid=70,mode=0700 \
    -v "$work:/keys:ro" -e BACKUP_AGE_RECIPIENTS="$recipient" "$@"
}

echo "=== munaxa-archive-wal and munaxa-restore-wal"

# One container per scenario, so state never leaks between them. PGDATA points at a directory in
# the container's own filesystem; /backup is the tmpfs.
archive_script='
  set -e
  mkdir -p /backup/wal /tmp/pgdata
  export PGDATA=/tmp/pgdata
  head -c 1048576 /dev/urandom > /tmp/segment
  printf "MUNAXA-PLAINTEXT-MARKER" >> /tmp/segment
'

expect_fail "archive: refuses without recipients" "BACKUP_AGE_RECIPIENTS is not set" -- \
  in_image -e BACKUP_AGE_RECIPIENTS= --entrypoint sh "$image" -c \
  "$archive_script munaxa-archive-wal /tmp/segment 000000010000000000000001"

expect_fail "archive: refuses something that is not an age public key" "not an age public key" -- \
  in_image -e BACKUP_AGE_RECIPIENTS=ssh-ed25519 --entrypoint sh "$image" -c \
  "$archive_script munaxa-archive-wal /tmp/segment 000000010000000000000001"

expect_fail "archive: refuses the database's own filesystem" "database's own filesystem" -- \
  in_image --entrypoint sh "$image" -c '
    set -e; mkdir -p /tmp/pgdata /tmp/wal; head -c 1024 /dev/urandom > /tmp/segment
    PGDATA=/tmp/pgdata BACKUP_WAL_DIR=/tmp/wal munaxa-archive-wal /tmp/segment 000000010000000000000001'

expect_fail "archive: refuses a file name that is not a WAL name" "unexpected file name" -- \
  in_image --entrypoint sh "$image" -c "$archive_script munaxa-archive-wal /tmp/segment ../escape"

expect_ok "archive: encrypts, records the plaintext digest, keeps no plaintext, and is idempotent" \
  in_image --entrypoint sh "$image" -c "$archive_script"'
    name=000000010000000000000001
    munaxa-archive-wal /tmp/segment $name
    [ -f /backup/wal/$name.age ] && [ -f /backup/wal/$name.sha256 ]
    [ "$(cat /backup/wal/$name.sha256)" = "$(sha256sum /tmp/segment | cut -d" " -f1)" ]
    ! grep -q MUNAXA-PLAINTEXT-MARKER /backup/wal/$name.age
    before=$(sha256sum /backup/wal/$name.age)
    munaxa-archive-wal /tmp/segment $name            # PostgreSQL retrying after a crash
    [ "$(sha256sum /backup/wal/$name.age)" = "$before" ]
    [ -z "$(ls -A /backup/wal | grep "^\.")" ]       # no temporary files left behind'

expect_fail "archive: never overwrites a segment with different content" "different content" -- \
  in_image --entrypoint sh "$image" -c "$archive_script"'
    name=000000010000000000000001
    munaxa-archive-wal /tmp/segment $name
    head -c 1024 /dev/urandom > /tmp/other
    munaxa-archive-wal /tmp/other $name'

restore_setup="$archive_script"'
  name=000000010000000000000001
  munaxa-archive-wal /tmp/segment $name
  export BACKUP_AGE_IDENTITY_FILE=/keys/identity
'
expect_ok "restore: decrypts a segment to exactly what was archived" \
  in_image --entrypoint sh "$image" -c "$restore_setup"'
    munaxa-restore-wal $name /tmp/restored
    cmp /tmp/segment /tmp/restored'

expect_ok "restore: answers non-zero, and writes nothing, for a segment that was never archived" \
  in_image --entrypoint sh "$image" -c "$restore_setup"'
    if munaxa-restore-wal 000000010000000000000009 /tmp/restored; then exit 1; fi
    [ ! -e /tmp/restored ] && [ ! -e /tmp/restored.restoring ]'

expect_fail "restore: refuses a segment whose recorded digest does not match" "does not match the digest" -- \
  in_image --entrypoint sh "$image" -c "$restore_setup"'
    echo 0000000000000000000000000000000000000000000000000000000000000000 > /backup/wal/$name.sha256
    munaxa-restore-wal $name /tmp/restored || { [ ! -e /tmp/restored ] && exit 1; }'

expect_fail "restore: refuses an altered ciphertext, writing nothing" "" -- \
  in_image --entrypoint sh "$image" -c "$restore_setup"'
    printf "x" | dd of=/backup/wal/$name.age bs=1 seek=2000 conv=notrunc 2>/dev/null
    if munaxa-restore-wal $name /tmp/restored; then exit 0; fi
    [ ! -e /tmp/restored ] || echo "a partial file was left" >&2
    exit 1'

expect_fail "restore: a different identity cannot decrypt" "" -- \
  in_image --entrypoint sh "$image" -c "$restore_setup"'
    BACKUP_AGE_IDENTITY_FILE=/keys/other munaxa-restore-wal $name /tmp/restored'

echo
echo "=== munaxa-backup validate (no database needed for these)"
validate() { in_image -e PGHOST=nowhere.invalid -e PGPASSWORD=x "$@" "$image" munaxa-backup validate; }
same_device() { in_image -e PGHOST=nowhere.invalid -e PGPASSWORD=x "$@" --entrypoint sh "$image" -c \
  'mkdir -p /tmp/pgdata; BACKUP_PGDATA_PATH=/tmp/pgdata BACKUP_DIR=/tmp munaxa-backup validate'; }

expect_fail "validate: refuses to run beside an identity file" "private key" -- \
  validate -e BACKUP_AGE_IDENTITY_FILE=/keys/identity
expect_fail "validate: refuses a private key in the environment" "private key" -- \
  validate -e STRAY="$(grep -o 'AGE-SECRET-KEY-[A-Z0-9]*' "$work/identity")"
expect_fail "validate: refuses a malformed recipient" "not an age public key" -- \
  validate -e BACKUP_AGE_RECIPIENTS="${recipient}x"
expect_fail "validate: refuses a missing recipient" "BACKUP_AGE_RECIPIENTS is not set" -- \
  validate -e BACKUP_AGE_RECIPIENTS=
expect_fail "validate: refuses a time that is not HH:MM" "BACKUP_AT" -- validate -e BACKUP_AT=25:00
expect_fail "validate: refuses a zero retention" "BACKUP_RETENTION_DAYS" -- \
  validate -e BACKUP_RETENTION_DAYS=0
expect_fail "validate: refuses the database's own filesystem" "database's own filesystem" -- same_device
expect_fail "validate: refuses when the database volume is not mounted for the check" "not mounted" -- \
  validate -e BACKUP_PGDATA_PATH=/nonexistent
expect_fail "validate: refuses without the backup role's password" "PGPASSWORD" -- \
  in_image -e PGHOST=nowhere.invalid -e BACKUP_ALLOW_SAME_DEVICE=1 "$image" munaxa-backup validate

echo
echo "=== munaxa-backup against a real PostgreSQL"
# pg_hba.conf admits replication only from the template's data network, so the test network uses
# that subnet — which is also why this cannot run beside a stack test on the same Docker host.
docker network create --subnet 172.28.11.0/24 "$network" >/dev/null
docker volume create "$run_id-backup" >/dev/null
docker volume create "$run_id-data" >/dev/null
docker run --rm -v "$run_id-backup:/backup" --entrypoint sh "$image" \
  -c 'mkdir -p /backup/wal && chown -R 70:70 /backup && chmod 0700 /backup'
# The backup volume is a named volume here, so it shares the Docker disk with the database
# volume: the same-device check is relaxed for this part, and tested above instead.
POSTGRES_PASSWORD="$(openssl rand -hex 16)" docker run -d --name "$database" --network "$network" -e POSTGRES_PASSWORD \
  -e BACKUP_AGE_RECIPIENTS="$recipient" -e BACKUP_ALLOW_SAME_DEVICE=1 \
  -v "$run_id-data:/var/lib/postgresql/data" -v "$run_id-backup:/backup" "$image" \
  postgres -c hba_file=/etc/munaxa-postgres/pg_hba.conf -c wal_level=replica -c archive_mode=on \
  -c 'archive_command=munaxa-archive-wal %p %f' -c archive_timeout=60 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$database" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
sleep 2
backup_password="$(openssl rand -hex 16)"
# Passed to containers through the environment (`-e PGPASSWORD`), never as an argument.
export PGPASSWORD="$backup_password"
docker exec -i "$database" psql -U postgres -v ON_ERROR_STOP=1 -q -v pw="$backup_password" >/dev/null <<'SQL'
CREATE ROLE edms_backup LOGIN BYPASSRLS PASSWORD :'pw';
GRANT pg_read_all_data TO edms_backup;
CREATE DATABASE edms_acme;
CREATE DATABASE edms_rival;
SQL
docker exec "$database" psql -U postgres -d edms_acme -qc \
  "CREATE TABLE marker (value text); INSERT INTO marker VALUES ('acme-row')" >/dev/null

tool() {
  docker run --rm -i --network "$network" --user 70:70 -v "$run_id-backup:/backup" \
    -v "$run_id-data:/var/lib/postgresql/data:ro" -v "$work:/keys:ro" \
    -e PGHOST="$database" -e PGPASSWORD -e BACKUP_AGE_RECIPIENTS="$recipient" \
    -e BACKUP_ALLOW_SAME_DEVICE=1 "$@"
}

expect_fail "validate: refuses a backup role without REPLICATION, and names the fix" "db-admin bootstrap" -- \
  tool "$image" munaxa-backup validate
docker exec "$database" psql -U postgres -qc 'ALTER ROLE edms_backup REPLICATION' >/dev/null
expect_ok "validate: passes with the role, archiving on and recipients set" tool "$image" munaxa-backup validate

expect_fail "health: fails before any backup has run" "did not succeed" -- tool "$image" munaxa-backup health
expect_ok "once: base backup, a dump per tenant database, prune and status" tool "$image" munaxa-backup once
expect_ok "health: passes after a successful run" tool "$image" munaxa-backup health
expect_ok "status: the monitoring file carries the metrics and no host or database names" \
  tool --entrypoint sh "$image" -c '
    f=/backup/status/backup.prom
    grep -q "^munaxa_backup_last_run_success 1$" $f
    grep -q "^munaxa_backup_last_success_timestamp_seconds [1-9]" $f
    grep -q "^munaxa_backup_wal_newest_archived_timestamp_seconds [1-9]" $f
    ! grep -qiE "edms_|postgres|password" $f'
expect_ok "once: nothing on the volume is plaintext" tool --entrypoint sh "$image" -c '
  ls /backup/dumps/*/edms_acme.dump.age /backup/dumps/*/edms_rival.dump.age /backup/dumps/*/roles.sql.age >/dev/null
  ! grep -rqE "PGDMP|PG_VERSION|acme-row|CREATE ROLE" /backup/base /backup/dumps /backup/wal'

expect_fail "decrypt: needs the identity" "BACKUP_AGE_IDENTITY_FILE" -- tool --entrypoint sh "$image" -c \
  'munaxa-backup decrypt "$(ls /backup/dumps/*/edms_acme.dump.age)" >/dev/null'
expect_ok "decrypt: an encrypted tenant dump decrypts to a custom-format dump holding its table data" \
  tool -e BACKUP_AGE_IDENTITY_FILE=/keys/identity --entrypoint sh "$image" -c '
    export PGUSER=edms_backup
    munaxa-backup decrypt "$(ls /backup/dumps/*/edms_acme.dump.age)" > /tmp/acme.dump
    head -c 5 /tmp/acme.dump | grep -q PGDMP
    pg_restore --list /tmp/acme.dump | grep -q "TABLE DATA public marker"'
expect_fail "decrypt: refuses a file altered after it was written" "does not match the digest" -- \
  tool -e BACKUP_AGE_IDENTITY_FILE=/keys/identity --user 0 --entrypoint sh "$image" -c '
    f="$(ls /backup/dumps/*/edms_rival.dump.age)"
    cp "$f" /tmp/keep && printf x | dd of="$f" bs=1 seek=100 conv=notrunc 2>/dev/null
    code=0; munaxa-backup decrypt "$f" >/dev/null || code=$?
    cp /tmp/keep "$f"; exit $code'

expect_fail "restore-base: needs the identity" "BACKUP_AGE_IDENTITY_FILE" -- \
  tool --entrypoint sh "$image" -c 'munaxa-backup restore-base latest /tmp/restore'
expect_fail "restore-base: never writes into a directory that is not empty" "not empty" -- \
  tool -e BACKUP_AGE_IDENTITY_FILE=/keys/identity --entrypoint sh "$image" -c \
  'mkdir -p /tmp/r && touch /tmp/r/existing && munaxa-backup restore-base latest /tmp/r'
expect_ok "restore-base: decrypts, extracts and verifies every file against the backup manifest" \
  tool -e BACKUP_AGE_IDENTITY_FILE=/keys/identity --entrypoint sh "$image" -c \
  'munaxa-backup restore-base latest /tmp/restore 2>&1 | grep -q "backup successfully verified"'

echo
echo "=== retention"
expect_ok "prune: removes old backups and the WAL only they needed, keeps the newest and .history" \
  tool --user 70:70 --entrypoint sh "$image" -c '
    set -e
    old=$(( $(date -u +%s) - 90 * 86400 ))
    for n in 1 2; do
      d=/backup/base/20000101T00000${n}Z; mkdir -p $d
      echo $old > $d/created-epoch; echo 00000001000000000000000$n > $d/start-wal
      : > $d/base.tar.age
      d=/backup/dumps/20000101T00000${n}Z; mkdir -p $d; echo $old > $d/created-epoch
    done
    mkdir -p /backup/base/20000101T000009Z.partial && touch -t 200001010000 /backup/base/20000101T000009Z.partial
    for s in 000000010000000000000000 00000001000000000000000A; do : > /backup/wal/$s.age; : > /backup/wal/$s.sha256; done
    : > /backup/wal/00000002.history.age
    BACKUP_MIN_KEEP=1 munaxa-backup prune
    [ ! -d /backup/base/20000101T000001Z ] && [ ! -d /backup/base/20000101T000002Z ]
    [ ! -d /backup/dumps/20000101T000001Z ] && [ ! -d /backup/dumps/20000101T000002Z ]
    [ ! -d /backup/base/20000101T000009Z.partial ]
    [ "$(ls -d /backup/base/*Z | wc -l)" -eq 1 ]           # the real, recent one
    [ ! -e /backup/wal/000000010000000000000000.age ]
    [ -e /backup/wal/00000002.history.age ]'
expect_ok "prune: keeps the newest BACKUP_MIN_KEEP however old they are" \
  tool --user 70:70 --entrypoint sh "$image" -c '
    set -e
    for d in /backup/base/*Z /backup/dumps/*Z; do echo 1 > $d/created-epoch; done
    BACKUP_MIN_KEEP=1 munaxa-backup prune
    [ "$(ls -d /backup/base/*Z | wc -l)" -eq 1 ] && [ "$(ls -d /backup/dumps/*Z | wc -l)" -eq 1 ]'

echo
echo "=== a failed run is visible"
docker stop "$database" >/dev/null
expect_fail "once: fails when the database is unreachable" "FAILED" -- tool "$image" munaxa-backup once
expect_fail "health: fails after a failed run" "did not succeed" -- tool "$image" munaxa-backup health
expect_ok "status: records the failure for monitoring" tool --entrypoint sh "$image" -c '
  grep -q "^munaxa_backup_last_run_success 0$" /backup/status/backup.prom
  grep -q "^munaxa_backup_last_failure_timestamp_seconds [1-9]" /backup/status/backup.prom'

echo
if [ "$failures" -eq 0 ]; then
  echo "All backup script checks passed"
else
  echo "$failures backup script check(s) FAILED"
fi
exit "$failures"
