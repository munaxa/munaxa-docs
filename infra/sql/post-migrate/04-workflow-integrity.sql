-- What an approval may not become. Applied after EVERY migration, and safe to re-run.
--
-- The engine's own rules live in the use case, where they produce a sentence a person can act on.
-- These are the three that span two tables — so a check constraint cannot see them — and that are
-- catastrophic rather than merely wrong when they are broken. Each is the second half of a rule the
-- application already enforces, and the second half is the one that still holds when a repair
-- script, a backfill or a support fix is what is doing the writing
-- (`docs/architecture/07-workflow-architecture.md` §8).

-- 1. An instance binds to a PUBLISHED version.
--
-- "An instance binds to a version, never to a definition" is §1's most important property, and it
-- is worth nothing if the version it binds to is still being edited. A draft is mutable by design;
-- an approval running under one would be an approval whose rules change while it runs, which is
-- exactly what versioning exists to prevent. DEPRECATED is allowed on purpose — retiring a version
-- stops *new* approvals and leaves running ones alone, so an instance started before the retirement
-- must stay readable and re-checkable afterwards.
CREATE OR REPLACE FUNCTION refuse_unpublished_workflow_binding() RETURNS trigger AS $$
DECLARE
  bound workflow_version_state;
BEGIN
  SELECT state INTO bound FROM workflow_version WHERE id = NEW.workflow_version_id;

  IF bound IS NULL THEN
    RAISE EXCEPTION 'workflow instance % binds to a version that does not exist', NEW.id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF bound = 'DRAFT' THEN
    RAISE EXCEPTION 'workflow instance % may not bind to draft version %', NEW.id, NEW.workflow_version_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_instance_binds_published ON workflow_instance;
CREATE TRIGGER workflow_instance_binds_published
  BEFORE INSERT OR UPDATE OF workflow_version_id ON workflow_instance
  FOR EACH ROW EXECUTE FUNCTION refuse_unpublished_workflow_binding();

-- 2. A task belongs to a stage of its own instance.
--
-- The workflow equivalent of "a document may not claim another document's revision", and the same
-- kind of mistake: two foreign keys that are individually valid and jointly nonsense. A task whose
-- stage belongs to a different instance counts toward a quorum in an approval nobody meant it to be
-- part of, and every reading of both instances afterwards is wrong in a way no join reveals.
CREATE OR REPLACE FUNCTION refuse_foreign_stage_task() RETURNS trigger AS $$
DECLARE
  owning uuid;
BEGIN
  SELECT instance_id INTO owning FROM workflow_stage WHERE id = NEW.stage_id;

  IF owning IS NULL THEN
    RAISE EXCEPTION 'approval task % references a stage that does not exist', NEW.id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF owning <> NEW.instance_id THEN
    RAISE EXCEPTION 'approval task % claims stage % of another instance', NEW.id, NEW.stage_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS approval_task_stage_is_own ON approval_task;
CREATE TRIGGER approval_task_stage_is_own
  BEFORE INSERT OR UPDATE OF stage_id, instance_id ON approval_task
  FOR EACH ROW EXECUTE FUNCTION refuse_foreign_stage_task();

-- 3. A decision is taken only while the instance is running.
--
-- A paused instance is one whose timers are stopped — a document under legal hold, a suspended
-- tenant — and the thing that makes pausing meaningful is that nothing progresses while it holds.
-- A finished instance is evidence, and a decision arriving after it ended would change what the
-- record says happened. Both are refused here as well as in the use case, because the use case's
-- version reads the instance a moment before it writes the task, and this one reads it in the same
-- statement.
CREATE OR REPLACE FUNCTION refuse_decision_on_idle_instance() RETURNS trigger AS $$
DECLARE
  running workflow_instance_state;
BEGIN
  IF NEW.decision IS NULL OR NEW.decision IS NOT DISTINCT FROM OLD.decision THEN
    RETURN NEW;
  END IF;

  SELECT state INTO running FROM workflow_instance WHERE id = NEW.instance_id;

  IF running <> 'RUNNING' THEN
    RAISE EXCEPTION 'approval task % may not be decided while its instance is %', NEW.id, running
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS approval_task_decided_while_running ON approval_task;
CREATE TRIGGER approval_task_decided_while_running
  BEFORE UPDATE OF decision ON approval_task
  FOR EACH ROW EXECUTE FUNCTION refuse_decision_on_idle_instance();
