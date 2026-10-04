# ADR-0024 — The first-customer launch uses the minimum-cost AWS architecture

- **Status:** Accepted (product-owner decision)
- **Date:** 2026-10-04
- **Phase:** Production Phase 0 (go-live decisions)
- **Builds on:** [ADR-0021](./0021-multi-tenant-hosted-launch.md),
  [ADR-0022](./0022-hosted-platform-aws-ecs-fargate.md) and
  [ADR-0023](./0023-initial-aws-region-eu-central-1.md). It **amends ADR-0022** where the table in
  [What this amends, and what it leaves alone](#what-this-amends-and-what-it-leaves-alone) says so, and supersedes nothing else. The application, the tenancy model, the platform (AWS ECS on
  Fargate) and the region (`eu-central-1`) are unchanged

## Context

[ADR-0022](./0022-hosted-platform-aws-ecs-fargate.md) chose AWS ECS on Fargate and named a full set of
supporting services: managed Redis, EFS for the antivirus signatures, an ALB with AWS WAF, and
CloudWatch alerting. The first design drawn from it for the initial launch was sized for the
25-tenant planning figure and estimated at about **$146–152 per month** before any customer pays.
The fuller high-availability form of the same design was estimated at about $500–600 per month.

The company has no revenue yet. The product owner's requirement is explicit:

> Use the absolute minimum realistic monthly AWS cost for the first paying customers, then scale
> individual components as customers and usage grow.

A read-only cost review of the launch design, checked against the repository, found the following.

- **No application code change is needed for the cheaper launch.** Every reduction below is
  configuration, task placement or infrastructure sizing. All three published images run as they are.
- **Several components of the first design are not required for 1–2 tenants**: a `db.t4g.small`
  database, a managed Redis node, an on-demand scanner, a standing bastion, a fifth secret and an
  external health check.
- **Four costs cannot be removed** without giving up a requirement: the load balancer, the three
  always-on tasks, their public IPv4 addresses and the database (§4).

### Evidence this decision relies on

All of it was gathered in the non-production account (`eu-central-1`, application revision `041e827`,
API image `ghcr.io/munaxa/munaxa-docs-api@sha256:085352e0f06f4da7400df23006b0ff1e870ebedc444edf84e3368772a0ba23ca`).

| Evidence | Result |
| --- | --- |
| ECS task-role S3 credentials on real Fargate | **Passed.** Temporary task-role credentials signed put, head, get, a presigned download (fetched with status 200) and delete against the validation bucket. No long-lived key was present |
| Static S3 credentials beside `STORAGE_CREDENTIALS_SOURCE=ECS_TASK_ROLE` | **Validated as refused.** The real API on Fargate named both `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`, refused to start, made no S3 call and did not echo the values |
| **RDS capability probe** (2026-10-04), RDS PostgreSQL 16.12 on `db.t4g.small`, run as the RDS master user over `sslmode=require` (TLSv1.3), inside one transaction that was **rolled back** | **Database role setup passed.** `infra/sql/cluster/01-roles.sql` ran in full, verbatim. `CREATE ROLE edms_backup LOGIN BYPASSRLS` succeeded. `GRANT pg_read_all_data TO edms_backup` succeeded. After rollback, no `edms_*` role remained |
| The same probe: connection capacity | **`max_connections` = 181** on `db.t4g.small`, with 3 reserved for superusers. It is set by the formula `LEAST({DBInstanceClassMemory/9531392},5000)` |
| The same probe: RDS specifics | The master user is not a true superuser: it is a member of `rds_superuser`, which was sufficient. On PostgreSQL 16 the master is **not** able to `SET ROLE edms_owner` by default; it needs `GRANT edms_owner TO <master> WITH SET TRUE` once before `CREATE DATABASE … OWNER edms_owner`, which was tested inside the rollback. `rds.force_ssl` is `1`, so `sslmode=require` is mandatory |
| Repository: browser access to the API | Browsers load previews from `${STORAGE_PUBLIC_URL}/api/v1/preview/stream/…` (`apps/api/src/modules/preview/application/preview-query.service.ts`). Every other API call is made server-side by the web tier (`apps/web/src/lib/api-client.ts`) |
| Repository: health payload | `/api/health` names every tenant by slug (`apps/api/src/core/observability/health/health.service.ts`), so it must not be public |

Not yet tested, and not changed by this record:

- `CREATE DATABASE`;
- the per-database SQL (`infra/sql/database`, `infra/sql/post-migrate`) and the migrations;
- a real `pg_dump` as `edms_backup` through forced row-level security;
- a `db.t4g.micro` instance;
- the full API starting in production mode on AWS.

## Decision

> **The first paying customers are served by the minimum-cost launch architecture defined in this
> record, targeted at 1–2 tenants and suitable, with the documented pool adjustment, for up to 5. It
> keeps every security, tenant-isolation, scanning, audit and recovery requirement of the product. It
> trades availability and operational convenience for cost. Each component is upgraded on its own
> trigger, without redesigning the application. This is a launch configuration, not a product limit
> and not a scalability ceiling. Production remains NOT READY.**

### 1. Capacity

- **Initial target:** 1–2 paying tenants.
- **Suitable for:** up to 5 tenants with `DATABASE_POOL_SIZE=4` (§2.5).
- **Not a product limit.** At each threshold in §6 one component is upgraded. The tenant model,
  images and code stay as they are.

### 2. The launch architecture

```
Internet ──443──▶ ALB (ACM certificate, 80→443) ── /api/v1/preview/stream* ──▶ API target (3001)
                     │ everything else
                     ▼
               Web task (3000) ──server-side, Cloud Map──▶ API task (3001 + Redis on 127.0.0.1)
                                                                 │ ICAP 1344, Cloud Map
                                                                 ▼
                                                       Scanner task (Fargate Spot)
 API ──5432 (sslmode=require)──▶ RDS PostgreSQL 16, db.t4g.micro, Single-AZ, private subnets
 API ──443 (task role)─────────▶ S3 bucket (versioned)
 API ──587 STARTTLS────────────▶ mail relay
```

#### 2.1 ECS

| Service | Size | Tasks | Notes |
| --- | --- | --- | --- |
| Web | 0.25 vCPU / 1 GB | 1 | No task role. Reaches the API server-side |
| API | 0.5 vCPU / 2 GB | 1 | Task role for S3 only; queue consumers on (`QUEUE_CONSUMERS_ENABLED=true`); Redis runs beside it in the same task (§2.6) |
| Scanner | 0.25 vCPU / 2 GB | 1 | On Fargate Spot (§2.7). No task role |

- **Images:** every task definition references `image@sha256:<digest>` only.
- **Web and API stay separate services.** They are not consolidated into one task (§3.1).
- **API deploys:** use a stop-first replacement (minimum healthy 0%) until running queue consumers
  on two API processes at once is validated (ADR-0022 consequence 6). This is also required by §2.6.
  Web and scanner use rolling replacement.

#### 2.2 Networking

- **ECS tasks:** run in the **public subnets** with public IPv4 addresses. **No NAT Gateway** at launch.
- **Security groups:** one each for the ALB, Web, API, Scanner, RDS and Redis access paths. Each tier
  accepts only:

| Tier | Accepts |
| --- | --- |
| ALB | 443 and 80 from the internet |
| Web | 3000 from the ALB |
| API | 3001 from the Web and ALB groups |
| Scanner | 1344 from the API group |
| RDS | 5432 from the API group, plus a short-lived operator task while one runs (§2.10) |

- **Redis** is on the API task's loopback interface, so nothing else can reach it (§2.6).
- **No public access** to the API, scanner, RDS or Redis ports. RDS is private and not publicly
  accessible.
- **Outbound traffic:** each task's own public address, through security-group rules. The scanner
  needs 443 for signature downloads.
- **S3 traffic:** stays on the S3 gateway endpoint associated with the public route table.

#### 2.3 ALB

- **One HTTPS ALB** with an ACM certificate; port 80 redirects to 443.
- **Routing:** every request goes to Web, except **`/api/v1/preview/stream*` only**, which goes to the
  API. No other `/api/*` path is routed publicly: `/api/health` would disclose tenant slugs, and
  `/api/metrics` is operator-only.
- **Health checks:** Web on `/login`, which makes no API or database call without a session. API on
  `/api/health/live`.
  - The API's health check is deliberately **not** `/api/health/ready`. One tenant's database outage
    would then remove every API task (ADR-0021 §4).
- **Real client IP:** `TRUST_PROXY` (API) and `WEB_TRUST_PROXY` (Web) name the public subnet ranges,
  which hold only the ALB and these tasks.
- **Preview URLs:** `STORAGE_PUBLIC_URL` is the web origin, so preview URLs resolve through the ALB
  rule above.

#### 2.4 Service discovery

- **Cloud Map** private DNS namespace with two names:
  - `api`, for `NEXT_PUBLIC_API_URL`, the Web → API calls;
  - `scanner`, for `AV_ICAP_URL=icap://scanner.<namespace>:1344/avscan`.

#### 2.5 API and database

- **S3 credentials:** `STORAGE_CREDENTIALS_SOURCE=ECS_TASK_ROLE`. No static S3 credential exists in
  the API's configuration; startup refuses one, as validated.
- **Database instance:**
  - RDS PostgreSQL 16, **`db.t4g.micro`, Single-AZ**, 20 GB gp3, encrypted, not publicly accessible;
  - deletion protection on; automated backups kept **35 days**;
  - every connection string uses `sslmode=require`.
- **Pool size:** `DATABASE_POOL_SIZE=5` for 1–2 tenants and **4 for 3–5 tenants**.
- **Connection budget:** tenants × pool × API processes, plus about 5 operator connections. There is
  no separate pool for `DATABASE_URL` with a catalogue.
  - **Micro capacity:** about **87–90** connections by the same formula, an **estimate**. Planning
    uses 80, about 75 usable. It is validated by `SHOW max_connections` when a micro instance first
    exists.
  - **5 tenants at pool 4:** about 25 connections normally, about 45 during an overlapped deploy.
- **One-time preparation:** the master user's `edms_owner` membership (`WITH SET TRUE`), as shown by
  the probe.
- **`edms_backup`:** created with `BYPASSRLS` and `pg_read_all_data` per runbook §6 step 1b, for
  per-tenant extraction restores.

#### 2.6 Redis beside the API

- **Placement:** Redis 7 runs as a second container in the **API task**, pinned by digest.
- **Access:** bound to **127.0.0.1 only**, with password authentication and
  `maxmemory-policy noeviction`. No TLS: the traffic never leaves the task's loopback interface.
- **Connection string:** `REDIS_URL=redis://:<password>@127.0.0.1:6379`, from the application secret.

**Accepted consequence: an API restart or crash empties Redis.**

- **Rebuilt automatically from PostgreSQL:** cron schedules and pending workflow timers, at startup
  (D-13).
- **Not replayed:**
  - jobs enqueued but not yet consumed: notifications, webhook fan-out, preview renders, search
    projections (D-15);
  - deduplication windows, rate-limit counters and cached decisions. A cold cache gives the same
    answers.
- **Every planned API restart** (a deployment, or onboarding a tenant under D-1) **drains the queues
  first**. Before restarting, the operator confirms queue depth and pending outbox rows are at or near
  zero (go-live runbook §13 step 4).
- **A crash is not protected.**
- **The search index** can be rebuilt; the other lost jobs cannot.

#### 2.7 Scanner

- **Service:** one separate scanner service, 0.25 vCPU / 2 GB, on **Fargate Spot**. The cluster's
  capacity provider strategy names `FARGATE_SPOT` for this service only.
- **Signatures:** kept on the task's own local storage; **no EFS**. The image's entrypoint downloads
  them before `clamd` starts. EventBridge Scheduler replaces the task **daily** to refresh them.
- **Container health check:** a real scan through c-icap, as in `infra/docker-compose.yml`, not an
  ICAP `OPTIONS` ping.
- **Fail closed, always.** An unreachable, interrupted or erroring scanner records uploads as
  `FAILED` and filing refuses them (go-live runbook §9.5). An unscanned upload is never treated as
  clean. Reads continue.
- **Alarm:** an EventBridge rule alerts on any scanner task stop, including a Spot interruption.
- **Move to on-demand Fargate** if Spot interruptions or unavailable Spot capacity affect customers'
  uploads (§6).

#### 2.8 Secrets

Four Secrets Manager secrets. No sensitive value is placed in a plain ECS environment variable.

| Secret | Read by | Holds |
| --- | --- | --- |
| GHCR pull credential | ECS execution roles, for image pulls | Registry `username` and `password` |
| Application bundle | API execution role | `JWT_ACCESS_SECRET`, `SIGNATURE_WITNESS_SECRET`, `AUDIT_CHECKPOINT_SECRET`, `MFA_TOTP_SEALING_KEY`, `DATABASE_URL`, `REDIS_URL`, mail credentials, metrics token, **and the tenant catalogue** |
| Operator bundle | Operators and short-lived operator tasks only, **never the API** | `edms_owner` and `edms_backup` connection strings, and the operator catalogue (ADR-0021 §3) |
| RDS-managed master secret | Operators | Created and rotated by RDS |

- **Version pinning:** each deployment pins the application bundle's version (ADR-0022 consequence
  8).
- **Temporary secrets:** a new tenant's first-administrator password, used for D-1 provisioning, is
  passed in a short-lived secret, never in a task override.

#### 2.9 Mail

Mail goes out through `MAIL_DRIVER=SMTP` with STARTTLS or TLS and certificate validation, as
ADR-0022 decided. **Two things stay open:**

- **The credential.** SES SMTP credentials are derived from a dedicated IAM user; the alternative is
  `MAIL_DRIVER=RESEND`. This record does not choose between them.
- **SES production access.** Sending to customers needs SES production access, and that has not been
  requested.

#### 2.10 Operations

- **No standing bastion.**
- **Database roles and tenant databases** are created by short-lived Fargate tasks: a pinned
  `postgres:16` client using the RDS-managed master secret, the pattern the capability probe used.
- **Tenant provisioning** (`node apps/api/dist/provision.js`, D-1) runs as a short-lived task on the
  API image, with `QUEUE_CONSUMERS_ENABLED=false`.
- **Migrations** run from the release engineer's workstation, exactly as documented
  (`scripts/migrate-tenants.mjs`). They reach the private RDS through an AWS Systems Manager
  port-forwarding session via a temporary tunnel task: it has its own minimal role, accepts no inbound
  traffic, and stops when the session ends.

#### 2.11 Monitoring

Launch monitoring is deliberately minimal and covers critical failures only. All alerts go to an SNS
topic for on-call email.

- **ALB:** no healthy Web target; no healthy API target; target 5xx rate.
- **RDS:** free storage; freeable memory; connections above 70% of `max_connections`; CPU utilisation
  or CPU credit balance.
- **Scanner:** the container health check with a real scan (§2.7); EventBridge on scanner task stops.
- **ECS:** EventBridge on any task stop and any failed deployment, plus failed EventBridge Scheduler
  runs (the daily signature refresh).
- **Backups:** an RDS event subscription for backup failure, low storage and maintenance.
- **AWS Health** events, through EventBridge.
- **AWS Budgets:** an alert on the monthly budget.

**Not deployed at launch** unless a customer or security requirement asks for it: Container Insights,
Prometheus or Grafana, GuardDuty, VPC Flow Logs, synthetic monitoring, ALB access logs and WAF.

**Accepted gaps.** Three alerts in the go-live runbook's set have no alarm at launch:

- the API's own `antivirus: DEGRADED` signal, as opposed to the scanner's own health;
- outbox and queue backlog;
- a single tenant's database being down, as opposed to the instance.

The operator checks them before each planned deployment.

#### 2.12 Backup and recovery

| | Launch (required before the first customer) | Later (on the triggers in §6) |
| --- | --- | --- |
| PostgreSQL | RDS automated backups kept 35 days (point-in-time restore of the instance); a **manual snapshot before every migration** (runbook §19.2 allows a snapshot); a monthly snapshot kept 12 months; deletion protection | Multi-AZ; cross-region snapshot copies; scheduled per-tenant logical dumps |
| One tenant | Restore by extraction: recover the instance to a time in a temporary instance, then copy the one tenant's database out as `edms_backup` (backup-and-restore §2.2) | — |
| Object storage | Versioning on, with a lifecycle rule for noncurrent versions | Cross-region replication, once the DR region is chosen (ADR-0023 leaves it open) |
| Rehearsal | **One recovery rehearsal before the first customer**, including a single-tenant restore by extraction | Periodic rehearsals |
| Enterprise | — | AWS Backup Vault Lock, cross-account backup copies, S3 Object Lock, a standby DR environment |

### 3. Rationale for the choices that look cheaper than they are

#### 3.1 Web, API and Scanner stay separate

Putting Web and API in one task works without code changes and saves about $12 per month. It is
rejected because ECS grants the task role to every container in a task.

- **S3 exposure.** A Web-tier compromise would hold direct read, write and delete access to every
  tenant's S3 objects, including the audit checkpoints, bypassing the application's authorisation and
  audit trail.
- **Network reach.** The Web tier would also share the API's network interface. It could then reach
  the database and the loopback Redis, against the go-live runbook's network matrix ("anything not
  listed should be closed").

The scanner parses untrusted files. Production prerequisite 5 requires it to have no database access
and no network path except from the API, so it stays a separate task with no task role.

#### 3.2 The ALB cannot be removed without a self-managed proxy

The edge must provide three things:

- publicly trusted HTTPS;
- one path routed to the API, `/api/v1/preview/stream*`, serving previews up to
  `PREVIEW_MAX_OUTPUT_BYTES` (64 MB by default);
- the real client address in `X-Forwarded-For`, for the per-address sign-in limit.

Fargate tasks cannot hold a fixed address. The managed alternatives fail:

| Alternative | Why it fails |
| --- | --- |
| API Gateway HTTP API | Caps responses at 10 MB, times out at 30 s, cannot stream, and cannot carry WAF |
| NLB | Costs the same as the ALB, cannot route by path, and adds no `X-Forwarded-For` |
| CloudFront | Its private VPC origins must themselves be a load balancer or an EC2 instance |

Only a reverse proxy on an EC2 instance (about $8 per month) is cheaper. It is rejected for paying
customers: it is a self-managed, internet-facing host with its own patching and certificate renewal,
and a single point of failure.

#### 3.3 Public IPv4 addresses are accepted temporarily

Three task addresses cost $10.95 per month. A NAT Gateway costs about $41.61 plus $0.052 per GB.

IPv6-only egress is not possible: the images are pulled from GHCR over IPv4.

**The security consequence:** the security group is the only barrier between the internet and each
task. It is controlled by:

- one security group per tier;
- no rule that admits the internet to anything but the ALB;
- infrastructure-as-code review of every rule change.

**The cost:** there is no fixed outbound address. A customer that must allow-list our address (for
webhooks, its mail relay or its identity provider), or whose policy forbids public addresses on
workloads, triggers the move to private subnets behind NAT (§6).

#### 3.4 Redis is colocated with the API on purpose

The smallest managed node, `cache.t4g.micro`, costs $13.14 per month. ElastiCache Serverless is ruled
out: its cluster-mode endpoint needs BullMQ key prefixes, and this application has no prefix setting
(ADR-0021 §7), so using it would need a code change.

Redis holds no records. Queues are fed from the transactional outbox (ADR-0011), and schedules and
timers are rebuilt from PostgreSQL (D-13).

There is a single API process, so locks and rate limits are not split across instances.

The accepted cost is §2.6: queued, unconsumed work is lost on every API restart. The queue-drain
step contains this for planned restarts; crashes are not covered. It is the first component upgraded
(§6).

#### 3.5 Fargate Spot is acceptable for the scanner because scanning fails closed

An interruption costs availability, not safety. During the 2–4 minutes until a replacement task has
signatures and `clamd` running, new uploads are recorded `FAILED` and must be uploaded again. Reads,
downloads and previews continue.

No interruption can mark a file clean. Spot saves about $10 per month on this task.

If Spot capacity is unavailable, the scanner may stay down until capacity returns. That is why the
scanner-stop alarm exists and why on-demand is the documented fallback.

### 4. Estimated monthly cost

USD, `eu-central-1` on-demand list prices from the AWS Price List API (2026-10-04), 730 hours.
Tax and AWS Support are excluded. **These are estimates, not a guaranteed bill.**

| Component | $/month | Kind |
| --- | --- | --- |
| Web task + its public IPv4 | 15.88 | Fixed |
| API task (with Redis inside it) + its public IPv4 | 28.11 | Fixed |
| Scanner task on Fargate Spot + its public IPv4 | ~9.24 | **Estimate**: Spot price varies (assumed about 65% below the on-demand $15.96) |
| RDS `db.t4g.micro` Single-AZ + 20 GB gp3 | 16.61 | Fixed |
| ALB (hourly + two public IPv4 + about 0.5 capacity units) | ~27.51 | Fixed + **usage** |
| Cloud Map namespace and two registrations | ~0.70 | Fixed |
| Secrets Manager (4) | 1.60 | Fixed |
| Route 53 public hosted zone (or $0 if DNS stays with the existing provider) | 0.50 | Fixed |
| CloudWatch alarms (~8) and logs (~0.5–1 GB) | ~1.40 | **Usage** |
| S3, SES, CloudTrail log storage, other | ~0.60 | **Usage** |
| RDS backups (within the free allowance equal to provisioned storage) | ~0 | **Usage** |
| **Target** | **≈ 102** | |

- **Usage-dependent:** document storage, downloads beyond the first 100 GB a month, email volume, log
  volume and load-balancer traffic.
- **On-demand scanner:** the total is about $113.
- **Unavoidable:** the ALB, the three always-on tasks, their public IPv4 addresses and the database,
  about $98. Production refuses to start without a scanner, so that task is unavoidable too.

**Not included:** the non-production environment. Its NAT Gateway and Multi-AZ `db.t4g.small` instance
cost about $100 per month while idle. Whether to keep it is a separate owner decision.

### 5. Launch requirements and later requirements

| Launch requirement (this record) | Future HA, scale or enterprise requirement |
| --- | --- |
| One task each of Web, API and Scanner | Several tasks per service across AZs; autoscaling |
| Single-AZ `db.t4g.micro` | `db.t4g.small` and larger; Multi-AZ |
| Redis beside the API | ElastiCache, then a replica or MemoryDB |
| One Spot scanner, local signatures | On-demand; several scanners sharing EFS |
| Public-subnet tasks, no NAT | Private subnets behind NAT |
| ALB without WAF | AWS WAF |
| Minimal alarms and events | Container Insights or Prometheus, GuardDuty, flow logs, synthetic checks |
| 35-day backups, monthly snapshots, versioning, one rehearsal | Cross-region replication and snapshot copies, vault lock, a DR environment |
| Stop-first API deployments | Rolling API deployments with separated consumers |

### 6. Upgrade path and triggers

Each row is applied on its own trigger. None changes the application.

| From → to | Trigger (first of) | Effect |
| --- | --- | --- |
| **RDS `db.t4g.micro` → `db.t4g.small`** | **Before the 6th tenant is onboarded**; `DatabaseConnections` above 55 sustained; `FreeableMemory` below 128 MB for 15 minutes, or any swap above 100 MB; CPU credit balance falling for 7 days, or daily average CPU above 40% | In-place class change on the same endpoint. About 5–10 minutes of downtime in the maintenance window |
| RDS `db.t4g.small` → larger | CPU above 60% sustained; free memory below 256 MB; connections above 70% of 181 | Class change |
| RDS Single-AZ → Multi-AZ | A contract promising more than 99.5% availability or recovery in under 2 hours; 10 or more tenants | Online conversion; same endpoint |
| `DATABASE_POOL_SIZE` 5 → 4 → 3 | 3rd tenant (→ 4); `db.t4g.small` with up to 25 tenants (→ 3) | Configuration and API restart |
| Redis loopback → ElastiCache `cache.t4g.micro` (TLS, AUTH, `noeviction`) | 3rd tenant; any lost-job incident; any need for zero-downtime API deployments | `REDIS_URL` change. About +$13 a month |
| ElastiCache → replica or MemoryDB | Multi-AZ adopted; memory above 60%; durability required | Replication-group change |
| Scanner Spot → on-demand | Any Spot interruption or capacity gap affecting customer uploads | Capacity-provider change. About +$10 a month |
| One scanner → several on EFS | Scanner CPU above 70%; upload volume; restarts too disruptive | EFS access point 101:102; scheduled `freshclam`; prove multiple writers (ADR-0022 consequence 4) |
| One API task → several | Load beyond one task after vertical scaling | Validate two consumers at once (ADR-0022 consequence 6), or run consumers in one separate service (`QUEUE_CONSUMERS_ENABLED`) |
| Task sizes | p95 CPU above 60% or memory above 75% for 3 business days; latency targets missed | Task-definition change |
| Public IPv4 → private subnets + NAT | A fixed outbound address required; a customer policy against public workload addresses; more than about 10 tasks | Subnet and `assignPublicIp` change; add NAT |
| No WAF → AWS WAF | An enterprise security review; observed abuse; a public marketing launch | Attach a web ACL to the ALB |
| Minimal monitoring → fuller observability | More than one incident a month found by users rather than alarms | Add Container Insights or scraping |
| In-region backups → cross-region | A DR region chosen; RTO, RPO or customer requirements | Replication and snapshot copy |

## Consequences

### Accepted launch limitations

Each is recorded here so that it is a decision, not a surprise.

1. **One task per service, in one AZ at a time.** A task failure means 1–4 minutes of
   unavailability for that service. API deployments stop the old task first.
2. **Single-AZ database.** An AZ failure is recovered by a point-in-time restore, in about 1–2 hours
   with at most 5 minutes of data lost. That is within the documented 2-hour RTO and 5-minute RPO,
   provided the rehearsal has been done. Restoring creates a **new endpoint**, so the catalogue changes
   and the API is redeployed. Maintenance causes brief downtime.
3. **Redis state is lost on every API restart** (§2.6). Planned restarts require a queue drain.
4. **The scanner may be interrupted** (§2.7). Uploads during the gap fail closed and must be repeated.
5. **No fixed outbound IP address** (§3.3).
6. **The security group is the only inbound control on each task** (§3.3).
7. **No WAF**, and reduced alarm coverage (§2.11).
8. **No cross-region copies of data or backups** until a DR region is chosen.
9. **The database server's certificate is not verified.** `sslmode=require` encrypts but does not
   verify it, and the images carry no RDS CA bundle.
10. **Connection capacity on `db.t4g.micro` is an estimate** until it is measured.

### What this amends, and what it leaves alone

**ADR-0022 is amended for the launch** in these places. ADR-0022 itself is not edited.

| ADR-0022 | This record (launch) |
| --- | --- |
| Managed Redis (ElastiCache or MemoryDB) | Redis beside the API at launch; ElastiCache is the first upgrade |
| EFS for the antivirus signature store | Local task storage with daily replacement; EFS is a scale option |
| Edge: ALB, ACM, Route 53, AWS WAF | ALB, ACM, Route 53 (optional), **no WAF at launch** |
| S3 credentials: open (static key pair or role) | ECS task-role credentials, as implemented in `041e827` and validated |
| Queue consumers: open | On the single API task |
| Scanner count: open | One, on Fargate Spot |
| Infrastructure parameters: open | §2 and §4 of this record |

**Unchanged:**

- AWS ECS on Fargate;
- `eu-central-1`;
- one multi-tenant deployment with one database per tenant (ADR-0015, ADR-0021);
- deployment by immutable digest; the worker image is not deployed;
- the application's provider neutrality;
- every production prerequisite.

### Out of date elsewhere, to be corrected separately

These documents still describe the earlier design; ADRs themselves are not edited.

- The go-live runbook, the production prerequisites checklist and the production infrastructure
  implementation checklist:
  - an instance or task role being "not supported" for S3;
  - general `/api/*` routing with `/api/health/ready` as the load balancer's health check;
  - Redis append-only persistence;
  - a signature volume.
- ADR-0021 §6's statement that the S3 adapter has no role-based credential provider.
- The comment in `apps/web/next.config.ts` that the API is never reached from the browser.
- The private-subnet, NAT-based network plan in the
  [region validation report](../../reports/aws-region-validation-eu-central-1.md).

### Still open, and not decided here

1. The mail credential (SES SMTP through an IAM user, or Resend), and the SES production-access
   request.
2. A separate production AWS account and its administrators.
3. The DR region.
4. The infrastructure-as-code tool and where definitions live (in `munaxa/munaxa-docs`, per
   ADR-0022).
5. A verified release package recording all three image digests for `041e827` or later.
6. Formal sign-off of KEY-1, D-1 and WF-1.
7. Acceptance of the reduced alarm set against production prerequisites 2–3.

### Production readiness

Production remains **NOT READY**
([production-prerequisites-checklist.md](../../operations/production-prerequisites-checklist.md)).
This record changes no prerequisite's status. Each still needs production evidence: DNS and TLS,
on-call routing, mail, backups and the rehearsal, the load baseline on these sizes, the scanner on
Fargate, and the full API start.

## Alternatives considered

| Alternative | Cost | Why not |
| --- | --- | --- |
| The first launch design (`db.t4g.small`, ElastiCache, on-demand scanner, bastion, 5 secrets) | ~$146–152 | Larger than 1–2 tenants need; every difference is a later upgrade in §6 |
| "Small customer" variant (as this record, with ElastiCache and an on-demand scanner) | ~$130 | It is the planned next step, triggered by §6 |
| The 25-tenant form (`db.t4g.small`, larger tasks) | ~$193 fixed | Its components are reached one trigger at a time |
| Web and API in one task | −$12 | §3.1 |
| An EC2 reverse proxy instead of the ALB | −$20 | §3.2 |
| API Gateway, NLB or CloudFront instead of the ALB | — | §3.2 |
| NAT Gateway with private task subnets | +$31 or more | §3.3; a later upgrade |
| ElastiCache Serverless | ≥ $7.37 | Needs a code change (§3.4) |
| Docker Compose on one EC2 host | ~−$20 to −$40 | Leaves ECS and loses the ECS task-role credential endpoint, so S3 would need static keys again |
