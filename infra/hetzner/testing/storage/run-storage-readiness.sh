#!/usr/bin/env bash
# Runs storage-readiness.cjs (the document store's readiness checks; readiness report §5.3) in the
# API image, through the product's own S3 adapter.
#
#   Local (MinIO; proves the checks, says nothing about any provider):
#     DOCS_API_IMAGE=munaxa-docs-api:local infra/hetzner/testing/storage/run-storage-readiness.sh
#   LOCAL_BUCKET=plain: a bucket WITHOUT versioning or Object Lock — the control, which must report
#   those as UNSUPPORTED, or FAIL with LOCAL_EXPECT_FEATURES=1.
#
#   Against a real bucket (gate P-1 for Hetzner Object Storage — NOT RUN YET, no bucket exists):
#     STORAGE_READINESS_ENV=/secure/path/hetzner-os-test.env DOCS_API_IMAGE=ghcr.io/…@sha256:… \
#       infra/hetzner/testing/storage/run-storage-readiness.sh
#   The file (mode 0600, outside the repository) is parsed, never executed; only these keys are read:
#     STORAGE_DRIVER=S3  STORAGE_BUCKET  STORAGE_REGION  STORAGE_ENDPOINT (https only)
#     STORAGE_FORCE_PATH_STYLE  STORAGE_ACCESS_KEY_ID  STORAGE_SECRET_ACCESS_KEY
#     STORAGE_TEST_EXPECT_VERSIONING=1   STORAGE_TEST_EXPECT_OBJECT_LOCK=1   (the bucket must have them)
#     STORAGE_TEST_OTHER_BUCKET          a bucket in the same account the key must NOT reach
#   Values are never printed. Every object version the run writes is removed at the end; an object
#   under Object Lock is removed once its retention (STORAGE_TEST_LOCK_SECONDS, default 20) ends.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
api_image="${DOCS_API_IMAGE:?set DOCS_API_IMAGE (the API image whose S3 adapter is under test)}"
minio_image="${MINIO_IMAGE:-munaxa-docs-test-minio:local}"
run_id="storage-$(openssl rand -hex 4)"
work="$(mktemp -d)"
chmod 700 "$work"
umask 077
network_args=()

cleanup() {
  docker rm -f "$run_id-minio" >/dev/null 2>&1 || true
  docker network rm "$run_id-net" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

keys=(STORAGE_DRIVER STORAGE_BUCKET STORAGE_REGION STORAGE_ENDPOINT STORAGE_FORCE_PATH_STYLE
  STORAGE_ACCESS_KEY_ID STORAGE_SECRET_ACCESS_KEY STORAGE_TEST_EXPECT_VERSIONING
  STORAGE_TEST_EXPECT_OBJECT_LOCK STORAGE_TEST_OTHER_BUCKET STORAGE_TEST_LOCK_SECONDS)

if [ -n "${STORAGE_READINESS_ENV:-}" ]; then
  [ -r "$STORAGE_READINESS_ENV" ] || { echo "STORAGE_READINESS_ENV is not a readable file"; exit 1; }
  for key in "${keys[@]}"; do
    line="$(grep -E "^$key=" "$STORAGE_READINESS_ENV" | tail -n 1 || true)"
    [ -n "$line" ] && printf '%s\n' "$line" >>"$work/storage.env"
  done
  value() { sed -n "s/^$1=//p" "$work/storage.env" | tail -n 1; }
  for key in STORAGE_DRIVER STORAGE_BUCKET STORAGE_REGION STORAGE_ENDPOINT STORAGE_ACCESS_KEY_ID STORAGE_SECRET_ACCESS_KEY; do
    [ -n "$(value "$key")" ] || { echo "STORAGE_READINESS_ENV does not set $key"; exit 1; }
  done
  case "$(value STORAGE_ENDPOINT)" in https://*) ;; *) echo "STORAGE_ENDPOINT must be https://"; exit 1 ;; esac
  echo "Store under test: EXTERNAL (bucket and endpoint from STORAGE_READINESS_ENV; not printed)"
else
  # MinIO with a versioned, Object-Locked bucket, a second bucket the key must not reach, and a key
  # with the document store's permissions (read, write, list, delete, versions) and no bypass of
  # retention — the shape README.md §6 asks of the real key.
  root_user="root-$(openssl rand -hex 4)" root_pw="$(openssl rand -hex 24)"
  key_id="docs-$(openssl rand -hex 4)" key_secret="$(openssl rand -hex 24)"
  docker network create --internal "$run_id-net" >/dev/null
  docker run -d --name "$run_id-minio" --network "$run_id-net" --network-alias minio \
    -e MINIO_ROOT_USER="$root_user" -e MINIO_ROOT_PASSWORD="$root_pw" "$minio_image" >/dev/null
  admin() { docker exec -e MC_HOST_t="http://$root_user:$root_pw@127.0.0.1:9000" "$run_id-minio" mc "$@"; }
  for _ in $(seq 1 60); do admin ready t >/dev/null 2>&1 && break; sleep 1; done
  if [ "${LOCAL_BUCKET:-locked}" = "plain" ]; then
    admin mb --quiet t/documents >/dev/null
  else
    admin mb --quiet --with-lock t/documents >/dev/null
  fi
  expect="${LOCAL_EXPECT_FEATURES:-$([ "${LOCAL_BUCKET:-locked}" = "plain" ] && echo 0 || echo 1)}"
  admin mb --quiet t/other-tenant-bucket >/dev/null
  cat >"$work/policy.json" <<'EOF'
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:ListBucket","s3:ListBucketVersions","s3:ListBucketMultipartUploads","s3:GetBucketVersioning","s3:GetBucketObjectLockConfiguration"],"Resource":["arn:aws:s3:::documents"]},
 {"Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:GetObjectVersion","s3:DeleteObject","s3:DeleteObjectVersion","s3:AbortMultipartUpload","s3:ListMultipartUploadParts","s3:PutObjectRetention","s3:GetObjectRetention"],"Resource":["arn:aws:s3:::documents/*"]}]}
EOF
  # Not secret; MinIO's own user must read it after the copy.
  chmod 644 "$work/policy.json"
  docker cp "$work/policy.json" "$run_id-minio:/tmp/policy.json"
  admin admin user add t "$key_id" "$key_secret" >/dev/null
  admin admin policy create t documents-only /tmp/policy.json >/dev/null
  admin admin policy attach t documents-only --user "$key_id" >/dev/null
  cat >"$work/storage.env" <<EOF
STORAGE_DRIVER=S3
STORAGE_BUCKET=documents
STORAGE_REGION=us-east-1
STORAGE_ENDPOINT=http://minio:9000
STORAGE_FORCE_PATH_STYLE=true
STORAGE_ACCESS_KEY_ID=$key_id
STORAGE_SECRET_ACCESS_KEY=$key_secret
STORAGE_TEST_EXPECT_VERSIONING=$expect
STORAGE_TEST_EXPECT_OBJECT_LOCK=$expect
STORAGE_TEST_OTHER_BUCKET=other-tenant-bucket
EOF
  network_args=(--network "$run_id-net")
  echo "Store under test: the local MinIO (${LOCAL_BUCKET:-locked} bucket; a scoped key)"
fi

output="$(docker run --rm "${network_args[@]}" --read-only --tmpfs /tmp --env-file "$work/storage.env" \
  -e "RUN_PREFIX=readiness-$(openssl rand -hex 6)/" -v "$here/storage-readiness.cjs:/probe/storage-readiness.cjs:ro" \
  --entrypoint node "$api_image" /probe/storage-readiness.cjs 2>&1)"
status=$?
printf '%s\n' "$output"
secret="$(sed -n 's/^STORAGE_SECRET_ACCESS_KEY=//p' "$work/storage.env")"
if printf '%s' "$output" | grep -qF "$secret"; then
  echo "FAIL        the storage secret appeared in the output"
  status=1
fi
exit "$status"
