#!/usr/bin/env bash
# The host's own check — docs/operations/monitoring.md §3 (R-6 of the readiness report).
#
# Run on the server every 5 minutes by ops/monitor.sh (systemd: ops/systemd/munaxa-host-check.*),
# from the release checkout:
#
#   infra/hetzner/ops/host-check.sh            prints one line per check; exit 0 = all well
#
# Its exit status decides whether monitor.sh pings the dead-man's switch (monitoring.md §4): a
# missed ping is the alert, so a server that is down, a timer that stopped and a check that failed
# all page the same way. It reads; it changes nothing, so running it again is always safe.
#
# Output carries no secrets, host names, tenant names, bucket names, file names of documents or
# connection strings: counts, percentages, ages and container service names only. Every line is
# one of the fixed sentences below; nothing read from a log or a response is echoed.
#
# Environment (all optional):
#   DOCS_ENV_FILE           the deploy.env to use (default: deploy.env at the checkout's root)
#   DISK_MAX_PERCENT        a filesystem above this is a finding (default 85)
#   MEMORY_MIN_PERCENT      available memory below this is a finding (default 10)
#   BACKUP_MAX_AGE_HOURS    the last successful backup older than this is a finding (default 26)
#   OFFSITE_MAX_AGE_HOURS   the last verified off-server copy older than this (default 2; the copy
#                           timer runs every 15 minutes)
#   SIGNATURE_MAX_AGE_HOURS the scanner's last successful signature refresh older than this (72)
#   TLS_MIN_DAYS            the served certificate expiring sooner than this (default 14)
#   LOG_WINDOW              how far back the log-derived checks look (default 10m)
#   EXPECTED_SERVICES       the services that must be running
#                           (default: proxy web api antivirus postgres redis db-backup)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$(cd "$here/.." && pwd)"
# deploy.env sits at the root of the release checkout (README.md §4).
env_file="${DOCS_ENV_FILE:-$(cd "$template/../.." && pwd)/deploy.env}"
disk_max="${DISK_MAX_PERCENT:-85}"
memory_min="${MEMORY_MIN_PERCENT:-10}"
backup_max_age="${BACKUP_MAX_AGE_HOURS:-26}"
offsite_max_age="${OFFSITE_MAX_AGE_HOURS:-2}"
signature_max_age="${SIGNATURE_MAX_AGE_HOURS:-72}"
tls_min_days="${TLS_MIN_DAYS:-14}"
log_window="${LOG_WINDOW:-10m}"
expected="${EXPECTED_SERVICES:-proxy web api antivirus postgres redis db-backup}"
findings=0

finding() {
  echo "FINDING  $*"
  findings=$((findings + 1))
}
ok() { echo "ok       $*"; }
now() { date +%s; }

# A value from deploy.env (the environment wins), read without executing the file.
setting() {
  local name="$1" value
  value="$(printenv "$name" || true)"
  if [ -z "$value" ] && [ -f "$env_file" ]; then
    value="$(sed -n "s/^$name=//p" "$env_file" | tail -n 1)"
  fi
  printf '%s' "$value"
}

if [ -n "${COMPOSE_FILES:-}" ]; then
  # shellcheck disable=SC2206 # a list of -f arguments, split on purpose (the stack test passes two)
  files=($COMPOSE_FILES)
else
  files=(-f "$template/compose.yaml")
fi
compose() {
  if [ -f "$env_file" ]; then
    docker compose --env-file "$env_file" "${files[@]}" "$@"
  else
    # The values are already in the environment (the stack test exports them).
    docker compose "${files[@]}" "$@"
  fi
}

# 1. Disks: the root filesystem (Docker's volumes live there) and the backup volume.
backup_dir="$(setting DOCS_BACKUP_DIR)"
for path in / ${backup_dir:+"$backup_dir"}; do
  used="$(df -P "$path" 2>/dev/null | awk 'NR == 2 { sub("%", "", $5); print $5 }')"
  if [ -z "$used" ]; then
    finding "disk: $path cannot be read"
  elif [ "$used" -gt "$disk_max" ]; then
    finding "disk: $path is ${used}% full (limit ${disk_max}%)"
  else
    ok "disk: $path ${used}% used"
  fi
done

# 2. Memory: what the kernel still has available.
available="$(awk '/MemTotal/ { total = $2 } /MemAvailable/ { free = $2 } END { if (total) printf "%d", free * 100 / total }' /proc/meminfo)"
if [ "${available:-0}" -lt "$memory_min" ]; then
  finding "memory: ${available:-unknown}% available (limit ${memory_min}%)"
else
  ok "memory: ${available}% available"
fi

# 3. Containers: Docker answers, every expected service runs, nothing was killed for memory, and
#    every health check passes (scanner: a real scan and fresh signatures; db-backup: a recent
#    successful run; the rest: their own probes).
if ! ids="$(compose ps -q 2>/dev/null)"; then
  finding "containers: Docker or Compose does not answer"
  ids=""
fi
running=" "
for id in $ids; do
  name="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$id" 2>/dev/null)"
  [ -n "$name" ] || continue
  if [ "$(docker inspect --format '{{.State.OOMKilled}}' "$id")" = "true" ]; then
    finding "memory: $name was killed for memory"
  fi
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")"
  state="$(docker inspect --format '{{.State.Status}}' "$id")"
  if [ "$state" != "running" ]; then
    finding "container: $name is $state"
  elif [ "$health" = "unhealthy" ]; then
    finding "container: $name is unhealthy"
    running="$running$name "
  else
    ok "container: $name $state${health:+ ($health)}"
    running="$running$name "
  fi
done
for service in $expected; do
  case "$running" in
    *" $service "*) ;;
    *) finding "container: $service is not running" ;;
  esac
done

# 4. The database answers on its own socket (the API's view of every tenant database is in 7).
if compose exec -T postgres pg_isready -q >/dev/null 2>&1; then
  ok "database: PostgreSQL accepts connections"
else
  finding "database: PostgreSQL does not accept connections"
fi

# 5. Backups: the last successful run, and WAL archiving.
if [ -n "$backup_dir" ]; then
  status="$(compose exec -T db-backup cat /backup/status/backup.prom 2>/dev/null)"
  last="$(printf '%s\n' "$status" | sed -n 's/^munaxa_backup_last_success_timestamp_seconds //p')"
  if [ -z "$last" ] || [ "$last" -eq 0 ]; then
    finding "backup: no successful backup recorded"
  else
    age=$((($(now) - last) / 3600))
    if [ "$age" -ge "$backup_max_age" ]; then
      finding "backup: the last successful backup is ${age} h old (limit ${backup_max_age} h)"
    else
      ok "backup: last success ${age} h ago"
    fi
  fi
  [ "$(printf '%s\n' "$status" | sed -n 's/^munaxa_backup_last_run_success //p')" = "1" ] ||
    finding "backup: the last run did not succeed"
  # shellcheck disable=SC2016 # expanded inside the container, from postgres.env
  archiver="$(compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -tA -F " " -c "SELECT failed_count, coalesce(last_failed_time > last_archived_time, false) FROM pg_stat_archiver"' 2>/dev/null)"
  if [ -z "$archiver" ]; then
    finding "backup: WAL archiving status cannot be read (is PostgreSQL up?)"
  elif [ "${archiver##* }" = "t" ]; then
    finding "backup: WAL archiving is failing (last failure after last success; ${archiver%% *} failures in total)"
  else
    ok "backup: WAL archiving working (${archiver%% *} failures since the counters were reset)"
  fi
fi

# 6. The off-server copy (README.md §7; monitoring M16), from the copy job's own status file on
#    the host. Configured by DOCS_OFFSITE_STATE_DIR; a deployment without it gets a finding,
#    because a backup that exists only on this server is lost with it.
offsite_dir="$(setting DOCS_OFFSITE_STATE_DIR)"
offsite_dir="${offsite_dir:-/var/lib/munaxa-docs/offsite}"
if [ -n "$backup_dir" ]; then
  prom="$offsite_dir/offsite.prom"
  if [ ! -r "$prom" ]; then
    finding "offsite: no status from the off-server copy (has it ever run?)"
  else
    value() { sed -n "s/^munaxa_offsite_$1 //p" "$prom"; }
    last="$(value last_success_timestamp_seconds)"
    if [ -z "$last" ] || [ "$last" -eq 0 ]; then
      finding "offsite: no verified off-server copy recorded"
    else
      age=$((($(now) - last) / 3600))
      if [ "$age" -ge "$offsite_max_age" ]; then
        finding "offsite: the last verified copy is ${age} h old (limit ${offsite_max_age} h)"
      else
        ok "offsite: last verified copy ${age} h ago"
      fi
    fi
    [ "$(value last_run_success)" = "1" ] || finding "offsite: the last copy run did not succeed"
    base="$(value newest_base_created_timestamp_seconds)"
    if [ -z "$base" ] || [ "$base" -eq 0 ]; then
      finding "offsite: no complete base backup on the remote"
    else
      ok "offsite: newest complete base backup on the remote is $((($(now) - base) / 3600)) h old"
    fi
  fi
fi

# 7. Readiness, from inside the server only: every tenant database (by position), Redis, scanner.
ready="$(compose exec -T api node -e "fetch('http://127.0.0.1:3001/api/health/ready').then(async r => { const b = await r.json(); console.log(r.status, (b.dependencies || []).filter(d => d.status !== 'UP').map(d => d.name + '=' + d.status).join(',')); }).catch(() => console.log('unreachable'))" 2>/dev/null)"
case "$ready" in
  '200 ') ok "api: ready, every dependency up" ;;
  200*) ok "api: ready, degraded: ${ready#200 }" ;;
  *) finding "api: not ready (${ready:-no answer})" ;;
esac

# 8. Object storage (monitoring M10): a read-only listing of a prefix nothing uses, through the
#    API's own adapter and configuration. Only the error's class name can come back.
# shellcheck disable=SC2016 # JavaScript, read by node inside the container
storage="$(compose exec -T api node -e '
  const { S3StorageAdapter } = require("/app/apps/api/dist/infrastructure/storage/s3.adapter.js");
  const e = process.env;
  const storage = new S3StorageAdapter({
    driver: e.STORAGE_DRIVER, bucket: e.STORAGE_BUCKET, region: e.STORAGE_REGION,
    endpoint: e.STORAGE_ENDPOINT, forcePathStyle: e.STORAGE_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId: e.STORAGE_ACCESS_KEY_ID, secretAccessKey: e.STORAGE_SECRET_ACCESS_KEY },
    now: () => new Date(),
  });
  const timer = setTimeout(() => { console.log("timeout"); process.exit(0); }, 15000);
  storage.list("munaxa-host-check-probe/").then(
    () => { clearTimeout(timer); console.log("ok"); },
    (error) => { clearTimeout(timer); console.log(String(error && error.name || "error").replace(/[^A-Za-z]/g, "")); },
  );' 2>/dev/null | tail -n 1)"
case "$storage" in
  ok) ok "storage: the object store answers a listing" ;;
  *) finding "storage: the object store does not answer (${storage:-no answer})" ;;
esac

# 9. Signals only the logs carry, counted over the last LOG_WINDOW (monitoring M10, M12, M14).
#    The count is reported, never the line: a log line may name a file or a tenant.
count_log() {
  compose logs --no-color --since "$log_window" "$1" 2>/dev/null | grep -cF "$2" || true
}
for signal in \
  "api|A download did not verify|storage: a download failed its integrity check and was quarantined" \
  "api|The audit chain failed verification|audit: the audit chain failed verification" \
  "antivirus|scans are refused|scanner: the scanner is refusing scans (signatures too old or engine down)" \
  "antivirus|FAIL-OPEN DETECTED|scanner: the fail-open guard stopped the ICAP server"; do
  service="${signal%%|*}" rest="${signal#*|}"
  text="${rest%%|*}" sentence="${rest#*|}"
  count="$(count_log "$service" "$text")"
  if [ "${count:-0}" -gt 0 ]; then
    finding "$sentence ($count time(s) in the last $log_window)"
  fi
done
ok "logs: checked the last $log_window for integrity, audit-chain and scanner events"

# 10. Scanner signatures (monitoring M11): when they were last known current, by the scanner
#     watch's own rule — the last successful refresh, or before the first one the newest signature
#     file. The container's health check enforces the same limit; this says how old they are.
# shellcheck disable=SC2016 # expanded inside the scanner container
refreshed="$(compose exec -T antivirus sh -c '
  if [ -s /var/lib/clamav/.munaxa-refreshed ]; then cat /var/lib/clamav/.munaxa-refreshed
  else for f in /var/lib/clamav/*.cvd /var/lib/clamav/*.cld; do [ -s "$f" ] && stat -c %Y "$f"; done | sort -n | tail -n 1
  fi' 2>/dev/null | tr -cd '0-9')"
if [ -z "$refreshed" ]; then
  finding "scanner: no signatures, or the scanner cannot be read"
else
  age=$((($(now) - refreshed) / 3600))
  if [ "$age" -ge "$signature_max_age" ]; then
    finding "scanner: signatures last known current ${age} h ago (limit ${signature_max_age} h)"
  else
    ok "scanner: signatures current as of ${age} h ago"
  fi
fi

# 11. TLS (monitoring M15): only when this host terminates TLS itself (compose.tls.yaml). The
#     certificate served on 127.0.0.1:443 for the public name, so no DNS is involved.
public_host="$(setting DOCS_PUBLIC_HOSTNAME)"
if [ -n "$public_host" ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    finding "tls: openssl is not installed, so the certificate cannot be checked"
  else
    end="$(echo | timeout 15 openssl s_client -connect 127.0.0.1:443 -servername "$public_host" 2>/dev/null |
      openssl x509 -noout -enddate 2>/dev/null | sed -n 's/^notAfter=//p')"
    if [ -z "$end" ]; then
      finding "tls: no certificate is served on port 443"
    else
      days=$((($(date -d "$end" +%s) - $(now)) / 86400))
      if [ "$days" -lt "$tls_min_days" ]; then
        finding "tls: the certificate expires in ${days} day(s) (limit ${tls_min_days})"
      else
        ok "tls: the certificate is valid for ${days} more day(s)"
      fi
    fi
  fi
fi

echo
if [ "$findings" -eq 0 ]; then
  echo "host check: all well"
else
  echo "host check: $findings finding(s)"
fi
# The number of findings, capped so it can never wrap round to 0 (an exit status is one byte).
exit $((findings > 100 ? 100 : findings))
