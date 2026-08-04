-- Phase 7 — document preview.
--
-- Three things arrive here: the render-state row behind "202 with status", the OCR result's
-- metadata, and the repair of the artefact table's uniqueness — the shape Phase 3 built could
-- not actually hold its own "one artefact per revision, kind and page" promise for the rows
-- whose page is NULL.

-- Text read off the pixels by an OCR engine. Its own kind rather than a flag on `TEXT`,
-- because the two answer differently: extracted text is the file's own words, OCR output is an
-- inference with a confidence, flagged in the UI rather than presented as authoritative
-- (`14-preview-architecture.md` §6).
ALTER TYPE "preview_artifact_kind" ADD VALUE 'OCR';

-- Where rendering stands for a revision. `UNSUPPORTED` is a terminal answer, not a failure:
-- the format has no renderer, the UI says so and offers download where permitted.
CREATE TYPE "preview_render_state" AS ENUM ('PENDING', 'READY', 'FAILED', 'UNSUPPORTED');

-- One artefact per revision, kind and page — now actually held for page-less artefacts.
--
-- The original index treats NULL pages as distinct, which is the default and is wrong here: a
-- redelivered render job could store two thumbnails or two PDF renditions for one revision and
-- nothing could say which is current. `NULLS NOT DISTINCT` makes the NULL page one page, which
-- is what "not per page" means. Recreated in raw SQL because Prisma cannot express it — the
-- same reason `uq_document_lock_live` lives in its migration.
DROP INDEX "uq_preview_artifact";
CREATE UNIQUE INDEX "uq_preview_artifact" ON "preview_artifact" ("revision_id", "kind", "page")
  NULLS NOT DISTINCT;

-- Where rendering stands for one revision — the row behind "202 with status" and behind the
-- operator's view of a failure (`14-preview-architecture.md` §§4, 7). One row per revision,
-- upserted by the preview consumer; the artefact rows are the evidence that pages exist, this
-- is the answer while they do not yet, or never will.
CREATE TABLE "preview_render" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "state" "preview_render_state" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT,
  "renderer" TEXT,
  "renderer_version" TEXT,
  "page_count" INTEGER,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "updated_by" UUID,

  CONSTRAINT "preview_render_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "preview_render" ADD CONSTRAINT "preview_render_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "preview_render" ADD CONSTRAINT "preview_render_revision_id_fkey"
  FOREIGN KEY ("revision_id") REFERENCES "document_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One status per revision. The consumer upserts against this, which is also what makes an
-- at-least-once redelivery write one row rather than two.
CREATE UNIQUE INDEX "uq_preview_render_revision" ON "preview_render" ("revision_id");

-- The operator's question: what is failing, per tenant.
CREATE INDEX "ix_preview_render_state" ON "preview_render" ("tenant_id", "state");

-- A terminal state states its reason; READY and PENDING have none to state.
ALTER TABLE "preview_render" ADD CONSTRAINT "ck_preview_render_reason"
  CHECK (("state" IN ('FAILED', 'UNSUPPORTED')) = ("reason" IS NOT NULL));

-- What an OCR engine read off a revision's pixels — metadata about the file, never the file.
-- The text itself is a `preview_artifact` of kind `OCR`; this row carries what the artefact
-- bytes cannot: engine, version, language and confidence, so a low-confidence result is
-- flagged rather than presented as authoritative (`14-preview-architecture.md` §6).
CREATE TABLE "ocr_result" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "engine" TEXT NOT NULL,
  "engine_version" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "confidence" SMALLINT NOT NULL,
  "character_count" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "updated_by" UUID,

  CONSTRAINT "ocr_result_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ocr_result" ADD CONSTRAINT "ocr_result_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ocr_result" ADD CONSTRAINT "ocr_result_revision_id_fkey"
  FOREIGN KEY ("revision_id") REFERENCES "document_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "uq_ocr_result_revision" ON "ocr_result" ("revision_id");

-- A confidence is a percentage the engine reported, not a score somebody invented.
ALTER TABLE "ocr_result" ADD CONSTRAINT "ck_ocr_result_confidence"
  CHECK ("confidence" BETWEEN 0 AND 100);
