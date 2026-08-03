-- Audit immutability, enforced by the database itself.
--
-- The grants in 01-roles-and-rls.sql already deny UPDATE and DELETE to the application role.
-- This trigger denies them to *everyone*, including a superuser session opened by an
-- administrator with good intentions and a bad idea. Together with the hash chain, that is
-- what makes the trail evidence rather than a log (docs/architecture/13-audit-architecture.md).
--
-- Retention still works: partitions are detached and dropped as whole months by the owner
-- role, which is a DDL operation the trigger does not see.

CREATE OR REPLACE FUNCTION audit_event_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

DROP TRIGGER IF EXISTS trg_audit_event_append_only ON audit_event;
CREATE TRIGGER trg_audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();
