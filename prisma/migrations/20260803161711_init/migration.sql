-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "audit_outcome" AS ENUM ('SUCCESS', 'DENIED', 'FAILED');

-- CreateEnum
CREATE TYPE "audit_subject_type" AS ENUM ('DOCUMENT', 'REVISION', 'FOLDER', 'LIBRARY', 'USER', 'ROLE', 'WORKFLOW', 'TASK', 'CONFIGURATION', 'SESSION', 'FILE');

-- CreateEnum
CREATE TYPE "actor_channel" AS ENUM ('WEB', 'API', 'WORKER', 'SYSTEM');

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "tenant_status" NOT NULL DEFAULT 'ACTIVE',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "actor_id" UUID,
    "on_behalf_of_id" UUID,
    "channel" "actor_channel" NOT NULL,
    "action" TEXT NOT NULL,
    "subject_type" "audit_subject_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "outcome" "audit_outcome" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "reason" TEXT,
    "correlation_id" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "hash" CHAR(64) NOT NULL,
    "previous_hash" CHAR(64) NOT NULL,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_message" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_path" TEXT NOT NULL,
    "request_method" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE INDEX "ix_tenant_status" ON "tenant"("status");

-- CreateIndex
CREATE INDEX "ix_audit_subject" ON "audit_event"("tenant_id", "subject_type", "subject_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "ix_audit_actor" ON "audit_event"("tenant_id", "actor_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "ix_audit_occurred" ON "audit_event"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "ix_audit_correlation" ON "audit_event"("correlation_id");

-- CreateIndex
CREATE INDEX "ix_outbox_pending" ON "outbox_message"("available_at");

-- CreateIndex
CREATE INDEX "ix_outbox_aggregate" ON "outbox_message"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "ix_idempotency_expiry" ON "idempotency_key"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_idempotency_tenant_key" ON "idempotency_key"("tenant_id", "key");

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_message" ADD CONSTRAINT "outbox_message_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
