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

-- Tables get their application grants from the post-migration SQL, never from default privileges
-- (L-2, docs-migration-path report). ../post-migrate/01-tenant-isolation.sql grants the application
-- read and write on every table in `public` after every migration, in the same transaction that
-- revokes write on Prisma's history again, and 02-audit-immutability.sql then takes UPDATE and
-- DELETE off audit_event. A default privilege used to grant the same thing at creation, and so gave
-- the application role write on `_prisma_migrations` — the history the start-up and provisioning
-- gate trusts — from the moment `prisma migrate deploy` created it on a fresh database until the
-- post-migration SQL revoked it. Nothing needs a table before the post-migration SQL has run: the
-- gate keeps provisioning and the API off a database until it has.
--
-- So the default is withdrawn here, before every migration. On a fresh database this is a no-op; on
-- one migrated by an earlier release it removes the default those releases set. Sequences keep
-- their default (USAGE, SELECT), which gives no write on any table.
ALTER DEFAULT PRIVILEGES FOR ROLE edms_owner IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM edms_app;

ALTER DEFAULT PRIVILEGES FOR ROLE edms_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO edms_app;

-- And Prisma's history is read-only to the application from before the first statement of the
-- migration, on a database whose earlier run (any release, any outcome) left write in place.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public._prisma_migrations FROM edms_app;
    -- A REVOKE by a role that does not own the table only warns. Whoever owns it, and whether the
    -- right comes directly, through PUBLIC or through a role, the application must end with none.
    IF has_table_privilege('edms_app', 'public._prisma_migrations', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION 'edms_app can still write public._prisma_migrations (is it owned by edms_owner?)';
    END IF;
  END IF;
END
$$;

-- The tenant discriminator every row-level security policy is keyed on.
--
-- Per database, because the policies that read it are. The setting is written with
-- set_config(..., true) inside the transaction, so it cannot leak to the next borrower of a pooled
-- connection — the failure mode that makes session-level tenant settings unsafe behind PgBouncer.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;
