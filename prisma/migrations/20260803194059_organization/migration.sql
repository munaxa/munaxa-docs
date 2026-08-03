-- CreateTable
CREATE TABLE "company" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "branch_id" UUID,
    "parent_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_department" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" UUID,

    CONSTRAINT "user_department_pkey" PRIMARY KEY ("user_id","department_id")
);

-- CreateIndex
CREATE INDEX "ix_company_tenant" ON "company"("tenant_id");

-- CreateIndex
CREATE INDEX "ix_entity_company" ON "entity"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "ix_branch_entity" ON "branch"("tenant_id", "entity_id");

-- CreateIndex
CREATE INDEX "ix_department_entity" ON "department"("tenant_id", "entity_id");

-- CreateIndex
CREATE INDEX "ix_department_path" ON "department"("tenant_id", "path");

-- CreateIndex
CREATE INDEX "ix_user_department_by_department" ON "user_department"("tenant_id", "department_id");

-- AddForeignKey
ALTER TABLE "company" ADD CONSTRAINT "company_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity" ADD CONSTRAINT "entity_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity" ADD CONSTRAINT "entity_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department" ADD CONSTRAINT "department_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department" ADD CONSTRAINT "department_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department" ADD CONSTRAINT "department_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department" ADD CONSTRAINT "department_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_department" ADD CONSTRAINT "user_department_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_department" ADD CONSTRAINT "user_department_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partial unique indexes. Prisma cannot express these, and the schema conventions require
-- them: a code freed by a soft delete must be reusable.
--
-- Codes are compared case-insensitively because they are typed by people and appear in
-- document numbers — "QA" and "qa" being two departments is a data-entry accident, not a
-- distinction anybody intends (`05-database-design.md` §2).
CREATE UNIQUE INDEX "uq_company_tenant_code" ON "company" ("tenant_id", lower("code"))
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "uq_entity_company_code" ON "entity" ("company_id", lower("code"))
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "uq_branch_entity_code" ON "branch" ("entity_id", lower("code"))
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "uq_department_entity_code" ON "department" ("entity_id", lower("code"))
  WHERE "deleted_at" IS NULL;

-- One primary department per person. A partial unique index rather than application logic:
-- two "primary" rows would make routing and numbering defaults nondeterministic, and the
-- second writer must lose rather than both succeed.
CREATE UNIQUE INDEX "uq_user_department_primary" ON "user_department" ("user_id")
  WHERE "is_primary";

-- Prefix search on the materialised path, for "every descendant of this node".
-- text_pattern_ops is what makes LIKE 'prefix%' use the index rather than scan.
CREATE INDEX "ix_department_path_prefix" ON "department" ("tenant_id", "path" text_pattern_ops);
