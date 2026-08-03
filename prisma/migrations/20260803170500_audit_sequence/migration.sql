-- Per-tenant, gap-free audit sequence (docs/architecture/13-audit-architecture.md §3).
--
-- The hash chain proves no record was altered. It cannot, by itself, prove that none was
-- removed from the end: truncate the last k events and what remains still chains perfectly.
-- A contiguous per-tenant sequence is what makes that hole visible.
--
-- Added nullable, backfilled in occurrence order per tenant, then made NOT NULL — so an
-- environment that already holds audit rows keeps them and comes out with a valid chain
-- position for each.

ALTER TABLE "audit_event" ADD COLUMN "sequence" BIGINT;

UPDATE "audit_event" AS e
SET "sequence" = numbered.position
FROM (
  SELECT "id",
         row_number() OVER (PARTITION BY "tenant_id" ORDER BY "occurred_at", "id") AS position
  FROM "audit_event"
) AS numbered
WHERE e."id" = numbered."id";

ALTER TABLE "audit_event" ALTER COLUMN "sequence" SET NOT NULL;

-- Makes a duplicate position impossible even if two writers bypass the advisory lock that
-- normally serialises them.
CREATE UNIQUE INDEX "uq_audit_tenant_sequence" ON "audit_event" ("tenant_id", "sequence");
