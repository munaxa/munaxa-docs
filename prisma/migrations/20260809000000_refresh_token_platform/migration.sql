-- P4.4B — refresh tokens gain the fields Platform authentication reads.
--
-- `@munaxa/auth`'s RefreshTokenService owns rotation from here. Its record carries five things
-- this table did not: who the token belongs to, what replaced it, whether it was revoked and why,
-- and the credential version it was minted against.
--
-- `used_at` becomes `rotated_at`. Same meaning — set the moment the token is exchanged — and the
-- rename is what lets the platform's compare-and-swap predicate address the column directly
-- instead of through a product-specific alias.
--
-- The token *hash* is deliberately untouched. Docs stored sha256(token) as hex; the platform's
-- `tokenFingerprint` with no pepper is the same function, so every live refresh token keeps
-- resolving across this deploy. Introducing a pepper here would have been a silent fleet-wide
-- sign-out, which is why the service is wired without one.

ALTER TABLE "refresh_token" RENAME COLUMN "used_at" TO "rotated_at";

-- The platform mints its own record ids (`rt_…`, time-sortable) and, during rotation, mints the
-- replacement's id internally — so it cannot be injected the way the session id can. The column
-- widens to text rather than the platform being bent to this product's format. Existing UUID
-- strings remain valid text, so no row is rewritten and no reference breaks.
ALTER TABLE "refresh_token" ALTER COLUMN "id" TYPE TEXT;

ALTER TABLE "refresh_token"
  ADD COLUMN "user_id"           UUID,
  ADD COLUMN "replaced_by"       TEXT,
  ADD COLUMN "revoked_at"        TIMESTAMPTZ(6),
  ADD COLUMN "revocation_reason" TEXT,
  ADD COLUMN "token_version"     INTEGER NOT NULL DEFAULT 0;

-- Backfill the owner from the family, which has always known it. Done before the NOT NULL below,
-- so the constraint describes the data rather than breaking on it.
UPDATE "refresh_token" AS t
   SET "user_id" = f."user_id"
  FROM "session_family" AS f
 WHERE f."id" = t."family_id"
   AND t."user_id" IS NULL;

-- Any token whose family vanished has no owner and no lineage to belong to. There should be none
-- — the foreign key cascades — but deleting is the honest handling of a row that cannot be made
-- valid, and it keeps the NOT NULL below truthful.
DELETE FROM "refresh_token" WHERE "user_id" IS NULL;

ALTER TABLE "refresh_token" ALTER COLUMN "user_id" SET NOT NULL;

-- Serves the two queries the refresh path runs: revoke every live token in a family, and revoke
-- every live token for a user. Partial, because a revoked or rotated token is never a target.
CREATE INDEX "ix_refresh_token_live_family"
    ON "refresh_token" ("tenant_id", "family_id")
 WHERE "revoked_at" IS NULL AND "rotated_at" IS NULL;

CREATE INDEX "ix_refresh_token_live_user"
    ON "refresh_token" ("tenant_id", "user_id")
 WHERE "revoked_at" IS NULL AND "rotated_at" IS NULL;
