-- CreateEnum
CREATE TYPE "revision_label_style" AS ENUM ('NUMERIC', 'ALPHABETIC', 'MAJOR_MINOR');

-- CreateEnum
CREATE TYPE "metadata_data_type" AS ENUM ('TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT', 'MULTI_SELECT', 'USER', 'DEPARTMENT');

-- CreateEnum
CREATE TYPE "retention_trigger" AS ENUM ('ON_PUBLISH', 'ON_SUPERSEDE', 'ON_ARCHIVE', 'ON_DELETE');

-- CreateEnum
CREATE TYPE "disposition" AS ENUM ('REVIEW', 'ARCHIVE', 'PURGE', 'RETAIN_FOREVER');

-- CreateEnum
CREATE TYPE "sequence_reset_scope" AS ENUM ('NEVER', 'YEARLY', 'MONTHLY', 'PER_COMPANY', 'PER_ENTITY', 'PER_BRANCH', 'PER_DEPARTMENT', 'PER_DOCUMENT_TYPE', 'PER_CATEGORY');

-- CreateEnum
CREATE TYPE "library_owner_scope" AS ENUM ('TENANT', 'COMPANY', 'ENTITY', 'DEPARTMENT');

-- CreateEnum
CREATE TYPE "workflow_version_state" AS ENUM ('DRAFT', 'PUBLISHED', 'DEPRECATED');

-- CreateTable
CREATE TABLE "confidentiality_level" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rank" SMALLINT NOT NULL,
    "allow_download" BOOLEAN NOT NULL DEFAULT true,
    "allow_print" BOOLEAN NOT NULL DEFAULT true,
    "watermark" BOOLEAN NOT NULL DEFAULT false,
    "require_reason" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "confidentiality_level_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_policy" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" "retention_trigger" NOT NULL,
    "period_months" INTEGER NOT NULL,
    "disposition" "disposition" NOT NULL,
    "review_required" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "retention_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "numbering_rule" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "separator" TEXT NOT NULL DEFAULT '-',
    "segments" JSONB NOT NULL,
    "reset_scope" "sequence_reset_scope"[],
    "reserve_on_submit" BOOLEAN NOT NULL DEFAULT true,
    "strict_gapless" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "numbering_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_sequence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "numbering_rule_id" UUID NOT NULL,
    "scope_key" TEXT NOT NULL,
    "next_value" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "number_sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "parent_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "path" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metadata_field" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "data_type" "metadata_data_type" NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "validation" JSONB NOT NULL DEFAULT '{}',
    "is_searchable" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "metadata_field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_type" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "numbering_rule_id" UUID NOT NULL,
    "workflow_definition_id" UUID,
    "retention_policy_id" UUID,
    "default_confidentiality_id" UUID NOT NULL,
    "revision_label_style" "revision_label_style" NOT NULL DEFAULT 'NUMERIC',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "type_metadata_field" (
    "tenant_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "metadata_field_id" UUID NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "default_value" TEXT,

    CONSTRAINT "type_metadata_field_pkey" PRIMARY KEY ("document_type_id","metadata_field_id")
);

-- CreateTable
CREATE TABLE "library" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "owner_scope_type" "library_owner_scope" NOT NULL,
    "owner_scope_id" UUID,
    "root_folder_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "library_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folder" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "library_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "path" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 1,
    "inherit_acl" BOOLEAN NOT NULL DEFAULT true,
    "is_root" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "delete_cascade_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_definition" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workflow_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "state" "workflow_version_state" NOT NULL DEFAULT 'DRAFT',
    "definition" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "published_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "workflow_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_confidentiality_rank" ON "confidentiality_level"("tenant_id", "rank");

-- CreateIndex
CREATE INDEX "ix_retention_policy_tenant" ON "retention_policy"("tenant_id");

-- CreateIndex
CREATE INDEX "ix_numbering_rule_tenant" ON "numbering_rule"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_number_sequence_scope" ON "number_sequence"("tenant_id", "numbering_rule_id", "scope_key");

-- CreateIndex
CREATE INDEX "ix_category_parent" ON "category"("tenant_id", "parent_id");

-- CreateIndex
CREATE INDEX "ix_category_path" ON "category"("tenant_id", "path");

-- CreateIndex
CREATE INDEX "ix_metadata_field_tenant" ON "metadata_field"("tenant_id");

-- CreateIndex
CREATE INDEX "ix_document_type_active" ON "document_type"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "ix_document_type_workflow" ON "document_type"("tenant_id", "workflow_definition_id");

-- CreateIndex
CREATE INDEX "ix_type_field_by_field" ON "type_metadata_field"("tenant_id", "metadata_field_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_library_root_folder" ON "library"("root_folder_id");

-- CreateIndex
CREATE INDEX "ix_library_owner" ON "library"("tenant_id", "owner_scope_type", "owner_scope_id");

-- CreateIndex
CREATE INDEX "ix_folder_parent" ON "folder"("tenant_id", "library_id", "parent_id");

-- CreateIndex
CREATE INDEX "ix_folder_path" ON "folder"("tenant_id", "path");

-- CreateIndex
CREATE INDEX "ix_folder_cascade" ON "folder"("tenant_id", "delete_cascade_id");

-- CreateIndex
CREATE INDEX "ix_workflow_definition_active" ON "workflow_definition"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "ix_workflow_version_state" ON "workflow_version"("tenant_id", "definition_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "uq_workflow_version_number" ON "workflow_version"("definition_id", "version");

-- AddForeignKey
ALTER TABLE "confidentiality_level" ADD CONSTRAINT "confidentiality_level_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_policy" ADD CONSTRAINT "retention_policy_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "numbering_rule" ADD CONSTRAINT "numbering_rule_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_sequence" ADD CONSTRAINT "number_sequence_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_sequence" ADD CONSTRAINT "number_sequence_numbering_rule_id_fkey" FOREIGN KEY ("numbering_rule_id") REFERENCES "numbering_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metadata_field" ADD CONSTRAINT "metadata_field_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type" ADD CONSTRAINT "document_type_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type" ADD CONSTRAINT "document_type_numbering_rule_id_fkey" FOREIGN KEY ("numbering_rule_id") REFERENCES "numbering_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type" ADD CONSTRAINT "document_type_workflow_definition_id_fkey" FOREIGN KEY ("workflow_definition_id") REFERENCES "workflow_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type" ADD CONSTRAINT "document_type_retention_policy_id_fkey" FOREIGN KEY ("retention_policy_id") REFERENCES "retention_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type" ADD CONSTRAINT "document_type_default_confidentiality_id_fkey" FOREIGN KEY ("default_confidentiality_id") REFERENCES "confidentiality_level"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "type_metadata_field" ADD CONSTRAINT "type_metadata_field_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_type"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "type_metadata_field" ADD CONSTRAINT "type_metadata_field_metadata_field_id_fkey" FOREIGN KEY ("metadata_field_id") REFERENCES "metadata_field"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library" ADD CONSTRAINT "library_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library" ADD CONSTRAINT "library_root_folder_id_fkey" FOREIGN KEY ("root_folder_id") REFERENCES "folder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folder" ADD CONSTRAINT "folder_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folder" ADD CONSTRAINT "folder_library_id_fkey" FOREIGN KEY ("library_id") REFERENCES "library"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folder" ADD CONSTRAINT "folder_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "folder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_definition" ADD CONSTRAINT "workflow_definition_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "workflow_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partial unique indexes. Prisma cannot express these, and the schema conventions require
-- them: a code freed by a soft delete must be reusable.
--
-- Codes and keys are compared case-insensitively because people type them and they appear in
-- document numbers and stored configuration — "PROC" and "proc" being two document types is a
-- data-entry accident, not a distinction anybody intends (`05-database-design.md` §2).

CREATE UNIQUE INDEX "uq_confidentiality_tenant_code" ON "confidentiality_level" ("tenant_id", lower("code"))
  WHERE "deleted_at" IS NULL;

-- Rank is the level's identity to the product: workflow conditions compare it and audit-on-read
-- is triggered by it, so "more sensitive than" has to be a total order. Two levels sharing a rank
-- would make that question ambiguous, decided by whichever row a query returned first.
CREATE UNIQUE INDEX "uq_confidentiality_tenant_rank" ON "confidentiality_level" ("tenant_id", "rank")
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "uq_retention_policy_tenant_code" ON "retention_policy" ("tenant_id", lower("code"))
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "uq_numbering_rule_tenant_key" ON "numbering_rule" ("tenant_id", lower("key"))
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "uq_metadata_field_tenant_key" ON "metadata_field" ("tenant_id", lower("key"))
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "uq_document_type_tenant_code" ON "document_type" ("tenant_id", lower("code"))
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "uq_library_tenant_code" ON "library" ("tenant_id", lower("code"))
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "uq_workflow_definition_tenant_key" ON "workflow_definition" ("tenant_id", lower("key"))
  WHERE "deleted_at" IS NULL;

-- A category's code names it in a document number, so it is unique per tenant rather than per
-- parent; its *name* is unique among live siblings, which is the rule `05-database-design.md` §1
-- gives as the worked example.
CREATE UNIQUE INDEX "uq_category_tenant_code" ON "category" ("tenant_id", lower("code"))
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "uq_category_sibling_name" ON "category" ("tenant_id", "parent_id", lower("name"))
  WHERE "deleted_at" IS NULL;

-- NULL parents are distinct to a unique index, so the constraint above does not constrain the
-- roots at all — two top-level categories called "Quality" would both be accepted. This is the
-- half that covers them, and the same pair appears below for folders.
CREATE UNIQUE INDEX "uq_category_root_name" ON "category" ("tenant_id", lower("name"))
  WHERE "deleted_at" IS NULL AND "parent_id" IS NULL;

CREATE UNIQUE INDEX "uq_folder_sibling_name" ON "folder" ("tenant_id", "parent_id", lower("name"))
  WHERE "deleted_at" IS NULL;

-- A library has exactly one root folder, and `is_root` is what says which. Without this a second
-- root would be accepted and `library.root_folder_id` would point at one of two.
CREATE UNIQUE INDEX "uq_folder_library_root" ON "folder" ("library_id")
  WHERE "is_root" AND "deleted_at" IS NULL;

-- Prefix search on the materialised paths, for "every descendant of this node".
-- text_pattern_ops is what makes LIKE 'prefix%' use the index rather than scan.
CREATE INDEX "ix_category_path_prefix" ON "category" ("tenant_id", "path" text_pattern_ops);
CREATE INDEX "ix_folder_path_prefix" ON "folder" ("tenant_id", "path" text_pattern_ops);

-- A tenant-wide library names no owner node; every other scope must name one. Expressed as a
-- check because it is the one part of the polymorphic owner reference a foreign key cannot carry,
-- and a tenant-wide library with a stray owner id would resolve its ACL chain from the wrong node.
ALTER TABLE "library" ADD CONSTRAINT "ck_library_owner_scope"
  CHECK (("owner_scope_type" = 'TENANT' AND "owner_scope_id" IS NULL)
      OR ("owner_scope_type" <> 'TENANT' AND "owner_scope_id" IS NOT NULL));

-- A root folder has no parent, and a non-root folder has one. Both halves matter: a root with a
-- parent would appear twice in its own subtree, and an orphan non-root would be unreachable from
-- the library while still holding documents.
ALTER TABLE "folder" ADD CONSTRAINT "ck_folder_root_has_no_parent"
  CHECK (("is_root" AND "parent_id" IS NULL) OR (NOT "is_root" AND "parent_id" IS NOT NULL));

-- A period of zero months is meaningful only for a policy that keeps the record indefinitely.
-- Anywhere else it means "dispose the moment the trigger fires", which reads as a configuration
-- mistake far more often than as an intent.
ALTER TABLE "retention_policy" ADD CONSTRAINT "ck_retention_period"
  CHECK (("disposition" = 'RETAIN_FOREVER' AND "period_months" = 0)
      OR ("disposition" <> 'RETAIN_FOREVER' AND "period_months" > 0));

-- Confidentiality ranks are compared, so the order has to be meaningful over a bounded range.
ALTER TABLE "confidentiality_level" ADD CONSTRAINT "ck_confidentiality_rank"
  CHECK ("rank" >= 0 AND "rank" <= 100);

-- A counter is never rewound. A sequence whose next value went backwards would re-issue numbers
-- it had already given out, which is the one thing numbering exists to make impossible.
ALTER TABLE "number_sequence" ADD CONSTRAINT "ck_number_sequence_next_value"
  CHECK ("next_value" >= 1);

-- Depth ceilings, checked here as well as in the domain. The application refuses first and with a
-- better message; this is what holds if a path is ever written by anything else.
ALTER TABLE "folder" ADD CONSTRAINT "ck_folder_depth"
  CHECK ("depth" >= 1 AND "depth" <= 32);

-- A published version carries the stamp of its publication, and an unpublished one carries none.
-- The immutability rule is enforced by the application; this is what makes a half-published
-- version — published with no publisher, or stamped while still a draft — unrepresentable.
ALTER TABLE "workflow_version" ADD CONSTRAINT "ck_workflow_version_published"
  CHECK (("state" = 'DRAFT' AND "published_at" IS NULL AND "published_by" IS NULL)
      OR ("state" <> 'DRAFT' AND "published_at" IS NOT NULL));
