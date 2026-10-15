#!/bin/sh
# Keeps the scanner's signatures current and its engine running — R-10 of the Hetzner readiness
# report. Started in the background by the entrypoint; `check` is part of the health check.
#
#   munaxa-scanner-watch start   start the engine, unless the signatures are past the refusal limit
#   munaxa-scanner-watch run     the loop (entrypoint)
#   munaxa-scanner-watch check   exit 0 only when signatures are fresh and the engine is meant to run
#
# What it does, every SCANNER_WATCH_INTERVAL_SECONDS (default 300):
#   - every SIGNATURE_REFRESH_INTERVAL_SECONDS (default 3600) runs freshclam. A success is recorded
#     in the signatures volume (.munaxa-refreshed), whether or not anything changed; clamd's
#     SelfCheck (clamd.conf) loads changed databases itself. A failure is logged and changes nothing:
#     scanning continues with the signatures already loaded. It never fails open — nothing here can
#     make the scanner pass a file it has not scanned.
#   - signatures older than SIGNATURE_MAX_AGE_HOURS (default 72) since the last successful refresh
#     make `check` fail, so the container reports unhealthy and monitoring alerts (monitoring.md).
#   - past SIGNATURE_REFUSE_AGE_HOURS (default 168; 0 turns it off) the engine is STOPPED: c-icap
#     then answers every scan with an error, and the API refuses the upload (fail closed) rather
#     than accept a verdict from signatures a week out of date. It starts again by itself once a
#     refresh succeeds.
#   - an engine that died for any other reason is restarted, and the restart is logged.
#   - **the fail-open guard.** c-icap's virus_scan answers "204, unmodified" for EVERY file — EICAR
#     included — when its engine module could not register because clamd was not answering when
#     c-icap started ("Antivirus engine is not available, allow 204"; found by
#     test-scanner-watch.sh). So c-icap is never started before clamd answers PING (`start`), and
#     every tick scans the EICAR test string through c-icap: a 204 means the scanner is passing
#     files it did not scan, and the watch stops the ICAP server (PID 1) so the container exits and
#     restarts. A stopped scanner refuses uploads; a fail-open one would accept anything.
set -eu

conf=/etc/munaxa-antivirus/clamd.conf
db=/var/lib/clamav
marker="$db/.munaxa-refreshed"
refusing=/var/run/clamav/munaxa-refusing
interval="${SCANNER_WATCH_INTERVAL_SECONDS:-300}"
refresh_every="${SIGNATURE_REFRESH_INTERVAL_SECONDS:-3600}"
max_age_hours="${SIGNATURE_MAX_AGE_HOURS:-72}"
refuse_age_hours="${SIGNATURE_REFUSE_AGE_HOURS:-168}"

log() { echo "munaxa-scanner-watch: $*" >&2; }

for setting in "SCANNER_WATCH_INTERVAL_SECONDS:$interval" \
  "SIGNATURE_REFRESH_INTERVAL_SECONDS:$refresh_every" \
  "SIGNATURE_MAX_AGE_HOURS:$max_age_hours" "SIGNATURE_REFUSE_AGE_HOURS:$refuse_age_hours"; do
  case "${setting#*:}" in
    '' | *[!0-9]*)
      log "${setting%%:*} must be a whole number"
      exit 2
      ;;
  esac
done

now() { date +%s; }

# When the signatures were last known current: the last successful refresh, or — before the first
# one — the newest database file.
refreshed_at() {
  if [ -s "$marker" ]; then
    cat "$marker"
    return
  fi
  newest=0
  for file in "$db"/*.cvd "$db"/*.cld; do
    [ -s "$file" ] || continue
    modified="$(stat -c %Y "$file")"
    [ "$modified" -gt "$newest" ] && newest="$modified"
  done
  echo "$newest"
}

age_hours() { echo $((($(now) - $(refreshed_at)) / 3600)); }

# By process, not by pid file: clamd writes its pid file only once its databases have loaded, which
# takes a minute, and an engine that is loading is running.
engine_running() { pgrep -x clamd >/dev/null 2>&1; }

start_engine() {
  rm -f /var/run/clamav/clamd.pid
  clamd -c "$conf"
}

stop_engine() { pkill -x clamd 2>/dev/null || true; }

# clamd's own answer on its TCP socket (clamd.conf), not the process: loading takes a minute.
engine_answers() {
  perl -MIO::Socket::INET -e '
    my $s = IO::Socket::INET->new(PeerAddr => "127.0.0.1", PeerPort => 3310, Timeout => 3) or exit 1;
    print $s "zPING\0"; my $r = ""; $s->recv($r, 16); exit($r =~ /^PONG/ ? 0 : 1);' 2>/dev/null
}

# What c-icap answers for the EICAR test string: the ICAP status line's code, or nothing. Assembled
# at run time so that neither this file nor the image is itself a test signature.
eicar_status() {
  probe="$(mktemp)"
  printf '%s%s%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$' 'EICAR-STANDARD-ANTIVIRUS-' 'TEST-FILE!$H+H*' >"$probe"
  timeout 30 c-icap-client -i 127.0.0.1 -p 1344 -s avscan -f "$probe" -resp http://probe/ -v 2>&1 |
    sed -n 's#^[[:space:]]*ICAP/1.0 \([0-9]*\).*#\1#p' | head -n 1
  rm -f "$probe"
}

# The guard: EICAR answered 204 is a scanner passing what it did not scan.
guard_fail_open() {
  if [ "$(eicar_status)" = "204" ]; then
    log "FAIL-OPEN DETECTED: the EICAR test string was answered 204; stopping the ICAP server so the scanner refuses instead"
    kill 1
    exit 1
  fi
}

refresh() {
  if freshclam --stdout --quiet; then
    now >"$marker.new" && mv "$marker.new" "$marker"
    log "signatures refreshed"
  else
    log "freshclam failed; scanning continues with the loaded signatures ($(age_hours) h since the last successful refresh)"
  fi
}

check() {
  if [ "$(eicar_status)" = "204" ]; then
    echo "FAIL-OPEN: the EICAR test string was answered 204" >&2
    exit 1
  fi
  if [ -e "$refusing" ]; then
    echo "scanner refusing: signatures are $(age_hours) h old (limit ${refuse_age_hours} h)" >&2
    exit 1
  fi
  if [ "$(age_hours)" -ge "$max_age_hours" ]; then
    echo "signatures are stale: $(age_hours) h since the last successful refresh (limit ${max_age_hours} h)" >&2
    exit 1
  fi
}

run() {
  # The entrypoint has just refreshed (or tried to) and started the engine.
  last_refresh_attempt="$(now)"
  while true; do
    sleep "$interval"
    guard_fail_open
    if [ $(($(now) - last_refresh_attempt)) -ge "$refresh_every" ]; then
      refresh
      last_refresh_attempt="$(now)"
    fi
    age="$(age_hours)"
    if [ "$refuse_age_hours" -gt 0 ] && [ "$age" -ge "$refuse_age_hours" ]; then
      if [ ! -e "$refusing" ]; then
        log "signatures are ${age} h old (limit ${refuse_age_hours} h): stopping the engine; scans are refused until a refresh succeeds"
        touch "$refusing"
      fi
      stop_engine
      continue
    fi
    if [ -e "$refusing" ]; then
      log "signatures are current again (${age} h): starting the engine"
      rm -f "$refusing"
    fi
    if [ "$age" -ge "$max_age_hours" ]; then
      log "signatures are stale: ${age} h since the last successful refresh (limit ${max_age_hours} h)"
    fi
    if ! engine_running; then
      log "the engine was not running: starting it"
      start_engine || log "the engine did not start; scans are refused until it does"
    fi
  done
}

# The entrypoint's start, BEFORE c-icap: the engine, answering. If the signatures are already past
# the refusal limit, it waits here — refreshing on schedule — with nothing listening on the ICAP
# port, so every upload is refused (connection refused) rather than passed. c-icap is started by the
# entrypoint only after this returns, because a c-icap started without a reachable engine passes
# everything (header).
start() {
  last_refresh_attempt="$(now)"
  while [ "$refuse_age_hours" -gt 0 ] && [ "$(age_hours)" -ge "$refuse_age_hours" ]; do
    if [ ! -e "$refusing" ]; then
      log "signatures are $(age_hours) h old (limit ${refuse_age_hours} h): not starting the engine; scans are refused until a refresh succeeds"
      touch "$refusing"
    fi
    sleep "$interval"
    if [ $(($(now) - last_refresh_attempt)) -ge "$refresh_every" ]; then
      refresh
      last_refresh_attempt="$(now)"
    fi
  done
  rm -f "$refusing"
  engine_running || start_engine
  for _ in $(seq 1 300); do
    engine_answers && return 0
    sleep 1
  done
  log "the engine did not answer within 300 s; not starting the ICAP server"
  exit 1
}

case "${1:-}" in
  run) run ;;
  start) start ;;
  check) check ;;
  record-refresh)
    # Called by the entrypoint after its own successful freshclam.
    now >"$marker.new" && mv "$marker.new" "$marker"
    ;;
  *)
    echo "usage: munaxa-scanner-watch start|run|check|record-refresh" >&2
    exit 2
    ;;
esac
