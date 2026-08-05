-- Phase 8 — search.
--
-- Four things arrive here: the read model ADR-0008 promised (`search_index_entry`, with its
-- weighted tsvector and materialised ACL subject arrays), the shadow table a rebuild writes
-- into while readers keep answering from the live one, the per-user saved and recent searches,
-- and the rebuild's own state row — which is what makes a rebuild resumable rather than
-- restartable.
--
-- The tsvector column, the GIN indexes over it and the operator-class index on the document
-- number live here in raw SQL because Prisma cannot express them — the same reason
-- `uq_document_lock_live` lives in its migration.

-- Enums.
CREATE TYPE "search_content_source" AS ENUM ('TEXT', 'OCR');
CREATE TYPE "search_rebuild_state" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- An audited `search:all` query and a rebuild are about the search capability, not any one
-- document — the same widening Phase 7 gave `preview_artifact_kind`.
ALTER TYPE "audit_subject_type" ADD VALUE 'SEARCH';

-- The read model. Deliberately no foreign keys beyond the tenant: a RESTRICT edge to
-- `document` would let a projection block a purge, and a CASCADE edge would make removal
-- implicit where the projection is the recorded remover. The index is rebuildable, never
-- authoritative.
CREATE TABLE "search_index_entry" (
    "document_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title_raw" TEXT NOT NULL,
    "number_exact" TEXT,
    "tsv" tsvector NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "document_type_id" UUID NOT NULL,
    "category_id" UUID,
    "status" "document_status" NOT NULL,
    "confidentiality_rank" SMALLINT NOT NULL,
    "entity_id" UUID,
    "branch_id" UUID,
    "department_id" UUID,
    "library_id" UUID NOT NULL,
    "folder_id" UUID NOT NULL,
    "folder_path" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "approver_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "revision_ordinal" INTEGER,
    "revision_label" TEXT,
    "filename" TEXT,
    "language" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "body_source" "search_content_source",
    "content_pending" BOOLEAN NOT NULL,
    "low_confidence" BOOLEAN NOT NULL DEFAULT false,
    "document_created_at" TIMESTAMPTZ(6) NOT NULL,
    "document_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "effective_from" DATE,
    "acl_subjects" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "acl_deny_subjects" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "acl_hash" TEXT NOT NULL,
    "indexed_at" TIMESTAMPTZ(6) NOT NULL,
    "source_version" INTEGER NOT NULL,

    CONSTRAINT "search_index_entry_pkey" PRIMARY KEY ("document_id")
);

ALTER TABLE "search_index_entry"
  ADD CONSTRAINT "search_index_entry_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The text index and the ACL overlap index — the two predicates every search carries.
CREATE INDEX "ix_search_entry_tsv" ON "search_index_entry" USING GIN ("tsv");
CREATE INDEX "ix_search_entry_acl" ON "search_index_entry" USING GIN ("acl_subjects");
-- `number:QMS-*` is a prefix match; `text_pattern_ops` is what lets LIKE 'QMS-%' use a btree.
CREATE INDEX "ix_search_entry_number" ON "search_index_entry" ("tenant_id", "number_exact" text_pattern_ops);
-- `approver:` queries and `meta.<fieldId>` filters.
CREATE INDEX "ix_search_entry_approvers" ON "search_index_entry" USING GIN ("approver_ids");
CREATE INDEX "ix_search_entry_metadata" ON "search_index_entry" USING GIN ("metadata" jsonb_path_ops);
-- The plain filter columns.
CREATE INDEX "ix_search_entry_status" ON "search_index_entry" ("tenant_id", "status");
CREATE INDEX "ix_search_entry_type" ON "search_index_entry" ("tenant_id", "document_type_id");
CREATE INDEX "ix_search_entry_folder_path" ON "search_index_entry" ("tenant_id", "folder_path");
CREATE INDEX "ix_search_entry_owner" ON "search_index_entry" ("tenant_id", "owner_id");
CREATE INDEX "ix_search_entry_updated" ON "search_index_entry" ("tenant_id", "document_updated_at" DESC);

-- The rebuild's build target: the same shape under other names, swapped in when a rebuild
-- completes (`12-search-architecture.md` §6). Readers keep answering from the live table
-- while this one fills; the swap is three renames in one transaction, and the swap script
-- renames the indexes and constraints with the tables so each name keeps describing the
-- logical role rather than the physical relation it happened to start on.
CREATE TABLE "search_index_entry_shadow" (
    "document_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title_raw" TEXT NOT NULL,
    "number_exact" TEXT,
    "tsv" tsvector NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "document_type_id" UUID NOT NULL,
    "category_id" UUID,
    "status" "document_status" NOT NULL,
    "confidentiality_rank" SMALLINT NOT NULL,
    "entity_id" UUID,
    "branch_id" UUID,
    "department_id" UUID,
    "library_id" UUID NOT NULL,
    "folder_id" UUID NOT NULL,
    "folder_path" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "approver_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "revision_ordinal" INTEGER,
    "revision_label" TEXT,
    "filename" TEXT,
    "language" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "body_source" "search_content_source",
    "content_pending" BOOLEAN NOT NULL,
    "low_confidence" BOOLEAN NOT NULL DEFAULT false,
    "document_created_at" TIMESTAMPTZ(6) NOT NULL,
    "document_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "effective_from" DATE,
    "acl_subjects" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "acl_deny_subjects" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "acl_hash" TEXT NOT NULL,
    "indexed_at" TIMESTAMPTZ(6) NOT NULL,
    "source_version" INTEGER NOT NULL,

    CONSTRAINT "search_index_entry_shadow_pkey" PRIMARY KEY ("document_id")
);

ALTER TABLE "search_index_entry_shadow"
  ADD CONSTRAINT "search_index_entry_shadow_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ix_search_entry_shadow_tsv" ON "search_index_entry_shadow" USING GIN ("tsv");
CREATE INDEX "ix_search_entry_shadow_acl" ON "search_index_entry_shadow" USING GIN ("acl_subjects");
CREATE INDEX "ix_search_entry_shadow_number" ON "search_index_entry_shadow" ("tenant_id", "number_exact" text_pattern_ops);
CREATE INDEX "ix_search_entry_shadow_approvers" ON "search_index_entry_shadow" USING GIN ("approver_ids");
CREATE INDEX "ix_search_entry_shadow_metadata" ON "search_index_entry_shadow" USING GIN ("metadata" jsonb_path_ops);
CREATE INDEX "ix_search_entry_shadow_status" ON "search_index_entry_shadow" ("tenant_id", "status");
CREATE INDEX "ix_search_entry_shadow_type" ON "search_index_entry_shadow" ("tenant_id", "document_type_id");
CREATE INDEX "ix_search_entry_shadow_folder_path" ON "search_index_entry_shadow" ("tenant_id", "folder_path");
CREATE INDEX "ix_search_entry_shadow_owner" ON "search_index_entry_shadow" ("tenant_id", "owner_id");
CREATE INDEX "ix_search_entry_shadow_updated" ON "search_index_entry_shadow" ("tenant_id", "document_updated_at" DESC);

-- One person's named, re-runnable search.
CREATE TABLE "saved_search" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "saved_search_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "saved_search"
  ADD CONSTRAINT "saved_search_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "saved_search"
  ADD CONSTRAINT "saved_search_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ix_saved_search_owner" ON "saved_search" ("tenant_id", "owner_user_id", "updated_at" DESC);

-- One name per owner among live rows. Partial, and case-insensitive, in raw SQL — Prisma can
-- express neither; the same reasoning as `uq_document_lock_live`.
CREATE UNIQUE INDEX "uq_saved_search_name"
  ON "saved_search" ("tenant_id", "owner_user_id", lower("name"))
  WHERE "deleted_at" IS NULL;

-- One person's recent queries, deduplicated by digest and pruned by configuration.
CREATE TABLE "recent_search" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "query" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "query_hash" TEXT NOT NULL,
    "searched_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recent_search_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "recent_search"
  ADD CONSTRAINT "recent_search_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recent_search"
  ADD CONSTRAINT "recent_search_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "uq_recent_search_query" ON "recent_search" ("tenant_id", "user_id", "query_hash");
CREATE INDEX "ix_recent_search_user" ON "recent_search" ("tenant_id", "user_id", "searched_at" DESC);

-- One rebuild run. The cursor is what makes it resumable; the partial unique is what makes
-- two concurrent rebuilds one rebuild and one refusal — the same shape as the check-out lock.
CREATE TABLE "search_rebuild" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "state" "search_rebuild_state" NOT NULL DEFAULT 'RUNNING',
    "cursor_document_id" UUID,
    "documents_indexed" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "search_rebuild_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "search_rebuild"
  ADD CONSTRAINT "search_rebuild_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ix_search_rebuild_tenant" ON "search_rebuild" ("tenant_id", "started_at" DESC);

CREATE UNIQUE INDEX "uq_search_rebuild_running"
  ON "search_rebuild" ("tenant_id")
  WHERE "state" = 'RUNNING';

-- An error is explained exactly when there is one — the same biconditional idiom as
-- `ck_preview_render_reason`.
ALTER TABLE "search_rebuild" ADD CONSTRAINT "ck_search_rebuild_error"
  CHECK (("state" = 'FAILED') = ("error" IS NOT NULL));

-- A completed or failed run records when it ended; a running one does not yet.
ALTER TABLE "search_rebuild" ADD CONSTRAINT "ck_search_rebuild_completed"
  CHECK (("state" = 'RUNNING') = ("completed_at" IS NULL));
