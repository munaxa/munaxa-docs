-- Phase 12 — notifications: what `18-notification-architecture.md` §§5 and 7 needed a database for.
--
-- Phase 1 built the whole pipeline and gave it three tables. This migration adds two columns and
-- three tables, and each answers one question the pipeline could not.
--
-- **Two enum values, because holding a message back is a state.** The alternative considered was
-- `release_at` alone — `QUEUED` rows with a future release, invisible to the claim — and it was
-- rejected because an operator asking "what is waiting to go out" would get one number covering
-- both a mail outage and a quiet-hours hold, which are the two conditions that most need telling
-- apart. `release_at` still exists and still gates the claim; the state says *why*.
--
-- A digested message is deliberately **not** `SUPPRESSED`. Suppression means an address that must
-- not be written to; overloading it would make "how many addresses are we refusing" a question
-- this table answers wrongly.
--
-- **`notification_quiet_hours` is per person, not per type.** `notification_preference` is keyed
-- `(user, type)`, and quiet hours are a property of the human being: nobody wants to be quiet for
-- approvals and loud for publications at three in the morning. The window is minutes past local
-- midnight rather than two timestamps, because "do not write to me between 19:00 and 07:00" is a
-- rule about a clock face and instants would expire. A start after the end wraps midnight, which
-- is the ordinary case rather than a special one.
--
-- **`notification_suppression` is keyed by the address, not the user.** Identity owns users and
-- nobody reads its tables — but the stronger reason is that suppression is a fact about a
-- *mailbox*. Somebody who corrects their address is reachable again at once, and somebody who
-- inherits a colleague's old address does not inherit their bounces. The third option, deriving
-- the count from `notification_message`, was rejected because it makes an operational decision a
-- scan over history that can never be cleared without deleting the record of what was sent.
--
-- **`notification_batch` is a row rather than a delayed job**, and that is the whole of §7's last
-- row. A job whose id encodes the batch would coalesce too — and would keep the *first* payload
-- and discard the rest, so a summary of five hundred purges would say "1". A row that increments
-- is the only shape that can count.
--
-- Row-level security is not written here. `infra/sql/post-migrate/01-tenant-isolation.sql`
-- discovers every table in `public` carrying `tenant_id` and applies FORCE ROW LEVEL SECURITY and
-- a `tenant_isolation` policy to it, and the post-migrate gate raises if one is missed. All three
-- tables below carry `tenant_id` and are therefore covered without being named anywhere.

-- AlterEnum
-- Additive only, and neither value is used inside this migration — which is what makes adding
-- two of them in one transaction safe on PostgreSQL 12 and later.
ALTER TYPE "delivery_state" ADD VALUE 'HELD';
ALTER TYPE "delivery_state" ADD VALUE 'DIGESTED';

-- AlterTable
ALTER TABLE "notification_message"
  ADD COLUMN "release_at" TIMESTAMPTZ(6),
  -- Which window a held message is waiting for, null when it is held only for quiet hours.
  -- Stored rather than re-read from the preference at collection time: the two answers differ
  -- the moment somebody changes their mind mid-window, and the honest one is the choice that was
  -- in force when the message was held.
  ADD COLUMN "digest_window" "digest_frequency",
  ADD COLUMN "digest_message_id" UUID;

-- The claim query now filters on `release_at` as well as state, so the index that serves it
-- carries the column. Replaced rather than added beside: two indexes on overlapping prefixes of
-- the same table cost writes on every notification and answer one question between them.
DROP INDEX IF EXISTS "ix_notification_pending";
CREATE INDEX "ix_notification_pending"
  ON "notification_message" ("tenant_id", "state", "release_at", "created_at");

-- CreateTable
CREATE TABLE "notification_quiet_hours" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_quiet_hours_pkey" PRIMARY KEY ("user_id")
);

-- The window is a clock face. A stored minute outside a day is not a preference anybody could
-- have expressed through the API, so it is refused by the database rather than defended against
-- on every read.
ALTER TABLE "notification_quiet_hours"
  ADD CONSTRAINT "ck_quiet_hours_range"
  CHECK ("start_minute" BETWEEN 0 AND 1439 AND "end_minute" BETWEEN 0 AND 1439);

-- CreateTable
CREATE TABLE "notification_suppression" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "bounce_count" INTEGER NOT NULL DEFAULT 0,
    "suppressed_at" TIMESTAMPTZ(6),
    "last_reason" TEXT,
    "last_bounced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_batch" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "type_key" TEXT NOT NULL,
    "recipient_ids" UUID[],
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "values" JSONB NOT NULL DEFAULT '{}',
    "release_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_batch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_notification_quiet_hours_tenant" ON "notification_quiet_hours"("tenant_id");
CREATE UNIQUE INDEX "uq_notification_suppression" ON "notification_suppression"("tenant_id", "address");
CREATE INDEX "ix_notification_suppression_active" ON "notification_suppression"("tenant_id", "suppressed_at");
CREATE UNIQUE INDEX "uq_notification_batch" ON "notification_batch"("tenant_id", "key");
CREATE INDEX "ix_notification_batch_due" ON "notification_batch"("tenant_id", "release_at");

-- AddForeignKey
ALTER TABLE "notification_quiet_hours"
  ADD CONSTRAINT "notification_quiet_hours_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_suppression"
  ADD CONSTRAINT "notification_suppression_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_batch"
  ADD CONSTRAINT "notification_batch_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- `SET NULL` rather than `RESTRICT`: a digest is one message among many and deleting one must not
-- be blocked by the members that name it. What it carried is still recorded on each member's own
-- row, in its state.
ALTER TABLE "notification_message"
  ADD CONSTRAINT "notification_message_digest_message_id_fkey"
  FOREIGN KEY ("digest_message_id") REFERENCES "notification_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
