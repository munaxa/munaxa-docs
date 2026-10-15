#!/bin/sh
# shellcheck shell=busybox # Alpine's ash: pipefail and [ \< ] are supported there
# PostgreSQL's archive_command — `munaxa-archive-wal %p %f` (compose.yaml, the `postgres` service).
#
# Encrypts one WAL file (or a .history/.backup file) to the backup volume. PostgreSQL removes or
# recycles the original only after this exits 0, so every failure below is safe: the file stays in
# pg_wal, archiving retries, and pg_stat_archiver.failed_count rises (monitoring.md alerts on it).
#
#   BACKUP_AGE_RECIPIENTS   one or more age public keys (age1…), comma- or space-separated
#   BACKUP_WAL_DIR          where archived WAL goes (default /backup/wal)
#   BACKUP_ALLOW_SAME_DEVICE=1   TESTS ONLY: allow the archive on the database's own filesystem
#
# Each segment is written as <name>.age plus <name>.sha256 (the digest of the plaintext, so a
# retried archive of the same segment is recognised and a different one is refused, and a restore
# can check what it decrypted). Nothing here ever holds a private key.
set -eu

src="${1:?usage: munaxa-archive-wal %p %f}"
name="${2:?usage: munaxa-archive-wal %p %f}"
dest="${BACKUP_WAL_DIR:-/backup/wal}"

fail() {
  echo "munaxa-archive-wal: $*" >&2
  exit 1
}

case "$name" in
  '' | *[!0-9A-Za-z._-]* | .*) fail "refusing an unexpected file name" ;;
esac
[ -d "$dest" ] && [ -w "$dest" ] || fail "$dest is not a writable directory"

# The one rule this whole mechanism exists for: a backup on the same disk as the only database copy
# is lost with it.
if [ "${BACKUP_ALLOW_SAME_DEVICE:-0}" != "1" ] &&
  [ "$(stat -c %d "$dest")" = "$(stat -c %d "${PGDATA:-/var/lib/postgresql/data}")" ]; then
  fail "refusing to archive onto the database's own filesystem ($dest); mount a separate volume"
fi

recipients=""
for recipient in $(printf '%s' "${BACKUP_AGE_RECIPIENTS:-}" | tr ',' ' '); do
  case "$recipient" in
    age1*) recipients="$recipients -r $recipient" ;;
    *) fail "BACKUP_AGE_RECIPIENTS holds something that is not an age public key" ;;
  esac
done
[ -n "$recipients" ] || fail "BACKUP_AGE_RECIPIENTS is not set"

digest="$(sha256sum "$src" | cut -d' ' -f1)"
if [ -e "$dest/$name.age" ]; then
  # PostgreSQL re-runs the command after a crash between our rename and its own bookkeeping. The
  # same bytes are a success; different bytes under one name are never overwritten.
  if [ -f "$dest/$name.sha256" ] && [ "$(cat "$dest/$name.sha256")" = "$digest" ]; then
    exit 0
  fi
  fail "$name is already archived with different content; not overwriting"
fi

tmp="$dest/.$name.$$"
trap 'rm -f "$tmp.age" "$tmp.sha256"' EXIT
# shellcheck disable=SC2086 # $recipients is a list of `-r key` arguments, split on purpose
age $recipients -o "$tmp.age" "$src"
printf '%s\n' "$digest" >"$tmp.sha256"
sync "$tmp.age" "$tmp.sha256"
mv "$tmp.sha256" "$dest/$name.sha256"
mv "$tmp.age" "$dest/$name.age"
sync -f "$dest/$name.age"
trap - EXIT
