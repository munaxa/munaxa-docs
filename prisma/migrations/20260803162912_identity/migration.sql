-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "password_algorithm" AS ENUM ('SCRYPT');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "user_status" NOT NULL DEFAULT 'INVITED',
    "password_hash" TEXT,
    "password_algorithm" "password_algorithm",
    "password_updated_at" TIMESTAMPTZ(6),
    "mfa_enrolled" BOOLEAN NOT NULL DEFAULT false,
    "permission_version" INTEGER NOT NULL DEFAULT 1,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission")
);

-- CreateTable
CREATE TABLE "user_role" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" UUID,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "session_family" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "session_family_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_user_email" ON "user"("tenant_id", "email_normalized");

-- CreateIndex
CREATE INDEX "ix_user_status" ON "user"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "ix_role_tenant" ON "role"("tenant_id");

-- CreateIndex
CREATE INDEX "ix_role_permission_lookup" ON "role_permission"("tenant_id", "permission");

-- CreateIndex
CREATE INDEX "ix_user_role_by_role" ON "user_role"("tenant_id", "role_id");

-- CreateIndex
CREATE INDEX "ix_session_family_user" ON "session_family"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "ix_refresh_token_family" ON "refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "ix_refresh_token_expiry" ON "refresh_token"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_refresh_token_hash" ON "refresh_token"("token_hash");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_family" ADD CONSTRAINT "session_family_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_family" ADD CONSTRAINT "session_family_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "session_family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique indexes. Prisma cannot express these, and the schema conventions require
-- them: a unique constraint on soft-deletable data must ignore deleted rows, so removing a
-- user frees their address for re-invitation and removing a role frees its key.
CREATE UNIQUE INDEX "uq_user_tenant_email" ON "user" ("tenant_id", "email_normalized")
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "uq_role_tenant_key" ON "role" ("tenant_id", "key")
  WHERE "deleted_at" IS NULL;
