#!/usr/bin/env bash
# Runs the host check and delivers its result — docs/operations/monitoring.md §4.
#
# Started every 5 minutes by ops/systemd/munaxa-host-check.timer:
#
#   infra/hetzner/ops/monitor.sh
#
#   all well   → one ping to HEARTBEAT_URL (the dead-man's switch). Its ABSENCE is the alert: a dead
#                server, a stopped timer and a failing check all page the same way.
#   findings   → no success ping; the finding lines go to HEARTBEAT_FAIL_URL and ALERT_WEBHOOK_URL
#                when those are set, so the page says what is wrong without waiting for the grace
#                period.
#
# Configuration: MONITORING_ENV (default /etc/munaxa-docs/monitoring.env, mode 0600, from
# config/monitoring.env.example). The file is parsed, never executed. The URLs are credentials
# (whoever holds the heartbeat URL can silence the alert), so they are passed to curl on its
# standard input, never on a command line, and never printed or logged.
#
# What leaves the server: the host check's FINDING lines only — fixed sentences with counts, ages,
# percentages and service names (host-check.sh) — filtered again here to a small character set and
# length. No log line, file name, tenant name, address or setting is ever sent.
#
# Exit: the host check's own status when delivery worked; 3 when delivery failed; 2 when the
# configuration is unusable (and nothing is sent).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config="${MONITORING_ENV:-/etc/munaxa-docs/monitoring.env}"
host_check="${HOST_CHECK:-$here/host-check.sh}"
log_file="${MONITOR_LOG:-/var/log/munaxa-docs/host-check.log}"

say() { echo "monitor: $*"; }
refuse() {
  say "$*"
  exit 2
}

# --- configuration -------------------------------------------------------------------------------

[ -f "$config" ] || refuse "no monitoring configuration at $config (from config/monitoring.env.example)"
mode="$(stat -c %a "$config")"
case "$mode" in
  600 | 400) ;;
  *) refuse "$config is mode $mode; it holds credentials and must be 0600" ;;
esac
get() { sed -n "s/^$1=//p" "$config" | tail -n 1; }
heartbeat_url="$(get HEARTBEAT_URL)"
fail_url="$(get HEARTBEAT_FAIL_URL)"
webhook_url="$(get ALERT_WEBHOOK_URL)"
contact="$(get ALERT_CONTACT)"
label="$(get MONITOR_LABEL | tr -cd 'A-Za-z0-9._-' | cut -c1-40)"
label="${label:-munaxa-docs}"

[ -n "$heartbeat_url" ] || refuse "HEARTBEAT_URL is not set"
# Who is paged is a decision, not a default: it is recorded here and configured in the monitoring
# service. An unfilled placeholder means nobody would be told.
[ -n "$contact" ] || refuse "ALERT_CONTACT is not set (who receives the alerts)"
for pair in "HEARTBEAT_URL:$heartbeat_url" "HEARTBEAT_FAIL_URL:$fail_url" \
  "ALERT_WEBHOOK_URL:$webhook_url" "ALERT_CONTACT:$contact"; do
  case "${pair#*:}" in
    *'<'* | *'>'*) refuse "${pair%%:*} still holds a placeholder" ;;
  esac
done
for pair in "HEARTBEAT_URL:$heartbeat_url" "HEARTBEAT_FAIL_URL:$fail_url" "ALERT_WEBHOOK_URL:$webhook_url"; do
  url="${pair#*:}"
  [ -n "$url" ] || continue
  case "$url" in
    https://*) ;;
    http://127.0.0.1:* | http://localhost:*)
      [ "${MONITOR_ALLOW_INSECURE_URLS:-0}" = "1" ] || refuse "${pair%%:*} must be https://"
      ;;
    *) refuse "${pair%%:*} must be an https:// URL" ;;
  esac
  # A URL that would break out of curl's quoted config line is refused, not escaped.
  case "$url" in
    *'"'* | *'\'* | *' '*) refuse "${pair%%:*} holds characters a URL does not need" ;;
  esac
done

# --- the check -----------------------------------------------------------------------------------

mkdir -p "$(dirname "$log_file")" 2>/dev/null || true
output="$("$host_check" 2>&1)"
status=$?
{
  date -u '+%Y-%m-%dT%H:%M:%SZ'
  printf '%s\n' "$output"
} >"$log_file.new" 2>/dev/null && mv "$log_file.new" "$log_file" 2>/dev/null
printf '%s\n' "$output"

# The finding lines, reduced to a character set that cannot carry markup, quotes or escapes, each
# cut to 200 characters, at most 20 of them.
summary="$(printf '%s\n' "$output" | grep '^FINDING' | head -n 20 |
  sed 's/^FINDING  *//' | tr -cd 'A-Za-z0-9 .,:;%()/=+_\n-' | cut -c1-200)"

# POSTs stdin to URL. The URL goes to curl on stdin as configuration, so it is never an argument.
deliver() {
  local name="$1" url="$2" body="$3" type="$4"
  if printf 'url = "%s"\n' "$url" | curl --config - --silent --fail --max-time 15 --retry 3 \
    --retry-delay 2 --retry-all-errors --header "Content-Type: $type" --data-binary @"$body" \
    --output /dev/null 2>/dev/null; then
    say "delivered to $name"
    return 0
  fi
  say "delivery to $name FAILED"
  return 1
}

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
delivered=1
if [ "$status" -eq 0 ]; then
  : >"$body"
  deliver "the heartbeat" "$heartbeat_url" "$body" text/plain || delivered=0
else
  [ -n "$summary" ] || summary="the host check failed without a finding line (exit $status)"
  printf '%s: %s finding(s)\n%s\n' "$label" "$(printf '%s\n' "$summary" | grep -c .)" "$summary" >"$body"
  if [ -z "$fail_url" ] && [ -z "$webhook_url" ]; then
    say "findings: no success ping; the dead-man's switch alerts after its grace period"
  fi
  if [ -n "$fail_url" ]; then
    deliver "the heartbeat's failure endpoint" "$fail_url" "$body" text/plain || delivered=0
  fi
  if [ -n "$webhook_url" ]; then
    # {"text": "..."}: the shape most chat and alerting webhooks accept. The summary's character
    # set holds no quote or backslash, so only the line breaks need escaping.
    printf '{"text":"%s"}' "$(sed ':a;N;$!ba;s/\n/\\n/g' "$body")" >"$body.json"
    deliver "the alert webhook" "$webhook_url" "$body.json" application/json || delivered=0
    rm -f "$body.json"
  fi
fi

[ "$delivered" -eq 1 ] || exit 3
exit "$status"
