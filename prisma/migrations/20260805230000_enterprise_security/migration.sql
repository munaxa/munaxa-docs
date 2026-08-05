-- Phase 14 — enterprise security: the ACL entries ADR-0005 has described since Phase 0, and the
-- second factor `user.mfa_enrolled` has been asserting the absence of for just as long.
--
-- --- `acl_entry` -------------------------------------------------------------------------------
--
-- `08-permission-model.md` §3's steps 3–5 have found nothing since Phase 8 bound the resolver,
-- because the table they read did not exist. It does now, and the model does not change: capability
-- still comes from `role_permission` and reach comes from here, and both must be satisfied.
--
-- Three properties are the ADR's rules made structural rather than validated.
--
-- **One entry per (subject, permission, node).** `uq_acl_entry` means `ALLOW` and `DENY` for the
-- same triple cannot coexist, so the walk never breaks a tie *at* a node — every tie it resolves is
-- between nodes, which is where deny-wins applies and where it is auditable by inspection.
--
-- **No soft delete.** Every other tenant-scoped table here carries `deleted_at`; this one does not,
-- and the omission is deliberate. A revoked ACL entry has no reader — nothing in the product asks
-- "what could this person reach before Tuesday" of a live table — and keeping tombstones would put
-- a `deleted_at IS NULL` on the hottest predicate in the product forever. The revocation's record is
-- the `ACL_REVOKED` audit event, which is append-only, hash-chained and attests its own payload.
--
-- **`scope_id` is never null.** A `TENANT` entry carries the tenant's own id, so the walk's
-- `scope_id IN (…)` needs no special case for the root and the index covers every level equally.
--
-- The two indexes are the two questions asked of this table. `ix_acl_entry_scope` serves the walk —
-- "every entry on these seven nodes for this permission" — and `ix_acl_entry_subject` serves
-- `visibilityFilter` and the permissions screen — "where does this subject reach". Neither is
-- partial: unlike `delegation`, this table has no history half, because a revocation removes the
-- row.
--
-- --- `mfa_enrolment` and `mfa_recovery_code` ---------------------------------------------------
--
-- `user.mfa_enrolled` has existed since Phase 1, read by the auth response and the admin view and
-- written by nothing — a column that has answered "no" for thirteen phases whatever the truth was.
-- The secret lives in its own table rather than beside it because `user` is read by the directory,
-- the recipient walk and every admin list, and a secret on that row is one careless projection away
-- from a payload. The boolean stays where it is and becomes derived: written in the same
-- transaction that confirms an enrolment, so nothing reading it has to learn a new column.
--
-- Recovery codes are hashed with the same hasher `credential.password_hash` uses, because a
-- recovery code *is* a second password: a database read that discloses one bypasses the factor it
-- backs up. `used_at` rather than a delete, so "how many have I burned" is a count rather than an
-- inference.
--
-- Row-level security is not written here. `infra/sql/post-migrate/01-tenant-isolation.sql`
-- discovers every table in `public` carrying `tenant_id`, applies FORCE ROW LEVEL SECURITY and the
-- `tenant_isolation` policy, and raises if one is missed. All three tables carry `tenant_id`, so
-- they are protected by construction rather than by remembering.

CREATE TYPE "acl_scope_type" AS ENUM ('TENANT', 'COMPANY', 'ENTITY', 'DEPARTMENT', 'LIBRARY', 'FOLDER', 'DOCUMENT');
CREATE TYPE "acl_subject_type" AS ENUM ('USER', 'ROLE', 'DEPARTMENT');
CREATE TYPE "acl_effect" AS ENUM ('ALLOW', 'DENY');

CREATE TABLE "acl_entry" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope_type" "acl_scope_type" NOT NULL,
    "scope_id" UUID NOT NULL,
    "subject_type" "acl_subject_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,
    "effect" "acl_effect" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "acl_entry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_acl_entry"
  ON "acl_entry" ("tenant_id", "scope_type", "scope_id", "subject_type", "subject_id", "permission");
CREATE INDEX "ix_acl_entry_scope" ON "acl_entry" ("tenant_id", "scope_id", "permission");
CREATE INDEX "ix_acl_entry_subject" ON "acl_entry" ("tenant_id", "subject_id", "permission");

ALTER TABLE "acl_entry"
  ADD CONSTRAINT "acl_entry_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- MFA ---------------------------------------------------------------------------------------

CREATE TABLE "mfa_enrolment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "secret" TEXT NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),
    "last_step" BIGINT,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "mfa_enrolment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_mfa_enrolment_user" ON "mfa_enrolment" ("user_id");

ALTER TABLE "mfa_enrolment"
  ADD CONSTRAINT "mfa_enrolment_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mfa_enrolment"
  ADD CONSTRAINT "mfa_enrolment_user_id_fkey" FOREIGN KEY ("user_id")
  REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "mfa_recovery_code" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "enrolment_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_code_pkey" PRIMARY KEY ("id")
);

-- "Which of this enrolment's codes are still live", which is the only question asked of it.
CREATE INDEX "ix_mfa_recovery_code_live"
  ON "mfa_recovery_code" ("tenant_id", "enrolment_id", "used_at");

ALTER TABLE "mfa_recovery_code"
  ADD CONSTRAINT "mfa_recovery_code_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Cascading, unlike everything else in this migration: a recovery code has no meaning without the
-- enrolment it backs up, and un-enrolling is an act somebody takes about their own account. The
-- `MFA_ENROLLED` audit row records the un-enrolment; the codes it invalidated are not evidence.
ALTER TABLE "mfa_recovery_code"
  ADD CONSTRAINT "mfa_recovery_code_enrolment_id_fkey" FOREIGN KEY ("enrolment_id")
  REFERENCES "mfa_enrolment" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
