-- The malware gate, in the database. Applied after EVERY migration, and safe to re-run.
--
-- `17-security-architecture.md` §5 says a file whose scan verdict is not CLEAN cannot be attached
-- to a revision, "enforced in the use case and by a database check, not only in the UI". The use
-- case enforces it; this is the second half, and the second half is the one that still holds when
-- somebody writes a repair script, a backfill or a support fix at three in the morning.
--
-- It is a trigger rather than a CHECK constraint because the condition spans two tables: the
-- verdict lives on `file_object` and the reference lives on `document_revision`. PostgreSQL check
-- constraints cannot see another row, and a materialised copy of the verdict on the revision would
-- be a second place for it to be wrong.
--
-- Two directions, because there are two ways to break the rule:
--
--   * attaching an unscanned or infected file to a revision, and
--   * moving a file that is already attached *out* of CLEAN — which is exactly what happens when a
--     scanner re-runs on a signature update and finds something it missed the first time.
--
-- The second is why the file-side trigger exists. Quarantining infected content that has already
-- been attached is a real operation with a real procedure: the revision is withdrawn first, then
-- the verdict is written. Refusing the write until that has happened is what stops a quarantine
-- silently leaving a document pointing at content the product now considers hostile.

CREATE OR REPLACE FUNCTION refuse_unscanned_revision_content() RETURNS trigger AS $$
DECLARE
  verdict scan_status;
BEGIN
  SELECT scan_status INTO verdict FROM file_object WHERE id = NEW.file_object_id;

  IF verdict IS NULL THEN
    RAISE EXCEPTION 'revision % references a file object that does not exist', NEW.id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF verdict <> 'CLEAN' THEN
    RAISE EXCEPTION 'revision % may not reference file object % with scan status %',
      NEW.id, NEW.file_object_id, verdict
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS revision_content_must_be_clean ON document_revision;
CREATE TRIGGER revision_content_must_be_clean
  BEFORE INSERT OR UPDATE OF file_object_id ON document_revision
  FOR EACH ROW EXECUTE FUNCTION refuse_unscanned_revision_content();

CREATE OR REPLACE FUNCTION refuse_declassifying_referenced_content() RETURNS trigger AS $$
DECLARE
  referencing bigint;
BEGIN
  IF OLD.scan_status = 'CLEAN' AND NEW.scan_status <> 'CLEAN' THEN
    SELECT count(*) INTO referencing
    FROM document_revision
    WHERE file_object_id = NEW.id AND deleted_at IS NULL;

    IF referencing > 0 THEN
      RAISE EXCEPTION 'file object % is referenced by % live revision(s) and cannot leave CLEAN',
        NEW.id, referencing
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_stays_clean_while_referenced ON file_object;
CREATE TRIGGER content_stays_clean_while_referenced
  BEFORE UPDATE OF scan_status ON file_object
  FOR EACH ROW EXECUTE FUNCTION refuse_declassifying_referenced_content();

-- A reference count is not a hint. It decides when retention may delete bytes, and a negative one
-- means the count has already drifted from the references it is counting — at which point the next
-- sweep deletes a blob a document still points at. Refusing the write is how the drift is found
-- while it is still one wrong statement rather than a missing file.
ALTER TABLE file_object DROP CONSTRAINT IF EXISTS ck_file_object_ref_count;
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_ref_count CHECK (ref_count >= 0);

-- Exactly one revision may be the effective one, and `document.current_revision_id` is unique, so
-- that half holds already. This is the other half: the revision it names must belong to the
-- document that names it. Without it a document could present another document's approved content
-- as its own, which is the single worst thing a document-control system can get wrong.
CREATE OR REPLACE FUNCTION refuse_foreign_current_revision() RETURNS trigger AS $$
DECLARE
  owner uuid;
BEGIN
  IF NEW.current_revision_id IS NOT NULL THEN
    SELECT document_id INTO owner FROM document_revision WHERE id = NEW.current_revision_id;
    IF owner IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'document % cannot present revision % of document % as its own',
        NEW.id, NEW.current_revision_id, owner
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.latest_revision_id IS NOT NULL THEN
    SELECT document_id INTO owner FROM document_revision WHERE id = NEW.latest_revision_id;
    IF owner IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'document % cannot claim revision % of document % as its latest',
        NEW.id, NEW.latest_revision_id, owner
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS current_revision_belongs_to_document ON document;
CREATE TRIGGER current_revision_belongs_to_document
  BEFORE INSERT OR UPDATE OF current_revision_id, latest_revision_id ON document
  FOR EACH ROW EXECUTE FUNCTION refuse_foreign_current_revision();
