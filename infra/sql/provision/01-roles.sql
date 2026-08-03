-- Database roles and privileges. Applied ONCE, at provisioning time, BEFORE the first
-- migration runs.
--
-- Nothing in this file may reference a table: at the moment it runs, the schema is empty.
-- Everything that depends on a table living in the database is in ../post-migrate/, which
-- runs after `prisma migrate deploy`. That split is not cosmetic — the previous single-file
-- version referenced `audit_event` here and aborted, which left the row-level security
-- policies below it unapplied and isolation layer 5 quietly absent.
--
-- The application connects as edms_app, which does NOT have BYPASSRLS; migrations run as
-- edms_owner, which owns the schema. A logic error in a query therefore returns nothing
-- rather than another tenant's rows
-- (docs/architecture/adr/0002-multi-tenant-isolation-model.md).

-- The migration owner. Owns every object; never used by the running application.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edms_owner') THEN
    CREATE ROLE edms_owner LOGIN;
  END IF;
END
$$;

-- The application role. NOBYPASSRLS is the point of this file.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edms_app') THEN
    CREATE ROLE edms_app LOGIN NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE edms_app SET statement_timeout = '15s';
ALTER ROLE edms_app SET idle_in_transaction_session_timeout = '30s';

GRANT CONNECT ON DATABASE edms TO edms_app;
GRANT USAGE ON SCHEMA public TO edms_app;

-- Every table edms_owner creates from here on is readable and writable by the application.
--
-- Audit is the one table that must not be updatable or deletable, and it is handled by a
-- targeted REVOKE in ../post-migrate/02-audit-immutability.sql. It is deliberately NOT done
-- with a default-privilege REVOKE: default privileges are cumulative and untargeted, so
-- revoking UPDATE and DELETE here would strip them from *every* future table — the
-- application could insert a user and then never deactivate one.
ALTER DEFAULT PRIVILEGES FOR ROLE edms_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO edms_app;

ALTER DEFAULT PRIVILEGES FOR ROLE edms_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO edms_app;

-- The tenant discriminator every row-level security policy is keyed on.
--
-- The setting is written with set_config(..., true) inside the transaction, so it cannot leak
-- to the next borrower of a pooled connection — the failure mode that makes session-level
-- tenant settings unsafe behind PgBouncer.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;
