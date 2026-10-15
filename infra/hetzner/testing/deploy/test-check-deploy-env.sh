#!/usr/bin/env bash
# Tests ops/check-deploy-env.sh: a complete TEST deploy.env passes; each kind of mistake is refused
# and named; the shipped examples, which hold placeholders, are refused. No value is real: digests
# and keys are generated for this run, the host name is under a domain the test never contacts.
#
#   infra/hetzner/testing/deploy/test-check-deploy-env.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$(cd "$here/../.." && pwd)"
check_script="$template/ops/check-deploy-env.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

pass() { echo "PASS  $*"; }
fail() {
  echo "FAIL  $*"
  failures=$((failures + 1))
}

digest() { printf 'sha256:%s' "$(openssl rand -hex 32)"; }
# A syntactically valid age recipient (bech32 alphabet), not a real key.
recipient() { printf 'age1%s' "$(LC_ALL=C tr -dc 'qpzry9x8gf2tvdw0s3jn54khce6mua7l' </dev/urandom | head -c 58)"; }
r1="$(recipient)" r2="$(recipient)"

good() {
  cat <<EOF
DOCS_PROJECT_NAME=munaxa-docs-test
DOCS_CONFIG_DIR=/etc/munaxa-docs
DOCS_API_IMAGE=ghcr.io/munaxa/munaxa-docs-api@$(digest)
DOCS_WEB_IMAGE=ghcr.io/munaxa/munaxa-docs-web@$(digest)
DOCS_ANTIVIRUS_IMAGE=ghcr.io/munaxa/munaxa-docs-antivirus@$(digest)
DOCS_POSTGRES_IMAGE=ghcr.io/munaxa/munaxa-docs-postgres@$(digest)
DOCS_PROXY_IMAGE=caddy:2.10.2-alpine@$(digest)
DOCS_REDIS_IMAGE=redis:7.4-alpine@$(digest)
DOCS_HTTP_BIND=127.0.0.1
DOCS_HTTP_PORT=8080
DOCS_PUBLIC_HOSTNAME=docs-test.munaxa-fixture.eu
DOCS_ACME_EMAIL=operator@munaxa-fixture.eu
DOCS_BACKUP_DIR=/mnt/munaxa-backup
DOCS_BACKUP_AGE_RECIPIENTS=$r1,$r2
DOCS_OFFSITE_STATE_DIR=/var/lib/munaxa-docs/offsite
EOF
}

good >"$work/good.env"
out="$("$check_script" "$work/good.env" 2>&1)"
[ $? -eq 0 ] && pass "a complete TEST deploy.env passes" || fail "the good file was refused: $out"

# Each case: a description, the text a PROBLEM line must contain, and a sed expression that breaks
# exactly one thing in the good file.
cases=(
  "an image by tag, not digest|DOCS_API_IMAGE must name|s#^DOCS_API_IMAGE=.*#DOCS_API_IMAGE=ghcr.io/munaxa/munaxa-docs-api:latest#"
  "a placeholder left in|placeholders remain|s#^DOCS_ACME_EMAIL=.*#DOCS_ACME_EMAIL=<required>#"
  "a private key pasted in|PRIVATE key|\$a DOCS_NOTE=AGE-SECRET-KEY-1QQQQ"
  "a password in deploy.env|secret-looking|\$a PGPASSWORD=hunter2"
  "only one backup recipient|at least two distinct|s#^DOCS_BACKUP_AGE_RECIPIENTS=.*#DOCS_BACKUP_AGE_RECIPIENTS=$r1#"
  "the same recipient twice|at least two distinct|s#^DOCS_BACKUP_AGE_RECIPIENTS=.*#DOCS_BACKUP_AGE_RECIPIENTS=$r1,$r1#"
  "an SSH key as a recipient|not an age public key|s#^DOCS_BACKUP_AGE_RECIPIENTS=.*#DOCS_BACKUP_AGE_RECIPIENTS=$r1,ssh-ed25519#"
  "the plain listener on every address|DOCS_HTTP_BIND must be|s#^DOCS_HTTP_BIND=.*#DOCS_HTTP_BIND=0.0.0.0#"
  "an IP address as the host name|fully qualified host name|s#^DOCS_PUBLIC_HOSTNAME=.*#DOCS_PUBLIC_HOSTNAME=203.0.113.10#"
  "localhost as the host name|fully qualified host name|s#^DOCS_PUBLIC_HOSTNAME=.*#DOCS_PUBLIC_HOSTNAME=localhost#"
  "an example name|reserved or example name|s#^DOCS_PUBLIC_HOSTNAME=.*#DOCS_PUBLIC_HOSTNAME=docs.example.com#"
  "an upper-case host name|fully qualified host name|s#^DOCS_PUBLIC_HOSTNAME=.*#DOCS_PUBLIC_HOSTNAME=Docs.Munaxa-Fixture.EU#"
  "no ACME contact|DOCS_ACME_EMAIL must be|/^DOCS_ACME_EMAIL=/d"
  "an http ACME directory|DOCS_ACME_CA must be|\$a DOCS_ACME_CA=http://acme.invalid/directory"
  "a relative backup directory|DOCS_BACKUP_DIR must be an absolute path|s#^DOCS_BACKUP_DIR=.*#DOCS_BACKUP_DIR=backup#"
  "no project name|DOCS_PROJECT_NAME must be set|/^DOCS_PROJECT_NAME=/d"
)
for entry in "${cases[@]}"; do
  description="${entry%%|*}" rest="${entry#*|}"
  expect="${rest%%|*}" expression="${rest#*|}"
  good | sed "$expression" >"$work/case.env"
  out="$("$check_script" "$work/case.env" 2>&1)"
  code=$?
  if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -F 'PROBLEM' | grep -qF "$expect"; then
    pass "refused: $description"
  else
    fail "not refused as expected: $description (exit $code)"
  fi
done

# No value from the file is ever printed, only setting names.
good | sed '$a PGPASSWORD=hunter2-must-not-print' >"$work/leak.env"
out="$("$check_script" "$work/leak.env" 2>&1)"
printf '%s' "$out" | grep -q 'hunter2' && fail "a value was printed" || pass "values are never printed, only setting names"

for example in deploy.env.example deploy.test.env.example; do
  out="$("$check_script" "$template/$example" 2>&1)"
  [ $? -ne 0 ] && printf '%s' "$out" | grep -q 'placeholders remain' && pass "$example is refused until filled in" ||
    fail "$example was accepted as it ships"
done

echo
if [ "$failures" -eq 0 ]; then
  echo "All deploy.env checks passed"
else
  echo "$failures deploy.env check(s) FAILED"
fi
exit "$failures"
