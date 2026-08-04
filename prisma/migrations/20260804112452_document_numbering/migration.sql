-- CreateEnum
CREATE TYPE "number_reservation_state" AS ENUM ('RESERVED', 'ASSIGNED', 'VOIDED', 'HELD');

-- CreateEnum
CREATE TYPE "number_origin" AS ENUM ('AUTOMATIC', 'MANUAL', 'IMPORTED');

-- AlterTable
ALTER TABLE "document" ADD COLUMN     "numbered_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "number_reservation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "numbering_rule_id" UUID NOT NULL,
    "scope_key" TEXT NOT NULL,
    "sequence_value" BIGINT NOT NULL,
    "formatted" TEXT NOT NULL,
    "state" "number_reservation_state" NOT NULL DEFAULT 'RESERVED',
    "origin" "number_origin" NOT NULL DEFAULT 'AUTOMATIC',
    "document_id" UUID,
    "workflow_instance_id" UUID,
    "reserved_at" TIMESTAMPTZ(6) NOT NULL,
    "assigned_at" TIMESTAMPTZ(6),
    "voided_at" TIMESTAMPTZ(6),
    "void_reason" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "number_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_number_reservation_document" ON "number_reservation"("tenant_id", "document_id");

-- CreateIndex
CREATE INDEX "ix_number_reservation_instance" ON "number_reservation"("tenant_id", "workflow_instance_id");

-- CreateIndex
CREATE INDEX "ix_number_reservation_rule" ON "number_reservation"("tenant_id", "numbering_rule_id", "state", "reserved_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_number_reservation_formatted" ON "number_reservation"("tenant_id", "formatted");

-- AddForeignKey
ALTER TABLE "number_reservation" ADD CONSTRAINT "number_reservation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_reservation" ADD CONSTRAINT "number_reservation_numbering_rule_id_fkey" FOREIGN KEY ("numbering_rule_id") REFERENCES "numbering_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_reservation" ADD CONSTRAINT "number_reservation_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_reservation" ADD CONSTRAINT "number_reservation_workflow_instance_id_fkey" FOREIGN KEY ("workflow_instance_id") REFERENCES "workflow_instance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------
-- What Prisma cannot express, and what never-reused rests on.
--
-- Partial indexes and cross-column checks, written by hand for the same reason the earlier
-- phases wrote theirs here: a rule the application enforces and the database does not is a
-- rule that holds until something other than the application writes.
-- ---------------------------------------------------------------------------------------

-- At most one live pending number per approval, and per document. Partial on `RESERVED`, so
-- the history of voided and assigned values is unbounded — a document rejected twice and then
-- approved leaves three rows, which is the point.
CREATE UNIQUE INDEX "uq_number_reservation_live_instance" ON "number_reservation" ("workflow_instance_id")
  WHERE "state" = 'RESERVED';
CREATE UNIQUE INDEX "uq_number_reservation_live_document" ON "number_reservation" ("tenant_id", "document_id")
  WHERE "state" = 'RESERVED';

-- Each state carries exactly the facts that make it that state. An assigned value names its
-- document and its instant; a voided one records when and why; a reservation or a held value
-- has neither. Half an assignment is the shape a partial write leaves behind.
ALTER TABLE "number_reservation" ADD CONSTRAINT "ck_number_reservation_state"
  CHECK ((("state" = 'ASSIGNED') = ("assigned_at" IS NOT NULL))
     AND ("state" <> 'ASSIGNED' OR "document_id" IS NOT NULL)
     AND (("state" = 'VOIDED') = ("voided_at" IS NOT NULL))
     AND ("state" <> 'HELD' OR "workflow_instance_id" IS NULL));

-- A value is drawn from a counter that starts at 1.
ALTER TABLE "number_reservation" ADD CONSTRAINT "ck_number_reservation_value"
  CHECK ("sequence_value" >= 1);

-- A document's number and the instant it was assigned travel together, both ways. Written now,
-- while nothing reaches PUBLISHED, so the rule from `09-numbering-architecture.md` §5 is already
-- standing when Phase 6 builds publication: a document cannot become PUBLISHED unnumbered.
ALTER TABLE "document" ADD CONSTRAINT "ck_document_numbered"
  CHECK (("document_number" IS NULL) = ("numbered_at" IS NULL));
ALTER TABLE "document" ADD CONSTRAINT "ck_document_numbered_when_published"
  CHECK ("status" <> 'PUBLISHED' OR "document_number" IS NOT NULL);
