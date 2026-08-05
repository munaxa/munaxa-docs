-- Phase 10 — soft delete and retention: the recycle bin, the disposition schedule, the legal
-- hold, and the purge.
--
-- Four things arrive here, and the third is the one worth reading carefully.
--
-- `retention_schedule` and `legal_hold` are `05-database-design.md` §3's two retention tables,
-- built for the first time. Both are indexed *partially*, on the rows the questions are actually
-- about: a schedule is due or it is history, and a hold is live or it is history, and in a library
-- of any age the history is almost all of it.
--
-- `delete_cascade_id` on `document` and `document_revision` is the answer to "what does deleting
-- this cascade to". Before this migration there was no single answer: a folder delete cascaded over
-- folders and stopped at the documents inside them, and a document delete gave back the reference on
-- its latest revision and left every earlier one counted — so a document with four revisions
-- returned one reference and its blobs could never reach zero. The column is the same mechanism
-- `folder.delete_cascade_id` has carried since Phase 2, extended to the two tables that were
-- missing it, so a restore reverses exactly one delete rather than everything currently deleted
-- underneath a node.
--
-- `document_tombstone` is what a purged document leaves behind, and it exists because of a
-- constraint rather than a preference. 13 §6 requires that a purged document's audit trail remains
-- "with the document number preserved so the record is still meaningful", and
-- `02-audit-immutability.sql` makes that enforceable: `audit_event` refuses `DELETE` to every role
-- including the owner. So the trail *will* outlive the row. What it cannot do is grow a number it
-- never carried — the events written before this phase were hashed with the payloads they have, and
-- rewriting one is the single operation this product will not perform on that table. The number is
-- therefore copied to a row the purge does not reach, together with the few facts that make an old
-- event legible. It has no `deleted_at`: a tombstone the recycle bin could hide would be a headstone
-- somebody could bury.
--
-- `ix_document_deleted` is the recycle bin's own index, and it is partial for the same reason
-- every index here is. Phase 9 noted there was an index on `(tenant_id, action, occurred_at)` and
-- none on `deleted_at`; a *full* index on `deleted_at` would index the whole library to answer a
-- question about the thousandth of it that is deleted.

CREATE TYPE "retention_schedule_state" AS ENUM ('PENDING', 'IN_REVIEW', 'EXECUTED', 'SUSPENDED', 'CANCELLED');

-- --- The cascade -----------------------------------------------------------------------------

ALTER TABLE "document"
  ADD COLUMN "delete_reason" TEXT,
  ADD COLUMN "delete_cascade_id" UUID;

ALTER TABLE "document_revision"
  ADD COLUMN "delete_cascade_id" UUID;

CREATE INDEX "ix_document_cascade" ON "document" ("tenant_id", "delete_cascade_id");
CREATE INDEX "ix_revision_cascade" ON "document_revision" ("tenant_id", "delete_cascade_id");

-- The recycle bin, the sweep and the disposition register all ask "what is deleted, newest first".
CREATE INDEX "ix_document_deleted" ON "document" ("tenant_id", "deleted_at" DESC)
  WHERE "deleted_at" IS NOT NULL;

-- --- The schedule ----------------------------------------------------------------------------

CREATE TABLE "retention_schedule" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "policy_id" UUID,
    "trigger" "retention_trigger" NOT NULL,
    "trigger_at" TIMESTAMPTZ(6) NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "disposition" "disposition" NOT NULL,
    "state" "retention_schedule_state" NOT NULL DEFAULT 'PENDING',
    "review_required" BOOLEAN NOT NULL DEFAULT false,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_note" TEXT,
    "executed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "retention_schedule_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "retention_schedule"
  ADD CONSTRAINT "retention_schedule_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "retention_schedule"
  ADD CONSTRAINT "retention_schedule_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "retention_schedule"
  ADD CONSTRAINT "retention_schedule_policy_id_fkey"
  FOREIGN KEY ("policy_id") REFERENCES "retention_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ix_retention_schedule_document" ON "retention_schedule" ("tenant_id", "document_id");

-- §3's `ix (tenant_id, due_at) WHERE state = 'PENDING'`, widened by one state: a schedule waiting
-- for a reviewer is still due, and the sweep has to find it to notice that somebody approved it.
CREATE INDEX "ix_retention_schedule_due" ON "retention_schedule" ("tenant_id", "due_at")
  WHERE "state" IN ('PENDING', 'IN_REVIEW');

-- One live schedule per document per trigger. Prisma cannot express a partial unique index, and
-- this is the constraint that makes the sweep idempotent under redelivery: a second delivery of the
-- same trigger updates the row it finds rather than writing a second schedule for the same fact.
CREATE UNIQUE INDEX "uq_retention_schedule_live" ON "retention_schedule" ("document_id", "trigger")
  WHERE "state" IN ('PENDING', 'IN_REVIEW', 'SUSPENDED');

-- --- The hold --------------------------------------------------------------------------------

CREATE TABLE "legal_hold" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "placed_by_id" UUID NOT NULL,
    "placed_at" TIMESTAMPTZ(6) NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "released_by_id" UUID,
    "release_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "legal_hold_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "legal_hold"
  ADD CONSTRAINT "legal_hold_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "legal_hold"
  ADD CONSTRAINT "legal_hold_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ix_legal_hold_document" ON "legal_hold" ("tenant_id", "document_id");

-- "Is this document held" is asked by every delete and every disposition, and a released hold
-- answers it with a no — so the index holds only the rows that can answer yes.
CREATE INDEX "ix_legal_hold_live" ON "legal_hold" ("tenant_id", "document_id")
  WHERE "released_at" IS NULL;

-- A hold with no stated matter is a hold nobody can ever justify releasing.
ALTER TABLE "legal_hold"
  ADD CONSTRAINT "ck_legal_hold_reason" CHECK (length(btrim("reason")) > 0);

-- A released hold names who released it. Half a release is a hold whose state nobody can read.
ALTER TABLE "legal_hold"
  ADD CONSTRAINT "ck_legal_hold_released"
  CHECK (("released_at" IS NULL) = ("released_by_id" IS NULL));

-- --- The tombstone ---------------------------------------------------------------------------

CREATE TABLE "document_tombstone" (
    "document_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_number" TEXT,
    "title" TEXT NOT NULL,
    "document_type_id" UUID,
    "document_type_name" TEXT,
    "folder_path" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "purged_at" TIMESTAMPTZ(6) NOT NULL,
    "purged_by_id" UUID,
    "schedule_id" UUID,
    "policy_id" UUID,
    "approved_by_id" UUID,
    "revisions_removed" INTEGER NOT NULL DEFAULT 0,
    "blobs_dereferenced" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_tombstone_pkey" PRIMARY KEY ("document_id")
);

ALTER TABLE "document_tombstone"
  ADD CONSTRAINT "document_tombstone_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Deliberately *no* foreign key to `document`, `retention_schedule`, `retention_policy` or
-- `document_type`. Every one of them is a row this table is designed to outlive: the document is
-- gone by the time this row is committed, and a type or a policy may be deleted years later. A
-- reference that could be broken by a later delete is a reference that would either block that
-- delete or leave this row unreadable, and both defeat the purpose of a tombstone.

CREATE INDEX "ix_tombstone_tenant" ON "document_tombstone" ("tenant_id", "purged_at" DESC);

-- The number stays unique among tombstones for the same reason it is unique among documents: it is
-- never re-issued, and two rows claiming the same one would mean it was.
CREATE UNIQUE INDEX "uq_tombstone_number" ON "document_tombstone" ("tenant_id", "document_number");
