#!/usr/bin/env bash
# Tests the scanner's signature refresh and engine watch (scanner-watch.sh; R-10), against the
# real image with real ClamAV signatures, with no network at all — so every refresh fails, which is
# the case that matters.
#
#   CLAMAV_SEED_DIR=/path/to/signatures DOCS_ANTIVIRUS_IMAGE=munaxa-docs-antivirus:local \
#     infra/antivirus/test-scanner-watch.sh
#
# The API counts only an ICAP 204 as clean (icap-antivirus.adapter.ts). So "fails closed" here means:
# while the engine is stopped or dead, no scan is answered 204 — every upload is refused.
set -uo pipefail

image="${DOCS_ANTIVIRUS_IMAGE:?set DOCS_ANTIVIRUS_IMAGE}"
seed="${CLAMAV_SEED_DIR:?set CLAMAV_SEED_DIR to a directory of ClamAV signatures (main/daily/bytecode)}"
run_id="scanner-watch-$(openssl rand -hex 4)"
volume="$run_id-signatures"
container="$run_id"
failures=0

cleanup() {
  docker rm -f "$container" "$container-empty" "$container-late" >/dev/null 2>&1 || true
  docker volume rm "$volume" "$volume-empty" >/dev/null 2>&1 || true
}
trap cleanup EXIT

pass() { echo "PASS  $*"; }
fail() {
  echo "FAIL  $*"
  failures=$((failures + 1))
}

# The ICAP status the scanner answers for a file: 204 clean, anything else not clean.
scan_status() {
  docker exec "$1" sh -c "printf '%s' '$2' > /tmp/probe && c-icap-client -i 127.0.0.1 -p 1344 -s avscan \
    -f /tmp/probe -resp http://probe/ -v 2>&1 | sed -n 's#^[[:space:]]*ICAP/1.0 \([0-9]*\).*#\1#p' | head -n 1"
}
clean='an ordinary harmless file'
# The EICAR test string, assembled at run time so this file itself is not a test signature.
eicar="X5O!P%@AP[4\\PZX54(P^)7CC)7}\$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!\$H+H*"

wait_until() {
  local what="$1" seconds="$2"
  shift 2
  for _ in $(seq 1 "$seconds"); do
    if "$@"; then
      return 0
    fi
    sleep 1
  done
  echo "  (gave up waiting for: $what)"
  return 1
}
clean_is_204() { [ "$(scan_status "$1" "$clean")" = "204" ]; }
clean_not_204() { [ "$(scan_status "$1" "$clean")" != "204" ]; }
check_ok() { docker exec "$1" munaxa-scanner-watch check >/dev/null 2>&1; }
# A freshclam with no network spends about a minute on retries, and the watch logs only after it,
# so a log line is waited for rather than expected after a fixed sleep.
log_has() { docker logs "$1" 2>&1 | grep -q "$2"; }
check_fails() { ! docker exec "$1" munaxa-scanner-watch check >/dev/null 2>&1; }
# Writes the "last successful refresh" marker as if it happened HOURS ago.
refreshed_hours_ago() {
  docker exec "$1" sh -c "echo \$(( \$(date +%s) - $2 * 3600 )) > /var/lib/clamav/.munaxa-refreshed"
}

docker volume create "$volume" >/dev/null
docker run --rm --user 0 --network none -v "$volume:/var/lib/clamav" -v "$seed:/seed:ro" \
  --entrypoint sh "$image" -c 'cp /seed/*.c?d /var/lib/clamav/ && touch /var/lib/clamav/*.c?d && chown -R 101:102 /var/lib/clamav'

echo "=== a refresh that fails while signatures exist: scanning continues"
docker run -d --name "$container" --network none -v "$volume:/var/lib/clamav" \
  -e SCANNER_WATCH_INTERVAL_SECONDS=3 -e SIGNATURE_REFRESH_INTERVAL_SECONDS=5 \
  -e SIGNATURE_MAX_AGE_HOURS=72 -e SIGNATURE_REFUSE_AGE_HOURS=168 "$image" >/dev/null
if wait_until "the engine to load" 240 clean_is_204 "$container"; then
  pass "starts and scans with the signatures in the volume when freshclam cannot reach a mirror"
else
  fail "the scanner did not start scanning"
fi
infected="$(scan_status "$container" "$eicar")"
[ -n "$infected" ] && [ "$infected" != "204" ] && pass "EICAR is still detected (answered $infected)" ||
  fail "EICAR was answered '$infected'"
if wait_until "the periodic refresh to fail" 180 log_has "$container" "freshclam failed; scanning continues"; then
  pass "the periodic refresh failed, and said so, without stopping the engine"
else
  fail "no log line for the failed periodic refresh"
fi
check_ok "$container" && pass "health: fresh signatures pass the check" || fail "health failed on fresh signatures"

echo
echo "=== stale signatures: reported, still scanning"
refreshed_hours_ago "$container" 80
if check_fails "$container"; then
  pass "health: signatures 80 h old fail the check (limit 72 h)"
else
  fail "health passed with 80 h old signatures"
fi
clean_is_204 "$container" && pass "stale but under the refusal limit: scanning continues" ||
  fail "scanning stopped below the refusal limit"
wait_until "the watch to log the staleness" 180 log_has "$container" "signatures are stale" &&
  pass "the staleness is logged" || fail "the staleness is not logged"

echo
echo "=== past the refusal limit: the engine stops and every scan is refused (fail closed)"
refreshed_hours_ago "$container" 200
if wait_until "the watch to stop the engine" 180 clean_not_204 "$container"; then
  pass "a clean file is no longer answered 204: the API refuses the upload"
else
  fail "the scanner still answered 204 with signatures 200 h old"
fi
infected="$(scan_status "$container" "$eicar")"
[ "$infected" != "204" ] && pass "and nothing else is answered 204 either (EICAR: $infected)" ||
  fail "EICAR was answered 204 while refusing"
check_fails "$container" && pass "health: the refusal fails the check" || fail "health passed while refusing"

echo
echo "=== a refresh succeeds again: the engine comes back by itself"
refreshed_hours_ago "$container" 0
if wait_until "the engine to reload" 240 clean_is_204 "$container"; then
  pass "scanning resumes once the signatures are current"
else
  fail "scanning did not resume"
fi
check_ok "$container" && pass "health: passes again" || fail "health still failing after recovery"

echo
echo "=== the engine dies: it is restarted, and nothing is passed meanwhile"
docker exec "$container" pkill -x clamd
sleep 1
clean_not_204 "$container" && pass "while the engine is down, a clean file is not answered 204" ||
  fail "a scan was answered 204 with the engine dead"
if wait_until "the watch to restart the engine" 240 clean_is_204 "$container"; then
  pass "the watch restarted the engine"
else
  fail "the engine was not restarted"
fi
if wait_until "the restart to be logged" 60 log_has "$container" "the engine was not running: starting it"; then
  pass "the restart is logged"
else
  fail "the restart is not logged"
  # What the watch did say, so a failure on a CI runner can be diagnosed from its log alone.
  docker logs "$container" 2>&1 | grep 'munaxa-scanner-watch' | tail -n 10 | sed 's/^/  /'
fi
docker rm -f "$container" >/dev/null

echo
echo "=== a start with signatures already past the refusal limit: the engine is not started"
docker run --rm --user 0 --network none -v "$volume:/var/lib/clamav" --entrypoint sh "$image" -c \
  'echo $(( $(date +%s) - 200 * 3600 )) > /var/lib/clamav/.munaxa-refreshed'
docker run -d --name "$container-late" --network none -v "$volume:/var/lib/clamav" \
  -e SCANNER_WATCH_INTERVAL_SECONDS=3 "$image" >/dev/null
wait_until "the start-up decision" 180 log_has "$container-late" "not starting the engine" &&
  pass "the refusal at start is logged" || fail "the refusal at start is not logged"
clean_not_204 "$container-late" && pass "nothing is answered 204 (the ICAP server is not even started)" ||
  fail "a scan was answered 204"
[ "$(scan_status "$container-late" "$eicar")" != "204" ] && pass "EICAR is not answered 204 either" ||
  fail "EICAR was answered 204"
docker rm -f "$container-late" >/dev/null

echo
echo "=== the fail-open guard"
# The hazard itself, shown rather than asserted from memory: c-icap started with no engine reachable
# answers 204 for EICAR. The entrypoint never does this; the guard is for when it happens anyway.
docker run --rm --user 0 --network none -v "$volume:/var/lib/clamav" --entrypoint sh "$image" -c \
  'date +%s > /var/lib/clamav/.munaxa-refreshed'
docker run -d --name "$container-late" --network none -v "$volume:/var/lib/clamav" \
  --entrypoint c-icap "$image" -N -f /etc/munaxa-antivirus/c-icap.conf >/dev/null
sleep 5
[ "$(scan_status "$container-late" "$eicar")" = "204" ] &&
  pass "the hazard is real: c-icap without an engine answers 204 for EICAR" ||
  fail "c-icap without an engine did not answer 204 (the guard's premise has changed; re-check it)"
docker rm -f "$container-late" >/dev/null
# The same c-icap with the watch running beside it: the guard stops it, so nothing is answered.
docker run -d --name "$container-late" --network none -v "$volume:/var/lib/clamav" \
  -e SCANNER_WATCH_INTERVAL_SECONDS=3 --entrypoint sh "$image" \
  -c 'munaxa-scanner-watch run & exec c-icap -N -f /etc/munaxa-antivirus/c-icap.conf' >/dev/null
exited() { [ "$(docker inspect --format '{{.State.Running}}' "$1")" = "false" ]; }
if wait_until "the guard to stop the ICAP server" 60 exited "$container-late"; then
  pass "the guard stopped the ICAP server that answered 204 for EICAR (the container exits; its restart policy starts it properly)"
else
  fail "the guard did not stop a fail-open ICAP server"
fi
log_has "$container-late" "FAIL-OPEN DETECTED" && pass "the guard says why" || fail "the guard did not log"

echo
echo "=== no signatures and no mirror: the scanner refuses to start"
docker volume create "$volume-empty" >/dev/null
code=0
timeout 120 docker run --name "$container-empty" --network none -v "$volume-empty:/var/lib/clamav" "$image" \
  >/tmp/"$run_id".log 2>&1 || code=$?
if [ "$code" -ne 0 ] && grep -q "refusing to start a scanner that detects nothing" /tmp/"$run_id".log; then
  pass "exits $code rather than start a scanner that detects nothing"
else
  fail "exit $code: $(tail -n 2 /tmp/"$run_id".log)"
fi
rm -f /tmp/"$run_id".log

echo
if [ "$failures" -eq 0 ]; then
  echo "All scanner watch checks passed"
else
  echo "$failures scanner watch check(s) FAILED"
fi
exit "$failures"
