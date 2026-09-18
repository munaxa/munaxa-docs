-- What `PURGED` means, said as a constraint — Slice 105A, part two of two.
--
-- ## What was broken
--
-- `DOCUMENT_DELETION_RULES` says of `number_reservation`: *"A number is never re-issued, even
-- after a purge (ADR-0004) … The purge sets its document pointer to null — the row outlives its
-- parent."* `ck_number_reservation_state` said an `ASSIGNED` row must name a document. Both were
-- written down, and they could not both hold: a retention disposition reaching a document that
-- had been numbered raised `23514` on the statement that nulls the pointer, the purge transaction
-- aborted, and — because `RetentionService.executeDue` has no per-document `catch` and
-- `listDue` orders `due_at ASC` — the stuck schedule sat at the head of the queue and stalled
-- every later disposition in the tenant, every night, for good.
--
-- ## What this says instead
--
-- The invariant is **strengthened**, not relaxed. `ASSIGNED` keeps its document pointer exactly
-- as before; `PURGED` is a distinct state that requires the pointers to be gone, which is the
-- fact that makes it different. `VOIDED` is untouched and keeps meaning "refused".
--
--   ASSIGNED  assigned_at IS NOT NULL, document_id IS NOT NULL
--   PURGED    assigned_at IS NOT NULL, document_id IS NULL, workflow_instance_id IS NULL
--   VOIDED    voided_at IS NOT NULL
--   HELD      workflow_instance_id IS NULL
--
-- ## Existing data
--
-- Nothing is rewritten, and nothing needs to be. No row can already be `PURGED` — the value did
-- not exist until the migration before this one — so every clause mentioning it is vacuously true
-- of existing data, and the first clause reduces to exactly the predicate it replaces:
-- `("state" IN ('ASSIGNED','PURGED')) = (assigned_at IS NOT NULL)` is
-- `("state" = 'ASSIGNED') = (assigned_at IS NOT NULL)` when no row is `PURGED`. Any row that
-- satisfied the old constraint satisfies this one. `ADD CONSTRAINT` validates the whole table
-- before it is accepted, so a database that somehow disagreed would fail this migration rather
-- than carry a constraint it does not meet.
ALTER TABLE "number_reservation" DROP CONSTRAINT "ck_number_reservation_state";

ALTER TABLE "number_reservation" ADD CONSTRAINT "ck_number_reservation_state"
  CHECK ((("state" IN ('ASSIGNED', 'PURGED')) = ("assigned_at" IS NOT NULL))
     AND ("state" <> 'ASSIGNED' OR "document_id" IS NOT NULL)
     AND ("state" <> 'PURGED' OR ("document_id" IS NULL AND "workflow_instance_id" IS NULL))
     AND (("state" = 'VOIDED') = ("voided_at" IS NOT NULL))
     AND ("state" <> 'HELD' OR "workflow_instance_id" IS NULL));
