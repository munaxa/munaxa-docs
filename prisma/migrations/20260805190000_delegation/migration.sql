-- Phase 11 — delegation: the routing overlay of `07-workflow-architecture.md` §4.
--
-- One table and one column, and the column is the smaller half of the phase's named risk.
--
-- `delegation` is `05-database-design.md` §3's row, built for the first time. Three of §4's six
-- rules are constraints here rather than validations somebody can route around: the period is
-- ordered, an emergency delegation has a stated ground, and a chain is at most one hop deep. The
-- fourth — how long a period may be — is deliberately *not* here, because it is a tenant setting
-- and a check constraint cannot read one. The fifth and sixth — authority at decision time, and
-- revocation reverting in-flight tasks — are behaviour and live in the use case.
--
-- `approval_task.delegation_id` is the link between a decision and the arrangement that authorised
-- it, and it is `ON DELETE RESTRICT` for a specific reason: a revoked delegation is exactly the one
-- an investigation asks about. Revocation and expiry are status changes on this table, never
-- deletions, and the restricting key makes that a property rather than a convention — the row
-- cannot go while any decision points at it.
--
-- What the key is *not* is the attestation. Phase 9 widened the chain's digest to version 2 to
-- cover `on_behalf_of_id`; it does not cover a column added after it, and the table refuses the
-- `UPDATE` that would rehash the trail. So the queryable link is here and the *attested* record is
-- the `DELEGATION_USED` audit row written in the same transaction as the decision — chained,
-- addressable, and filed against the delegation so "everything done under this arrangement" is a
-- trail query rather than a join.
--
-- Every index is partial, on the rows the question is actually about. A tenant's delegation table
-- is almost entirely history within a year — a delegation is a fortnight's arrangement, not a row
-- per document — and the three questions asked of it are all about the handful in force.
--
-- Row-level security is not written here. `infra/sql/post-migrate/01-tenant-isolation.sql`
-- discovers every table in `public` carrying `tenant_id` and applies FORCE ROW LEVEL SECURITY and
-- the `tenant_isolation` policy, and its gate raises if one is missed. `delegation` carries
-- `tenant_id`, so it is protected by construction rather than by remembering.

CREATE TYPE "delegation_status" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'DECLINED', 'REVOKED', 'EXPIRED');
CREATE TYPE "delegation_kind" AS ENUM ('STANDARD', 'EMERGENCY');

CREATE TABLE "delegation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "delegator_id" UUID NOT NULL,
    "delegate_id" UUID NOT NULL,
    "kind" "delegation_kind" NOT NULL DEFAULT 'STANDARD',
    "status" "delegation_status" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "permissions" TEXT[] NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "decline_reason" TEXT,
    "revoked_by_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "delegation_pkey" PRIMARY KEY ("id")
);

-- §4: "bounded; open-ended delegations are refused". The *length* is a tenant setting; the
-- ordering is structure, and a row whose period runs backwards authorises nothing coherent.
ALTER TABLE "delegation"
  ADD CONSTRAINT "ck_delegation_period" CHECK ("ends_at" > "starts_at");

-- Nobody delegates to themselves. The cycle walk in `@edms/domain` refuses it as the degenerate
-- one-node cycle; this is the same refusal where no code has to run for it to hold.
ALTER TABLE "delegation"
  ADD CONSTRAINT "ck_delegation_distinct" CHECK ("delegator_id" <> "delegate_id");

-- §4: "one hop, never a cycle". The hop count is not configurable — a tenant that could raise it
-- could build a chain nobody can read — so the bound is here rather than in a setting.
ALTER TABLE "delegation"
  ADD CONSTRAINT "ck_delegation_depth" CHECK ("depth" >= 0 AND "depth" <= 1);

-- An emergency delegation bypasses the approval; it does not bypass the audit. The ground is
-- mandatory at the table, so the one path that skips a control cannot also skip its own record.
ALTER TABLE "delegation"
  ADD CONSTRAINT "ck_delegation_emergency_reason"
  CHECK ("kind" <> 'EMERGENCY' OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0));

-- A declined delegation states why, and an approved one names who approved it. Both are the
-- difference between a decision and a status somebody set.
ALTER TABLE "delegation"
  ADD CONSTRAINT "ck_delegation_declined_reason"
  CHECK ("status" <> 'DECLINED' OR ("decline_reason" IS NOT NULL AND length(btrim("decline_reason")) > 0));

ALTER TABLE "delegation"
  ADD CONSTRAINT "ck_delegation_revoked"
  CHECK (
    "status" <> 'REVOKED'
    OR ("revoked_at" IS NOT NULL AND "revoke_reason" IS NOT NULL AND length(btrim("revoke_reason")) > 0)
  );

ALTER TABLE "delegation"
  ADD CONSTRAINT "delegation_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "delegation"
  ADD CONSTRAINT "delegation_delegator_id_fkey" FOREIGN KEY ("delegator_id")
  REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "delegation"
  ADD CONSTRAINT "delegation_delegate_id_fkey" FOREIGN KEY ("delegate_id")
  REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The authority predicate's own index, and the only one on the hot path: "which delegations let
-- this person act, right now". Partial on the live rows — a delegation table is almost all history.
CREATE INDEX "ix_delegation_delegate" ON "delegation" ("tenant_id", "delegate_id", "status")
  WHERE "status" = 'ACTIVE';

-- "What have I given away", plus the approval queue's lookup of a request's delegator. Not partial
-- on `ACTIVE`: this one serves the register as well as the working list, and the register is the
-- history the other index deliberately excludes.
CREATE INDEX "ix_delegation_delegator" ON "delegation" ("tenant_id", "delegator_id", "status");

-- The nightly sweep: which delegations in force have run out. Partial for the same reason, and
-- ascending because the sweep reads the oldest expiries first and stops.
CREATE INDEX "ix_delegation_expiry" ON "delegation" ("tenant_id", "ends_at")
  WHERE "status" = 'ACTIVE';

-- --- The link between a decision and the arrangement that authorised it -----------------------

ALTER TABLE "approval_task" ADD COLUMN "delegation_id" UUID;

-- RESTRICT, deliberately: the delegation a decision was taken under can never be deleted. §4's
-- visibility rule — "the delegator sees every action taken on their behalf" — has to keep holding
-- after the delegation is revoked, and a revoked delegation is the one somebody comes looking for.
ALTER TABLE "approval_task"
  ADD CONSTRAINT "approval_task_delegation_id_fkey" FOREIGN KEY ("delegation_id")
  REFERENCES "delegation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- "Everything decided under this delegation", which is the delegation history screen and the
-- investigation's first query. Partial: a delegated decision is a small minority of tasks.
CREATE INDEX "ix_approval_task_delegation" ON "approval_task" ("tenant_id", "delegation_id")
  WHERE "delegation_id" IS NOT NULL;

-- A decision taken on somebody's behalf names all three of them, or none. A row with a delegation
-- but no delegator — or the reverse — is a trail that cannot answer "who decided, and for whom",
-- which is the single question §4 says delegation exists to keep answerable.
ALTER TABLE "approval_task"
  ADD CONSTRAINT "ck_approval_task_delegation_pair"
  CHECK (("delegation_id" IS NULL) = ("on_behalf_of_id" IS NULL));

-- --- The subject type ------------------------------------------------------------------------

-- A delegation is not a `USER`, for the reason an evidence bundle was not a `DOCUMENT` in Phase 9.
-- A delegation is an arrangement *between* two people, and filing its four actions under the user
-- type would put them on somebody's user timeline with no honest answer to whose — the delegator's
-- would hide from the delegate every record of an authority they were given.
--
-- `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in PostgreSQL before 12; this
-- cluster is 16, where it can, and the migration runner wraps each file in one. `IF NOT EXISTS`
-- keeps the file re-runnable, which is what the post-migrate discipline assumes of everything here.
ALTER TYPE "audit_subject_type" ADD VALUE IF NOT EXISTS 'DELEGATION';
