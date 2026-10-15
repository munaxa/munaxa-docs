#!/usr/bin/env bash
# Tests alert delivery (ops/monitor.sh; monitoring.md §4) against a local HTTP receiver that records
# what it is sent. The host check is replaced by stand-ins that pass, fail, or print hostile text,
# so what is tested is delivery, its refusals and what may leave the server.
#
#   infra/hetzner/testing/monitoring/test-monitor.sh
#
# Needs python3 and curl. Nothing leaves this machine.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
monitor="$(cd "$here/../../ops" && pwd)/monitor.sh"
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
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 — expected '$3', got '$2'"; fi; }

# --- a receiver: one line per request, "<path> <body as JSON string>" -----------------------------
cat >"$work/receiver.py" <<'EOF'
import http.server, json, sys
log = sys.argv[2]
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8", "replace")
        with open(log, "a") as f:
            f.write(json.dumps({"path": self.path, "type": self.headers.get("Content-Type"), "body": body}) + "\n")
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
received() { wc -l <"$work/received" | tr -d ' '; }

# The token in each URL stands for the secret part of a real one; it must never be printed.
token="tok$(openssl rand -hex 12)"
base="http://127.0.0.1:$port"
write_config() {
  cat >"$work/monitoring.env"
  chmod 600 "$work/monitoring.env"
}
good_config() {
  write_config <<EOF
HEARTBEAT_URL=$base/ping/$token
HEARTBEAT_FAIL_URL=$base/ping/$token/fail
ALERT_WEBHOOK_URL=$base/hook/$token
ALERT_CONTACT=test-operator
MONITOR_LABEL=test-env
EOF
}

# Stand-in host checks.
cat >"$work/check-pass" <<'EOF'
#!/bin/sh
echo "ok       disk: / 40% used"
echo "host check: all well"
EOF
cat >"$work/check-fail" <<'EOF'
#!/bin/sh
echo "ok       disk: / 40% used"
echo "FINDING  disk: / is 97% full (limit 85%)"
echo "FINDING  offsite: the last copy run did not succeed"
echo "host check: 2 finding(s)"
exit 2
EOF
# Text a broken or compromised check might print: quotes, a JSON breakout, shell and markup.
cat >"$work/check-hostile" <<'EOF'
#!/bin/sh
echo 'FINDING  api: not ready ("},{"evil":"x") $(rm -rf /) <script>alert(1)</script> \u0000 `id`'
exit 1
EOF
chmod +x "$work"/check-*

run() {
  MONITORING_ENV="$work/monitoring.env" MONITOR_LOG="$work/log/host-check.log" \
    MONITOR_ALLOW_INSECURE_URLS=1 HOST_CHECK="$work/$1" "$monitor" 2>&1
}

echo "=== configuration refusals: nothing is sent"
rm -f "$work/monitoring.env"
out="$(run check-pass)"
check "no configuration file: exit 2" "$?" 2
write_config <<EOF
HEARTBEAT_URL=<required: the ping URL>
ALERT_CONTACT=<required: who>
EOF
out="$(run check-pass)"
[ $? -eq 2 ] && printf '%s' "$out" | grep -q placeholder && pass "placeholders are refused" || fail "placeholders accepted: $out"
write_config <<EOF
HEARTBEAT_URL=$base/ping/$token
EOF
out="$(run check-pass)"
[ $? -eq 2 ] && printf '%s' "$out" | grep -q ALERT_CONTACT && pass "a missing ALERT_CONTACT is refused (nobody would be told)" || fail "no contact accepted: $out"
good_config
chmod 644 "$work/monitoring.env"
out="$(run check-pass)"
[ $? -eq 2 ] && printf '%s' "$out" | grep -q 'must be 0600' && pass "a world-readable configuration is refused" || fail "mode 644 accepted: $out"
write_config <<EOF
HEARTBEAT_URL=http://monitor.example/ping/$token
ALERT_CONTACT=test-operator
EOF
out="$(run check-pass)"
[ $? -eq 2 ] && printf '%s' "$out" | grep -q 'https' && pass "a plain-http URL is refused" || fail "http accepted: $out"
check "nothing was sent while refusing" "$(received)" 0

echo
echo "=== all well: one heartbeat ping, nothing else"
good_config
out="$(run check-pass)"
check "exit 0" "$?" 0
check "one request" "$(received)" 1
check "to the heartbeat URL" "$(python3 -c 'import json,sys; print(json.loads(open(sys.argv[1]).readline())["path"])' "$work/received")" "/ping/$token"
grep -q 'all well' "$work/log/host-check.log" && pass "the check's output is in the local log" || fail "no local log"
run check-pass >/dev/null
check "a second run sends one more ping (safe to repeat)" "$(received)" 2

echo
echo "=== findings: no success ping; the failure endpoint and the webhook get the findings"
: >"$work/received"
out="$(run check-fail)"
check "exit is the check's own (2)" "$?" 2
paths="$(python3 -c 'import json,sys; print(" ".join(json.loads(l)["path"] for l in open(sys.argv[1])))' "$work/received")"
check "sent to the failure endpoint and the webhook, not the heartbeat" "$paths" "/ping/$token/fail /hook/$token"
python3 - "$work/received" <<'EOF' && pass "the webhook body is valid JSON naming both findings, and nothing else" || fail "webhook body wrong"
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1])]
hook = [l for l in lines if l["path"].startswith("/hook/")][0]
assert hook["type"] == "application/json"
text = json.loads(hook["body"])["text"]
assert "disk: / is 97% full (limit 85%)" in text, text
assert "offsite: the last copy run did not succeed" in text, text
assert "40% used" not in text, text   # ok lines are not sent
assert text.startswith("test-env: 2 finding(s)"), text
EOF

echo
echo "=== hostile text from the check cannot break out of the message"
: >"$work/received"
run check-hostile >/dev/null
python3 - "$work/received" <<'EOF' && pass "quotes, backslashes, markup and shell syntax are stripped; the JSON is intact" || fail "hostile text reached the receiver"
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1])]
hook = [l for l in lines if l["path"].startswith("/hook/")][0]
payload = json.loads(hook["body"])
assert list(payload) == ["text"], payload
text = payload["text"]
for bad in ['"', "\\", "<", ">", "`", "$", "{", "}"]:
    assert bad not in text, (bad, text)
EOF

echo
echo "=== delivery failure: reported, and the exit says so"
kill "$receiver_pid"
wait "$receiver_pid" 2>/dev/null
receiver_pid=""
out="$(run check-pass)"
check "exit 3 when the heartbeat cannot be reached" "$?" 3
printf '%s' "$out" | grep -q 'delivery to the heartbeat FAILED' && pass "and says so" || fail "no failure message: $out"
out2="$(run check-fail)"
check "exit 3 when no alert could be delivered" "$?" 3

echo
echo "=== no URL token in anything printed or logged"
leak=0
printf '%s%s' "$out" "$out2" | grep -qF "$token" && leak=1
grep -qF "$token" "$work/log/host-check.log" && leak=1
check "the URL tokens appear nowhere" "$leak" 0

echo
if [ "$failures" -eq 0 ]; then
  echo "All alert delivery checks passed"
else
  echo "$failures alert delivery check(s) FAILED"
fi
exit "$failures"
