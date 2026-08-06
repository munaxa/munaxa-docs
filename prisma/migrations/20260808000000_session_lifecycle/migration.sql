-- P4.4 stage 2 — session families gain a lifecycle.
--
-- Today a `session_family` is valid until something revokes it. Nothing expires it: a family whose
-- tokens keep rotating stays live forever, so a stolen refresh token that the thief keeps warm is
-- a permanent credential. That is the gap this closes, and it is the phase's absolute requirement:
-- a family must never remain valid indefinitely.
--
-- Two deadlines, because one is not enough. `idle_expires_at` moves forward on each rotation and
-- kills a lineage that stops being used. `absolute_expires_at` never moves and kills one that is
-- kept artificially alive — which is precisely the attacker's behaviour, and precisely what an
-- idle timeout alone cannot catch.
--
-- Expand only: every column has a default or is backfilled here, so the running release — which
-- reads none of them — keeps working and this deploys ahead of the code that does
-- (20 §4's expand → migrate → contract).

ALTER TABLE "session_family"
  ADD COLUMN "last_seen_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  ADD COLUMN "idle_expires_at"     TIMESTAMPTZ(6),
  ADD COLUMN "absolute_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "auth_methods"        TEXT[]  NOT NULL DEFAULT ARRAY['password']::TEXT[],
  ADD COLUMN "mfa_satisfied"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "token_version"       INTEGER NOT NULL DEFAULT 0;

-- Backfill from *now*, not from `created_at`.
--
-- Dating the deadlines from creation would expire every family older than the absolute window the
-- instant this lands — a fleet-wide forced sign-out on deploy, for a change whose entire purpose is
-- to bound sessions rather than to end them. Measuring from now gives every existing family one
-- fresh window and no more: the invariant holds from the first day, and the estate drains into it
-- within a single absolute period instead of all at once.
--
-- The windows match the defaults the application resolves (30 days), so a family created a second
-- before this migration and one created a second after it are treated identically.
UPDATE "session_family"
   SET "last_seen_at"        = now(),
       "idle_expires_at"     = now() + INTERVAL '30 days',
       "absolute_expires_at" = now() + INTERVAL '30 days'
 WHERE "revoked_at" IS NULL;

-- A revoked family is already dead; give it deadlines in the past rather than a live window, so
-- nothing can read one as valid if a future revocation check is ever missed. Defence in depth
-- against a bug that does not exist yet, at the cost of one UPDATE.
UPDATE "session_family"
   SET "last_seen_at"        = COALESCE("revoked_at", "created_at"),
       "idle_expires_at"     = COALESCE("revoked_at", "created_at"),
       "absolute_expires_at" = COALESCE("revoked_at", "created_at")
 WHERE "revoked_at" IS NOT NULL;

-- Now that every row has values, the deadlines become mandatory: a family with no expiry is the
-- state this migration exists to make unrepresentable.
ALTER TABLE "session_family"
  ALTER COLUMN "idle_expires_at"     SET NOT NULL,
  ALTER COLUMN "absolute_expires_at" SET NOT NULL;

-- Serves the concurrency-limit query, which is the one that runs on every sign-in and is the only
-- one that must be fast under contention: live families for a user, ordered oldest-seen first so
-- eviction picks its victim without a sort.
--
-- Partial on `revoked_at IS NULL` because revoked rows are never counted toward a limit and are the
-- majority of the table over time.
CREATE INDEX "ix_session_family_live"
    ON "session_family" ("tenant_id", "user_id", "last_seen_at")
 WHERE "revoked_at" IS NULL;

-- Serves the expiry sweep: whatever is past its absolute deadline, across tenants.
CREATE INDEX "ix_session_family_absolute_expiry"
    ON "session_family" ("absolute_expires_at")
 WHERE "revoked_at" IS NULL;
