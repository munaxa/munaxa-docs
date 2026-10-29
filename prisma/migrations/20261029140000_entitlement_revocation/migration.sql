-- Platform ADR-0022: the revocation list in force for an on-premises tenant.
--
-- An installation receives a signed revocation list (`mxr1`) next to its licence. The newest one it
-- verified is kept here, so deleting the file, or offering an older list, does not undo a
-- revocation, across restarts too. `revocation_sequence` only grows: the writer updates only when
-- the new one is higher. Both are set together or not at all.
--
-- Additive. No existing row changes. Row-level security already covers the table
-- (infra/sql/post-migrate/01-tenant-isolation.sql).

ALTER TABLE "entitlement_state"
    ADD COLUMN "revocation_list" TEXT,
    ADD COLUMN "revocation_sequence" INTEGER,
    ADD CONSTRAINT "ck_entitlement_state_revocation_pair"
        CHECK (("revocation_list" IS NULL) = ("revocation_sequence" IS NULL)),
    ADD CONSTRAINT "ck_entitlement_state_revocation_sequence"
        CHECK ("revocation_sequence" IS NULL OR "revocation_sequence" >= 1);
