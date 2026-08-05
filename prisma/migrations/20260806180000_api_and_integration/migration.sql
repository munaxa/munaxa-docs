-- Phase 17 — API and integration: five tables, four enums, and five columns on two existing
-- tables. Everything else in the phase is behaviour over what already exists.
--
-- --- The column whose absence was the phase's first finding ------------------------------------
--
-- `user.password_hash` has been nullable since Phase 1, and **nothing anywhere recorded where an
-- identity came from**. A row with no password could equally be an invitation nobody has accepted
-- or somebody who signs in through Entra ID, and no query could tell them apart. `identity_source`,
-- `external_id`, `identity_provider_id` and `federated_at` are that gap closed. The default is
-- `LOCAL`, so every existing row is correctly described by the migration that adds the column.
--
-- --- Why `api_client.subject_user_id` is NOT NULL ----------------------------------------------
--
-- ADR-0018. A machine caller is a *delegated subject*: `RequestContext.userId` is the person the
-- key acts as, so every reach predicate in the product — `visibilityCondition`, `whereFor`,
-- `ACL_RESOLVER` — is unchanged and none of them has to learn what a machine is. A nullable column
-- would make the alternative representable, and the alternative is severe rather than merely
-- wrong: `PrismaDocumentRepository.visibilityCondition` answers a subject-less caller with an
-- **empty predicate**, which is every document in the tenant. Phase 15 found that in the export
-- lane and worked around it; here the schema forbids it.
--
-- --- Why `audit_event.api_client_id` is a column rather than a payload field --------------------
--
-- The chain's digest covers columns. 13 §4's argument for `reason` applies unchanged: a value in
-- `jsonb` is attested only as part of a blob the verifier cannot address, and "which credential
-- took this action" is the first question an incident asks. `chain_hash_version` 3 covers it, and
-- rows already written keep verifying under 1 and 2 because the table refuses `UPDATE` to every
-- role including the owner — which is exactly why widening has to be versioned rather than
-- retrospective.
--
-- --- Why the webhook and provider secrets are stored in clear -----------------------------------
--
-- Every other secret in this schema is a digest, because every other secret authenticates somebody
-- *to us* and a digest is enough to check one. These do not. A webhook signature is computed from
-- its key on every delivery and an OIDC token exchange presents its client secret, so a one-way
-- digest could not produce either. They are shared secrets with a counterparty, never returned by
-- any read path after creation, and rotating one is a new value rather than a re-derivation.
--
-- --- What is not here --------------------------------------------------------------------------
--
-- No SAML columns: there is no XML parser in this lockfile at any level and the lockfile cannot
-- gain one, so `identity_provider_kind` has one value and adding `SAML` later is a migration
-- rather than a redesign. No LDAP: a wire protocol is not an HTTP redirect flow and needs a
-- dependency that is equally absent. No WebAuthn: `cbor` is absent from the store entirely and
-- Phase 14's row stays open. No quota column on any of these — ADR-0012's and Phase 21's, as
-- Phases 10, 13, 15 and 16 have each recorded.
--
-- Row-level security is not written here. `infra/sql/post-migrate/01-tenant-isolation.sql`
-- discovers every table carrying `tenant_id` and forces a policy onto it, which is why all five of
-- these carry one and why a hand-maintained list was refused in Phase 0.5.

-- CreateEnum
CREATE TYPE "webhook_delivery_state" AS ENUM ('PENDING', 'DELIVERED', 'RETRYING', 'DEAD');

-- CreateEnum
CREATE TYPE "identity_provider_kind" AS ENUM ('OIDC');

-- CreateEnum
CREATE TYPE "identity_source" AS ENUM ('LOCAL', 'FEDERATED');

-- CreateEnum
CREATE TYPE "audit_sink_kind" AS ENUM ('PULL', 'PUSH');

-- AlterEnum
ALTER TYPE "audit_subject_type" ADD VALUE 'INTEGRATION';

-- AlterTable
ALTER TABLE "audit_event" ADD COLUMN "api_client_id" UUID;

-- AlterTable
ALTER TABLE "user" ADD COLUMN "identity_source" "identity_source" NOT NULL DEFAULT 'LOCAL',
ADD COLUMN "external_id" TEXT,
ADD COLUMN "identity_provider_id" UUID,
ADD COLUMN "federated_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "api_client" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "key_prefix" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "subject_user_id" UUID NOT NULL,
    "scopes" TEXT[],
    "expires_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "api_client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoint" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "event_types" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "disabled_at" TIMESTAMPTZ(6),
    "disabled_reason" TEXT,
    "last_success_at" TIMESTAMPTZ(6),
    "last_failure_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "webhook_endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_delivery" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "state" "webhook_delivery_state" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "response_status" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_provider" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "identity_provider_kind" NOT NULL DEFAULT 'OIDC',
    "name" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "discovery_url" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT NOT NULL,
    "domains" TEXT[],
    "claim_mapping" JSONB NOT NULL DEFAULT '{}',
    "role_mappings" JSONB NOT NULL DEFAULT '[]',
    "default_role_keys" TEXT[],
    "jit_provisioning" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "identity_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_sink" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "audit_sink_kind" NOT NULL DEFAULT 'PULL',
    "name" TEXT NOT NULL,
    "endpoint_url" TEXT,
    "secret" TEXT,
    "actions" TEXT[],
    "last_streamed_sequence" BIGINT NOT NULL DEFAULT 0,
    "last_streamed_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "audit_sink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_api_client_prefix" ON "api_client"("tenant_id", "key_prefix");

-- CreateIndex
CREATE INDEX "ix_api_client_subject" ON "api_client"("tenant_id", "subject_user_id");

-- CreateIndex
CREATE INDEX "ix_webhook_endpoint_enabled" ON "webhook_endpoint"("tenant_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "uq_webhook_delivery_event" ON "webhook_delivery"("endpoint_id", "event_id");

-- CreateIndex
CREATE INDEX "ix_webhook_delivery_due" ON "webhook_delivery"("tenant_id", "state", "next_attempt_at");

-- CreateIndex
CREATE INDEX "ix_webhook_delivery_endpoint" ON "webhook_delivery"("tenant_id", "endpoint_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_identity_provider_tenant" ON "identity_provider"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_audit_sink_tenant" ON "audit_sink"("tenant_id");

-- CreateIndex
--
-- No `WHERE deleted_at IS NULL`, and that is a property of the columns rather than an omission:
-- PostgreSQL treats NULLs as distinct in a unique index, and every local user has a NULL provider
-- and a NULL external id. The constraint therefore binds exactly the federated rows — one provider
-- subject can never become two accounts — and ignores every password account.
CREATE UNIQUE INDEX "uq_user_external_identity" ON "user"("tenant_id", "identity_provider_id", "external_id");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_identity_provider_id_fkey" FOREIGN KEY ("identity_provider_id") REFERENCES "identity_provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_client" ADD CONSTRAINT "api_client_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_client" ADD CONSTRAINT "api_client_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_provider" ADD CONSTRAINT "identity_provider_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_sink" ADD CONSTRAINT "audit_sink_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
