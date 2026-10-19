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

# --- --backups-deferred (compose.backups-deferred.yaml; README.md §4) ----------------------------

out="$("$check_script" "$work/good.env" --bogus 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -q '^usage:' && pass "an unknown option is refused" ||
  fail "an unknown option was accepted"

# The flag and DOCS_BACKUPS_DEFERRED=1 (read by ops/host-check.sh) go together.
with_deferral() { sed '$a DOCS_BACKUPS_DEFERRED=1'; }
good | with_deferral >"$work/good-deferred.env"
out="$("$check_script" "$work/good-deferred.env" --backups-deferred 2>&1)"
[ $? -eq 0 ] && printf '%s' "$out" | grep -q '^DEFERRED' && printf '%s' "$out" | grep -q 'BACKUPS DEFERRED' &&
  pass "--backups-deferred: a TEST project passes and says backups are deferred" ||
  fail "--backups-deferred: the TEST file was refused or not marked deferred: $out"

for name in munaxa-docs-prod munaxa-docs munaxa-docs-test-copy munaxa-docs-testing; do
  good | sed "s#^DOCS_PROJECT_NAME=.*#DOCS_PROJECT_NAME=$name#" >"$work/case.env"
  "$check_script" "$work/case.env" >/dev/null 2>&1
  normal=$?
  with_deferral <"$work/case.env" >"$work/case-deferred.env"
  out="$("$check_script" "$work/case-deferred.env" --backups-deferred 2>&1)"
  if [ $? -ne 0 ] && [ "$normal" -eq 0 ] && printf '%s' "$out" | grep -F 'PROBLEM' | grep -qF 'must end in -test'; then
    pass "--backups-deferred refused for project $name (accepted without the flag)"
  else
    fail "--backups-deferred not refused as expected for project $name"
  fi
done

# The flag defers backups only: an unrelated mistake is still refused.
good | sed 's#^DOCS_API_IMAGE=.*#DOCS_API_IMAGE=ghcr.io/munaxa/munaxa-docs-api:latest#' | with_deferral >"$work/case.env"
out="$("$check_script" "$work/case.env" --backups-deferred 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -F 'PROBLEM' | grep -qF 'DOCS_API_IMAGE must name' &&
  pass "--backups-deferred still refuses an image by tag" || fail "--backups-deferred accepted an image by tag"

# Flag and setting must agree, so the host check never skips backups this check requires.
out="$("$check_script" "$work/good.env" --backups-deferred 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -F 'PROBLEM' | grep -qF 'needs DOCS_BACKUPS_DEFERRED=1' &&
  pass "--backups-deferred without DOCS_BACKUPS_DEFERRED=1 is refused" || fail "the flag was accepted without the setting"
out="$("$check_script" "$work/good-deferred.env" 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -F 'PROBLEM' | grep -qF 'needs --backups-deferred' &&
  pass "DOCS_BACKUPS_DEFERRED=1 without --backups-deferred is refused" || fail "the setting was accepted without the flag"
good | sed '$a DOCS_BACKUPS_DEFERRED=yes' >"$work/case.env"
out="$("$check_script" "$work/case.env" 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -F 'PROBLEM' | grep -qF 'must be 0 or 1' &&
  pass "DOCS_BACKUPS_DEFERRED=yes is refused" || fail "DOCS_BACKUPS_DEFERRED=yes was accepted"
good | sed '$a DOCS_BACKUPS_DEFERRED=0' >"$work/case.env"
"$check_script" "$work/case.env" >/dev/null 2>&1 && pass "DOCS_BACKUPS_DEFERRED=0 is the normal mode" ||
  fail "DOCS_BACKUPS_DEFERRED=0 was refused"

# On the host: a configuration directory as the server would hold it, but no backup volume, no
# offsite.env and no off-server state directory. Modes only; no ownership change, so no root needed.
cfg="$work/etc-munaxa-docs"
mkdir -m 0700 "$cfg"
for f in api.env postgres.env redis.env operator.env backup.env monitoring.env; do
  printf 'SETTING=fixture-value\n' >"$cfg/$f"
  chmod 0600 "$cfg/$f"
done
for f in tenants.json operator-tenants.json; do
  printf '{"tenants": []}\n' >"$cfg/$f"
  chmod 0400 "$cfg/$f"
done
on_host() {
  good | sed -e "s#^DOCS_CONFIG_DIR=.*#DOCS_CONFIG_DIR=$cfg#" \
    -e "s#^DOCS_BACKUP_DIR=.*#DOCS_BACKUP_DIR=$work/no-backup-volume#" \
    -e "s#^DOCS_OFFSITE_STATE_DIR=.*#DOCS_OFFSITE_STATE_DIR=$work/no-offsite-state#"
}
on_host >"$work/host.env"
on_host | with_deferral >"$work/host-deferred.env"

# Normal mode still insists on every backup requirement.
out="$("$check_script" "$work/host.env" --on-host 2>&1)"
code=$?
for expect in 'offsite.env is missing' 'DOCS_BACKUP_DIR does not exist' 'DOCS_OFFSITE_STATE_DIR must exist'; do
  [ "$code" -ne 0 ] && printf '%s' "$out" | grep -F 'PROBLEM' | grep -qF "$expect" &&
    pass "normal mode on the host refuses: $expect" || fail "normal mode on the host did not refuse: $expect"
done

out="$("$check_script" "$work/host-deferred.env" --on-host --backups-deferred 2>&1)"
code=$?
if [ "$code" -eq 0 ] && ! printf '%s' "$out" | grep -q 'PROBLEM'; then
  pass "deferred mode on the host passes without backup volume, offsite.env or off-server state"
else
  fail "deferred mode on the host was refused (exit $code): $out"
fi
for expect in 'offsite.env' 'DOCS_BACKUP_DIR' 'DOCS_OFFSITE_STATE_DIR'; do
  printf '%s' "$out" | grep '^DEFERRED' | grep -qF "$expect" && pass "deferred mode reports $expect as DEFERRED" ||
    fail "deferred mode did not report $expect as DEFERRED"
done

# The option order does not matter.
"$check_script" "$work/host-deferred.env" --backups-deferred --on-host >/dev/null 2>&1 &&
  pass "the options are accepted in either order" || fail "--backups-deferred --on-host was refused"

# Deferred mode on the host keeps every other requirement: monitoring is not deferred, modes and
# placeholders are still checked, and a non-TEST project is still refused.
mv "$cfg/monitoring.env" "$work/monitoring.env.aside"
out="$("$check_script" "$work/host-deferred.env" --on-host --backups-deferred 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -F 'PROBLEM' | grep -qF 'monitoring.env is missing' &&
  pass "deferred mode still requires monitoring.env" || fail "deferred mode accepted a missing monitoring.env"
mv "$work/monitoring.env.aside" "$cfg/monitoring.env"
chmod 0644 "$cfg/api.env"
out="$("$check_script" "$work/host-deferred.env" --on-host --backups-deferred 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -F 'PROBLEM' | grep -qF 'api.env is mode 644' &&
  pass "deferred mode still refuses a readable secret file" || fail "deferred mode accepted api.env at 0644"
chmod 0600 "$cfg/api.env"
printf 'HEARTBEAT_URL=<required>\n' >>"$cfg/monitoring.env"
out="$("$check_script" "$work/host-deferred.env" --on-host --backups-deferred 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -F 'PROBLEM' | grep -qF 'monitoring.env still holds a placeholder' &&
  pass "deferred mode still refuses a placeholder in monitoring.env" || fail "deferred mode accepted a monitoring.env placeholder"
printf 'SETTING=fixture-value\n' >"$cfg/monitoring.env"
on_host | sed 's#^DOCS_PROJECT_NAME=.*#DOCS_PROJECT_NAME=munaxa-docs-prod#' | with_deferral >"$work/host-prod.env"
out="$("$check_script" "$work/host-prod.env" --on-host --backups-deferred 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -F 'PROBLEM' | grep -qF 'must end in -test' &&
  pass "deferred mode on the host is refused for a non-TEST project" || fail "deferred mode on the host accepted munaxa-docs-prod"

echo
if [ "$failures" -eq 0 ]; then
  echo "All deploy.env checks passed"
else
  echo "$failures deploy.env check(s) FAILED"
fi
exit "$failures"
