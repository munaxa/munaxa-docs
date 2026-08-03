-- What every tenant database needs before its first migration. Applied ONCE PER DATABASE, as
-- edms_owner, by `scripts/migrate-tenants.mjs`.
--
-- Split from ../cluster/01-roles.sql because these are database-scoped and roles are not. Under
-- ADR-0015 a deployment has one database per company, so this file runs N times and the role file
-- runs once — and a file that mixed them would either fail on the second database or leave the
-- second database ungranted.
--
-- Nothing here may reference a table: at the moment it runs, the schema is empty. That is the split
-- ../post-migrate/ exists for, and it was learned the hard way — an earlier single-file version
-- referenced `audit_event` before the first migration, aborted on that line, and left every
-- row-level security policy below it unapplied.

-- `current_database()` rather than a literal. The database is named after the tenant, so a literal
-- would be right for exactly one of them.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO edms_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO edms_app;

-- Every table edms_owner creates from here on is readable and writable by the application.
--
-- Audit is the one table that must not be updatable or deletable, and it is handled by a targeted
-- REVOKE in ../post-migrate/02-audit-immutability.sql. It is deliberately NOT done with a
-- default-privilege REVOKE: default privileges are cumulative and untargeted, so revoking UPDATE and
-- DELETE here would strip them from *every* future table — the application could insert a user and
-- then never deactivate one.
ALTER DEFAULT PRIVILEGES FOR ROLE edms_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO edms_app;

ALTER DEFAULT PRIVILEGES FOR ROLE edms_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO edms_app;

-- The tenant discriminator every row-level security policy is keyed on.
--
-- Per database, because the policies that read it are. The setting is written with
-- set_config(..., true) inside the transaction, so it cannot leak to the next borrower of a pooled
-- connection — the failure mode that makes session-level tenant settings unsafe behind PgBouncer.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;
