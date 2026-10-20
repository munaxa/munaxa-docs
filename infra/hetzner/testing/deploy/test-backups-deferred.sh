#!/usr/bin/env bash
# Tests compose.backups-deferred.yaml (README.md §4, "TEST with backups deferred") on the RENDERED
# configuration, not on the overlay's text, because Compose merges some keys (command, volumes,
# profiles) instead of replacing them:
#
#   1. without the overlay, backups are still on: WAL archiving, the backup mount, db-backup started
#      by `up`, offsite in `ops`, and both env files required;
#   2. with it: PostgreSQL has no archiving and no backup mount and sets none of fsync,
#      synchronous_commit or full_page_writes (so all stay on); neither `up` nor `--profile ops`
#      includes db-backup or offsite; both render without backup.env or offsite.env; named
#      explicitly, each is inert (no volume, env file, command, health check or restart; an
#      entrypoint that exits 64);
#   3. with a PostgreSQL image (POSTGRES_IMAGE, default: the local build munaxa-docs-postgres:16.10),
#      the running server: archive_mode off, fsync, synchronous_commit and full_page_writes on; and
#      db-backup and offsite, each started by name, run and exit 64 without restarting, with no
#      mount and no health check, creating nothing on the host. Skipped when Docker has no daemon.
#
#   infra/hetzner/testing/deploy/test-backups-deferred.sh
#
# Compose versions differ in how they apply `!reset` and `!override` (compose.backups-deferred.yaml),
# so run it under each version in use: CI runs it with the runner's Compose; DOCKER_CONFIG pointing
# at a directory whose cli-plugins/ holds another docker-compose runs it with that one.
#
# Uses the template's fixed subnets (172.28.10–14.0/24): never run beside the stack test.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$(cd "$here/../.." && pwd)"
postgres_image="${POSTGRES_IMAGE:-munaxa-docs-postgres:16.10}"
project="deferred-$(openssl rand -hex 4)-test"
work="$(mktemp -d)"
failures=0

cleanup() {
  # By project name only, from Docker's own labels: no configuration is rendered, so a broken
  # overlay cannot leave this run's containers holding the template's subnets for the next one.
  docker compose -p "$project" down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT

pass() { echo "PASS  $*"; }
fail() {
  echo "FAIL  $*"
  failures=$((failures + 1))
}

# A configuration directory WITHOUT backup.env and offsite.env: deferred mode must not need them.
config="$work/config"
mkdir -p "$config"
printf 'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 16)" >"$config/postgres.env"
for f in api.env redis.env operator.env; do : >"$config/$f"; done
echo '{}' >"$config/tenants.json"
echo '{}' >"$config/operator-tenants.json"
cat >"$work/deploy.env" <<EOF
DOCS_PROJECT_NAME=$project
DOCS_CONFIG_DIR=$config
DOCS_API_IMAGE=api@sha256:$(printf '%064d' 0)
DOCS_WEB_IMAGE=web@sha256:$(printf '%064d' 0)
DOCS_ANTIVIRUS_IMAGE=antivirus@sha256:$(printf '%064d' 0)
DOCS_POSTGRES_IMAGE=$postgres_image
DOCS_BACKUP_DIR=$work/no-backup-volume
DOCS_OFFSITE_STATE_DIR=$work/no-offsite-state
DOCS_BACKUP_AGE_RECIPIENTS=age1fixtureone,age1fixturetwo
EOF
base=(docker compose --env-file "$work/deploy.env" -f "$template/compose.yaml")
deferred=("${base[@]}" -f "$template/compose.backups-deferred.yaml")

echo "Docker Compose $(docker compose version --short)"

echo "=== 1. without the overlay, backups are still required"
out="$("${base[@]}" config -q 2>&1)"
[ $? -ne 0 ] && printf '%s' "$out" | grep -q 'backup.env' && pass "the base template refuses to render without backup.env" ||
  fail "the base template rendered without backup.env"
: >"$config/backup.env"
: >"$config/offsite.env"
"${base[@]}" --profile ops config --format json >"$work/base.json" 2>"$work/err" || fail "the base template does not render: $(cat "$work/err")"
"${base[@]}" config --services >"$work/base.services" 2>/dev/null
python3 - "$work/base.json" "$work/base.services" <<'EOF' && pass "base: archiving on, the backup mount, db-backup started by up, offsite in ops" || fail "the base template's backups changed"
import json, sys
c = json.load(open(sys.argv[1]))
up = open(sys.argv[2]).read().split()
pg = c["services"]["postgres"]
cmd = pg["command"]
assert "archive_mode=on" in cmd and "archive_command=munaxa-archive-wal %p %f" in cmd, cmd
assert any(v["target"] == "/backup/wal" for v in pg["volumes"]), pg["volumes"]
assert "db-backup" in up, up
assert "ops" in c["services"]["offsite"].get("profiles", []), c["services"]["offsite"]
assert c["services"]["db-backup"]["entrypoint"] == ["munaxa-backup", "run"]
EOF
rm "$config/backup.env" "$config/offsite.env"

echo "=== 2. with the overlay"
"${deferred[@]}" config -q 2>"$work/err" && pass "renders without backup.env or offsite.env" ||
  fail "does not render without the backup env files: $(cat "$work/err")"
"${deferred[@]}" --profile ops config -q 2>"$work/err" && pass "the ops profile renders without offsite.env (migrate, db-admin still usable)" ||
  fail "--profile ops does not render: $(cat "$work/err")"
"${deferred[@]}" config --format json >"$work/deferred.json" 2>/dev/null
"${deferred[@]}" config --services >"$work/up.services" 2>/dev/null
"${deferred[@]}" --profile ops config --services >"$work/ops.services" 2>/dev/null
"${deferred[@]}" config --format json db-backup offsite >"$work/named.json" 2>"$work/err" ||
  fail "db-backup and offsite cannot be rendered by name: $(cat "$work/err")"
python3 - "$work/deferred.json" "$work/up.services" "$work/ops.services" <<'EOF' && pass "postgres: no archiving, no backup mount, durability settings left at their defaults" || fail "postgres is not as expected"
import json, sys
c = json.load(open(sys.argv[1]))
pg = c["services"]["postgres"]
cmd = " ".join(pg["command"])
assert pg["command"] == ["postgres", "-c", "hba_file=/etc/munaxa-postgres/pg_hba.conf"], pg["command"]
for setting in ("archive_mode", "archive_command", "fsync", "synchronous_commit", "full_page_writes", "wal_level=minimal"):
    assert setting not in cmd, setting
assert [v["target"] for v in pg["volumes"]] == ["/var/lib/postgresql/data"], pg["volumes"]
assert all("backup" not in str(v.get("source", "")) for v in pg["volumes"])
EOF
python3 - "$work/up.services" "$work/ops.services" <<'EOF' && pass "neither up nor --profile ops includes db-backup or offsite" || fail "a backup service is still started by up or ops"
import sys
for path in sys.argv[1:]:
    services = open(path).read().split()
    assert "postgres" in services and "api" in services, services
    assert "db-backup" not in services and "offsite" not in services, (path, services)
EOF
python3 - "$work/named.json" <<'EOF' && pass "named explicitly, db-backup and offsite are inert: no volume, env file, command, health check or restart; exit 64" || fail "a backup service named explicitly is not inert"
import json, sys
c = json.load(open(sys.argv[1]))
for name in ("db-backup", "offsite"):
    s = c["services"][name]
    assert s.get("profiles") == ["backups-deferred"], (name, s.get("profiles"))
    assert not s.get("volumes"), (name, s.get("volumes"))
    assert not s.get("env_file"), (name, s.get("env_file"))
    assert not s.get("command"), (name, s.get("command"))
    assert s.get("restart") == "no", (name, s.get("restart"))
    assert s["entrypoint"][:2] == ["/bin/sh", "-c"] and s["entrypoint"][2].endswith("exit 64"), (name, s["entrypoint"])
    assert s.get("healthcheck") in (None, {"disable": True}), (name, s.get("healthcheck"))
EOF

echo "=== 3. the running server"
if ! docker info >/dev/null 2>&1; then
  echo "SKIP  no Docker daemon: the running-server checks did not run"
elif ! docker image inspect "$postgres_image" >/dev/null 2>&1; then
  echo "SKIP  $postgres_image is not present locally: the running-server checks did not run"
else
  "${deferred[@]}" up -d --wait --wait-timeout 120 postgres >"$work/up.log" 2>&1 ||
    fail "postgres did not become healthy: $(tail -n 5 "$work/up.log")"
  # shellcheck disable=SC2016 # expanded inside the container
  settings="$("${deferred[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -tA -F= -c "SELECT name, setting FROM pg_settings WHERE name IN (\$\$archive_mode\$\$, \$\$fsync\$\$, \$\$synchronous_commit\$\$, \$\$full_page_writes\$\$) ORDER BY name"' 2>&1)"
  expected="$(printf 'archive_mode=off\nfsync=on\nfull_page_writes=on\nsynchronous_commit=on')"
  [ "$settings" = "$expected" ] && pass "the server runs with archive_mode=off and fsync, full_page_writes, synchronous_commit on" ||
    fail "the server's settings are not as expected: $settings"
  # Each backup service started by name: it must run (so the checks below are not vacuous), exit 64
  # with its message, never restart, have no health check, and mount nothing from the host or the
  # stack. The only mount allowed is an anonymous volume at a path the IMAGE declares (VOLUME): the
  # PostgreSQL image declares /var/lib/postgresql/data, so Docker gives every container of it an
  # empty one of its own — not postgres-data, not the backup directory.
  for service in db-backup offsite; do
    "${deferred[@]}" up -d --no-deps "$service" >"$work/$service.log" 2>&1
    sleep 3
    id="$("${deferred[@]}" ps -a -q "$service" 2>/dev/null)"
    if [ -z "$id" ]; then
      fail "$service started by name did not run at all: $(tail -n 3 "$work/$service.log")"
      continue
    fi
    shape="$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}} {{.RestartCount}} health={{if .Config.Healthcheck}}{{.Config.Healthcheck.Test}}{{else}}none{{end}}' "$id")"
    docker inspect --format '{{json .Mounts}}' "$id" >"$work/$service.mounts.json"
    docker image inspect --format '{{json .Config.Volumes}}' "$(docker inspect --format '{{.Image}}' "$id")" >"$work/$service.image-volumes.json"
    mounts="$(python3 - "$work/$service.mounts.json" "$work/$service.image-volumes.json" <<'EOF'
import json, re, sys
mounts = json.load(open(sys.argv[1])) or []
declared = json.load(open(sys.argv[2])) or {}
bad = [m for m in mounts if not (m.get("Type") == "volume" and re.fullmatch(r"[0-9a-f]{64}", m.get("Name", ""))
       and m.get("Destination") in declared)]
print("ok" if not bad else "; ".join(f'{m.get("Type")} {m.get("Name") or m.get("Source")} -> {m.get("Destination")}' for m in bad))
EOF
    )"
    case "$shape" in
      "exited 64 0 health=none" | "exited 64 0 health=[NONE]") ;;
      *) mounts="state: $shape; mounts: $mounts" ;;
    esac
    if [ "$mounts" = ok ] && docker logs "$id" 2>&1 | grep -q 'backups are deferred'; then
      pass "$service started by name: exits 64, says why, no restart, no health check, no host or stack mount"
    else
      fail "$service started by name did not stay inert: $mounts"
    fi
  done
  [ ! -e "$work/no-backup-volume" ] && [ ! -e "$work/no-offsite-state" ] &&
    pass "neither started service created the backup directory or the off-server state directory" ||
    fail "a started backup service created a directory on the host"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "All backups-deferred checks passed"
else
  echo "$failures backups-deferred check(s) FAILED"
fi
exit "$failures"
