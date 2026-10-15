#!/usr/bin/env bash
# The host's own check — docs/operations/monitoring.md §3 (R-6 of the readiness report).
#
# Run on the server by a systemd timer every 5 minutes, from the release checkout:
#
#   infra/hetzner/ops/host-check.sh            prints one line per finding; exit 0 = all well
#
# and its exit status decides whether the timer pings the dead-man's switch (monitoring.md §4):
# a missed ping is the alert, so a server that is down, a timer that stopped and a check that
# failed all page the same way. It reads; it changes nothing.
#
# Output carries no secrets, host names, tenant names or connection strings: counts, percentages,
# ages and container service names only.
#
# Environment (all optional):
#   DOCS_ENV_FILE        the deploy.env to use (default infra/hetzner/deploy.env)
#   DISK_MAX_PERCENT     a filesystem above this is a finding (default 85)
#   MEMORY_MIN_PERCENT   available memory below this is a finding (default 10)
#   BACKUP_MAX_AGE_HOURS the last successful backup older than this is a finding (default 26)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$(cd "$here/.." && pwd)"
env_file="${DOCS_ENV_FILE:-$template/deploy.env}"
disk_max="${DISK_MAX_PERCENT:-85}"
memory_min="${MEMORY_MIN_PERCENT:-10}"
backup_max_age="${BACKUP_MAX_AGE_HOURS:-26}"
findings=0

finding() {
  echo "FINDING  $*"
  findings=$((findings + 1))
}
ok() { echo "ok       $*"; }

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
backup_dir="$(sed -n 's/^DOCS_BACKUP_DIR=//p' "$env_file" 2>/dev/null | tail -n 1)"
backup_dir="${DOCS_BACKUP_DIR:-$backup_dir}"
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

# 2. Memory: what the kernel still has available, and any container killed for memory.
available="$(awk '/MemTotal/ { total = $2 } /MemAvailable/ { free = $2 } END { if (total) printf "%d", free * 100 / total }' /proc/meminfo)"
if [ "${available:-0}" -lt "$memory_min" ]; then
  finding "memory: ${available}% available (limit ${memory_min}%)"
else
  ok "memory: ${available}% available"
fi
for id in $(compose ps -q 2>/dev/null); do
  name="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$id")"
  if [ "$(docker inspect --format '{{.State.OOMKilled}}' "$id")" = "true" ]; then
    finding "memory: $name was killed for memory"
  fi
  # 3. Every container that has a health check reports healthy (scanner: a real scan and fresh
  #    signatures; db-backup: a recent successful run; the rest: their own probes).
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")"
  state="$(docker inspect --format '{{.State.Status}}' "$id")"
  if [ "$state" != "running" ]; then
    finding "container: $name is $state"
  elif [ "$health" = "unhealthy" ]; then
    finding "container: $name is unhealthy"
  else
    ok "container: $name $state${health:+ ($health)}"
  fi
done

# 4. Backups: the last successful run, and WAL archiving.
if [ -n "$backup_dir" ]; then
  status="$(compose exec -T db-backup cat /backup/status/backup.prom 2>/dev/null)"
  last="$(printf '%s\n' "$status" | sed -n 's/^munaxa_backup_last_success_timestamp_seconds //p')"
  if [ -z "$last" ] || [ "$last" -eq 0 ]; then
    finding "backup: no successful backup recorded"
  else
    age=$((($(date +%s) - last) / 3600))
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

# 5. Readiness, from inside the server only: every tenant database (by position), Redis, scanner.
ready="$(compose exec -T api node -e "fetch('http://127.0.0.1:3001/api/health/ready').then(async r => { const b = await r.json(); console.log(r.status, (b.dependencies || []).filter(d => d.status !== 'UP').map(d => d.name + '=' + d.status).join(',')); }).catch(() => console.log('unreachable'))" 2>/dev/null)"
case "$ready" in
  '200 ') ok "api: ready, every dependency up" ;;
  200*) ok "api: ready, degraded: ${ready#200 }" ;;
  *) finding "api: not ready (${ready:-no answer})" ;;
esac

echo
if [ "$findings" -eq 0 ]; then
  echo "host check: all well"
else
  echo "host check: $findings finding(s)"
fi
exit "$findings"
