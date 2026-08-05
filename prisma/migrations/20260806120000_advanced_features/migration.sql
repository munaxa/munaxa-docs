-- Phase 16 — advanced document features: three capabilities that had no table, and no others.
--
-- `document_template` and `document_signature` appear nowhere in the Phase 0 architecture — no
-- table, no port, no ADR, no section in 03, 06 or 17. `bulk_operation` is the record five bulk
-- operations poll and audit against. Everything else this phase does — OCR, watermarks,
-- thumbnails, compare, storage deduplication — was built in Phases 3, 6 and 7 and needs no schema.
--
-- --- Why a signature is a row and not a column --------------------------------------------------
--
-- ADR-0017 decides that a signature here is a 21 CFR Part 11 §11.50 manifestation — printed name,
-- instant, meaning — bound under §11.70 to the content digest and witnessed by the server. A
-- `signed_by`/`signed_at` pair on `document_revision` would have been smaller and would have made
-- three things unrepresentable: two signatories with different meanings, a witness signature over
-- somebody else's, and a withdrawal that is itself dated and attributed. All three are ordinary in
-- a controlled-document regime.
--
-- `statement_body` stores the exact serialisation that was signed rather than rebuilding it at
-- verification time. That is Phase 9's rule about its evidence manifest, applied again: a
-- verification that reconstructs its own input depends on today's code producing the same string
-- as the code that signed, which is a property of a release rather than of a signature.
--
-- --- Why `bulk_operation_item.target_id` is not a foreign key -----------------------------------
--
-- The five operations name three different tables — documents, approval tasks, file objects — and
-- the record has to survive a purge that destroys the row it points at. `document_tombstone` took
-- the same shape in Phase 10 for the same reason.
--
-- --- What is not here --------------------------------------------------------------------------
--
-- No quota column, on any of these. Phases 10, 13 and 15 have each recorded that storage reports
-- bytes and never a quota; that is ADR-0012's and Phase 21's, and it stays true here.
--
-- Row-level security is not written below because it is not written anywhere: the post-migration
-- SQL discovers every table carrying `tenant_id` and forces a policy onto it, and refuses to finish
-- if one is left unprotected (`infra/sql/post-migrate/01-tenant-isolation.sql`). All four tables
-- below carry it.

-- CreateEnum
CREATE TYPE "bulk_operation_state" AS ENUM ('REQUESTED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "bulk_operation_kind" AS ENUM ('UPLOAD', 'METADATA', 'APPROVAL', 'RESTORE', 'EXPORT');

-- CreateEnum
CREATE TYPE "bulk_item_outcome" AS ENUM ('APPLIED', 'REFUSED', 'BLOCKED', 'FAILED');

-- CreateEnum
CREATE TYPE "signature_purpose" AS ENUM ('AUTHORSHIP', 'REVIEWED', 'APPROVAL', 'ACCEPTANCE', 'WITNESS');

-- DropIndex
DROP INDEX "ix_search_entry_acl";

-- DropIndex
DROP INDEX "ix_search_entry_approvers";

-- DropIndex
DROP INDEX "ix_search_entry_metadata";

-- DropIndex
DROP INDEX "ix_search_entry_number";

-- DropIndex
DROP INDEX "ix_search_entry_tsv";

-- DropIndex
DROP INDEX "ix_search_entry_shadow_acl";

-- DropIndex
DROP INDEX "ix_search_entry_shadow_approvers";

-- DropIndex
DROP INDEX "ix_search_entry_shadow_metadata";

-- DropIndex
DROP INDEX "ix_search_entry_shadow_number";

-- DropIndex
DROP INDEX "ix_search_entry_shadow_tsv";

-- CreateTable
CREATE TABLE "document_template" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "document_type_id" UUID NOT NULL,
    "category_id" UUID,
    "confidentiality_id" UUID NOT NULL,
    "default_folder_id" UUID,
    "file_object_id" UUID,
    "filename" TEXT,
    "defaultMetadata" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_signature" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "signer_user_id" UUID NOT NULL,
    "purpose" "signature_purpose" NOT NULL,
    "statement" TEXT,
    "content_sha256" TEXT NOT NULL,
    "statement_body" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'HMAC-SHA256',
    "key_id" TEXT NOT NULL,
    "signed_at" TIMESTAMPTZ(6) NOT NULL,
    "reauthenticated" BOOLEAN NOT NULL DEFAULT false,
    "withdrawn_at" TIMESTAMPTZ(6),
    "withdrawn_by" UUID,
    "withdrawn_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "document_signature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_operation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "bulk_operation_kind" NOT NULL,
    "state" "bulk_operation_state" NOT NULL DEFAULT 'REQUESTED',
    "requested_by_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "requested" INTEGER NOT NULL DEFAULT 0,
    "applied" INTEGER NOT NULL DEFAULT 0,
    "refused" INTEGER NOT NULL DEFAULT 0,
    "blocked" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "file_object_id" UUID,
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "bulk_operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_operation_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "outcome" "bulk_item_outcome" NOT NULL,
    "error_code" TEXT,
    "detail" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bulk_operation_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_document_template_active" ON "document_template"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "ix_document_template_type" ON "document_template"("tenant_id", "document_type_id");

-- CreateIndex
CREATE INDEX "ix_document_signature_revision" ON "document_signature"("tenant_id", "revision_id");

-- CreateIndex
CREATE INDEX "ix_document_signature_document" ON "document_signature"("tenant_id", "document_id", "signed_at" DESC);

-- CreateIndex
CREATE INDEX "ix_document_signature_signer" ON "document_signature"("tenant_id", "signer_user_id");

-- CreateIndex
CREATE INDEX "ix_bulk_operation_tenant" ON "bulk_operation"("tenant_id", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "ix_bulk_operation_state" ON "bulk_operation"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "ix_bulk_operation_item_outcome" ON "bulk_operation_item"("tenant_id", "operation_id", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bulk_operation_item" ON "bulk_operation_item"("operation_id", "target_id");

-- AddForeignKey
ALTER TABLE "document_template" ADD CONSTRAINT "document_template_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_template" ADD CONSTRAINT "document_template_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_template" ADD CONSTRAINT "document_template_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_template" ADD CONSTRAINT "document_template_confidentiality_id_fkey" FOREIGN KEY ("confidentiality_id") REFERENCES "confidentiality_level"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_template" ADD CONSTRAINT "document_template_default_folder_id_fkey" FOREIGN KEY ("default_folder_id") REFERENCES "folder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_template" ADD CONSTRAINT "document_template_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_signature" ADD CONSTRAINT "document_signature_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_signature" ADD CONSTRAINT "document_signature_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_signature" ADD CONSTRAINT "document_signature_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "document_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_signature" ADD CONSTRAINT "document_signature_signer_user_id_fkey" FOREIGN KEY ("signer_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_operation" ADD CONSTRAINT "bulk_operation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_operation" ADD CONSTRAINT "bulk_operation_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_operation" ADD CONSTRAINT "bulk_operation_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_operation_item" ADD CONSTRAINT "bulk_operation_item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_operation_item" ADD CONSTRAINT "bulk_operation_item_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "bulk_operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterEnum
ALTER TYPE "audit_subject_type" ADD VALUE 'BULK_OPERATION';
