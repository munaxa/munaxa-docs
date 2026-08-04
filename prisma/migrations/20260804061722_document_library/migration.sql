-- CreateEnum
CREATE TYPE "scan_status" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "upload_session_state" AS ENUM ('OPEN', 'COMPLETED', 'EXPIRED', 'ABORTED');

-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'REJECTED', 'APPROVED', 'PUBLISHED', 'CHECKED_OUT', 'SUPERSEDED', 'ARCHIVED', 'EXPIRED', 'DELETED', 'PURGED');

-- CreateEnum
CREATE TYPE "revision_status" AS ENUM ('DRAFT', 'IN_APPROVAL', 'PUBLISHED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "document_origin" AS ENUM ('UPLOAD', 'SCAN');

-- CreateEnum
CREATE TYPE "preview_artifact_kind" AS ENUM ('PAGE_IMAGE', 'THUMBNAIL', 'PDF', 'TEXT');

-- CreateTable
CREATE TABLE "file_object" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "checksum_sha256" CHAR(64) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "storage_driver" TEXT NOT NULL,
    "scan_status" "scan_status" NOT NULL DEFAULT 'PENDING',
    "scan_threat" TEXT,
    "scanner" TEXT,
    "scanned_at" TIMESTAMPTZ(6),
    "ref_count" INTEGER NOT NULL DEFAULT 0,
    "derived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,

    CONSTRAINT "file_object_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_session" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "declared_mime_type" TEXT NOT NULL,
    "declared_size_bytes" BIGINT NOT NULL,
    "target_key" TEXT NOT NULL,
    "state" "upload_session_state" NOT NULL DEFAULT 'OPEN',
    "multipart_upload_id" TEXT,
    "file_object_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "upload_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "folder_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "category_id" UUID,
    "confidentiality_id" UUID NOT NULL,
    "retention_policy_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "document_status" NOT NULL DEFAULT 'DRAFT',
    "origin" "document_origin" NOT NULL DEFAULT 'UPLOAD',
    "document_number" TEXT,
    "owner_user_id" UUID NOT NULL,
    "current_revision_id" UUID,
    "latest_revision_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_revision" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "status" "revision_status" NOT NULL DEFAULT 'DRAFT',
    "file_object_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "change_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_metadata_value" (
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "metadata_field_id" UUID NOT NULL,
    "text_value" TEXT,
    "number_value" DECIMAL(38,10),
    "date_value" TIMESTAMPTZ(6),
    "boolean_value" BOOLEAN,
    "reference_value" UUID,
    "select_values" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "document_metadata_value_pkey" PRIMARY KEY ("document_id","metadata_field_id")
);

-- CreateTable
CREATE TABLE "document_favorite" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_favorite_pkey" PRIMARY KEY ("user_id","document_id")
);

-- CreateTable
CREATE TABLE "document_view" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "viewed_at" TIMESTAMPTZ(6) NOT NULL,
    "view_count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_view_pkey" PRIMARY KEY ("user_id","document_id")
);

-- CreateTable
CREATE TABLE "preview_artifact" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "kind" "preview_artifact_kind" NOT NULL,
    "page" INTEGER,
    "file_object_id" UUID NOT NULL,
    "renderer" TEXT NOT NULL,
    "renderer_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "preview_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_file_object_refcount" ON "file_object"("tenant_id", "ref_count");

-- CreateIndex
CREATE INDEX "ix_file_object_scan" ON "file_object"("tenant_id", "scan_status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_file_object_checksum" ON "file_object"("tenant_id", "checksum_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "uq_file_object_key" ON "file_object"("tenant_id", "storage_key");

-- CreateIndex
CREATE INDEX "ix_upload_session_expiry" ON "upload_session"("tenant_id", "state", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_document_current_revision" ON "document"("current_revision_id");

-- CreateIndex
CREATE INDEX "ix_document_folder" ON "document"("tenant_id", "folder_id", "deleted_at", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "ix_document_owner" ON "document"("tenant_id", "owner_user_id", "status");

-- CreateIndex
CREATE INDEX "ix_document_type" ON "document"("tenant_id", "document_type_id");

-- CreateIndex
CREATE INDEX "ix_document_category" ON "document"("tenant_id", "category_id");

-- CreateIndex
CREATE INDEX "ix_document_status" ON "document"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_document_number" ON "document"("tenant_id", "document_number");

-- CreateIndex
CREATE INDEX "ix_revision_document" ON "document_revision"("tenant_id", "document_id", "ordinal" DESC);

-- CreateIndex
CREATE INDEX "ix_revision_file" ON "document_revision"("tenant_id", "file_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_revision_ordinal" ON "document_revision"("document_id", "ordinal");

-- CreateIndex
CREATE INDEX "ix_metadata_value_text" ON "document_metadata_value"("tenant_id", "metadata_field_id", "text_value");

-- CreateIndex
CREATE INDEX "ix_metadata_value_date" ON "document_metadata_value"("tenant_id", "metadata_field_id", "date_value");

-- CreateIndex
CREATE INDEX "ix_metadata_value_number" ON "document_metadata_value"("tenant_id", "metadata_field_id", "number_value");

-- CreateIndex
CREATE INDEX "ix_favorite_user" ON "document_favorite"("tenant_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_view_user" ON "document_view"("tenant_id", "user_id", "viewed_at" DESC);

-- CreateIndex
CREATE INDEX "ix_preview_revision" ON "preview_artifact"("tenant_id", "revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_preview_artifact" ON "preview_artifact"("revision_id", "kind", "page");

-- AddForeignKey
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_session" ADD CONSTRAINT "upload_session_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_session" ADD CONSTRAINT "upload_session_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_confidentiality_id_fkey" FOREIGN KEY ("confidentiality_id") REFERENCES "confidentiality_level"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_retention_policy_id_fkey" FOREIGN KEY ("retention_policy_id") REFERENCES "retention_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_current_revision_id_fkey" FOREIGN KEY ("current_revision_id") REFERENCES "document_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_revision" ADD CONSTRAINT "document_revision_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_revision" ADD CONSTRAINT "document_revision_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_revision" ADD CONSTRAINT "document_revision_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_metadata_value" ADD CONSTRAINT "document_metadata_value_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_metadata_value" ADD CONSTRAINT "document_metadata_value_metadata_field_id_fkey" FOREIGN KEY ("metadata_field_id") REFERENCES "metadata_field"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_favorite" ADD CONSTRAINT "document_favorite_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_favorite" ADD CONSTRAINT "document_favorite_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_view" ADD CONSTRAINT "document_view_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_view" ADD CONSTRAINT "document_view_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_artifact" ADD CONSTRAINT "preview_artifact_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_artifact" ADD CONSTRAINT "preview_artifact_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "document_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_artifact" ADD CONSTRAINT "preview_artifact_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
