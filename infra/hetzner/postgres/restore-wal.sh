#!/bin/sh
# shellcheck shell=busybox # Alpine's ash: pipefail and [ \< ] are supported there
# PostgreSQL's restore_command in a RECOVERY environment — `munaxa-restore-wal %f %p`
# (backup-and-restore.md §5.3). Never configured on the live server.
#
#   BACKUP_WAL_DIR             the archived WAL (default /backup/wal), read-only is enough
#   BACKUP_AGE_IDENTITY_FILE   the age identity (private key) — present only in recovery
#
# Exits non-zero when the segment is not in the archive, which is how PostgreSQL learns that the
# archive has ended. A segment whose decrypted digest is not the one recorded at archive time is
# refused: recovery stops there rather than replaying altered WAL.
set -eu

name="${1:?usage: munaxa-restore-wal %f %p}"
target="${2:?usage: munaxa-restore-wal %f %p}"
dir="${BACKUP_WAL_DIR:-/backup/wal}"
identity="${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE is not set}"

case "$name" in
  '' | *[!0-9A-Za-z._-]* | .*) echo "munaxa-restore-wal: unexpected file name" >&2; exit 1 ;;
esac
# Not archived: the normal end of the archive, not an error worth a message.
[ -f "$dir/$name.age" ] || exit 1

age -d -i "$identity" -o "$target.restoring" "$dir/$name.age"
expected="$(cat "$dir/$name.sha256" 2>/dev/null || true)"
actual="$(sha256sum "$target.restoring" | cut -d' ' -f1)"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  rm -f "$target.restoring"
  echo "munaxa-restore-wal: $name does not match the digest recorded when it was archived" >&2
  exit 1
fi
mv "$target.restoring" "$target"
