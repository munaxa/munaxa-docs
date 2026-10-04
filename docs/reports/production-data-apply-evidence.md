# Production Terraform `eu-prod/data` — apply evidence

**Date:** 2026-10-04. **Account** `800728620253`, **region** `eu-central-1`. **Applied by** the
Production deployer role (session `claude-terraform`, source identity `claude-munaxa-docs`). Records
the apply of `infra/terraform/eu-prod/data/` only; `eu-prod/service` was not started. No secret value,
password or state content is reproduced here. Production remains **NOT READY**.

## 1. What was applied

| Item | Value |
| --- | --- |
| Code | Commit `82d354f` ([munaxa/munaxa-docs#130](https://github.com/munaxa/munaxa-docs/pull/130)), plus `8a8c240` (plan-only fix below) |
| Plan before apply | **19 to add, 0 to change, 0 to destroy**, all in the data root: KMS key and alias; DB subnet group, parameter group, log group, DB instance; S3 bucket and its 7 configuration resources; backup vault, plan, selection; backup IAM role and inline policy. Data sources resolved to the Production VPC, its three DB subnets and the `rds` group. No ElastiCache, ECS, ALB, ACM, Cloud Map or application secret |
| Apply | 2026-10-04 21:00:47–21:09:47 UTC (RDS 8 m 34 s): **19 added, 0 changed, 0 destroyed** |
| First post-apply plan | 1 in-place change on the parameter group: RDS reports `rds.force_ssl` (=1, the PostgreSQL 16 default) with apply method `pending-reboot`, the code declared `immediate`. A provider read-back difference, not drift: the live value is `1` |
| Fix | `8a8c240` declares `apply_method = "pending-reboot"`; no AWS change |
| Final post-apply plan | **exit 0, "No changes."** State `eu-prod/data/terraform.tfstate`, SSE-KMS with the state key |

## 2. Resources (non-secret configuration)

**KMS** `alias/munaxa-docs-eu-prod` → `key/99d766af-ba14-48b4-aab2-3c8c402957b3`: customer managed,
rotation on (365 days), 30-day deletion window, policy delegates to IAM only, tagged
`Environment=Production, Stack=data`. Not the Terraform state key.

**RDS** `munaxa-docs-eu-prod-pg` (`available`):

| Setting | Value |
| --- | --- |
| Engine | PostgreSQL **16.12**, minor upgrades off |
| Class / AZ | **db.t4g.micro**, Single-AZ, eu-central-1a |
| Storage | **20 GB gp3** (3000 IOPS, 125 MB/s), autoscaling to **100 GB**, encrypted with the data key |
| Network | Subnet group `munaxa-docs-eu-prod-db` (the three DB subnets, local routes only); security group `sg-0f93fdd2718cd67de` (`rds`); **not publicly accessible**; endpoint `munaxa-docs-eu-prod-pg.cx6gsegwu0rz.eu-central-1.rds.amazonaws.com:5432` |
| TLS | Parameter group `munaxa-docs-eu-prod-pg16` (`in-sync`), `rds.force_ssl = 1`; CA `rds-ca-rsa2048-g1` |
| Recovery | Deletion protection **on**; automated backups **35 days**, window 00:30–01:00; PITR active (latest restorable time 21:08:14 at verification); final snapshot required; copy tags to snapshots |
| Master user | `munaxa_master`, password managed by RDS in Secrets Manager (`rds!db-acca3ccd-…`, rotation on, encrypted with the data key, tagged `Environment=Production`). Not read |
| Observability | Performance Insights 7 days (data key); PostgreSQL log exported to `/aws/rds/instance/munaxa-docs-eu-prod-pg/postgresql` (30 days); Enhanced Monitoring off |
| Maintenance | Sunday 02:00–02:30 UTC |

No application database, role or tenant database was created.

**S3** `munaxa-docs-eu-prod-docs-800728620253`: versioning **Enabled**; all four Block Public Access
settings on; **BucketOwnerEnforced**; **SSE-S3** (AES256; SSE-C blocked); lifecycle: abort incomplete
multipart uploads after 1 day, expire noncurrent versions after 90 days keeping the 3 newest; CORS:
origin `https://docs.munaxa.com` only, GET and PUT, headers `content-type` and
`x-amz-checksum-sha256`; policy denies non-TLS requests and `s3:DeleteBucket`; policy status not
public; empty.

**AWS Backup**: vault `munaxa-docs-eu-prod` (data key, 0 recovery points, not locked); plan
`munaxa-docs-eu-prod-monthly`, rule `monthly-12-months`, `cron(0 3 1 * ? *)` UTC, start window 60 min,
completion 720 min, **delete after 365 days**; selection `munaxa-docs-eu-prod-pg` = the DB instance ARN
only, role below. AWS Backup's own service-linked role `AWSServiceRoleForBackup` was created on first
use (`AWSBackupServiceLinkedRolePolicyForBackup`; on the deployer's allow-list).

## 3. The backup role

`arn:aws:iam::800728620253:role/munaxa-docs/eu-prod/munaxa-docs-eu-prod-backup`: workload boundary,
one inline policy, no managed policy, no instance profile.

- **Trust:** `backup.amazonaws.com`, `sts:AssumeRole`, no conditions. This is AWS's documented trust
  for a Backup service role; AWS Backup documents `aws:SourceArn`/`aws:SourceAccount` for resource
  policies (KMS, SNS), not for this trust. Only a principal of this account with `iam:PassRole` can
  hand the role to AWS Backup.
- **Permissions** instead of the AWS managed policy (59 statements over 20 services, including
  `iam:PassRole`): `CreateDBSnapshot`, `AddTagsToResource`, `ListTagsForResource` on the instance and
  `snapshot:awsbackup:*`; `DeleteDBSnapshot` on `snapshot:awsbackup:*` only (retention expiry);
  `DescribeDBInstances`, `DescribeDBSnapshots`, `tag:GetResources`; `DescribeBackupVault`,
  `CopyIntoBackupVault` on the vault; `kms:DescribeKey` and `kms:CreateGrant`
  (`GrantIsForAWSResource`) on the data key; **explicit deny of `kms:*` on the state key**.

| Validation (live role) | Result |
| --- | --- |
| Access Analyzer `validate-policy` | 0 findings (trust and permissions) |
| `check-no-public-access` (trust) | PASS |
| `check-access-not-granted` | 8/8 PASS: state key; any KMS data use; IAM writes and `PassRole`; `sts:AssumeRole`; S3 objects; secret values; deleting/modifying/copying/restoring the database; Organizations |
| `simulate-principal-policy` (live boundary) | 30/30 as designed. Allowed: the 12 actions above. Refused: state key (explicit), data-key decrypt, deleting the final or automated snapshots, deleting/modifying the instance, copy and share of snapshots, Non-Prod database (explicit), other regions (explicit), deleting the vault or recovery points, starting jobs, `PassRole` and `AssumeRole` (explicit), state objects, documents, the master secret |
| Real STS | `claude-munaxa-docs` assuming the role: `AccessDenied`, with and without a source identity |

## 4. Account-level verification

| Check | Result |
| --- | --- |
| Core IAM | The 9 core roles' trust and inline policies byte-identical to the reviewed documents; workload boundary still v1 (now on 10 roles) |
| Bootstrap | Only `deployer-network` changed (v2, [correction](./production-bootstrap-network-fix-evidence.md)); all other bootstrap policies v1 |
| No service infrastructure | 0 Production ECS clusters, task definitions, load balancers, ACM certificates, Cloud Map namespaces, `munaxa-docs-eu-prod/*` secrets, schedule groups; 0 ElastiCache clusters |
| Non-Prod | Fingerprint with Production items excluded **identical** to the baseline before the core apply (`munaxa-docs-eu-nonprod-pg` and the Non-Prod network unchanged) |
| State | `bootstrap/`, `eu-prod/core/`, `eu-prod/data/` objects only; no lock files; no local state or plan files |

**CloudTrail writes, 21:00:47 onwards.** By the deployer (source identity `claude-munaxa-docs`):
`CreateKey`, `EnableKeyRotation`, `CreateAlias`, 4 `CreateGrant` on the data key (made while
creating the encrypted resources); `CreateDBParameterGroup`, `ModifyDBParameterGroup`,
`CreateDBSubnetGroup`, `CreateDBInstance`; `CreateLogGroup`, `PutRetentionPolicy`; `CreateSecret` (the
RDS-managed secret); `CreateBucket`, `PutBucketPublicAccessBlock`, `PutBucketOwnershipControls`,
`PutBucketVersioning`, `PutBucketEncryption`, `PutBucketLifecycle`, `PutBucketCors` (plus 2
`OperationAborted` retries), `PutBucketPolicy`; `CreateBackupVault`, `CreateBackupPlan`,
`CreateBackupSelection`; `CreateRole`, `PutRolePolicy`, `CreateServiceLinkedRole`
(`backup.amazonaws.com`). By AWS services on behalf of these resources: RDS, Performance Insights and
EC2 grants on the data key, the RDS ENI, the RDS log stream, and the master secret's initial
`PutSecretValue` and `RotateSecret`. **No other write by Claude's identities.**

Observed, not ours: three failed `ListOrganizationsFeatures` calls by the account **root** user from
an IAM console browser session (21:04–21:10 UTC).

## 5. Limitations and unproven behaviour

- **The backup has not run yet.** The first job runs at 03:00 UTC on the 1st of the month; until then
  the trust and permissions are proven by simulation and Access Analyzer only. Check the first job
  (or run an on-demand job as an administrator) before relying on it. There is no alarm on a failed
  AWS Backup job yet; the RDS event subscription belongs to the service root.
- `max_connections` on `db.t4g.micro` is still an estimate (ADR-0024 §2.5); measure it with
  `SHOW max_connections` at the first operator connection.
- `sslmode=require` encrypts but does not verify the server certificate (ADR-0024 limitation 9).
- Single-AZ: an AZ failure is recovered by point-in-time restore to a new endpoint.
- The S3 bucket's deletion is refused by its own policy; an administrator must remove the policy
  first. Versioning suspension is not policy-blocked (Terraform review only).
- The AWS MCP tool in this environment runs as the account root user; it was used once, read-only,
  to read the AWS managed backup policy. All changes were made by Terraform.
