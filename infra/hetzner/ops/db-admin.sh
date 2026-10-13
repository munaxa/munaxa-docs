#!/bin/sh
# Database administration for a Hetzner deployment — go-live-runbook.md §6, as commands.
#
# Runs in the `db-admin` service of compose.yaml (profile `ops`): the PostgreSQL image's own client,
# on the private data network, as the cluster superuser. It is never part of the running stack.
#
#   docker compose --profile ops run --rm db-admin bootstrap        # once per cluster
#   docker compose --profile ops run --rm db-admin create-tenant <slug>   # once per tenant
#
# Every value comes from the environment (config/postgres.env and config/operator.env), never from
# arguments, so no password reaches `ps` or the shell history. Each password is passed to psql as a
# variable and quoted by psql with :'…', so a character special to SQL is escaped by psql, not here.
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is not set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set}"
export PGHOST="${PGHOST:-postgres}" PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD" PGDATABASE=postgres

psql_admin() {
  psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 "$@"
}

bootstrap() {
  : "${EDMS_OWNER_PASSWORD:?EDMS_OWNER_PASSWORD is not set}"
  : "${EDMS_APP_PASSWORD:?EDMS_APP_PASSWORD is not set}"
  : "${EDMS_BACKUP_PASSWORD:?EDMS_BACKUP_PASSWORD is not set}"

  # Step 1: the repository's cluster roles, verbatim. Idempotent.
  psql_admin --file /sql/cluster/01-roles.sql

  # Step 1, continued: the credentials. 01-roles.sql creates both roles with no password on purpose —
  # "issue its credential from your secret store" — and this is where that happens on Hetzner.
  # (`infra/sql/cluster/02-app-credentials.sh` is the local compose stack's version and is not used.)
  #
  # Step 1b: the backup role (STG-2). Row-level security is forced on every tenant table, so a
  # logical backup needs a role that bypasses it and can read everything, and nothing else.
  psql_admin \
    --set owner_password="$EDMS_OWNER_PASSWORD" \
    --set app_password="$EDMS_APP_PASSWORD" \
    --set backup_password="$EDMS_BACKUP_PASSWORD" <<'SQL'
ALTER ROLE edms_owner PASSWORD :'owner_password';
ALTER ROLE edms_app PASSWORD :'app_password';
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edms_backup') AS create_backup \gset
\if :create_backup
CREATE ROLE edms_backup LOGIN BYPASSRLS;
\endif
ALTER ROLE edms_backup PASSWORD :'backup_password';
GRANT pg_read_all_data TO edms_backup;
SQL
  echo "Cluster roles ready: edms_owner, edms_app, edms_backup."
}

create_tenant() {
  slug="${1:-}"
  # The same shape the catalogue's `{slug}` substitution produces; refused before anything runs.
  case "$slug" in
    '' | *[!a-z0-9-]* | -* | *-)
      echo "Usage: create-tenant <slug>   (lower-case letters, digits and inner hyphens)" >&2
      exit 2
      ;;
  esac
  # Exactly what the catalogue templates (`…/edms_{slug}`) resolve to, hyphens included: the
  # migration runner and the API address the database by that name.
  database="edms_$slug"
  # On stdin rather than --command: psql interpolates :'db' only in input it reads, not in -c.
  exists="$(psql_admin --tuples-only --no-align --set db="$database" <<'SQL'
SELECT 1 FROM pg_database WHERE datname = :'db';
SQL
)"
  if [ "$exists" = "1" ]; then
    echo "Database $database already exists; nothing to do."
    return 0
  fi
  # Step 2: one empty database per tenant, owned by edms_owner. Its grants, schema and policies are
  # applied by the migration runner (`migrate` service), never here.
  psql_admin --set db="$database" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER edms_owner', :'db') \gexec
SQL
  echo "Created $database (owner edms_owner). Next: add it to both catalogues, then run migrate."
}

command="${1:-}"
shift || true
case "$command" in
  bootstrap) bootstrap ;;
  create-tenant) create_tenant "$@" ;;
  *)
    echo "Usage: db-admin.sh bootstrap | create-tenant <slug>" >&2
    exit 2
    ;;
esac
