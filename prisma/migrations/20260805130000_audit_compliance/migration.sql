-- Phase 9 — audit and compliance: the read path, verification and evidence export.
--
-- Three things arrive here, and the first is the one worth reading carefully.
--
-- `chain_hash_version` widens what the digest attests. Phase 1's digest covered nine fields and
-- left `sequence`, `channel`, `on_behalf_of_id`, `reason`, `correlation_id`, `ip_address` and
-- `user_agent` uncovered — so a bundle that claimed to prove a stated reason for access, or which
-- delegate acted, would have been claiming more than the chain proved. The widening is versioned
-- rather than retrospective because existing rows *cannot* be rehashed: `audit_event` refuses
-- `UPDATE` to every role including the owner, and that refusal is the property the whole design
-- exists for. Adding the column with a default is DDL and does not fire the row trigger, so every
-- existing row is stamped `1` without a single row update, and keeps verifying against the field
-- set it was written under.
--
-- `ix_audit_action` is what makes §6's audit search a search rather than a scan. The other three
-- indexes answer "this document", "this person" and "this request"; nothing answered "this kind of
-- event", which is how a compliance report asks its questions.
--
-- `audit_export` is a job, not audit data: mutable, retryable, and soft-deletable with the rest of
-- the derived artefacts. What is immutable is the trail it was made from, which is why the bundle
-- carries a signed manifest rather than this row carrying a hash.

-- An evidence bundle is not a DOCUMENT: it is an artefact *about* documents, with its own
-- identifier and its own download. Filing `AUDIT_EXPORTED` under the document type would put the
-- row in the timeline of whichever document happened to be first in the range.
ALTER TYPE "audit_subject_type" ADD VALUE 'EXPORT';

CREATE TYPE "audit_export_state" AS ENUM ('REQUESTED', 'RUNNING', 'COMPLETED', 'FAILED');

ALTER TABLE "audit_event"
  ADD COLUMN "chain_hash_version" SMALLINT NOT NULL DEFAULT 1;

CREATE INDEX "ix_audit_action" ON "audit_event" ("tenant_id", "action", "occurred_at" DESC);

CREATE TABLE "audit_export" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "state" "audit_export_state" NOT NULL DEFAULT 'REQUESTED',
    "from_date" TIMESTAMPTZ(6) NOT NULL,
    "to_date" TIMESTAMPTZ(6) NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "requested_by_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "storage_prefix" TEXT,
    "artefacts" JSONB NOT NULL DEFAULT '[]',
    "chain_intact" BOOLEAN,
    "broken_at_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "audit_export_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ix_audit_export_tenant" ON "audit_export" ("tenant_id", "requested_at" DESC);

ALTER TABLE "audit_export"
  ADD CONSTRAINT "audit_export_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
