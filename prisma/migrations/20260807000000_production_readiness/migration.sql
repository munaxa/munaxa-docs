-- Phase 18 — production readiness.
--
-- The integrity sweep 17 §8 has promised since Phase 0 ("a rolling verifier … mismatch quarantines
-- and raises an incident") and 13 §2 has carried an audit action for since Phase 0 with nothing
-- writing it. What was missing was somewhere to record the finding.
--
-- Expand only: two columns with defaults and one index. Every existing row becomes UNVERIFIED,
-- which is the honest description of a blob nothing has read back — and it is also the sweep's
-- starting position, because `integrity_checked_at` is null and the index orders nulls first.
-- Old code ignores both columns, so this deploys ahead of the release that reads them
-- (20 §4's expand → migrate → contract).

CREATE TYPE "integrity_status" AS ENUM ('UNVERIFIED', 'VERIFIED', 'MISMATCH', 'UNREADABLE');

ALTER TABLE "file_object"
  ADD COLUMN "integrity_status" "integrity_status" NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN "integrity_checked_at" TIMESTAMPTZ(6);

-- Serves exactly one query: the sweep's "least recently verified first, never-verified before
-- everything else", per tenant. Named here because 19 §3 requires every index to state the query
-- it exists for.
CREATE INDEX "ix_file_object_integrity" ON "file_object" ("tenant_id", "integrity_checked_at");
