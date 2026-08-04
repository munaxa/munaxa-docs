-- Phase 6 — revision control.
--
-- Three things arrive here: the check-out lock, what publication writes onto a revision, and
-- the constraint that makes "exactly one published revision" a property of the database rather
-- than a promise of the code that usually runs.

-- A draft abandoned when its check-out was cancelled or replaced. Retained in history: its
-- ordinal is spent, never reissued, and a history with a gap is unusable as evidence — so the
-- row stays and says what became of it (`10-revision-architecture.md` §3).
ALTER TYPE "revision_status" ADD VALUE 'DISCARDED';

-- How a lock ended. A closed set rather than free text, because "who released this and why"
-- is a question a compliance report groups by; the free-text half is `release_note`.
CREATE TYPE "document_lock_release_reason" AS ENUM ('CHECKED_IN', 'CANCELLED', 'FORCED', 'EXPIRED');

-- What publication writes onto a revision, and what restore records.
ALTER TABLE "document_revision"
  ADD COLUMN "published_at" TIMESTAMPTZ(6),
  ADD COLUMN "effective_from" DATE,
  ADD COLUMN "effective_to" DATE,
  ADD COLUMN "restored_from_revision_id" UUID,
  ADD COLUMN "metadata_snapshot" JSONB;

ALTER TABLE "document_revision" ADD CONSTRAINT "document_revision_restored_from_revision_id_fkey"
  FOREIGN KEY ("restored_from_revision_id") REFERENCES "document_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The effective window is a window: a `to` without a `from` is not a window, and one that ends
-- before it starts is somebody's transposition.
ALTER TABLE "document_revision" ADD CONSTRAINT "ck_revision_effective_window"
  CHECK ("effective_to" IS NULL OR ("effective_from" IS NOT NULL AND "effective_to" >= "effective_from"));

-- A revision is or was effective exactly when it records the instant it became so. `SUPERSEDED`
-- keeps its `published_at` — when it *was* published is half of its history — and nothing that
-- never published may carry one.
ALTER TABLE "document_revision" ADD CONSTRAINT "ck_revision_published_state"
  CHECK (("status" IN ('PUBLISHED', 'SUPERSEDED')) = ("published_at" IS NOT NULL));

-- Exactly one published revision per document, held by the database.
--
-- `uq_document_current_revision` already holds the other half — no revision is current of two
-- documents. This is the half concurrent publishes contend on: partial on `PUBLISHED`, the same
-- shape as `uq_workflow_instance_live`, so two publications racing on one document produce one
-- published revision and one refusal, whatever the code above believed it had read.
CREATE UNIQUE INDEX "uq_revision_published" ON "document_revision" ("document_id")
  WHERE "status" = 'PUBLISHED';

-- The check-out lock: one person's exclusive claim on producing a document's next revision.
--
-- A row per check-out rather than a flag on the document, because the history is the point:
-- who held it, since when, how it ended and why are the questions §3 of
-- `10-revision-architecture.md` says a lock must answer, and a boolean answers none of them.
CREATE TABLE "document_lock" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "locked_by" UUID NOT NULL,
  "checked_out_revision_id" UUID,
  "draft_revision_id" UUID,
  "acquired_at" TIMESTAMPTZ(6) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "released_at" TIMESTAMPTZ(6),
  "released_by" UUID,
  "release_reason" "document_lock_release_reason",
  "release_note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "updated_by" UUID,
  "version" INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT "document_lock_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "document_lock" ADD CONSTRAINT "document_lock_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_lock" ADD CONSTRAINT "document_lock_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_lock" ADD CONSTRAINT "document_lock_locked_by_fkey"
  FOREIGN KEY ("locked_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_lock" ADD CONSTRAINT "document_lock_checked_out_revision_id_fkey"
  FOREIGN KEY ("checked_out_revision_id") REFERENCES "document_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_lock" ADD CONSTRAINT "document_lock_draft_revision_id_fkey"
  FOREIGN KEY ("draft_revision_id") REFERENCES "document_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One live lock per document.
--
-- The constraint this phase exists on top of. Two check-outs racing must produce one lock and
-- one refusal naming the holder, and that is a partial-unique-index question — the same shape
-- as `uq_workflow_instance_live` — never a read-then-check question: the check that ran a
-- moment earlier is a moment old. Partial on `released_at IS NULL`, so a document's history of
-- locks is unbounded, which is the point of keeping them.
CREATE UNIQUE INDEX "uq_document_lock_live" ON "document_lock" ("document_id")
  WHERE "released_at" IS NULL;

-- A lock is released exactly when it says why.
ALTER TABLE "document_lock" ADD CONSTRAINT "ck_document_lock_release"
  CHECK (("released_at" IS NULL) = ("release_reason" IS NULL));

-- A claim that lapses before it exists is a clock bug, found here rather than in a sweep.
ALTER TABLE "document_lock" ADD CONSTRAINT "ck_document_lock_expiry"
  CHECK ("expires_at" > "acquired_at");

-- The lock history of one document, newest first.
CREATE INDEX "ix_document_lock_document" ON "document_lock" ("tenant_id", "document_id", "acquired_at" DESC);

-- "What do I have checked out."
CREATE INDEX "ix_document_lock_holder" ON "document_lock" ("tenant_id", "locked_by");
