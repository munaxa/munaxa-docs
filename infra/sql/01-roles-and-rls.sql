-- Database roles and row-level security.
--
-- This is isolation layer 5, and the only one that survives an application bug
-- (docs/architecture/adr/0002-multi-tenant-isolation-model.md). The application connects as
-- edms_app, which does NOT have BYPASSRLS; migrations run as edms_owner, which owns the
-- schema. A logic error in a query therefore returns nothing rather than another tenant's
-- rows.
--
-- Applied by the platform team at provisioning time, before the first migration runs.

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
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO edms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE edms_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO edms_app;

-- Audit is append-only at the grant level, not merely by convention.
REVOKE UPDATE, DELETE ON audit_event FROM edms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE edms_owner IN SCHEMA public
  REVOKE UPDATE, DELETE ON TABLES FROM edms_app;

-- Row-level security, keyed on a transaction-local setting.
--
-- The setting is written with set_config(..., true) inside the transaction, so it cannot leak
-- to the next borrower of a pooled connection — the failure mode that makes session-level
-- tenant settings unsafe behind PgBouncer.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;

-- Applied to every tenant-scoped table. `tenant` itself is excluded: it has no tenant_id, and
-- it is read only by the operator console under a separate role.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['audit_event', 'outbox_message', 'idempotency_key']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      target
    );
  END LOOP;
END
$$;

-- A tenant-scoped table added without a policy is a hole, so make that state impossible to
-- miss: this query must return zero rows in CI against a migrated database.
--
--   SELECT c.relname
--   FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public'
--     AND c.relkind = 'r'
--     AND c.relname <> 'tenant'
--     AND EXISTS (SELECT 1 FROM information_schema.columns
--                 WHERE table_name = c.relname AND column_name = 'tenant_id')
--     AND NOT c.relrowsecurity;
