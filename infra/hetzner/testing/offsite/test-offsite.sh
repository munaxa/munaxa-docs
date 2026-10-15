#!/usr/bin/env bash
# Tests the off-server backup copy (offsite/offsite.sh; README.md §7) against a local MinIO, with
# the copy job run as the `offsite` service runs it: the pinned rclone image, uid 70, read-only root,
# the backup volume mounted read-only, a credential that can add and read objects but not delete.
#
#   DOCS_POSTGRES_IMAGE=munaxa-docs-postgres:local infra/hetzner/testing/offsite/test-offsite.sh
#
# Synthetic data only: random bytes encrypted with a key pair made for this run. MinIO is a stand-in
# for Backblaze B2 or Scaleway; nothing here says anything about either provider (README.md §7).
# Nothing leaves this machine.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$(cd "$here/../.." && pwd)"
postgres_image="${DOCS_POSTGRES_IMAGE:?set DOCS_POSTGRES_IMAGE (the template PostgreSQL image, which carries age)}"
minio_image="${MINIO_IMAGE:-munaxa-docs-test-minio:local}"
rclone_image="$(sed -n 's/.*DOCS_OFFSITE_IMAGE:-\([^}]*\)}.*/\1/p' "$template/compose.yaml")"
[ -n "$rclone_image" ] || {
  echo "cannot read the offsite image from compose.yaml"
  exit 1
}

run_id="offsite-$(openssl rand -hex 4)"
net="$run_id-net"
minio="$run_id-minio"
bucket="offsite-test"
prefix="munaxa-docs-test"
work="$(mktemp -d)"
chmod 700 "$work"
backup="$work/backup"
state="$work/state"
mkdir -p "$backup/wal" "$backup/base" "$backup/dumps" "$backup/status" "$state" "$work/out"
failures=0

cleanup() {
  docker rm -f "$minio" "$run_id-lock" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  # Files written by uid 70 are removed from a container.
  docker run --rm -v "$work:/w" --entrypoint sh "$postgres_image" -c 'rm -rf /w/* /w/.[!.]*' >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

pass() { echo "PASS  $*"; }
fail() {
  echo "FAIL  $*"
  failures=$((failures + 1))
}
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 — expected '$3', got '$2'"; fi; }

secret() { openssl rand -hex 24; }
root_user="root-$(openssl rand -hex 4)" root_pw="$(secret)"
key_id="offsite-$(openssl rand -hex 4)" key_secret="$(secret)"

# --- MinIO with a versioned bucket and a no-delete credential ------------------------------------
docker network create --internal "$net" >/dev/null
docker run -d --name "$minio" --network "$net" --network-alias minio \
  -e MINIO_ROOT_USER="$root_user" -e MINIO_ROOT_PASSWORD="$root_pw" "$minio_image" >/dev/null
# Admin commands go through `mc` inside the MinIO container; the alias comes from the environment.
admin() {
  docker exec -e MC_HOST_t="http://$root_user:$root_pw@127.0.0.1:9000" "$minio" mc "$@"
}
for _ in $(seq 1 60); do admin ready t >/dev/null 2>&1 && break; sleep 1; done
admin mb --quiet "t/$bucket" >/dev/null
admin version enable "t/$bucket" >/dev/null
cat >"$work/policy.json" <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:ListBucket","s3:ListBucketMultipartUploads"],"Resource":["arn:aws:s3:::$bucket"]},
 {"Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":["arn:aws:s3:::$bucket/*"]}]}
EOF
docker cp "$work/policy.json" "$minio:/tmp/policy.json"
admin admin user add t "$key_id" "$key_secret" >/dev/null
admin admin policy create t offsite-append /tmp/policy.json >/dev/null
admin admin policy attach t offsite-append --user "$key_id" >/dev/null

cat >"$work/offsite.env" <<EOF
RCLONE_CONFIG_OFFSITE_TYPE=s3
RCLONE_CONFIG_OFFSITE_PROVIDER=Minio
RCLONE_CONFIG_OFFSITE_ENDPOINT=http://minio:9000
RCLONE_CONFIG_OFFSITE_REGION=us-east-1
RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=$key_id
RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=$key_secret
OFFSITE_BUCKET=$bucket
OFFSITE_PREFIX=$prefix
OFFSITE_ALLOW_INSECURE_ENDPOINT=1
OFFSITE_RETRIES=1
RCLONE_S3_UPLOAD_CUTOFF=5M
RCLONE_S3_CHUNK_SIZE=5M
EOF
chmod 600 "$work/offsite.env"

# The copy job, exactly as compose.yaml runs it. Extra arguments before `--` are docker options.
offsite() {
  local options=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do
    options+=("$1")
    shift
  done
  shift
  docker run --rm --user 70:70 --read-only --tmpfs /tmp --security-opt no-new-privileges:true \
    --cap-drop ALL --network "$net" --env-file "$work/offsite.env" -e BACKUP_DIR=/backup \
    -e OFFSITE_STATE_DIR=/state -e HOME=/tmp \
    -v "$template/offsite/offsite.sh:/opt/munaxa/offsite.sh:ro" -v "$backup:/backup:ro" \
    -v "$state:/state" "${options[@]}" --entrypoint /bin/sh "$rclone_image" /opt/munaxa/offsite.sh "$@"
}
prom() { sed -n "s/^munaxa_offsite_$1 //p" "$state/offsite.prom" 2>/dev/null; }
remote_ls() { admin ls --recursive "t/$bucket/$prefix/" 2>/dev/null | awk '{ print $NF }' | sort; }

# --- Synthetic encrypted backups, written by uid 70 as the template's services write them ---------
docker run --rm --entrypoint age-keygen "$postgres_image" >"$work/identity.txt" 2>/dev/null
recipient="$(grep -o 'age1[a-z0-9]*' "$work/identity.txt")"
identity_secret="$(grep -o 'AGE-SECRET-KEY-[A-Z0-9]*' "$work/identity.txt")"
chown -R 70:70 "$backup" "$state" "$work/out"
chmod 0700 "$backup" "$state"
as70() { docker run --rm --user 70:70 --network none -v "$backup:/backup" -e R="$recipient" --entrypoint sh "$postgres_image" -ec "$1"; }
# A WAL file as munaxa-archive-wal writes it: .sha256 of the plaintext, then the ciphertext.
make_wal() {
  as70 "head -c $2 /dev/urandom > /tmp/p; sha256sum /tmp/p | cut -d' ' -f1 > /backup/wal/$1.sha256
        age -r \"\$R\" -o /backup/wal/$1.age /tmp/p"
}
# A base backup as munaxa-backup writes it: in NAME.partial, renamed when complete.
make_base() {
  as70 "d=/backup/base/$1.partial; mkdir -p \$d; head -c $2 /dev/urandom | age -r \"\$R\" -o \$d/base.tar.age
        sha256sum \$d/base.tar.age | cut -d' ' -f1 > \$d/base.tar.age.sha256
        echo $3 > \$d/start-wal; date +%s > \$d/created-epoch; ${4:-mv \$d /backup/base/$1}"
}
make_dumps() {
  as70 "d=/backup/dumps/$1.partial; mkdir -p \$d
        for f in roles.sql edms_acme.dump edms_rival.dump; do
          head -c 200000 /dev/urandom | age -r \"\$R\" -o \$d/\$f.age
          sha256sum \$d/\$f.age | cut -d' ' -f1 > \$d/\$f.age.sha256
        done; date +%s > \$d/created-epoch; mv \$d /backup/dumps/$1"
}

make_wal 000000010000000000000001 1048576
make_wal 000000010000000000000002 1048576
make_wal 000000010000000000000003 1048576
# Over the 5 MB upload cutoff: a multipart upload, whose ETag is not an MD5.
make_base 20261015T010000Z 12000000 000000010000000000000002
make_base 20261015T020000Z 100000 000000010000000000000003 'true'
make_dumps 20261015T010500Z
as70 'echo "munaxa_backup_last_run_success 1" > /backup/status/backup.prom'

echo "=== configuration refusals"
out="$(offsite -e OFFSITE_BUCKET='<bucket>' -- validate 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -q 'placeholder' && pass "a placeholder value is refused" || fail "placeholder accepted: $out"
out="$(offsite -e OFFSITE_ALLOW_INSECURE_ENDPOINT=0 -- validate 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -q 'https' && pass "a plain-http endpoint is refused" || fail "http accepted: $out"
out="$(offsite -e "STRAY=$identity_secret" -- validate 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -q 'private key' && pass "a private key in the environment is refused" || fail "identity accepted"
out="$(docker run --rm --user 70:70 --network "$net" --env-file "$work/offsite.env" -e BACKUP_DIR=/backup \
  -e OFFSITE_STATE_DIR=/state -v "$template/offsite/offsite.sh:/opt/munaxa/offsite.sh:ro" \
  -v "$backup:/backup" -v "$state:/state" --entrypoint /bin/sh "$rclone_image" /opt/munaxa/offsite.sh validate 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -q 'read-only' && pass "a writable backup mount is refused" || fail "writable mount accepted: $out"
offsite -- validate >/dev/null 2>&1 && pass "a correct configuration validates against the remote" || fail "validate failed"

echo
echo "=== first copy"
out="$(offsite -- sync 2>&1)"
code=$?
check "the first run succeeds" "$code" 0
[ "$code" -eq 0 ] || printf '%s\n' "$out" | tail -n 15 | sed 's/^/  /'
remote="$(remote_ls)"
check "every WAL file and its digest is on the remote" "$(printf '%s\n' "$remote" | grep -c '^wal/')" 6
printf '%s\n' "$remote" | grep -q '^base/20261015T010000Z/COMPLETE$' && pass "the complete base backup has its COMPLETE marker" || fail "no COMPLETE marker"
printf '%s\n' "$remote" | grep -q '^dumps/20261015T010500Z/COMPLETE$' && pass "the dump set has its COMPLETE marker" || fail "no dump marker"
printf '%s\n' "$remote" | grep -q 'partial' && fail "a .partial backup was copied" || pass "the unfinished (.partial) base backup was not copied"
printf '%s\n' "$remote" | grep -q '^status/' && fail "status/ was copied" || pass "status/ is not copied"
check "one run manifest" "$(printf '%s\n' "$remote" | grep -c '^manifests/')" 1
check "status: last run succeeded" "$(prom last_run_success)" 1
check "status: nothing pending" "$(prom pending_files)" 0
[ "$(prom newest_base_created_timestamp_seconds)" -gt 0 ] && pass "status: the newest complete base backup is recorded" || fail "no base age in status"
etag="$(admin stat --json "t/$bucket/$prefix/base/20261015T010000Z/base.tar.age" | sed -n 's/.*"etag":"\([^"]*\)".*/\1/p')"
case "$etag" in *-*) pass "the 12 MB base backup went up as a multipart upload (ETag $etag) and was verified by reading it back" ;; *) fail "expected a multipart ETag, got '$etag'" ;; esac

echo
echo "=== a second run is idempotent; a concurrent run does nothing"
before="$(prom last_success_timestamp_seconds)"
sleep 1
offsite -- sync >/dev/null 2>&1
check "the second run succeeds" "$?" 0
check "no new manifest when nothing is new" "$(remote_ls | grep -c '^manifests/')" 1
docker run -d --name "$run_id-lock" --user 70:70 -v "$state:/state" --entrypoint sh "$rclone_image" \
  -c 'exec 9>/state/lock; flock 9; sleep 60' >/dev/null
sleep 2
last="$(prom last_success_timestamp_seconds)"
out="$(offsite -- sync 2>&1)"
check "a run started while another holds the lock exits 0" "$?" 0
printf '%s' "$out" | grep -q 'another copy run holds the lock' && pass "and says why" || fail "no lock message: $out"
check "and changes no state" "$(prom last_success_timestamp_seconds)" "$last"
docker rm -f "$run_id-lock" >/dev/null
[ "$last" -ge "$before" ] || fail "status went backwards"

echo
echo "=== network outage: the run fails, records it, and marks nothing"
# First with nothing new to send: the run must still notice the remote is gone (found by the stack
# test — such a run once reported success without contacting the remote).
docker network disconnect "$net" "$minio"
out="$(offsite -e OFFSITE_LOW_LEVEL_RETRIES=1 -- sync 2>&1)"
code=$?
[ "$code" -ne 0 ] && printf '%s' "$out" | grep -q 'remote does not answer' &&
  pass "with nothing new to copy, an unreachable remote still fails the run" ||
  fail "a run with nothing new passed with the remote unreachable (exit $code)"
docker network connect --alias minio "$net" "$minio"
for _ in $(seq 1 30); do admin ready t >/dev/null 2>&1 && break; sleep 1; done
offsite -- sync >/dev/null 2>&1 || fail "the run after reconnecting failed"
make_wal 000000010000000000000004 1048576
as70 'mv /backup/base/20261015T020000Z.partial /backup/base/20261015T020000Z'
docker network disconnect "$net" "$minio"
success_before="$(prom last_success_timestamp_seconds)"
out="$(offsite -e OFFSITE_LOW_LEVEL_RETRIES=1 -- sync 2>&1)"
code=$?
[ "$code" -ne 0 ] && pass "the run fails (exit $code)" || fail "the run passed with the remote unreachable"
check "status: last run failed" "$(prom last_run_success)" 0
check "status: last success unchanged" "$(prom last_success_timestamp_seconds)" "$success_before"
[ "$(prom pending_files)" -gt 0 ] && pass "status: $(prom pending_files) file(s) pending" || fail "nothing pending after a failed run"
[ -f "$state/markers/base/20261015T020000Z/COMPLETE" ] && fail "a base backup was marked complete without reaching the remote" || pass "the new base backup is not marked complete"
docker network connect --alias minio "$net" "$minio"
for _ in $(seq 1 30); do admin ready t >/dev/null 2>&1 && break; sleep 1; done
offsite -- sync >/dev/null 2>&1
check "after the outage the next run catches up" "$?" 0
remote_ls | grep -q '^base/20261015T020000Z/COMPLETE$' && pass "the new base backup is complete on the remote" || fail "no marker after recovery"
check "status: nothing pending" "$(prom pending_files)" 0

echo
echo "=== an interrupted run (copied, never verified) is not a recovery point until verified"
make_base 20261015T030000Z 100000 000000010000000000000004
# What a run killed between the copy and the verification leaves: the files, no manifest, no marker.
docker run --rm --network "$net" --env-file "$work/offsite.env" -v "$backup:/backup:ro" \
  --entrypoint rclone "$rclone_image" --config /dev/null --s3-no-check-bucket copy \
  /backup/base/20261015T030000Z "offsite:$bucket/$prefix/base/20261015T030000Z" >/dev/null 2>&1
remote_ls | grep -q '^base/20261015T030000Z/base.tar.age$' && pass "(set-up) the files are on the remote" || fail "set-up failed"
out="$(offsite -- list-remote 2>&1)"
printf '%s' "$out" | grep -q 20261015T030000Z && fail "list-remote shows an unverified backup as complete" ||
  pass "list-remote does not offer it"
offsite -- sync >/dev/null 2>&1
check "the next run verifies what is there (no overwrite) and succeeds" "$?" 0
out="$(offsite -- list-remote 2>&1)"
printf '%s' "$out" | grep -q 20261015T030000Z && pass "then it is complete" || fail "still not complete"

echo
echo "=== a different object already under a backup's name: refused, never overwritten, never marked"
make_wal 000000010000000000000005 1048576
make_base 20261015T040000Z 100000 000000010000000000000005
head -c 1000 /dev/urandom >"$work/garbage"
docker cp "$work/garbage" "$minio:/tmp/garbage"
admin cp --quiet /tmp/garbage "t/$bucket/$prefix/wal/000000010000000000000005.age" >/dev/null
admin cp --quiet /tmp/garbage "t/$bucket/$prefix/base/20261015T040000Z/base.tar.age" >/dev/null
out="$(offsite -- sync 2>&1)"
check "the run fails" "$?" 1
printf '%s' "$out" | grep -q 'PROBLEM' && pass "and names the problem" || fail "no problem reported: $out"
check "the foreign object was not overwritten (one version only)" \
  "$(admin ls --versions "t/$bucket/$prefix/wal/000000010000000000000005.age" | grep -c ' 000000010000000000000005.age$')" 1
[ -f "$state/markers/base/20261015T040000Z/COMPLETE" ] && fail "a base backup with a foreign file was marked complete" ||
  pass "the base backup with a foreign file is not marked complete"
check "status: last run failed" "$(prom last_run_success)" 0

echo
echo "=== recovery from the remote (as on a new host: the remote only)"
fetch() {
  docker run --rm --user 70:70 --read-only --tmpfs /tmp --network "$net" --env-file "$work/offsite.env" \
    -e HOME=/tmp -v "$template/offsite/offsite.sh:/opt/munaxa/offsite.sh:ro" -v "$work/out:/restore" \
    --entrypoint /bin/sh "$rclone_image" /opt/munaxa/offsite.sh fetch "$@"
}
offsite -- list-remote 2>&1 | sed 's/^/  list-remote: /'
out="$(fetch /restore/latest 2>&1)"
check "fetch of the newest complete recovery point succeeds" "$?" 0
printf '%s\n' "$out" | tail -n 2
printf '%s' "$out" | grep -q 'base backup 20261015T030000Z' && pass "it chose the newest COMPLETE base backup, not the one with a foreign file" ||
  fail "wrong base chosen: $out"
printf '%s' "$out" | grep -q 'left out 1 WAL' && pass "the unverified WAL object was left out" || fail "the foreign WAL was not reported as left out"
[ -f "$work/out/latest/wal/000000010000000000000005.age" ] && fail "the foreign WAL file was fetched" || pass "and not fetched"
same=1
for f in base/20261015T030000Z/base.tar.age wal/000000010000000000000004.age dumps/20261015T010500Z/edms_acme.dump.age; do
  [ "$(sha256sum <"$backup/$f")" = "$(sha256sum <"$work/out/latest/$f")" ] || same=0
done
check "fetched files are byte-identical to the originals" "$same" 1
plain="$(docker run --rm -v "$work/out/latest:/r:ro" -v "$work/identity.txt:/id:ro" --entrypoint sh "$postgres_image" \
  -c 'age -d -i /id /r/wal/000000010000000000000004.age | sha256sum | cut -d" " -f1')"
check "a fetched WAL file decrypts with the offline identity to the digest recorded at archiving" \
  "$plain" "$(cat "$backup/wal/000000010000000000000004.sha256")"
out="$(fetch /restore/old 20261015T010000Z 2>&1)"
check "fetch of a named older backup succeeds" "$?" 0
check "it brings the WAL from that backup's start on" "$(find "$work/out/old/wal" -name '*.age' | wc -l)" 3
# Damage on the remote after verification: a full credential writes a new version over the base.
admin cp --quiet /tmp/garbage "t/$bucket/$prefix/base/20261015T020000Z/base.tar.age" >/dev/null
out="$(fetch /restore/tampered 20261015T020000Z 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -q 'does not match' && pass "fetch refuses a base backup altered on the remote" ||
  fail "an altered base backup was fetched: $out"
# `mc ls` matches by prefix, so the .sha256 beside it is filtered out by name.
check "the original version is still on the remote (versioning)" \
  "$(admin ls --versions "t/$bucket/$prefix/base/20261015T020000Z/base.tar.age" | grep -c ' base.tar.age$')" 2

echo
echo "=== the copy never deletes, and its credential cannot"
as70 'rm -rf /backup/base/20261015T010000Z /backup/wal/000000010000000000000001.age /backup/wal/000000010000000000000001.sha256'
count_before="$(remote_ls | wc -l)"
offsite -- sync >/dev/null 2>&1
remote_ls | grep -q '^base/20261015T010000Z/base.tar.age$' && pass "a backup pruned locally stays on the remote" || fail "the remote copy disappeared"
[ "$(remote_ls | wc -l)" -ge "$count_before" ] && pass "no object was removed by a sync" || fail "objects were removed"
out="$(docker run --rm --network "$net" --env-file "$work/offsite.env" --entrypoint rclone "$rclone_image" \
  --config /dev/null --s3-no-check-bucket deletefile "offsite:$bucket/$prefix/wal/000000010000000000000002.age" 2>&1)"
[ $? -ne 0 ] && pass "the copy credential is refused a delete (policy: no s3:DeleteObject)" || fail "the credential could delete"
remote_ls | grep -q '^wal/000000010000000000000002.age$' && pass "and the object is still there" || fail "object deleted"

echo
echo "=== a damaged local file is not copied"
make_dumps 20261015T050000Z
as70 'printf x >> /backup/dumps/20261015T050000Z/edms_acme.dump.age'
out="$(offsite -- sync 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -q 'does not match its recorded digest' && pass "a local file that no longer matches its digest is refused" ||
  fail "a damaged local file was accepted: $out"
remote_ls | grep -q '^dumps/20261015T050000Z/COMPLETE$' && fail "the damaged dump set was marked complete" || pass "its set is not marked complete"

echo
echo "=== nothing secret in what the job printed"
all_output="$(offsite -- sync 2>&1; offsite -- list-remote 2>&1; cat "$state/offsite.prom")"
leak=0
for value in "$key_secret" "$root_pw" "$identity_secret"; do
  printf '%s' "$all_output$out" | grep -qF "$value" && leak=1
done
check "no credential or key appears in the output or the status file" "$leak" 0
grep -q "$bucket\|$prefix\|minio" "$state/offsite.prom" && fail "the status file names the bucket or host" || pass "the status file holds numbers only"

echo
if [ "$failures" -eq 0 ]; then
  echo "All off-server copy checks passed"
else
  echo "$failures off-server copy check(s) FAILED"
fi
exit "$failures"
