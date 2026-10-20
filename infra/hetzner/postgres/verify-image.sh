#!/usr/bin/env bash
# Accepts or refuses a built munaxa-docs-postgres image before it is pushed (publish-images.yml) or
# deployed: the versions it must carry, the backup tools, the refusal to hold a private key, a real
# start, and no credential in its history.
#
#   infra/hetzner/postgres/verify-image.sh IMAGE
#
# Starts one throwaway container with no network and a generated password; removes it at the end.
set -uo pipefail

image="${1:?usage: verify-image.sh IMAGE}"
name="pg-verify-$(openssl rand -hex 4)"
failures=0
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

pass() { echo "PASS  $*"; }
fail() {
  echo "FAIL  $*"
  failures=$((failures + 1))
}
in_image() { docker run --rm --network none --entrypoint sh "$image" -c "$1" 2>&1; }

version="$(in_image 'postgres --version')"
[ "$version" = "postgres (PostgreSQL) 16.10" ] && pass "PostgreSQL 16.10" || fail "PostgreSQL version: $version"
age_version="$(in_image 'age --version')"
[ "$age_version" = "1.2.1" ] && pass "age 1.2.1" || fail "age version: $age_version"
tools="$(in_image 'for t in munaxa-archive-wal munaxa-restore-wal munaxa-backup age age-keygen pg_basebackup pg_verifybackup; do command -v "$t" >/dev/null || echo "missing $t"; done; test -r /etc/munaxa-postgres/pg_hba.conf || echo "missing pg_hba.conf"')"
[ -z "$tools" ] && pass "the backup tools and pg_hba.conf are present" || fail "$tools"

# Every backup command refuses to run beside a private key; validate checks that first.
refusal="$(docker run --rm --network none -e BACKUP_AGE_IDENTITY_FILE=/nonexistent --entrypoint munaxa-backup "$image" validate 2>&1)"
case "$refusal" in *"private key"*) pass "munaxa-backup refuses to run beside an identity" ;; *) fail "no refusal: $refusal" ;; esac

# A real start, as the template starts it (official entrypoint, password from the environment).
password="$(openssl rand -hex 24)"
docker run -d --name "$name" --network none -e POSTGRES_PASSWORD="$password" "$image" >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] && pass "starts and accepts connections" || fail "did not become ready: $(docker logs "$name" 2>&1 | tail -n 5)"
answer="$(docker exec "$name" psql -U postgres -tAc 'SHOW server_version' 2>&1)"
[ "$answer" = "16.10" ] && pass "answers a query (server_version $answer)" || fail "query: $answer"

history="$(docker history --no-trunc --format '{{.CreatedBy}}' "$image")"
if printf '%s' "$history" | grep -Eiq 'password=|secret=|token=|AGE-SECRET-KEY'; then
  fail "a credential appears in the image history"
else
  pass "no credential in the image history"
fi
docker logs "$name" 2>&1 | grep -qF "$password" && fail "the password appears in the log" || pass "the password is not logged"

echo
if [ "$failures" -eq 0 ]; then
  echo "munaxa-docs-postgres image accepted: $image"
else
  echo "munaxa-docs-postgres image REFUSED: $failures check(s) failed"
fi
exit "$failures"
