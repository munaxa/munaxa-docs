-- CreateEnum
CREATE TYPE "workflow_instance_state" AS ENUM ('RUNNING', 'PAUSED', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "workflow_stage_state" AS ENUM ('PENDING', 'ACTIVE', 'COMPLETED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "approval_task_state" AS ENUM ('PENDING', 'DECIDED', 'WITHDRAWN', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "task_decision" AS ENUM ('APPROVED', 'REJECTED', 'CHANGES_REQUESTED');

-- CreateEnum
CREATE TYPE "workflow_timer_kind" AS ENUM ('DEADLINE', 'REMINDER');

-- CreateEnum
CREATE TYPE "workflow_timer_state" AS ENUM ('SCHEDULED', 'PAUSED', 'FIRED', 'CANCELLED');

-- AlterTable
ALTER TABLE "user_department" ADD COLUMN     "is_manager" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "workflow_instance" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "workflow_version_id" UUID NOT NULL,
    "state" "workflow_instance_state" NOT NULL DEFAULT 'RUNNING',
    "current_stage_index" INTEGER NOT NULL DEFAULT -1,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "started_by" UUID,
    "ended_at" TIMESTAMPTZ(6),
    "end_reason" TEXT,
    "paused_at" TIMESTAMPTZ(6),
    "pause_reason" TEXT,
    "escalation_count" INTEGER NOT NULL DEFAULT 0,
    "number_assigned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workflow_instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_stage" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "completion_rule" TEXT NOT NULL,
    "threshold" INTEGER,
    "ordered" BOOLEAN NOT NULL DEFAULT false,
    "state" "workflow_stage_state" NOT NULL DEFAULT 'PENDING',
    "activated_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "due_at" TIMESTAMPTZ(6),
    "skip_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workflow_stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_task" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "assignee_id" UUID NOT NULL,
    "resolved_by" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "state" "approval_task_state" NOT NULL DEFAULT 'PENDING',
    "decision" "task_decision",
    "decided_by_id" UUID,
    "on_behalf_of_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "comment" TEXT,
    "due_at" TIMESTAMPTZ(6),
    "escalated_from_id" UUID,
    "auto_decided" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "approval_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_comment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "stage_id" UUID,
    "task_id" UUID,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "decision" "task_decision",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_timer" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "task_id" UUID,
    "kind" "workflow_timer_kind" NOT NULL,
    "state" "workflow_timer_state" NOT NULL DEFAULT 'SCHEDULED',
    "fire_at" TIMESTAMPTZ(6) NOT NULL,
    "remaining_ms" INTEGER,
    "fired_at" TIMESTAMPTZ(6),
    "offset" TEXT,
    "job_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_timer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_group" (
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

    CONSTRAINT "approval_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_group_member" (
    "tenant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" UUID,

    CONSTRAINT "approval_group_member_pkey" PRIMARY KEY ("group_id","user_id")
);

-- CreateTable
CREATE TABLE "working_calendar" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entity_id" UUID,
    "weekend_days" INTEGER[],
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "working_calendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "working_calendar_holiday" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "calendar_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "working_calendar_holiday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_workflow_instance_document" ON "workflow_instance"("tenant_id", "document_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "ix_workflow_instance_state" ON "workflow_instance"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "ix_workflow_instance_version" ON "workflow_instance"("tenant_id", "workflow_version_id");

-- CreateIndex
CREATE INDEX "ix_workflow_stage_instance" ON "workflow_stage"("tenant_id", "instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_workflow_stage_index" ON "workflow_stage"("instance_id", "index");

-- CreateIndex
CREATE INDEX "ix_approval_task_inbox" ON "approval_task"("tenant_id", "assignee_id", "state", "due_at");

-- CreateIndex
CREATE INDEX "ix_approval_task_instance" ON "approval_task"("tenant_id", "instance_id");

-- CreateIndex
CREATE INDEX "ix_approval_task_stage" ON "approval_task"("tenant_id", "stage_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_approval_task_assignee" ON "approval_task"("stage_id", "assignee_id");

-- CreateIndex
CREATE INDEX "ix_workflow_comment_instance" ON "workflow_comment"("tenant_id", "instance_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_workflow_comment_document" ON "workflow_comment"("tenant_id", "document_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_workflow_timer_instance" ON "workflow_timer"("tenant_id", "instance_id", "state");

-- CreateIndex
CREATE INDEX "ix_workflow_timer_due" ON "workflow_timer"("tenant_id", "state", "fire_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_workflow_timer_job" ON "workflow_timer"("tenant_id", "job_id");

-- CreateIndex
CREATE INDEX "ix_approval_group_active" ON "approval_group"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "ix_approval_group_member_user" ON "approval_group_member"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "ix_working_calendar_entity" ON "working_calendar"("tenant_id", "entity_id");

-- CreateIndex
CREATE INDEX "ix_working_calendar_holiday" ON "working_calendar_holiday"("tenant_id", "calendar_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "uq_working_calendar_holiday" ON "working_calendar_holiday"("calendar_id", "day");

-- AddForeignKey
ALTER TABLE "workflow_instance" ADD CONSTRAINT "workflow_instance_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instance" ADD CONSTRAINT "workflow_instance_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instance" ADD CONSTRAINT "workflow_instance_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "document_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instance" ADD CONSTRAINT "workflow_instance_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "workflow_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instance" ADD CONSTRAINT "workflow_instance_workflow_version_id_fkey" FOREIGN KEY ("workflow_version_id") REFERENCES "workflow_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_stage" ADD CONSTRAINT "workflow_stage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_stage" ADD CONSTRAINT "workflow_stage_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "workflow_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_task" ADD CONSTRAINT "approval_task_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_task" ADD CONSTRAINT "approval_task_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "workflow_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_task" ADD CONSTRAINT "approval_task_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "workflow_stage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_task" ADD CONSTRAINT "approval_task_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_task" ADD CONSTRAINT "approval_task_escalated_from_id_fkey" FOREIGN KEY ("escalated_from_id") REFERENCES "approval_task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_comment" ADD CONSTRAINT "workflow_comment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_comment" ADD CONSTRAINT "workflow_comment_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "workflow_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_comment" ADD CONSTRAINT "workflow_comment_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "workflow_stage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_comment" ADD CONSTRAINT "workflow_comment_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "approval_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_comment" ADD CONSTRAINT "workflow_comment_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_timer" ADD CONSTRAINT "workflow_timer_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_timer" ADD CONSTRAINT "workflow_timer_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "workflow_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_timer" ADD CONSTRAINT "workflow_timer_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "workflow_stage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_timer" ADD CONSTRAINT "workflow_timer_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "approval_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_group" ADD CONSTRAINT "approval_group_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_group_member" ADD CONSTRAINT "approval_group_member_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "approval_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_group_member" ADD CONSTRAINT "approval_group_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_calendar" ADD CONSTRAINT "working_calendar_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_calendar" ADD CONSTRAINT "working_calendar_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_calendar_holiday" ADD CONSTRAINT "working_calendar_holiday_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "working_calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------
-- What Prisma cannot express, and what the engine's correctness rests on.
--
-- Everything below is either a partial index (Prisma has no syntax for a `WHERE` clause on
-- one) or a check constraint spanning columns. They are written here for the same reason the
-- earlier phases wrote theirs here: a rule the application enforces and the database does not
-- is a rule that holds until something other than the application writes.
-- ---------------------------------------------------------------------------------------

-- One live approval per document.
--
-- The single most important constraint in this migration. Two running instances on one document
-- means two sets of approvers deciding on two revisions with one status column between them, and
-- whichever finished last would silently win. Submission checks first and says so politely; this
-- is what holds when two submissions race and both pass that check.
--
-- Partial on the live states, so a document's *history* of approvals is unbounded — a rejected
-- attempt, a revised resubmission and an eventual approval are three rows, which is the point.
CREATE UNIQUE INDEX "uq_workflow_instance_live" ON "workflow_instance" ("document_id")
  WHERE "state" IN ('RUNNING', 'PAUSED');

-- The approval inbox, which is the busiest read in the engine: "what needs my attention".
-- Partial, so the index holds only undecided work rather than every decision ever taken.
CREATE INDEX "ix_approval_task_pending" ON "approval_task" ("tenant_id", "assignee_id", "due_at")
  WHERE "state" = 'PENDING';

-- The timer sweep's query, and the reconciliation that re-enqueues a job Redis lost. Partial for
-- the same reason: a fired timer is history and never appears in it again.
CREATE INDEX "ix_workflow_timer_pending" ON "workflow_timer" ("tenant_id", "fire_at")
  WHERE "state" = 'SCHEDULED';

-- Keys and codes are unique per tenant, case-insensitively, among live rows — the same shape
-- every configuration table in Phase 2 uses, for the same two reasons: a code freed by a soft
-- delete is available again, and "QA" and "qa" are one code to the database as well as to the
-- person who typed it.
CREATE UNIQUE INDEX "uq_approval_group_tenant_key" ON "approval_group" ("tenant_id", lower("key"))
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "uq_working_calendar_tenant_code" ON "working_calendar" ("tenant_id", lower("code"))
  WHERE "deleted_at" IS NULL;

-- Exactly one default calendar per tenant. A tenant with two defaults has no default, and the
-- deadline arithmetic would then depend on which row a query happened to return first.
CREATE UNIQUE INDEX "uq_working_calendar_default" ON "working_calendar" ("tenant_id")
  WHERE "is_default" AND "deleted_at" IS NULL;

-- One calendar per entity. A second would make "which calendar does this document's entity use"
-- ambiguous at exactly the moment a deadline is being computed.
CREATE UNIQUE INDEX "uq_working_calendar_entity" ON "working_calendar" ("tenant_id", "entity_id")
  WHERE "entity_id" IS NOT NULL AND "deleted_at" IS NULL;

-- A decided task carries its decision, its decider and its instant; an undecided one carries
-- none of them. Half a decision — a decision with no decider, a decider with no decision — is
-- the shape a partial write leaves behind, and it is unrepresentable rather than merely unlikely.
ALTER TABLE "approval_task" ADD CONSTRAINT "ck_approval_task_decided"
  CHECK ((("state" = 'DECIDED') = ("decision" IS NOT NULL))
     AND (("decision" IS NULL) = ("decided_at" IS NULL))
     AND (("decision" IS NULL) = ("decided_by_id" IS NULL)));

-- A stage that names a threshold names a rule that takes one, and vice versa. `QUORUM` without a
-- count and `ALL` with one are the two ways to write a completion condition nothing can evaluate.
ALTER TABLE "workflow_stage" ADD CONSTRAINT "ck_workflow_stage_threshold"
  CHECK ((("completion_rule" IN ('QUORUM', 'PERCENT')) = ("threshold" IS NOT NULL))
     AND ("threshold" IS NULL OR "threshold" >= 1));

-- A finished instance has an end; a running one does not. Without this an instance could report
-- `COMPLETED` with no completion instant, and every duration report would silently exclude it.
ALTER TABLE "workflow_instance" ADD CONSTRAINT "ck_workflow_instance_ended"
  CHECK ((("state" IN ('COMPLETED', 'REJECTED', 'CANCELLED')) = ("ended_at" IS NOT NULL))
     AND (("state" = 'PAUSED') = ("paused_at" IS NOT NULL)));

-- A paused timer carries what it had left; a scheduled one does not. This is the whole of §6's
-- "resumes with the remaining duration, never restarting the clock", made unrepresentable to get
-- wrong: a timer cannot be paused without recording the remainder that resume will use.
ALTER TABLE "workflow_timer" ADD CONSTRAINT "ck_workflow_timer_remaining"
  CHECK ((("state" = 'PAUSED') = ("remaining_ms" IS NOT NULL))
     AND ("remaining_ms" IS NULL OR "remaining_ms" >= 0)
     AND (("state" = 'FIRED') = ("fired_at" IS NOT NULL)));

-- ISO-8601 weekday numbers, and a week that has at least one working day in it. A calendar whose
-- weekend is every day is a deadline that can never be reached, and the deadline arithmetic would
-- loop looking for the next working day.
ALTER TABLE "working_calendar" ADD CONSTRAINT "ck_working_calendar_weekend"
  CHECK (array_length("weekend_days", 1) IS NULL
      OR (array_length("weekend_days", 1) <= 6
          AND "weekend_days" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]));
