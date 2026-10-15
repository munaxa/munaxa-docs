#!/bin/sh
# shellcheck shell=busybox # the rclone image is Alpine: ash with pipefail
# munaxa-offsite — the off-server copy of the encrypted backups (R-1a; README.md §7,
# backup-and-restore.md §5.5).
#
# Runs in the `offsite` service (compose.yaml, profile `ops`) on the pinned rclone image, started by
# the host timer (ops/systemd/munaxa-offsite.timer). It reads DOCS_BACKUP_DIR READ-ONLY and copies
# to a bucket at another provider. Everything it copies is already `age` ciphertext; no key that
# could decrypt it exists on the server or here.
#
#   munaxa-offsite validate            configuration and the remote are usable; nothing is written
#   munaxa-offsite sync                copy what is new, verify it, mark complete recovery points
#   munaxa-offsite status              rewrite the status file from the recorded state
#   munaxa-offsite list-remote         the recovery points on the remote that are complete
#   munaxa-offsite fetch DEST [STAMP]  download a complete recovery point (default: the newest) and
#                                      every verified WAL file into DEST, checking each byte, in the
#                                      layout `munaxa-backup restore-base` and munaxa-restore-wal read
#
# What it never does: delete, overwrite, `rclone sync`, `move` or `purge` anything on the remote.
# The credential is meant to be unable to do those too (README.md §7); this script does not rely
# on that.
#
# A recovery point on the remote is VALID only when its COMPLETE marker exists. The marker is
# uploaded last, after every file of that backup was copied and read back with the expected size
# and SHA-256, and it lists those files with their size and digest; `fetch` checks every byte it
# downloads against it. A WAL file is valid only when a run manifest (manifests/) lists it, which
# also happens only after it was read back. So an interrupted upload, a half-written object or a
# file changed after the fact is never a recovery point: at worst it is an unlisted object.
#
# Environment (from offsite.env, mode 0600 — never on a command line):
#   RCLONE_CONFIG_OFFSITE_TYPE=s3 and the rest of rclone's remote settings for the remote
#     `offsite` (_PROVIDER, _ENDPOINT, _REGION, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY)
#   OFFSITE_BUCKET            the bucket
#   OFFSITE_PREFIX            one directory per environment in that bucket (e.g. munaxa-docs-test)
#   OFFSITE_VERIFY            download (default): read every new object back and compare SHA-256;
#                             listing: size and the provider's own MD5 only, when it has one
#   OFFSITE_STATE_DIR         this job's own state and status (default /state)
#   BACKUP_DIR                the backup volume, mounted read-only (default /backup)
#   OFFSITE_RETRIES           rclone's whole-run retries (default 3)
#   OFFSITE_LOW_LEVEL_RETRIES rclone's retries of each request (default 10)
#   OFFSITE_ALLOW_INSECURE_ENDPOINT=1   TESTS ONLY: allow an http:// endpoint
set -eu
set -o pipefail

BACKUP_DIR="${BACKUP_DIR:-/backup}"
STATE="${OFFSITE_STATE_DIR:-/state}"
OFFSITE_VERIFY="${OFFSITE_VERIFY:-download}"
OFFSITE_RETRIES="${OFFSITE_RETRIES:-3}"
VERIFIED="$STATE/verified.tsv"

log() { echo "munaxa-offsite: $*" >&2; }
fail() {
  log "$*"
  exit 1
}
now() { date -u +%s; }

# --- configuration -------------------------------------------------------------------------------

remote_root() { printf 'offsite:%s/%s' "$OFFSITE_BUCKET" "$OFFSITE_PREFIX"; }

# The rclone flags every remote call uses. No call here may create a bucket (the credential need not
# be able to) or rewrite an object that exists.
rc() {
  rclone --config /dev/null --s3-no-check-bucket --contimeout 30s --timeout 5m \
    --low-level-retries "${OFFSITE_LOW_LEVEL_RETRIES:-10}" --stats 0 "$@"
}

validate_remote() {
  # The server must never hold a key that opens its own backups — nor this job.
  # grep reads to the end (no -q): under pipefail an early exit can fail the writer and the test.
  if env | grep 'AGE-SECRET-KEY-' >/dev/null; then
    fail "an age identity (private key) is in the environment; the copy job holds no key"
  fi
  [ "${RCLONE_CONFIG_OFFSITE_TYPE:-}" = "s3" ] ||
    fail "RCLONE_CONFIG_OFFSITE_TYPE must be s3 (offsite.env)"
  for name in RCLONE_CONFIG_OFFSITE_ENDPOINT RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID \
    RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY OFFSITE_BUCKET OFFSITE_PREFIX; do
    value="$(printenv "$name" || true)"
    [ -n "$value" ] || fail "$name is not set (offsite.env)"
    case "$value" in
      *'<'* | *'>'*) fail "$name still holds a placeholder (offsite.env)" ;;
    esac
  done
  case "$RCLONE_CONFIG_OFFSITE_ENDPOINT" in
    https://*) ;;
    http://*)
      [ "${OFFSITE_ALLOW_INSECURE_ENDPOINT:-0}" = "1" ] ||
        fail "RCLONE_CONFIG_OFFSITE_ENDPOINT must be https://"
      log "WARNING: OFFSITE_ALLOW_INSECURE_ENDPOINT=1 — plain http (tests only)"
      ;;
    *) fail "RCLONE_CONFIG_OFFSITE_ENDPOINT must be an https:// URL" ;;
  esac
  printf '%s' "$OFFSITE_PREFIX" | grep -Eq '^[a-z0-9][a-z0-9._-]{0,62}$' ||
    fail "OFFSITE_PREFIX must be one lower-case path segment"
  case "$OFFSITE_VERIFY" in download | listing) ;; *) fail "OFFSITE_VERIFY must be download or listing" ;; esac
  case "$OFFSITE_RETRIES" in '' | *[!0-9]*) fail "OFFSITE_RETRIES must be a whole number" ;; esac
}

validate() {
  validate_remote
  [ -d "$BACKUP_DIR/wal" ] && [ -r "$BACKUP_DIR/wal" ] || fail "$BACKUP_DIR is not a readable backup volume"
  # Read-only on purpose: this job must not be able to damage what it copies.
  if touch "$BACKUP_DIR/.offsite-write-test" 2>/dev/null; then
    rm -f "$BACKUP_DIR/.offsite-write-test"
    fail "$BACKUP_DIR is writable; mount it read-only for the copy job"
  fi
  mkdir -p "$STATE/markers" && [ -w "$STATE" ] || fail "$STATE is not writable"
  touch "$VERIFIED"
}

# --- what is local -------------------------------------------------------------------------------

# Every file a complete backup consists of, relative to BACKUP_DIR, one per line, sorted. Never a
# .partial directory, a hidden temporary file, or status/ (which changes every ten minutes).
local_files() {
  (
    cd "$BACKUP_DIR"
    for file in wal/*.age; do
      [ -f "$file" ] || continue
      name="${file#wal/}"
      name="${name%.age}"
      # munaxa-archive-wal writes the .sha256 before renaming the .age into place, so a segment
      # without its digest is not finished.
      [ -f "wal/$name.sha256" ] || continue
      echo "$file"
      echo "wal/$name.sha256"
    done
    for area in base dumps; do
      for dir in "$area"/*; do
        [ -d "$dir" ] && [ -f "$dir/created-epoch" ] || continue
        case "$dir" in *.partial) continue ;; esac
        for file in "$dir"/*; do
          [ -f "$file" ] && echo "$file"
        done
      done
    done
  ) | grep -E '^(wal|base|dumps)/[0-9A-Za-z][0-9A-Za-z._/-]*$' | sort
}

# The recorded "size<TAB>sha256" of PATH, or nothing.
verified_entry() { awk -F '\t' -v p="$1" '$1 == p { print $2 "\t" $3; exit }' "$VERIFIED"; }

# --- sync ----------------------------------------------------------------------------------------

state_set() {
  touch "$STATE/state"
  grep -v "^$1=" "$STATE/state" >"$STATE/state.new" || true
  echo "$1=$2" >>"$STATE/state.new"
  mv "$STATE/state.new" "$STATE/state"
}
state_get() {
  value="$(sed -n "s/^$1=//p" "$STATE/state" 2>/dev/null | tail -n 1)"
  echo "${value:-0}"
}

# Reads PATH back from the remote and prints "size<TAB>sha256", or nothing when it cannot be read.
remote_digest() {
  tmp="$(mktemp)"
  if rc cat "$(remote_root)/$1" >"$tmp" 2>/dev/null; then
    printf '%s\t%s\n' "$(stat -c %s "$tmp")" "$(sha256sum "$tmp" | cut -d' ' -f1)"
  fi
  rm -f "$tmp"
}

sync_run() {
  run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  problems=0

  # 1. What is new, and whether anything already copied has changed locally since. One pass over
  #    each list: a volume holds thousands of WAL files.
  local_files >"$work/all"
  (cd "$BACKUP_DIR" && xargs -r stat -c '%n	%s' <"$work/all") >"$work/sizes"
  awk -F '\t' -v out="$work/new" '
    FILENAME == ARGV[1] { size[$1] = $2; next }
    !($1 in size) { print $1 > out; next }
    size[$1] != $2 { print $1 }
  ' "$VERIFIED" "$work/sizes" >"$work/changed"
  touch "$work/new"
  while read -r path; do
    log "PROBLEM: $path changed size after it was copied; the copy is kept, the change is not sent"
    problems=$((problems + 1))
  done <"$work/changed"

  # 2. A local file that no longer matches the digest written beside it is not sent: copying it
  #    would only spread the damage. (A WAL file's .sha256 is of its plaintext and needs the key, so
  #    the restore checks that one.)
  : >"$work/send"
  while read -r path; do
    case "$path" in
      base/*.age | dumps/*.age)
        if [ "$(sha256sum "$BACKUP_DIR/$path" | cut -d' ' -f1)" != "$(cat "$BACKUP_DIR/$path.sha256" 2>/dev/null)" ]; then
          log "PROBLEM: $path does not match its recorded digest on the backup volume; not copied"
          problems=$((problems + 1))
          continue
        fi
        ;;
    esac
    echo "$path" >>"$work/send"
  done <"$work/new"
  log "$(wc -l <"$work/all") file(s) on the backup volume, $(wc -l <"$work/send") to copy"

  # 3. Copy. --immutable: an object that exists with different content is an error, never
  #    overwritten. --no-traverse: no listing of the whole bucket. rclone retries the run, then each
  #    transfer; an S3 object appears only once its upload completes, so an interrupted multipart
  #    upload leaves no object at all (the provider's lifecycle rule clears its parts).
  copy_ok=1
  if [ -s "$work/send" ]; then
    rc copy "$BACKUP_DIR" "$(remote_root)" --files-from-raw "$work/send" --immutable \
      --no-traverse --checksum --retries "$OFFSITE_RETRIES" --log-level NOTICE || copy_ok=0
    [ "$copy_ok" = 1 ] || log "the copy did not complete; what arrived is verified below, the rest is retried next run"
  fi

  # 4. Verify what was sent: the size from the provider's listing (every S3 implementation reports
  #    it), the provider's MD5 when it has one for that object, and — by default — the SHA-256 of
  #    the bytes read back. Only then is a file recorded as verified.
  : >"$work/verified-now"
  if [ -s "$work/send" ]; then
    rc lsf -R --files-only "$(remote_root)" --files-from-raw "$work/send" --format 'sph' \
      --hash MD5 --separator '	' >"$work/listing" 2>/dev/null || true
    while read -r path; do
      line="$(awk -F '\t' -v p="$path" '$2 == p { print; exit }' "$work/listing")"
      if [ -z "$line" ]; then
        log "pending: $path is not on the remote yet"
        continue
      fi
      local_size="$(stat -c %s "$BACKUP_DIR/$path")"
      remote_size="$(printf '%s' "$line" | cut -f1)"
      remote_md5="$(printf '%s' "$line" | cut -f3)"
      if [ "$remote_size" != "$local_size" ]; then
        log "PROBLEM: $path is $remote_size bytes on the remote, $local_size here"
        problems=$((problems + 1))
        continue
      fi
      # An S3 ETag is an MD5 only for a single-part upload; rclone reports a hash only when it can
      # trust it, so an empty value means "none", never "mismatch".
      if [ -n "$remote_md5" ] && [ "$remote_md5" != "$(md5sum "$BACKUP_DIR/$path" | cut -d' ' -f1)" ]; then
        log "PROBLEM: $path has a different MD5 on the remote"
        problems=$((problems + 1))
        continue
      fi
      local_sha="$(sha256sum "$BACKUP_DIR/$path" | cut -d' ' -f1)"
      if [ "$OFFSITE_VERIFY" = "download" ]; then
        read_back="$(remote_digest "$path" || true)"
        if [ "$read_back" != "$local_size	$local_sha" ]; then
          log "PROBLEM: $path read back from the remote does not match (size and SHA-256)"
          problems=$((problems + 1))
          continue
        fi
      elif [ -z "$remote_md5" ]; then
        log "PROBLEM: $path has no provider checksum and OFFSITE_VERIFY=listing; size alone is not enough"
        problems=$((problems + 1))
        continue
      fi
      printf '%s\t%s\t%s\n' "$path" "$local_size" "$local_sha" >>"$work/verified-now"
    done <"$work/send"
  fi

  # 5. The run manifest: what this run verified. Uploaded before any marker, so a COMPLETE marker
  #    never names a file no manifest lists.
  if [ -s "$work/verified-now" ]; then
    manifest="manifests/$run_stamp-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n').tsv"
    mkdir -p "$work/up/manifests"
    cp "$work/verified-now" "$work/up/$manifest"
    if upload_verified "$work/up" "$manifest"; then
      cat "$work/verified-now" >>"$VERIFIED"
    else
      log "PROBLEM: the run manifest could not be stored; this run's files stay unverified"
      problems=$((problems + 1))
    fi
  fi

  # 6. COMPLETE markers for every backup whose files are now all verified.
  for area in base dumps; do
    for stamp in $(sed -n "s#^$area/\([^/]*\)/.*#\1#p" "$work/all" | sort -u); do
      [ -f "$STATE/markers/$area/$stamp/COMPLETE" ] && continue
      : >"$work/marker"
      complete=1
      for path in $(grep "^$area/$stamp/" "$work/all"); do
        entry="$(verified_entry "$path")"
        if [ -z "$entry" ]; then
          complete=0
          break
        fi
        printf '%s\t%s\n' "$path" "$entry" >>"$work/marker"
      done
      [ "$complete" = 1 ] || continue
      mkdir -p "$work/up/$area/$stamp"
      cp "$work/marker" "$work/up/$area/$stamp/COMPLETE"
      if upload_verified "$work/up" "$area/$stamp/COMPLETE"; then
        mkdir -p "$STATE/markers/$area/$stamp"
        cp "$work/marker" "$STATE/markers/$area/$stamp/COMPLETE"
        log "$area/$stamp: complete on the remote"
      else
        log "PROBLEM: the COMPLETE marker of $area/$stamp could not be stored"
        problems=$((problems + 1))
      fi
    done
  done

  cut -f1 "$VERIFIED" | sort -u >"$work/verified-paths"
  pending="$(comm -23 "$work/all" "$work/verified-paths" | wc -l)"

  # 7. The remote itself, every run, even with nothing new to send: it must answer, and the newest
  #    base backup this job marked complete must still be there. Without this, a run with nothing
  #    to copy would report success while the remote is unreachable, or after it lost the copy.
  newest_marked="$(find "$STATE/markers/base" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1)"
  if [ -n "$newest_marked" ]; then
    stamp="$(basename "$newest_marked")"
    if ! rc lsf "$(remote_root)/base/$stamp" --files-only 2>/dev/null | grep -x COMPLETE >/dev/null; then
      log "PROBLEM: the remote does not answer, or no longer holds the newest complete base backup ($stamp)"
      problems=$((problems + 1))
    fi
  elif ! rc lsf "$(remote_root)" --max-depth 1 >/dev/null 2>&1; then
    log "PROBLEM: the remote does not answer"
    problems=$((problems + 1))
  fi

  if [ "$copy_ok" = 1 ] && [ "$problems" -eq 0 ] && [ "$pending" -eq 0 ]; then
    state_set last_success "$(now)"
    state_set last_run_success 1
    state_set last_problems 0
    write_status "$pending"
    log "run succeeded: $(wc -l <"$work/verified-now") file(s) copied and verified, nothing pending"
    return 0
  fi
  state_set last_failure "$(now)"
  state_set last_run_success 0
  state_set last_problems "$problems"
  write_status "$pending"
  log "run FAILED: $problems problem(s), $pending file(s) not yet verified on the remote"
  return 1
}

# Uploads FILE (relative to DIR) without overwriting, reads it back and compares. Markers and
# manifests are small, so they are always read back in full.
upload_verified() {
  dir="$1"
  file="$2"
  rc copyto "$dir/$file" "$(remote_root)/$file" --immutable --retries "$OFFSITE_RETRIES" \
    --log-level NOTICE || return 1
  expected="$(stat -c %s "$dir/$file")	$(sha256sum "$dir/$file" | cut -d' ' -f1)"
  [ "$(remote_digest "$file" || true)" = "$expected" ]
}

# --- status --------------------------------------------------------------------------------------

# node_exporter textfile format, read by ops/host-check.sh. Ages and counts only: no names of
# tenants, hosts, buckets or keys.
write_status() {
  pending="${1:-$(state_get last_pending)}"
  state_set last_pending "$pending"
  newest_base=0
  for marker in "$STATE"/markers/base/*/COMPLETE; do
    [ -f "$marker" ] || continue
    stamp="$(basename "$(dirname "$marker")")"
    epoch="$(cat "$BACKUP_DIR/base/$stamp/created-epoch" 2>/dev/null || echo 0)"
    [ "$epoch" -gt "$newest_base" ] && newest_base="$epoch"
  done
  newest_wal=0
  for path in $(awk -F '\t' '$1 ~ /^wal\/.*\.age$/ { print $1 }' "$VERIFIED"); do
    [ -f "$BACKUP_DIR/$path" ] || continue
    mtime="$(stat -c %Y "$BACKUP_DIR/$path")"
    [ "$mtime" -gt "$newest_wal" ] && newest_wal="$mtime"
  done
  {
    echo '# HELP munaxa_offsite_last_success_timestamp_seconds When the last fully verified copy run finished.'
    echo '# TYPE munaxa_offsite_last_success_timestamp_seconds gauge'
    echo "munaxa_offsite_last_success_timestamp_seconds $(state_get last_success)"
    echo '# HELP munaxa_offsite_last_run_success Whether the last copy run succeeded (1) or not (0).'
    echo '# TYPE munaxa_offsite_last_run_success gauge'
    echo "munaxa_offsite_last_run_success $(state_get last_run_success)"
    echo '# HELP munaxa_offsite_last_failure_timestamp_seconds When a copy run last failed (0 = never).'
    echo '# TYPE munaxa_offsite_last_failure_timestamp_seconds gauge'
    echo "munaxa_offsite_last_failure_timestamp_seconds $(state_get last_failure)"
    echo '# HELP munaxa_offsite_pending_files Files on the backup volume not yet verified on the remote.'
    echo '# TYPE munaxa_offsite_pending_files gauge'
    echo "munaxa_offsite_pending_files $pending"
    echo '# HELP munaxa_offsite_newest_base_created_timestamp_seconds Creation time of the newest base backup complete on the remote.'
    echo '# TYPE munaxa_offsite_newest_base_created_timestamp_seconds gauge'
    echo "munaxa_offsite_newest_base_created_timestamp_seconds $newest_base"
    echo '# HELP munaxa_offsite_newest_wal_timestamp_seconds Modification time of the newest WAL file verified on the remote.'
    echo '# TYPE munaxa_offsite_newest_wal_timestamp_seconds gauge'
    echo "munaxa_offsite_newest_wal_timestamp_seconds $newest_wal"
  } >"$STATE/offsite.prom.new"
  mv "$STATE/offsite.prom.new" "$STATE/offsite.prom"
}

# --- recovery side -------------------------------------------------------------------------------

# The base backups and dump sets whose COMPLETE marker is on the remote, oldest first.
complete_remote() {
  rc lsf "$(remote_root)/$1" --dirs-only 2>/dev/null | tr -d / | sort | while read -r stamp; do
    # A listing of a missing key succeeds empty, so the marker is looked for by name. grep reads the
    # whole listing: with -q it could exit first, and under pipefail rclone's broken pipe would make
    # a complete backup look incomplete.
    if rc lsf "$(remote_root)/$1/$stamp" --files-only 2>/dev/null | grep -x COMPLETE >/dev/null; then
      echo "$stamp"
    fi
  done
}

list_remote() {
  echo "complete base backups on the remote:"
  complete_remote base | sed 's/^/  /'
  echo "complete dump sets on the remote:"
  complete_remote dumps | sed 's/^/  /'
}

# Downloads PATH to DEST/PATH and checks it against "size<TAB>sha256".
fetch_checked() {
  path="$1"
  expected="$2"
  dest="$3"
  mkdir -p "$(dirname "$dest/$path")"
  rc copyto "$(remote_root)/$path" "$dest/$path" --retries "$OFFSITE_RETRIES" --log-level ERROR ||
    fail "could not download $path"
  actual="$(stat -c %s "$dest/$path")	$(sha256sum "$dest/$path" | cut -d' ' -f1)"
  [ "$actual" = "$expected" ] || fail "$path does not match what was verified when it was copied; refusing it"
}

fetch() {
  dest="$1"
  wanted="${2:-latest}"
  mkdir -p "$dest"
  [ -z "$(ls -A "$dest")" ] || fail "$dest is not empty"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  complete_remote base >"$work/bases"
  if [ "$wanted" = "latest" ]; then
    wanted="$(tail -n 1 "$work/bases")"
  fi
  [ -n "$wanted" ] && grep -qx "$wanted" "$work/bases" ||
    fail "no complete base backup ${wanted:+named $wanted }on the remote"

  # The base backup, every file checked against its marker.
  rc cat "$(remote_root)/base/$wanted/COMPLETE" >"$work/marker" || fail "cannot read the marker"
  while IFS='	' read -r path size sha; do
    case "$path" in "base/$wanted/"*) ;; *) fail "the marker of $wanted names $path" ;; esac
    fetch_checked "$path" "$size	$sha" "$dest"
  done <"$work/marker"
  start_wal="$(cut -c1-24 "$dest/base/$wanted/start-wal")"

  # Every WAL file a run manifest lists from the backup's start on (and every timeline history).
  # A WAL object no manifest lists was never verified; it is left out, and replay stops before it.
  rc copy "$(remote_root)/manifests" "$work/manifests" --log-level ERROR || fail "cannot read the manifests"
  cat "$work"/manifests/*.tsv 2>/dev/null | awk -F '\t' '$1 ~ /^wal\//' | sort -u >"$work/wal"
  count=0
  while IFS='	' read -r path size sha; do
    segment="${path#wal/}"
    case "$segment" in
      *.history.age | *.history.sha256) ;;
      *) [ ! "$(printf '%s' "$segment" | cut -c1-24)" \< "$start_wal" ] || continue ;;
    esac
    fetch_checked "$path" "$size	$sha" "$dest"
    count=$((count + 1))
  done <"$work/wal"
  cut -f1 "$work/wal" | sort -u >"$work/listed"
  rc lsf "$(remote_root)/wal" 2>/dev/null | sed 's#^#wal/#' | sort >"$work/remote-wal" || true
  unlisted="$(comm -23 "$work/remote-wal" "$work/listed" | wc -l)"
  [ "$unlisted" -eq 0 ] || log "left out $unlisted WAL object(s) no manifest lists (never verified)"

  # The newest complete dump set, the same way.
  dumps="$(complete_remote dumps | tail -n 1)"
  if [ -n "$dumps" ]; then
    rc cat "$(remote_root)/dumps/$dumps/COMPLETE" >"$work/dumps-marker" || fail "cannot read the dump marker"
    while IFS='	' read -r path size sha; do
      case "$path" in "dumps/$dumps/"*) ;; *) fail "the marker of dump set $dumps names $path" ;; esac
      fetch_checked "$path" "$size	$sha" "$dest"
    done <"$work/dumps-marker"
  fi
  mkdir -p "$dest/status"
  log "fetched base backup $wanted, $count WAL file(s)${dumps:+ and dump set $dumps} into $dest; every byte matched"
}

command="${1:-}"
[ $# -gt 0 ] && shift
case "$command" in
  validate)
    validate
    rc lsf "$(remote_root)" --max-depth 1 >/dev/null || fail "the remote cannot be listed (endpoint, bucket or credential)"
    log "configuration valid; the remote answers"
    ;;
  sync)
    validate
    mkdir -p "$STATE"
    # One run at a time: a timer firing while the previous run is still copying exits quietly.
    exec 9>"$STATE/lock"
    if ! flock -n 9; then
      log "another copy run holds the lock; this one exits without doing anything"
      exit 0
    fi
    sync_run
    ;;
  status)
    write_status
    ;;
  list-remote)
    validate
    list_remote
    ;;
  fetch)
    # Recovery may run on a new host, where the volume is not there; only the remote is needed.
    validate_remote
    fetch "${1:?usage: munaxa-offsite fetch DEST [STAMP]}" "${2:-latest}"
    ;;
  *)
    echo "usage: munaxa-offsite validate|sync|status|list-remote|fetch DEST [STAMP]" >&2
    exit 2
    ;;
esac
