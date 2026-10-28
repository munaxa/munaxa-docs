-- ADR-0026: the entitlement state a deployment keeps for each tenant.
--
-- One row per tenant, holding the last entitlement snapshot this deployment verified and the latest
-- instant it has observed. The snapshot is what keeps a tenant working through an outage of the
-- central subscription service (degraded by age, never widened); the instant is what makes a clock
-- wound back to un-expire an offline licence detectable after a restart, not only within one process.
--
-- Additive. No existing row is touched, and a tenant with no row behaves as one never yet resolved.
-- Row-level security is applied by infra/sql/post-migrate/01-tenant-isolation.sql, which discovers
-- the tenant_id column.

CREATE TABLE "entitlement_state" (
    "tenant_id" UUID NOT NULL,
    "snapshot" JSONB,
    "source" TEXT NOT NULL,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "entitlement_state_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "ck_entitlement_state_source" CHECK ("source" IN ('UNMETERED', 'LICENSE_FILE', 'CONTROL_PLANE'))
);

ALTER TABLE "entitlement_state" ADD CONSTRAINT "entitlement_state_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
