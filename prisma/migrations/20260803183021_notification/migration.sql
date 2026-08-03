-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('EMAIL', 'IN_APP', 'SMS', 'PUSH', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "delivery_state" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "digest_frequency" AS ENUM ('IMMEDIATE', 'HOURLY', 'DAILY', 'WEEKLY');

-- CreateTable
CREATE TABLE "notification_template" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type_key" TEXT NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "locale" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "body_html" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "notification_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preference" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type_key" TEXT NOT NULL,
    "channels" "notification_channel"[],
    "digest" "digest_frequency" NOT NULL DEFAULT 'IMMEDIATE',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("user_id","type_key")
);

-- CreateTable
CREATE TABLE "notification_message" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "type_key" TEXT NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "locale" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "body_html" TEXT,
    "state" "delivery_state" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "failure_reason" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_notification_template" ON "notification_template"("tenant_id", "type_key", "channel", "locale");

-- CreateIndex
CREATE INDEX "ix_notification_preference_type" ON "notification_preference"("tenant_id", "type_key");

-- CreateIndex
CREATE INDEX "ix_notification_inbox" ON "notification_message"("tenant_id", "recipient_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_notification_pending" ON "notification_message"("tenant_id", "state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_notification_idempotency" ON "notification_message"("tenant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "notification_template" ADD CONSTRAINT "notification_template_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_message" ADD CONSTRAINT "notification_message_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_message" ADD CONSTRAINT "notification_message_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
