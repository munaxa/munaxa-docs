# ADR-0022 — The hosted service runs on AWS: Amazon ECS on AWS Fargate

- **Status:** Accepted (product-owner decision, Phase 0 Decision 1)
- **Date:** 2026-10-01
- **Phase:** Production Phase 0 (go-live decisions)
- **Builds on:** [ADR-0015](./0015-database-per-tenant.md) and
  [ADR-0021](./0021-multi-tenant-hosted-launch.md) — it supersedes neither

## Context

The repository ships container images and has never prescribed a platform: the go-live runbook calls
itself deployment-agnostic and leaves the choice of infrastructure provider and orchestrator to the
operator ([go-live-runbook.md §1–§2](../../operations/go-live-runbook.md)). That stays true of the
product. What did not exist was a choice for **the Munaxa-hosted service** itself, and Phase 0 could
not close without one.

[ADR-0021](./0021-multi-tenant-hosted-launch.md) fixed the shape of that service: one multi-tenant
deployment, one PostgreSQL database per customer. The planning target for the first production
deployment is **up to 25 tenants** — a launch planning figure, not a product limit. The release to
deploy is `4e8e1ca`, published as three immutable images
([production-release-package-4e8e1ca.md](../../reports/production-release-package-4e8e1ca.md)), and
`bda59e8` makes the configured database pool size the one in force.

AWS ECS on Fargate was evaluated read-only against the documented production requirements: immutable
digest deployment, runtime secret injection, the antivirus signature volume writable by UID/GID
101:102, private API → scanner traffic on port 1344, scheduled signature updates, health checks,
horizontal API/Web scaling, private access to PostgreSQL, Redis and object storage, and the worker
image not being deployed. No requirement failed. Every open item was a test in a non-production
account, a design decision within AWS, or an application change that does not depend on the
provider.

## Decision

> **Phase 0 Decision 1 — Hosting/orchestrator: AWS, with Amazon ECS on AWS Fargate as the container
> orchestrator, is selected as the hosting platform for the initial Munaxa-hosted multi-tenant SaaS
> launch (planning capacity: up to 25 tenants; one PostgreSQL database per tenant, per ADR-0015 and
> ADR-0021). The supporting managed services are RDS PostgreSQL 16, a managed Redis (ElastiCache or
> MemoryDB, to be decided), S3, EFS for the antivirus signature store, ALB/ACM/Route 53/WAF, Secrets
> Manager, CloudWatch-based alerting and SES via SMTP. Images are deployed only by the published
> immutable digests; the worker image is not deployed. Deployment manifests live in
> `munaxa/munaxa-docs`. The application remains provider-neutral, and dedicated and on-premise
> deployments remain supported by the same images. This selects the platform only: production
> remains NOT READY until the non-production AWS tests, the application changes and the
> product-owner decisions recorded with this decision are complete and evidenced, and the AWS region
> and account structure are decided before any resource is provisioned.**

The decision has four parts, and only the first is closed.

### 1. Decided: the platform

| Concern | Decided |
| --- | --- |
| Cloud provider | AWS |
| Orchestrator and compute | Amazon ECS on AWS Fargate, for the API and the web application |
| PostgreSQL | RDS PostgreSQL 16, one database per tenant (ADR-0015) |
| Object storage | S3 |
| Antivirus signature store | EFS, mounted by the scanner as UID/GID 101:102 |
| Edge | ALB, ACM, Route 53, AWS WAF |
| Secrets | Secrets Manager |
| Monitoring and alerting | CloudWatch-based |
| Mail | SES, through the existing `MAIL_DRIVER=SMTP` |
| Images | The published immutable digests only; the `worker` image is not deployed (go-live-runbook §11) |
| Manifests | In `munaxa/munaxa-docs` |

### 2. Not decided: supporting-service choices

| Choice | Options | Why it matters |
| --- | --- | --- |
| **Redis** | ElastiCache or MemoryDB | ElastiCache has no append-only file, so jobs enqueued but not yet consumed can be lost on failover (D-15), a deviation from `appendonly yes`; MemoryDB keeps a durable log. BullMQ needs `noeviction` either way |
| Image delivery | Direct GHCR pull, ECR pull-through cache, or a by-digest copy into ECR | With direct GHCR, an expired pull credential stops new tasks from starting. Tied to Decision 2's open token items |
| S3 credentials | A bucket-scoped static key pair for launch, or an application change for role-based credentials | The S3 adapter signs with configured keys only; an instance role or task role is not supported (go-live-runbook §7) |
| Queue consumers | On every API task, or a separate single consumer service | Each consumer instance runs its own every-tenant sweeps; the runbook and a configuration comment disagree (go-live-runbook §11) |
| Scanner count | One task, or several sharing EFS | One is a single point of failure for uploads; several need the shared-writer behaviour proven |
| Signature-update path | Domain-filtered egress, or a private mirror | The scanner may reach nothing but its update source (prerequisite 5) |

### 3. Not decided: infrastructure parameters

The AWS region and DR region, the AWS account structure and its administrators, ECS task CPU and
memory, task counts, the RDS instance class and Multi-AZ form, the Redis node type, the number of
Availability Zones, VPC endpoints, retention locations, and budget. **None is chosen by this
record**, and no resource may be provisioned before the region and account structure are decided.

### 4. Unchanged: production readiness

Production remains **NOT READY**
([production-prerequisites-checklist.md](../../operations/production-prerequisites-checklist.md)).
Selecting a platform evidences none of the prerequisites.

## Consequences

**What must be proven in a non-production AWS account before production**, each against the
existing documented requirement:

1. GHCR (or ECR) pull by digest, with the digest preserved.
2. RDS: `infra/sql/cluster/01-roles.sql` without a true superuser; `edms_backup` with `BYPASSRLS` and
   `pg_read_all_data`; forced row-level security; migrations of two tenants; Multi-AZ failover with
   the application reconnecting.
3. Redis over TLS with auth (`rediss://`) through ioredis and BullMQ; `noeviction`; queue rebuild
   after a flush.
4. The scanner on EFS: the 101:102 access point passing `entrypoint.sh`; clamd load and reload;
   scheduled freshclam as a one-off task; behaviour with more than one writer; first start inside the
   ECS start period; memory; `probe.mjs` exit 0 from the API's network; egress to the update source
   only.
5. Health wiring: one tenant database being unavailable must not make ECS replace or the ALB drop
   every API task (ADR-0021 §4).
6. Cron safety with consumers on more than one task, if that placement is chosen.
7. S3: presigned PUT and GET from a browser, CORS, versioning, cross-region replication.
8. Secrets Manager: version pinning per deployment, retention of key history for 7+ years, the size of
   an inline tenant catalogue.
9. SES over SMTP with TLS from a private subnet; SPF, DKIM and DMARC.
10. Alerts reaching production on-call.
11. Recovery rehearsal 7b, including a single-tenant point-in-time restore by extraction
    ([backup-and-restore.md §2.2](../../operations/backup-and-restore.md)).
12. The load baseline, with connection usage measured against RDS `max_connections`: each API task
    holds up to `DATABASE_MAX_TENANT_CLIENTS × DATABASE_POOL_SIZE` (25 × 10 = 250 by default).

**Application changes that may be required before production**, depending on the results above and
the open choices:

- the readiness behaviour when one tenant database is unavailable, unless infrastructure wiring alone
  contains it (ADR-0021 §4);
- role-based S3 credentials, only if long-lived keys are not accepted;
- a read-only scanner mode, only if several scanners share EFS and conflict;
- cron safety across instances, only if consumers stay on every task and the test fails.

Each goes through the ordinary pull-request and CI path and produces new image digests.

**Constraints accepted with the platform** — each still subject to the sign-offs already recorded:
point-in-time recovery is per RDS instance, so one tenant is restored by extraction; onboarding a
tenant restarts the API (D-1); no API keys on the multi-tenant deployment (KEY-1); WAF inspects the
first 8 KB of a request body, which affects API requests only, because document uploads and downloads
go directly to S3 by presigned URL; a rotated secret takes effect only after a redeployment; the SES
sandbox and Fargate quotas need AWS requests.

**Portability is kept, deliberately.** The application contains no AWS SDK and no AWS-only code path;
its only AWS-specific line is the default S3 endpoint for a region. Every AWS facility the hosted
service uses reaches the application as environment configuration. A change made for AWS — role-based
credentials, for example — must stay optional, so that dedicated and on-premise deployments keep
running the same images.

## Alternatives considered

Only AWS ECS on Fargate was evaluated, at the product owner's direction; other providers were not
compared. Kubernetes on AWS, Compose on a VM and the other deployment shapes the images support remain
available to dedicated and on-premise deployments, which this decision does not constrain.
