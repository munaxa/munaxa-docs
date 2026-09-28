-- RC validation, D-20: the idempotency record becomes the claim.
--
-- `IdempotencyInterceptor` looked a stored response up, ran the request, and stored the response
-- afterwards, in Redis. Nothing claimed the key while the first request ran, so five simultaneous
-- retries under one key created up to five documents. The record now lives where the schema always
-- put it — this table, in the tenant's own database — and is written *before* the request runs, by
-- whichever request's INSERT wins the unique index below. That is atomic across every API process.
--
-- The table has never been written to (the interceptor used Redis), so nothing is converted.

ALTER TABLE "idempotency_key"
    ADD COLUMN "state" TEXT NOT NULL DEFAULT 'COMPLETED',
    ADD COLUMN "owner_token" UUID,
    ADD COLUMN "lease_expires_at" TIMESTAMPTZ(6),
    ALTER COLUMN "status_code" DROP NOT NULL,
    ALTER COLUMN "response_body" DROP NOT NULL;

-- Every writer names the state; the default existed only to add the column.
ALTER TABLE "idempotency_key" ALTER COLUMN "state" DROP DEFAULT;

-- A claim names its owner and its lease; a completed record carries the status it answered with.
ALTER TABLE "idempotency_key" ADD CONSTRAINT "ck_idempotency_state" CHECK (
    ("state" = 'IN_PROGRESS' AND "owner_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    OR ("state" = 'COMPLETED' AND "status_code" IS NOT NULL)
);

-- One row per request rather than per key: the same key with a different method, path or body is a
-- different request, performed and replayed on its own (Slice 56), and must not be refused because
-- another request already holds the key.
DROP INDEX "uq_idempotency_tenant_key";
CREATE UNIQUE INDEX "uq_idempotency_request" ON "idempotency_key"("tenant_id", "key", "request_method", "request_path", "request_hash");
