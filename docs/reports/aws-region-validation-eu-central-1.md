# AWS region validation — from me-central-1 to eu-central-1

Point-in-time evidence for [ADR-0023](../architecture/adr/0023-initial-aws-region-eu-central-1.md).
It separates three things that must not be confused:

| | Status |
| --- | --- |
| **Architecture decision** | `eu-central-1` is the initial hosted AWS region (ADR-0023) |
| **Regional validation** | Read-only assessment of `eu-central-1` complete (§3) |
| **Infrastructure provisioning** | **Nothing exists in `eu-central-1`.** §4–§5 are a plan, not a record |

The account is the dedicated non-production validation account, referred to here as
`<nonprod-account>`. Application revision `041e827`; API image
`ghcr.io/munaxa/munaxa-docs-api@sha256:085352e0f06f4da7400df23006b0ff1e870ebedc444edf84e3368772a0ba23ca`.
Production remains **NOT READY**.

## 1. me-central-1 — what happened (historical)

`me-central-1` was the first planned region. This section is history; it explains the change and is
not a configuration to follow.

| Step | Result |
| --- | --- |
| Account baseline | Account-level S3 Block Public Access enabled |
| Network, 3 AZs planned | **AWS refused every subnet in `me-central-1b`**: `CreateSubnet` → `InvalidParameterValue: Availability Zone mec1-az2 is unavailable. Please try again later.` The account's default VPC had no `1b` subnet either. The network was completed in `1a` and `1c` only |
| S3 validation bucket and ECS IAM roles | Created and verified (§6) |
| RDS PostgreSQL 16 | **Not established.** `DescribeOrderableDBInstanceOptions` listed PostgreSQL 16.12 on `db.t4g.small`, gp3, `MultiAZCapable: true`, encryption supported. The scripted `CreateDBInstance` was stopped by the operator tooling's safety layer before reaching AWS. A console attempt followed; afterwards `DescribeDBInstances` returned `DBInstanceNotFound` and the region held no instance. No AWS error was captured, so the cause is not known |

Observed in `me-central-1` but **not attributable to the region**: the operator session could not
reach the SES, MemoryDB and Service Quotas endpoints (its egress gateway refused the connection), and
CloudTrail answered `503`, then failed certificate validation. These are properties of the session's
network path and are recorded so they are not mistaken for AWS limitations.

The product owner then excluded Arab-region AWS regions for the validation environment and named
`eu-central-1`.

## 2. Why eu-central-1

- Every required service is available (§3).
- Three Availability Zones are available to the account, against the two left in `me-central-1`.
- The exact RDS configuration — PostgreSQL 16.12, `db.t4g.small`, gp3, Multi-AZ, encrypted, VPC — is
  orderable.
- SES is available, **in sandbox** (§3).

## 3. eu-central-1 read-only assessment

Read-only API calls only; nothing was created. "Not verifiable read-only" means the capability is
documented by AWS but can only be proven by creating the resource.

| Service | Required capability | Status | Evidence |
| --- | --- | --- | --- |
| Region | Enabled for the account | ✅ | `opt-in-not-required`; caller identity resolves |
| Availability Zones | At least two | ✅ three | `eu-central-1a` (euc1-az2), `1b` (euc1-az3), `1c` (euc1-az1), all `available` |
| RDS | PostgreSQL 16.x | ✅ | 16.9 – 16.15 offered |
| RDS | `db.t4g.small`, Multi-AZ, encrypted, VPC | ✅ | Orderable for 16.12/gp3: `MultiAZCapable`, `SupportsStorageEncryption`, `Vpc` all true; AZs 1a/1b/1c |
| RDS | Quota headroom | ✅ | DB instances 0/40, subnet groups 0/50 |
| ElastiCache | Redis 7.x | ✅ | 7.0, 7.1 (family `redis7`); Valkey 7.2 – 9.1 also offered |
| ElastiCache | Small node types | ✅ | `cache.t4g.micro/small/medium`, `cache.t3.micro/small/medium` |
| ElastiCache | `noeviction` | ✅ | `maxmemory-policy` modifiable; `noeviction` allowed (default `volatile-lru`, so a custom parameter group is needed) |
| ElastiCache | Cluster mode off, TLS, AUTH, private subnets | ⚠️ not verifiable read-only | Documented for Redis 7; API reachable |
| EFS | Encrypted, mount targets in 2+ AZs | ✅ available; ⚠️ mount targets not exercised | API reachable; endpoint service in 1a – 1d |
| ECS | Fargate | ✅ | `FARGATE` and `FARGATE_SPOT` `ACTIVE` |
| ECS | Linux/x86_64, private subnets | ⚠️ not verifiable read-only | Standard Fargate platform; the image is `linux/amd64` |
| S3 | Regional bucket, gateway endpoint | ✅ | `com.amazonaws.eu-central-1.s3` offered as `Gateway` |
| Secrets Manager, ALB, ACM, Route 53, WAF, CloudWatch Logs and alarms, ECR, NAT Gateway | Available | ✅ | APIs reachable; interface endpoint services exist where applicable |
| SES | Service and SMTP | ✅ available; ⚠️ **sandbox** | `ProductionAccessEnabled: false`, `SendingEnabled: true`, `HEALTHY`, 200/24 h at 1/s; `email-smtp` endpoint service in 1a – 1c |

The account's `eu-central-1` holds only its default VPC.

## 4. Planned non-production network (not provisioned)

The `me-central-1` security-boundary design, carried over unchanged.

**VPC** `munaxa-docs-nonprod`, `10.120.0.0/16`, DNS support and hostnames on, in `eu-central-1a` and
`eu-central-1b`.

| Tier | eu-central-1a | eu-central-1b | Route table |
| --- | --- | --- | --- |
| Public | `10.120.0.0/24` | `10.120.2.0/24` | `0.0.0.0/0` → Internet Gateway |
| Application (private) | `10.120.16.0/20` | `10.120.48.0/20` | `0.0.0.0/0` → NAT Gateway; S3 prefix list → S3 Gateway Endpoint |
| Database (private) | `10.120.64.0/24` | `10.120.66.0/24` | local only — no internet route |

- **One NAT Gateway**, in public `1a`, with one Elastic IP. If `1a` fails, outbound internet from the
  application subnets stops (image pulls, AWS APIs over NAT, signature updates); S3 does not, because
  it uses the gateway endpoint. A second NAT Gateway is a later decision.
- **S3 Gateway Endpoint** on the application route table.
- **Security groups**, default outbound rule removed from each:

| Group | Inbound | Outbound |
| --- | --- | --- |
| `alb` | TCP 443 from `0.0.0.0/0` | TCP 3000, 3001 → `ecs` |
| `ecs` | TCP 3000, 3001 from `alb` | 5432 → `rds`, 6379 → `redis`, 1344 → `scanner`, 443 → `0.0.0.0/0` |
| `scanner` | TCP 1344 from `ecs` | 443 → `0.0.0.0/0` (signature updates) |
| `rds` | TCP 5432 from `ecs` | none |
| `redis` | TCP 6379 from `ecs` | none |

Open in the design, carried from `me-central-1`: the scanner's EFS mount needs an NFS (2049) rule
between the scanner and its mount targets, which neither design has yet. The same CIDR as the
`me-central-1` VPC is reused; that matters only if the two are ever peered.

## 5. What changes for eu-central-1 (not yet done)

| Item | Today (`me-central-1`) | Needed for `eu-central-1` |
| --- | --- | --- |
| ECS task role trust | `aws:SourceArn` like `arn:aws:ecs:me-central-1:<nonprod-account>:*` | `arn:aws:ecs:eu-central-1:<nonprod-account>:*` (IAM is global: update in place, or create EU roles) |
| ECS execution role trust | as above | as above |
| Execution role log permission | `arn:aws:logs:me-central-1:…:log-group:/munaxa-docs/nonprod/*` | the same in `eu-central-1`. Its open log-stream simulation finding still stands |
| Task role S3 permission | bucket `munaxa-docs-nonprod-val-4c7e91b2` (in `me-central-1`) | the new `eu-central-1` validation bucket's ARN |
| S3 validation bucket | `me-central-1` | **recreated** in `eu-central-1` with the same settings (Block Public Access, BucketOwnerEnforced, SSE-S3, versioning, TLS-only policy, multipart abort after 1 day). A bucket's region cannot change |
| API configuration | — | `STORAGE_REGION=eu-central-1`, `STORAGE_CREDENTIALS_SOURCE=ECS_TASK_ROLE`, `STORAGE_ENDPOINT` unset |
| CloudWatch log group | `/munaxa-docs/nonprod/api` in `me-central-1` | recreated in `eu-central-1` |

## 6. me-central-1 inventory (untouched)

Nothing below has been deleted or changed by the region decision. The resources stay until the
`eu-central-1` replacement is operationally validated.

| Resource | Identifier | Class | Ongoing cost |
| --- | --- | --- | --- |
| VPC `munaxa-docs-nonprod` | `vpc-03e7c5de453ea1b72` (`10.120.0.0/16`) | temporary — later deletion candidate | none |
| Subnets (6: public, app, db × 1a/1c) | `subnet-0fc8ad0a7af98e362`, `-08fc16dcf374467de`, `-04045769c0f1cd026`, `-0599aa2654b26db81`, `-0918e875a905c0133`, `-0f695e403c17a7ba2` | temporary — later deletion candidate | none |
| Route tables (public, app, db) | `rtb-04adcb3be7493566b`, `rtb-011b23b3ca3e7dbbc`, `rtb-0965f2bfd40703e4f` | temporary — later deletion candidate | none |
| Internet Gateway | `igw-066ff91b59e34a78b` | temporary — later deletion candidate | none |
| **NAT Gateway** | `nat-07804c68d03665f4f` | temporary — **first deletion candidate** | **yes, hourly plus per-GB** |
| **Elastic IP** | `eipalloc-00811a1f8247833ba` | temporary — delete after the NAT Gateway | **yes, public IPv4** |
| S3 Gateway Endpoint | `vpce-062d918e35555593c` | temporary — later deletion candidate | none |
| Security groups (alb, ecs, scanner, rds, redis) | `sg-01044a746dcfa2af3`, `sg-068846e6b8cc82c7e`, `sg-0414f570fdcb37224`, `sg-09cfbebb6de73ef8d`, `sg-09d3e21d5a8b961a8` | temporary — later deletion candidate | none |
| S3 validation bucket | `munaxa-docs-nonprod-val-4c7e91b2` (empty) | temporary — later deletion candidate | negligible |
| ECS task role | `munaxa-docs-nonprod-ecs-task-role` | **reusable** — IAM is global; trust and S3 resource to be repointed (§5) | none |
| ECS execution role | `munaxa-docs-nonprod-ecs-execution-role` | **reusable** — trust and log resource to be repointed (§5) | none |
| CloudWatch log group | `/munaxa-docs/nonprod/api` (30-day retention, empty) | temporary — later deletion candidate | none while empty |
| RDS DB subnet group | `munaxa-docs-nonprod-db` | temporary — later deletion candidate | none |
| Account-level S3 Block Public Access | account setting | **keep** — account-wide, not regional | none |

Deletion order, when approved: NAT Gateway → Elastic IP → endpoint, security groups, route tables,
subnets, Internet Gateway, VPC; the empty bucket, log group and DB subnet group independently. The
default VPC is not part of this inventory and stays as it is.
