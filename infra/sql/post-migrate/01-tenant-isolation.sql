-- Row-level security. Applied after EVERY migration, and safe to re-run.
--
-- This file discovers the tables it protects rather than listing them. A hand-maintained list
-- is a hole waiting to open: someone adds a tenant-scoped table in a later phase, forgets the
-- list, and isolation layer 5 is missing for exactly that table with nothing to say so.
-- Discovery makes the omission impossible instead of merely detectable.
--
-- The rule: every table in `public` that carries a `tenant_id` column gets FORCE ROW LEVEL
-- SECURITY and a `tenant_isolation` policy keyed on current_tenant_id(). `tenant` itself is
-- excluded — it has no tenant_id, and it is read by the operator console under a separate
-- role (docs/architecture/adr/0013-operator-console-as-separate-surface.md).
--
-- FORCE matters: without it the table owner bypasses the policy, and the owner is who
-- migrations and maintenance run as.

DO $$
DECLARE
  target text;
BEGIN
  FOR target IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname <> 'tenant'
      AND NOT c.relname LIKE '\_prisma%'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = c.relname
          AND column_name = 'tenant_id'
      )
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

-- Tables that already existed when the default privileges were set do not inherit them, so
-- grant explicitly. Re-running is harmless.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO edms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO edms_app;

-- The gate. A tenant-scoped table without RLS is an isolation hole, so refuse to finish
-- rather than report success. This is the check that ../../docs/reports/ recorded as
-- outstanding (R4): it now runs on every deploy, not only in CI.
DO $$
DECLARE
  unprotected text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO unprotected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname <> 'tenant'
    AND NOT c.relname LIKE '\_prisma%'
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = c.relname
        AND column_name = 'tenant_id'
    )
    AND NOT c.relrowsecurity;

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'tenant-scoped tables without row-level security: %', unprotected;
  END IF;
END
$$;
