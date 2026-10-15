#!/bin/sh
# shellcheck shell=busybox # Alpine's ash: pipefail and [ \< ] are supported there
# munaxa-backup — PostgreSQL backups for the Hetzner template (R-1; backup-and-restore.md §5).
#
# Runs in the `db-backup` service (compose.yaml) as the backup role `edms_backup` over the private
# data network. It holds no private key: everything it writes is encrypted with `age` to the
# recipients in BACKUP_AGE_RECIPIENTS, and only `restore-base` / `decrypt` (recovery) take an
# identity.
#
#   munaxa-backup validate         check the configuration and the database connection
#   munaxa-backup once             validate, base backup, per-tenant dumps, prune, status
#   munaxa-backup run              `once` daily at BACKUP_AT (UTC), status every 10 minutes
#   munaxa-backup health           exit 0 when the last run succeeded and is recent enough
#   munaxa-backup status           rewrite the status files (also done by every run)
#   munaxa-backup list             what is on the backup volume
#   munaxa-backup decrypt FILE     check a backup file's digest, then decrypt it to stdout (identity)
#   munaxa-backup restore-base NAME|latest DIR   decrypt, extract and verify a base backup (identity)
#
# Layout under BACKUP_DIR (one directory per environment, on its own filesystem):
#   wal/<segment>.age, .sha256        written by munaxa-archive-wal (the postgres service)
#   base/<UTC stamp>/                 base.tar.age (pg_basebackup -Ft, WAL included, manifest
#                                     SHA-256), base.tar.age.sha256, start-wal, created-epoch
#   dumps/<UTC stamp>/                <database>.dump.age (+ .sha256) per tenant, roles.sql.age
#   status/backup.prom, status/state  for monitoring (monitoring.md) and `health`
# A directory is written as <stamp>.partial and renamed only when complete; a half-written backup
# never looks like one.
#
# Environment:
#   PGHOST (postgres), PGUSER (edms_backup), PGPASSWORD (backup.env)
#   BACKUP_AGE_RECIPIENTS        age public keys, comma- or space-separated (deploy.env)
#   BACKUP_DIR                   default /backup
#   BACKUP_AT                    HH:MM UTC for the daily run (default 02:30)
#   BACKUP_RETENTION_DAYS        base backups and WAL kept (default 35; backup-and-restore.md §1)
#   BACKUP_DUMP_RETENTION_DAYS   per-tenant dumps kept (default 35)
#   BACKUP_MIN_KEEP              newest backups always kept, whatever their age (default 2)
#   BACKUP_MAX_AGE_HOURS         `health` fails past this since the last success (default 26)
#   BACKUP_PGDATA_PATH           the database volume, mounted read-only only for the device check
#   BACKUP_ALLOW_SAME_DEVICE=1   TESTS ONLY: allow the backups on the database's own filesystem
#   BACKUP_AGE_IDENTITY_FILE     the private key — recovery only; refused by every backup command
set -eu
set -o pipefail

BACKUP_DIR="${BACKUP_DIR:-/backup}"
BACKUP_AT="${BACKUP_AT:-02:30}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-35}"
BACKUP_DUMP_RETENTION_DAYS="${BACKUP_DUMP_RETENTION_DAYS:-35}"
BACKUP_MIN_KEEP="${BACKUP_MIN_KEEP:-2}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
BACKUP_PGDATA_PATH="${BACKUP_PGDATA_PATH:-/var/lib/postgresql/data}"
export PGHOST="${PGHOST:-postgres}" PGUSER="${PGUSER:-edms_backup}" PGDATABASE=postgres
export PGCONNECT_TIMEOUT=10

log() { echo "munaxa-backup: $*" >&2; }
fail() {
  log "$*"
  exit 1
}
now() { date -u +%s; }
stamp() { date -u +%Y%m%dT%H%M%SZ; }
psql_q() { psql --no-psqlrc --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 "$@"; }

# --- configuration -------------------------------------------------------------------------------

recipient_args() {
  args=""
  for recipient in $(printf '%s' "${BACKUP_AGE_RECIPIENTS:-}" | tr ',' ' '); do
    # An age X25519 recipient: "age1" and 58 bech32 characters. Anything else — an SSH key, a
    # typo, a private key pasted into the wrong variable — is refused rather than guessed at.
    printf '%s' "$recipient" | grep -Eq '^age1[02-9ac-hj-np-z]{58}$' ||
      fail "BACKUP_AGE_RECIPIENTS holds something that is not an age public key"
    args="$args -r $recipient"
  done
  [ -n "$args" ] || fail "BACKUP_AGE_RECIPIENTS is not set"
  printf '%s' "$args"
}

positive_integer() {
  case "$2" in
    '' | *[!0-9]* | 0*) fail "$1 must be a positive whole number" ;;
  esac
}

# Everything that can be checked without writing a backup. Called by every backup command first,
# so a misconfiguration fails the run (and the status) instead of producing something unusable.
validate() {
  # The server must never be able to decrypt its own backups.
  if [ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ] || env | grep -q 'AGE-SECRET-KEY-'; then
    fail "an age identity (private key) is present; backups are written with public keys only"
  fi
  recipient_args >/dev/null
  case "$BACKUP_AT" in
    [01][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) ;;
    *) fail "BACKUP_AT must be HH:MM (UTC)" ;;
  esac
  positive_integer BACKUP_RETENTION_DAYS "$BACKUP_RETENTION_DAYS"
  positive_integer BACKUP_DUMP_RETENTION_DAYS "$BACKUP_DUMP_RETENTION_DAYS"
  positive_integer BACKUP_MIN_KEEP "$BACKUP_MIN_KEEP"
  positive_integer BACKUP_MAX_AGE_HOURS "$BACKUP_MAX_AGE_HOURS"
  [ -d "$BACKUP_DIR" ] && [ -w "$BACKUP_DIR" ] || fail "$BACKUP_DIR is not a writable directory"
  if [ "${BACKUP_ALLOW_SAME_DEVICE:-0}" = "1" ]; then
    log "WARNING: BACKUP_ALLOW_SAME_DEVICE=1 — backups may share the database's disk (tests only)"
  else
    [ -d "$BACKUP_PGDATA_PATH" ] ||
      fail "the database volume is not mounted at $BACKUP_PGDATA_PATH, so the device check cannot run"
    [ "$(stat -c %d "$BACKUP_DIR")" != "$(stat -c %d "$BACKUP_PGDATA_PATH")" ] ||
      fail "refusing to back up onto the database's own filesystem ($BACKUP_DIR); mount a separate volume"
  fi
  mkdir -p "$BACKUP_DIR/base" "$BACKUP_DIR/dumps" "$BACKUP_DIR/status" "$BACKUP_DIR/wal"
  [ -n "${PGPASSWORD:-}" ] || fail "PGPASSWORD (the edms_backup password, backup.env) is not set"
  replication="$(psql_q -c 'SELECT rolreplication FROM pg_roles WHERE rolname = current_user')" ||
    fail "cannot connect to PostgreSQL at $PGHOST as $PGUSER"
  [ "$replication" = "t" ] ||
    fail "$PGUSER lacks REPLICATION; run db-admin bootstrap again (it grants it)"
  archiving="$(psql_q -c 'SHOW archive_mode')"
  [ "$archiving" = "on" ] || fail "archive_mode is $archiving on the server; WAL is not being archived"
}

# --- writing -------------------------------------------------------------------------------------

# Encrypts stdin to FILE, then records the ciphertext's SHA-256 beside it, so a copy can be checked
# anywhere without the private key.
seal_to() {
  file="$1"
  # shellcheck disable=SC2046 # recipient_args is a list of `-r key` arguments, split on purpose
  age $(recipient_args) -o "$file"
  sha256sum "$file" | cut -d' ' -f1 >"$file.sha256"
}

base_backup() {
  name="$(stamp)"
  partial="$BACKUP_DIR/base/$name.partial"
  mkdir -p "$partial"
  # The WAL segment current before the backup starts: every segment the backup could need is at or
  # after it, so `prune` may delete WAL strictly older than the oldest kept backup's start-wal.
  psql_q -c 'SELECT pg_walfile_name(pg_current_wal_lsn())' >"$partial/start-wal"
  log "base backup $name: started"
  # -Ft to stdout writes one tar with WAL (-X fetch) and the manifest inside, so the backup is
  # complete on its own; pg_verifybackup checks it on restore.
  pg_basebackup -D - -Ft -X fetch --checkpoint=fast --manifest-checksums=SHA256 \
    --label="munaxa-$name" | seal_to "$partial/base.tar.age"
  now >"$partial/created-epoch"
  sync -f "$partial/base.tar.age"
  mv "$partial" "$BACKUP_DIR/base/$name"
  log "base backup $name: done ($(stat -c %s "$BACKUP_DIR/base/$name/base.tar.age") bytes encrypted)"
}

tenant_dumps() {
  name="$(stamp)"
  partial="$BACKUP_DIR/dumps/$name.partial"
  mkdir -p "$partial"
  # Role definitions without passwords: what `pg_restore` needs to exist first (runbook §2.1 step 1).
  pg_dumpall --roles-only --no-role-passwords | seal_to "$partial/roles.sql.age"
  count=0
  for database in $(psql_q -c "SELECT datname FROM pg_database WHERE datname LIKE 'edms\_%' AND datallowconn ORDER BY 1"); do
    # As edms_backup: BYPASSRLS and pg_read_all_data, so forced row-level security does not hide
    # rows from the dump (STG-2).
    pg_dump --format=custom --dbname="$database" | seal_to "$partial/$database.dump.age"
    count=$((count + 1))
  done
  now >"$partial/created-epoch"
  sync -f "$partial/roles.sql.age"
  mv "$partial" "$BACKUP_DIR/dumps/$name"
  log "tenant dumps $name: $count database(s)"
}

# --- retention -----------------------------------------------------------------------------------

# Prints the complete backups in AREA, oldest first.
complete_backups() {
  for entry in "$BACKUP_DIR/$1"/*; do
    [ -d "$entry" ] && [ -f "$entry/created-epoch" ] && case "$entry" in *.partial) ;; *) echo "$entry" ;; esac
  done | sort
}

# Removes backups in AREA older than DAYS, always keeping the newest BACKUP_MIN_KEEP.
prune_area() {
  area="$1"
  days="$2"
  total="$(complete_backups "$area" | wc -l)"
  removable=$((total - BACKUP_MIN_KEEP))
  cutoff=$(($(now) - days * 86400))
  complete_backups "$area" | while read -r entry; do
    [ "$removable" -gt 0 ] || break
    if [ "$(cat "$entry/created-epoch")" -lt "$cutoff" ]; then
      log "prune: removing $area/$(basename "$entry")"
      rm -rf "$entry"
      removable=$((removable - 1))
    fi
  done
  # A .partial left by a crashed run is never a backup; remove it once it is a day old.
  for entry in "$BACKUP_DIR/$area"/*.partial; do
    [ -d "$entry" ] || continue
    if [ "$(stat -c %Y "$entry")" -lt $(($(now) - 86400)) ]; then
      log "prune: removing the abandoned $area/$(basename "$entry")"
      rm -rf "$entry"
    fi
  done
}

prune() {
  prune_area base "$BACKUP_RETENTION_DAYS"
  prune_area dumps "$BACKUP_DUMP_RETENTION_DAYS"
  oldest="$(complete_backups base | head -n 1)"
  if [ -z "$oldest" ]; then
    # Without a base backup no WAL is useful — and none is deleted either.
    return 0
  fi
  keep_from="$(cut -c1-24 "$oldest/start-wal")"
  printf '%s' "$keep_from" | grep -Eq '^[0-9A-F]{24}$' || fail "$oldest/start-wal is malformed"
  removed=0
  for file in "$BACKUP_DIR/wal"/*.age; do
    [ -f "$file" ] || continue
    segment="$(basename "$file" .age)"
    # Only plain segments and .backup files are pruned by name; .history files are tiny and every
    # recovery may need them, so they are kept.
    printf '%s' "$segment" | grep -Eq '^[0-9A-F]{24}(\.[0-9A-F]{8}\.backup)?$' || continue
    if [ "$(printf '%s' "$segment" | cut -c1-24)" \< "$keep_from" ]; then
      rm -f "$file" "$BACKUP_DIR/wal/$segment.sha256"
      removed=$((removed + 1))
    fi
  done
  log "prune: kept WAL from $keep_from; removed $removed file(s)"
}

# --- status --------------------------------------------------------------------------------------

# The recorded value of KEY, or 0 when nothing has been recorded.
state_get() {
  value="$(sed -n "s/^$1=//p" "$BACKUP_DIR/status/state" 2>/dev/null | tail -n 1)"
  echo "${value:-0}"
}

state_set() {
  touch "$BACKUP_DIR/status/state"
  grep -v "^$1=" "$BACKUP_DIR/status/state" >"$BACKUP_DIR/status/state.new" || true
  echo "$1=$2" >>"$BACKUP_DIR/status/state.new"
  mv "$BACKUP_DIR/status/state.new" "$BACKUP_DIR/status/state"
}

# The node_exporter textfile format, so an existing collector can scrape it (monitoring.md).
# Values only: no host names, no database names, no secrets.
write_status() {
  mkdir -p "$BACKUP_DIR/status"
  newest_wal=0
  # shellcheck disable=SC2012 # names are WAL segment names this script and PostgreSQL control
  newest="$(ls -t "$BACKUP_DIR/wal"/*.age 2>/dev/null | head -n 1 || true)"
  [ -n "$newest" ] && newest_wal="$(stat -c %Y "$newest")"
  latest_base="$(complete_backups base | tail -n 1)"
  base_bytes=0
  [ -n "$latest_base" ] && base_bytes="$(stat -c %s "$latest_base/base.tar.age")"
  free_bytes="$(df -P -k "$BACKUP_DIR" | awk 'NR == 2 { print $4 * 1024 }')"
  {
    echo '# HELP munaxa_backup_last_success_timestamp_seconds When the last complete backup run finished.'
    echo '# TYPE munaxa_backup_last_success_timestamp_seconds gauge'
    echo "munaxa_backup_last_success_timestamp_seconds $(state_get last_success)"
    echo '# HELP munaxa_backup_last_run_success Whether the last backup run succeeded (1) or failed (0).'
    echo '# TYPE munaxa_backup_last_run_success gauge'
    echo "munaxa_backup_last_run_success $(state_get last_run_success)"
    echo '# HELP munaxa_backup_last_failure_timestamp_seconds When a backup run last failed (0 = never).'
    echo '# TYPE munaxa_backup_last_failure_timestamp_seconds gauge'
    echo "munaxa_backup_last_failure_timestamp_seconds $(state_get last_failure)"
    echo '# HELP munaxa_backup_wal_newest_archived_timestamp_seconds Modification time of the newest archived WAL file.'
    echo '# TYPE munaxa_backup_wal_newest_archived_timestamp_seconds gauge'
    echo "munaxa_backup_wal_newest_archived_timestamp_seconds $newest_wal"
    echo '# HELP munaxa_backup_base_bytes Size of the newest base backup, encrypted.'
    echo '# TYPE munaxa_backup_base_bytes gauge'
    echo "munaxa_backup_base_bytes $base_bytes"
    echo '# HELP munaxa_backup_volume_free_bytes Free space on the backup volume.'
    echo '# TYPE munaxa_backup_volume_free_bytes gauge'
    echo "munaxa_backup_volume_free_bytes ${free_bytes:-0}"
  } >"$BACKUP_DIR/status/backup.prom.new"
  mv "$BACKUP_DIR/status/backup.prom.new" "$BACKUP_DIR/status/backup.prom"
}

# --- runs ----------------------------------------------------------------------------------------

once() {
  started="$(now)"
  if (validate && base_backup && tenant_dumps && prune); then
    state_set last_success "$(now)"
    state_set last_run_success 1
    log "run succeeded in $(($(now) - started)) s"
    write_status
    return 0
  fi
  state_set last_failure "$(now)"
  state_set last_run_success 0
  write_status || true
  log "run FAILED"
  return 1
}

seconds_until_next_run() {
  hour="${BACKUP_AT%%:*}"
  minute="${BACKUP_AT##*:}"
  current="$(now)"
  target=$((current - current % 86400 + ${hour#0} * 3600 + ${minute#0} * 60))
  [ "$target" -gt "$current" ] || target=$((target + 86400))
  echo $((target - current))
}

run() {
  validate
  # A deployment with no base backup yet takes one now rather than waiting for the first night:
  # WAL archived before any base backup is unusable.
  if [ -z "$(complete_backups base | tail -n 1)" ]; then
    once || true
  fi
  while true; do
    write_status || true
    wait_for="$(seconds_until_next_run)"
    if [ "$wait_for" -gt 600 ]; then
      sleep 600
      continue
    fi
    sleep "$wait_for"
    once || true
  done
}

health() {
  [ "$(state_get last_run_success)" = "1" ] || fail "the last backup run did not succeed"
  last="$(state_get last_success)"
  [ $(($(now) - last)) -le $((BACKUP_MAX_AGE_HOURS * 3600)) ] ||
    fail "no successful backup in the last $BACKUP_MAX_AGE_HOURS hours"
}

# --- recovery (needs the identity) ---------------------------------------------------------------

require_identity() {
  [ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ] && [ -r "$BACKUP_AGE_IDENTITY_FILE" ] ||
    fail "set BACKUP_AGE_IDENTITY_FILE to the age identity (recovery only)"
}

# Checks the ciphertext against the digest recorded when it was written, then decrypts to stdout.
decrypt() {
  file="$1"
  require_identity
  [ -f "$file" ] && [ -f "$file.sha256" ] || fail "$file or its .sha256 is missing"
  [ "$(sha256sum "$file" | cut -d' ' -f1)" = "$(cat "$file.sha256")" ] ||
    fail "$file does not match the digest recorded when it was written"
  age -d -i "$BACKUP_AGE_IDENTITY_FILE" "$file"
}

restore_base() {
  name="$1"
  target="$2"
  if [ "$name" = "latest" ]; then
    name="$(basename "$(complete_backups base | tail -n 1)")"
  fi
  source="$BACKUP_DIR/base/$name"
  [ -f "$source/base.tar.age" ] || fail "no base backup named $name"
  mkdir -p "$target"
  [ -z "$(ls -A "$target")" ] || fail "$target is not empty; a restore never writes over a database"
  decrypt "$source/base.tar.age" | tar -x -C "$target"
  chmod 0700 "$target"
  # The manifest inside the backup lists every file with its SHA-256; this checks them all, and the
  # WAL the backup needs.
  pg_verifybackup "$target"
  log "restored base backup $name into $target and verified it against its manifest"
}

list() {
  echo "base backups:"
  complete_backups base | while read -r entry; do
    echo "  $(basename "$entry")  $(stat -c %s "$entry/base.tar.age") bytes  start-wal $(cat "$entry/start-wal")"
  done
  echo "dump sets:"
  complete_backups dumps | while read -r entry; do echo "  $(basename "$entry")"; done
  echo "archived WAL files: $(find "$BACKUP_DIR/wal" -name '*.age' | wc -l)"
}

command="${1:-}"
[ $# -gt 0 ] && shift
case "$command" in
  validate) validate && log "configuration valid" ;;
  once) once ;;
  run) run ;;
  health) health ;;
  status) write_status ;;
  list) list ;;
  decrypt) decrypt "${1:?usage: munaxa-backup decrypt FILE}" ;;
  restore-base) restore_base "${1:?usage: munaxa-backup restore-base NAME|latest DIR}" "${2:?usage: munaxa-backup restore-base NAME|latest DIR}" ;;
  # Internal steps, exposed for tests and for an operator who needs one of them alone.
  base) validate && base_backup && write_status ;;
  dumps) validate && tenant_dumps && write_status ;;
  prune) validate && prune && write_status ;;
  *)
    echo "usage: munaxa-backup validate|once|run|health|status|list|decrypt FILE|restore-base NAME|latest DIR" >&2
    exit 2
    ;;
esac
