#!/bin/sh
# Gives `edms_app` a password, when the environment supplies one. Applied ONCE PER CLUSTER, by the
# same entrypoint that runs 01-roles.sql.
#
# It exists because 01-roles.sql creates the role with `LOGIN` and no password, which is correct for
# production — where the credential is issued by whatever the deployment uses for credentials, and a
# password committed to this repository would be a prohibited action
# (docs/architecture/17-security-architecture.md §10) — and broken for the local stack, where the
# official image's default `scram-sha-256` authentication has no verifier to check against. The
# documented `DATABASE_URL` in .env.example connects as `edms_app` with a password, so without this
# the setup instructions fail at the first query with `password authentication failed`.
#
# A shell script rather than SQL because the entrypoint runs `.sql` files through psql with no
# variables passed, so SQL cannot read an environment variable. The password therefore lives where
# the stack's other development credential already lives — infra/docker-compose.yml — rather than in
# a file that also bootstraps production.
#
# Unset means unset: production leaves EDMS_APP_PASSWORD absent and nothing happens. That is the
# safe direction, because the failure mode of the alternative is a well-known password on a
# production role.
set -eu

if [ -z "${EDMS_APP_PASSWORD:-}" ]; then
  echo "EDMS_APP_PASSWORD is not set; leaving edms_app without a password."
  echo "  Set it for a local or CI cluster whose pg_hba requires one. In production the"
  echo "  credential is issued outside this repository."
  exit 0
fi

# ALTER rather than CREATE: 01-roles.sql already made the role, and it runs first because the
# entrypoint applies this directory in filename order.
#
# The password is passed as a psql variable and quoted with :'…' so a character that is special to
# SQL is escaped by psql rather than by this script.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 \
  --set app_password="$EDMS_APP_PASSWORD" <<'SQL'
ALTER ROLE edms_app PASSWORD :'app_password';
SQL

echo "edms_app can now authenticate with a password."
