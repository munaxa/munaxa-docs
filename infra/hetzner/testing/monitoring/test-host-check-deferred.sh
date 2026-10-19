#!/usr/bin/env bash
# Tests ops/host-check.sh and ops/monitor.sh with backups deferred (DOCS_BACKUPS_DEFERRED;
# README.md §4, "TEST with backups deferred"): the deferral is honoured only for a -test project,
# replaces exactly the backup checks, and leaves every other check, the heartbeat and the alerts
# working.
#
#   infra/hetzner/testing/monitoring/test-host-check-deferred.sh
#
# The REAL host-check.sh and monitor.sh run; only `docker` is a stand-in, first on PATH, answering
# as a running stack would (which services run, readiness, archive_mode, the backup status file).
# Needs python3 and curl. No daemon, no image, and nothing leaves this machine.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ops="$(cd "$here/../../ops" && pwd)"
work="$(mktemp -d)"
chmod 700 "$work"
failures=0
receiver_pid=""

cleanup() {
  [ -n "$receiver_pid" ] && kill "$receiver_pid" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT

pass() { echo "PASS  $*"; }
fail() {
  echo "FAIL  $*"
  failures=$((failures + 1))
}

# --- the stand-in docker ---------------------------------------------------------------------------
# $state/running: the services `compose ps` lists; $state/ready: the readiness answer;
# $state/archive_mode: what SHOW archive_mode returns. Everything else answers healthy.
mkdir -p "$work/bin" "$work/state"
state="$work/state"
cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
s="$FAKE_DOCKER_STATE"
running() { grep -qx "$1" "$s/running"; }
if [ "$1" = inspect ]; then
  service="${4#id-}"
  case "$3" in
    *Labels*) echo "$service" ;;
    *OOMKilled*) echo false ;;
    *Health*) echo healthy ;;
    *State.Status*) echo running ;;
  esac
  exit 0
fi
[ "$1" = compose ] || exit 1
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file | -f | -p | --profile) shift 2 ;;
    *) break ;;
  esac
done
command="$1"
shift
case "$command" in
  ps) sed 's/^/id-/' "$s/running" ;;
  logs) ;;
  exec)
    [ "$1" = -T ] && shift
    service="$1"
    shift
    running "$service" || exit 1
    case "$service:$*" in
      postgres:pg_isready*) ;;
      *pg_stat_archiver*) echo "0 f" ;;
      *archive_mode*) cat "$s/archive_mode" ;;
      db-backup:cat*) printf 'munaxa_backup_last_success_timestamp_seconds %s\nmunaxa_backup_last_run_success 1\n' "$(date +%s)" ;;
      api:*health/ready*) cat "$s/ready" ;;
      api:*) echo ok ;;
      antivirus:*) date +%s ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$work/bin/docker"

# A healthy stack, as each scenario starts.
stack() {
  printf '%s\n' "$@" >"$state/running"
  echo '200 ' >"$state/ready"
  echo off >"$state/archive_mode"
}
all_services=(proxy web api antivirus postgres redis db-backup)
deferred_services=(proxy web api antivirus postgres redis)

# A backup volume and an off-server copy that are both fine, for the normal mode.
mkdir -p "$work/backup" "$work/offsite"
printf 'munaxa_offsite_last_success_timestamp_seconds %s\nmunaxa_offsite_last_run_success 1\nmunaxa_offsite_newest_base_created_timestamp_seconds %s\n' \
  "$(date +%s)" "$(date +%s)" >"$work/offsite/offsite.prom"
deploy_env() { # PROJECT DEFERRAL(or "") BACKUP_DIR
  {
    echo "DOCS_PROJECT_NAME=$1"
    [ -n "$2" ] && echo "DOCS_BACKUPS_DEFERRED=$2"
    echo "DOCS_BACKUP_DIR=$3"
    echo "DOCS_OFFSITE_STATE_DIR=$work/offsite"
  } >"$work/deploy.env"
}
# The host check as the systemd unit runs it: a clean environment, deploy.env by path. Limits that
# depend on this machine are opened up; each scenario below decides what is healthy.
host_check() {
  env -i PATH="$work/bin:$PATH" HOME="$work" FAKE_DOCKER_STATE="$state" DOCS_ENV_FILE="$work/deploy.env" \
    DISK_MAX_PERCENT=100 MEMORY_MIN_PERCENT=0 "$ops/host-check.sh" 2>&1
}
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }
deferred_lines() { printf '%s\n' "$out" | grep -c '^DEFERRED'; }

echo "=== normal TEST mode, backups enabled: strict as before"
deploy_env munaxa-docs-test "" "$work/backup"
stack "${all_services[@]}"
out="$(host_check)"
code=$?
[ "$code" -eq 0 ] && has 'ok       backup: last success' && has 'ok       offsite: last verified copy' && [ "$(deferred_lines)" -eq 0 ] &&
  pass "healthy with backups: all well, and the backup and off-server checks ran" || fail "normal mode (exit $code): $out"
stack "${deferred_services[@]}"
out="$(host_check)"
[ $? -ne 0 ] && has 'FINDING  container: db-backup is not running' && has 'FINDING  backup: no successful backup recorded' &&
  pass "without the setting, a missing db-backup and missing backups are findings" || fail "normal mode accepted a missing db-backup: $out"
deploy_env munaxa-docs-test 0 "$work/backup"
stack "${all_services[@]}"
out="$(host_check)"
[ $? -eq 0 ] && [ "$(deferred_lines)" -eq 0 ] && has 'ok       backup: last success' && pass "DOCS_BACKUPS_DEFERRED=0 is the normal mode" ||
  fail "DOCS_BACKUPS_DEFERRED=0 changed the checks: $out"

echo
echo "=== TEST mode with backups deferred"
deploy_env munaxa-docs-test 1 "$work/no-backup-volume"
stack "${deferred_services[@]}"
out="$(host_check)"
code=$?
if [ "$code" -eq 0 ] && has 'host check: all well' && has 'ok       backup: WAL archiving is off' &&
  [ "$(deferred_lines)" -eq 3 ] && ! has 'db-backup is not running' && ! has 'no-backup-volume'; then
  pass "deferred: all well without db-backup, the backup volume or the off-server copy; three DEFERRED lines"
else
  fail "deferred mode (exit $code): $out"
fi
skipped=""
for check in 'ok       disk: / ' 'ok       memory:' 'ok       container: api running' 'ok       database: PostgreSQL accepts' \
  'ok       api: ready' 'ok       storage: the object store answers' 'ok       logs: checked' 'ok       scanner: signatures current'; do
  has "$check" || skipped="$skipped [$check]"
done
[ -z "$skipped" ] && pass "deferred: the disk, memory, container, database, readiness, storage, log and scanner checks all ran" ||
  fail "deferred mode skipped unrelated checks:$skipped"
echo on >"$state/archive_mode"
out="$(host_check)"
[ $? -ne 0 ] && has 'FINDING  backup: backups are deferred but WAL archiving is on' &&
  pass "deferred but archiving on (overlay not applied): a finding" || fail "deferred mode accepted archive_mode=on: $out"

echo
echo "=== the setting refused"
for name in munaxa-docs-prod munaxa-docs munaxa-docs-testing; do
  deploy_env "$name" 1 "$work/backup"
  stack "${deferred_services[@]}"
  out="$(host_check)"
  if [ $? -ne 0 ] && has 'DOCS_BACKUPS_DEFERRED=1 is refused' && has 'FINDING  container: db-backup is not running' &&
    has 'FINDING  backup: no successful backup recorded' && [ "$(deferred_lines)" -eq 0 ]; then
    pass "refused for $name: a finding, and every backup check still runs"
  else
    fail "the setting was not refused for $name: $out"
  fi
done
deploy_env munaxa-docs-test yes "$work/backup"
stack "${all_services[@]}"
out="$(host_check)"
[ $? -ne 0 ] && has 'DOCS_BACKUPS_DEFERRED must be 0 or 1' && has 'ok       backup: last success' && [ "$(deferred_lines)" -eq 0 ] &&
  pass "an invalid value is a finding, and backups are still checked" || fail "DOCS_BACKUPS_DEFERRED=yes accepted: $out"

echo
echo "=== an unrelated failure still fails while backups are deferred"
deploy_env munaxa-docs-test 1 "$work/no-backup-volume"
stack "${deferred_services[@]}"
echo '503 postgres=DOWN' >"$state/ready"
out="$(host_check)"
[ $? -ne 0 ] && has 'FINDING  api: not ready' && pass "API not ready: a finding" || fail "an unready API passed: $out"
stack proxy web api antivirus postgres
out="$(host_check)"
[ $? -ne 0 ] && has 'FINDING  container: redis is not running' && pass "Redis stopped: a finding" || fail "a stopped Redis passed: $out"
stack "${deferred_services[@]}"
out="$(env -i PATH="$work/bin:$PATH" HOME="$work" FAKE_DOCKER_STATE="$state" DOCS_ENV_FILE="$work/deploy.env" \
  DISK_MAX_PERCENT=0 MEMORY_MIN_PERCENT=0 "$ops/host-check.sh" 2>&1)"
[ $? -ne 0 ] && has 'FINDING  disk: / is' && pass "a full root disk: a finding" || fail "a full root disk passed: $out"

echo
echo "=== monitor.sh: the heartbeat, alerts and configuration checks stay active"
cat >"$work/receiver.py" <<'EOF'
import http.server, sys
log = sys.argv[2]
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8", "replace")
        with open(log, "a") as f:
            f.write(self.path + " " + body.replace("\n", " ") + "\n")
        self.send_response(200)
        self.end_headers()
    def log_message(self, *args):
        pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
EOF
port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
python3 "$work/receiver.py" "$port" "$work/received" &
receiver_pid=$!
for _ in $(seq 1 50); do
  curl -s -o /dev/null -X POST "http://127.0.0.1:$port/ready" && break
  sleep 0.1
done
: >"$work/received"
base="http://127.0.0.1:$port"
monitoring() {
  cat >"$work/monitoring.env"
  chmod 600 "$work/monitoring.env"
}
good_monitoring() {
  monitoring <<EOF
HEARTBEAT_URL=$base/ping
HEARTBEAT_FAIL_URL=$base/ping/fail
ALERT_CONTACT=test-operator
EOF
}
monitor() {
  env -i PATH="$work/bin:$PATH" HOME="$work" FAKE_DOCKER_STATE="$state" DOCS_ENV_FILE="$work/deploy.env" \
    DISK_MAX_PERCENT=100 MEMORY_MIN_PERCENT=0 MONITORING_ENV="$work/monitoring.env" \
    MONITOR_LOG="$work/log/host-check.log" MONITOR_ALLOW_INSECURE_URLS=1 "$ops/monitor.sh" 2>&1
}
received() { cat "$work/received"; }

deploy_env munaxa-docs-test 1 "$work/no-backup-volume"
stack "${deferred_services[@]}"
good_monitoring
out="$(monitor)"
code=$?
[ "$code" -eq 0 ] && [ "$(received)" = "/ping " ] && pass "deferred and healthy: exactly one heartbeat ping" ||
  fail "no heartbeat when deferred and healthy (exit $code): $out / $(received)"
: >"$work/received"
echo '503 redis=DOWN' >"$state/ready"
out="$(monitor)"
code=$?
if [ "$code" -ne 0 ] && ! grep -q '^/ping ' "$work/received" && grep '^/ping/fail ' "$work/received" | grep -q 'api: not ready' &&
  ! grep -q 'DEFERRED' "$work/received"; then
  pass "deferred with an unrelated failure: no heartbeat; the finding goes to the failure endpoint"
else
  fail "an unrelated failure was not alerted (exit $code): $(received)"
fi
echo '200 ' >"$state/ready"
: >"$work/received"
rm -f "$work/monitoring.env"
out="$(monitor)"
[ $? -eq 2 ] && [ -z "$(received)" ] && pass "deferred, no monitoring.env: refused (exit 2), nothing sent" ||
  fail "a missing monitoring.env was accepted: $out"
monitoring <<EOF
HEARTBEAT_URL=<required: the ping URL>
ALERT_CONTACT=test-operator
EOF
out="$(monitor)"
[ $? -eq 2 ] && [ -z "$(received)" ] && printf '%s' "$out" | grep -q placeholder &&
  pass "deferred, a placeholder in monitoring.env: refused, nothing sent" || fail "a placeholder was accepted: $out"
monitoring <<EOF
HEARTBEAT_URL=http://monitor.invalid/ping
ALERT_CONTACT=test-operator
EOF
out="$(monitor)"
[ $? -eq 2 ] && [ -z "$(received)" ] && pass "deferred, a plain-http heartbeat URL: refused, nothing sent" ||
  fail "a plain-http URL was accepted: $out"
good_monitoring
chmod 644 "$work/monitoring.env"
out="$(monitor)"
[ $? -eq 2 ] && [ -z "$(received)" ] && pass "deferred, a world-readable monitoring.env: refused, nothing sent" ||
  fail "a 0644 monitoring.env was accepted: $out"
monitoring <<EOF
HEARTBEAT_URL=$base/ping
EOF
out="$(monitor)"
[ $? -eq 2 ] && [ -z "$(received)" ] && printf '%s' "$out" | grep -q ALERT_CONTACT &&
  pass "deferred, no ALERT_CONTACT: refused, nothing sent" || fail "a missing ALERT_CONTACT was accepted: $out"

echo
if [ "$failures" -eq 0 ]; then
  echo "All host-check deferral checks passed"
else
  echo "$failures host-check deferral check(s) FAILED"
fi
exit "$failures"
