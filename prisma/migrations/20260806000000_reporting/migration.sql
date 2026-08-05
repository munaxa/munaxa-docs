-- Phase 15 — enterprise reporting: the two tables `reporting` has needed since Phase 0.5, and no
-- others.
--
-- `application/ports.ts` has declared `REPORT_DEFINITION_REPOSITORY` and `REPORTING_SERVICE` since
-- the skeleton with nothing behind either. This migration gives them the only rows a report engine
-- genuinely owns, and the interesting part is what is **not** here.
--
-- --- What is not here: a read model ------------------------------------------------------------
--
-- No projected fact table, no materialised view, no rollup. Every report in this phase is an
-- aggregate over a table that already exists, issued by the module that owns it and filtered by the
-- predicate that module's own list is built from. A second materialisation would need a second
-- invalidation story, and Phase 14 has just written a long one about `acl_subjects` — where a stale
-- row is a *missing* search result. A stale report figure is not missing; it is a wrong number
-- somebody acts on, which is the worse of the two failures.
--
-- --- What is not here: `report_schedule` -------------------------------------------------------
--
-- The brief says "scheduling ready", and "ready" is not "built". Four phases have now had to
-- discharge a contract that shipped with nothing behind it, and a `report_schedule` table with no
-- writer and no reader would be the fifth. What exists instead is the seam a scheduler needs: the
-- `reporting.export` lane, a `report_export` row that is its own record, an idempotent claim, and
-- an audited run. A scheduled report is then a row in this table enqueued by a cron entry, and the
-- Phase 15 report names the phase that closes it.
--
-- --- `report_definition` ----------------------------------------------------------------------
--
-- A saved report: which catalogue key, and which parameters. **Never a query.** `key` names an
-- entry in code and `query` holds the parameter map; nothing here can carry SQL, a column list or a
-- table name. That is the enforcement of the constraint at the head of `reporting/application/
-- ports.ts` — a definition that could name a column would be a tenant pinning one, and no migration
-- would ever again be a decision this repository alone could take.
--
-- Personal, exactly like `saved_search`, and with the same partial unique index: one name per owner
-- among live rows. Prisma cannot express a partial unique, so it is written here, which is also
-- where `saved_search`'s lives.
--
-- --- `report_export` --------------------------------------------------------------------------
--
-- Its own table beside `audit_export` rather than a shared one. They differ in what they hold, not
-- merely in what they are called: an evidence bundle is a range of the trail with a chain
-- verification, checkpoints and a signed manifest; a report export is one file of rows produced
-- under the requester's own reach. One table would need both column sets, half of them null on
-- every row, plus a discriminator every query then has to remember.
--
-- `requested_by_id` is `NOT NULL` and that is load-bearing twice. An export is always somebody's
-- act — Phase 9's reasoning, unchanged. And the lane reads this column to reconstitute *whose*
-- reach the rows are filtered by: `PrismaDocumentRepository.visibilityCondition` returns an empty
-- predicate for a caller with no user, so an export that ran with no subject would be an export of
-- every row in the tenant, written to a file and handed to whoever asked.
--
-- Row-level security is not written here. `infra/sql/post-migrate/01-tenant-isolation.sql`
-- discovers every table in `public` carrying `tenant_id`, applies FORCE ROW LEVEL SECURITY and the
-- `tenant_isolation` policy, and raises if one is missed. Both tables carry `tenant_id`, so they
-- are protected by construction rather than by remembering.

CREATE TYPE "report_export_state" AS ENUM ('REQUESTED', 'RUNNING', 'COMPLETED', 'FAILED');

-- Named for what it is. `SPREADSHEET_XML` is SpreadsheetML 2003 — a real Excel format and not
-- XLSX — and a value called `XLSX` would be the product asserting a container it never wrote.
CREATE TYPE "report_export_format" AS ENUM ('CSV', 'SPREADSHEET_XML', 'PDF');

CREATE TABLE "report_definition" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "report_definition_pkey" PRIMARY KEY ("id")
);

-- The list this table has: "my saved reports, most recently changed first".
CREATE INDEX "ix_report_definition_owner"
  ON "report_definition" ("tenant_id", "owner_user_id", "updated_at" DESC);

-- One name per owner among live rows. Partial, so a deleted definition frees its name — the same
-- rule and the same shape as `uq_saved_search_name`.
CREATE UNIQUE INDEX "uq_report_definition_name"
  ON "report_definition" ("tenant_id", "owner_user_id", "name")
  WHERE "deleted_at" IS NULL;

ALTER TABLE "report_definition"
  ADD CONSTRAINT "report_definition_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "report_definition"
  ADD CONSTRAINT "report_definition_owner_user_id_fkey" FOREIGN KEY ("owner_user_id")
  REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "report_export" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "report_key" TEXT NOT NULL,
    "format" "report_export_format" NOT NULL,
    "state" "report_export_state" NOT NULL DEFAULT 'REQUESTED',
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "requested_by_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "storage_key" TEXT,
    "file_object_id" UUID,
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT FALSE,
    "substitutions" INTEGER NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "report_export_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ix_report_export_tenant"
  ON "report_export" ("tenant_id", "requested_at" DESC);

ALTER TABLE "report_export"
  ADD CONSTRAINT "report_export_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "report_export"
  ADD CONSTRAINT "report_export_requested_by_id_fkey" FOREIGN KEY ("requested_by_id")
  REFERENCES "user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
