# ADR-0023 — The initial hosted AWS region is eu-central-1 (Frankfurt)

- **Status:** Accepted (product-owner decision)
- **Date:** 2026-10-02
- **Phase:** Production Phase 0 (go-live decisions)
- **Builds on:** [ADR-0022](./0022-hosted-platform-aws-ecs-fargate.md) — it supersedes nothing.
  ADR-0022 left the AWS region open; this record closes that one item and leaves every other open
  item of ADR-0022 as it was

## Context

[ADR-0022](./0022-hosted-platform-aws-ecs-fargate.md) selected AWS, with Amazon ECS on AWS Fargate,
for the Munaxa-hosted multi-tenant service, and recorded that **no AWS resource may be provisioned
before the region and account structure are decided**. It chose no region.

The account structure for validation is now in use: a dedicated non-production AWS account. The
region was first planned as `me-central-1` (UAE). Working in that region for the non-production
validation produced two findings, both recorded as evidence in
[aws-region-validation-eu-central-1.md](../../reports/aws-region-validation-eu-central-1.md):

1. **An Availability Zone limitation.** AWS refused every subnet in `me-central-1b`
   (`InvalidParameterValue: Availability Zone mec1-az2 is unavailable`), leaving two usable zones.
2. **The RDS PostgreSQL instance was never established.** The RDS API listed PostgreSQL 16.12 on
   `db.t4g.small` (gp3, Multi-AZ, encrypted) as orderable in `me-central-1`, but no instance was
   created: the scripted attempt was stopped by the operator tooling before it reached AWS, and the
   console attempt left no instance and no recorded AWS error. The cause is therefore **not
   established**; what is established is that the data tier of the validation environment could not
   be brought up there.

The product owner then excluded Arab-region AWS regions for the validation environment and named
`eu-central-1` as the candidate. A read-only assessment of `eu-central-1` for the same account found
every service the stack needs available, three Availability Zones, and the exact RDS configuration
orderable.

## Decision

> **The initial Munaxa-hosted AWS region is `eu-central-1` (Europe, Frankfurt), starting with the
> non-production validation environment. The non-production environment uses two Availability Zones,
> `eu-central-1a` and `eu-central-1b`; `eu-central-1c` is held in reserve. This records a region
> only: no `eu-central-1` resource exists yet, the planning capacity stays up to 25 tenants, and
> production remains NOT READY.**

### What this record changes

| Item | Before | After |
| --- | --- | --- |
| Initial hosted AWS region (ADR-0022 §3) | open | **`eu-central-1`** |
| Non-production Availability Zones | — | `eu-central-1a`, `eu-central-1b` (`eu-central-1c` in reserve) |

### What it does not change

- **The product architecture.** One hosted multi-tenant deployment (ADR-0021), one PostgreSQL
  database per tenant (ADR-0015), Redis as a disposable queue/cache, S3 object storage, ECS on
  Fargate, the scanner on ECS with its signatures on EFS, deployment by immutable image digest, and a
  provider-neutral application.
- **The disaster-recovery region.** Not chosen here. It is a separate decision, still open.
- **Every other open item of ADR-0022:** Redis flavour, image delivery (GHCR or ECR), S3
  credentials, queue-consumer placement, scanner count, signature-update path, sizing and budget.
- **Production readiness.** Selecting a region evidences no prerequisite
  ([production-prerequisites-checklist.md](../../operations/production-prerequisites-checklist.md)).

## Consequences

- **SES is in sandbox in `eu-central-1`** (verified addresses only, 200 messages a day). Production
  sending needs an AWS request, which has not been made. Non-production can validate mail to
  verified addresses only.
- **The `me-central-1` validation resources do not move.** IAM is global, but both ECS roles trust
  `ecs-tasks.amazonaws.com` on the condition `aws:SourceArn = arn:aws:ecs:me-central-1:<account>:*`,
  and the execution role's log permission names `me-central-1` log groups; both must name
  `eu-central-1` before an EU task can use them. An S3 bucket's region is fixed, so the validation
  bucket is recreated in `eu-central-1`. The network is rebuilt. The report lists each resource and
  what becomes of it.
- **Data residency.** Customer data of the hosted service is processed in the EU (Germany). Any
  contractual or regulatory constraint on where customer data may reside must be checked against
  this before production; this record does not assess it.
- **The application needs no change.** The region reaches it as `STORAGE_REGION`; AWS's own S3
  endpoint for that region is derived from it.

## Alternatives considered

- **Stay in `me-central-1`.** Rejected for the validation environment by the product owner after
  the findings above; Arab-region AWS regions are excluded for it.
- **Other European regions.** Not assessed; `eu-central-1` was the owner's named candidate and was
  found complete.
