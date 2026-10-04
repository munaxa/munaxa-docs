# Production Terraform `eu-prod/core` — apply evidence

**Date:** 2026-10-04. **Account** `800728620253`, **region** `eu-central-1`. **Applied by** the
Production deployer role (`munaxa-docs-eu-prod-deployer`, session `claude-terraform`, source identity
`claude-munaxa-docs`). This records the apply of `infra/terraform/eu-prod/core/` only. Bootstrap was not
re-applied; `eu-prod/data` and `eu-prod/service` were not started. Production remains **NOT READY**.

## 1. What was applied

| Item | Value |
| --- | --- |
| Commit | **`4e728bb83e8f265ade4d1022816c8066fc725d17`** (`main`, PR #129), clean working tree |
| Plan before apply | Through the deployer role, key `eu-prod/core/terraform.tfstate`: **18 to add, 0 to change, 0 to destroy**. Only `aws_iam_role` ×9 and `aws_iam_role_policy` ×9, every role at `/munaxa-docs/eu-prod/` with the workload boundary. No other resource type and no Non-Prod identifier. All 18 policy documents byte-identical to those validated for PR #129 |
| Apply | That saved plan, 2026-10-04 20:06:50–20:07:00 UTC: **18 added, 0 changed, 0 destroyed**, no errors |
| State | `s3://munaxa-docs-tfstate-eu-prod-800728620253/eu-prod/core/terraform.tfstate`, SSE-KMS with the state key, 18 resources. No lock file left; no local state or plan files; nothing committed. Bootstrap state version unchanged |
| Post-apply plan | `terraform plan -detailed-exitcode` → **exit 0, "No changes."** |

## 2. Roles created

All carry `arn:aws:iam::800728620253:policy/munaxa-docs/bootstrap/munaxa-docs-eu-prod-workload-boundary`
(still `v1`, unchanged; now used by exactly these 9 roles), exactly one inline policy, no attached
managed policy, and tags `Environment=Production, ManagedBy=Terraform, Project=MunaxaDocs, Stack=core`.

| Role ARN (`arn:aws:iam::800728620253:role/munaxa-docs/eu-prod/…`) | Inline policy | Trust |
| --- | --- | --- |
| `munaxa-docs-eu-prod-web-execution` | `…-web-execution` | ECS |
| `munaxa-docs-eu-prod-api-execution` | `…-api-execution` | ECS |
| `munaxa-docs-eu-prod-scanner-execution` | `…-scanner-execution` | ECS |
| `munaxa-docs-eu-prod-ops-dbadmin-execution` | `…-ops-dbadmin-execution` | ECS |
| `munaxa-docs-eu-prod-ops-provision-execution` | `…-ops-provision-execution` | ECS |
| `munaxa-docs-eu-prod-ops-tunnel-execution` | `…-ops-tunnel-execution` | ECS |
| `munaxa-docs-eu-prod-ops-tunnel-task` | `…-ops-tunnel-task-exec` | ECS |
| `munaxa-docs-eu-prod-api-task` | `…-api-task-documents` | ECS |
| `munaxa-docs-eu-prod-scheduler` | `…-scheduler-scanner-refresh` | Scheduler |

- **ECS trust:** `ecs-tasks.amazonaws.com`, `aws:SourceAccount = 800728620253`, `ArnLike aws:SourceArn = arn:aws:ecs:eu-central-1:800728620253:*`.
- **Scheduler trust:** `scheduler.amazonaws.com`, `aws:SourceAccount` and `aws:SourceArn = arn:aws:scheduler:eu-central-1:800728620253:schedule-group/munaxa-docs-eu-prod`.

Every live inline policy and trust policy is identical to the reviewed configuration. There are no
instance profiles.

## 3. Verification on the live resources

| Check | Result |
| --- | --- |
| **Isolation** (`simulate-principal-policy` on each real role: its inline policy and its live boundary) | **492/492 as expected.** Every intended workload action is allowed, so the boundary blocks nothing legitimate. Refused for every role: Non-Prod S3, secrets, logs, ECS and RDS; both state objects and the CloudTrail bucket; the state key (directly, through Secrets Manager and through S3); IAM administration, `PassRole`, users and access keys; `sts:AssumeRole` of the deployer, Non-Prod roles and every other workload role; reading or changing other workload roles; Organizations, account, CloudTrail and account-level S3 controls; other regions; and other workloads' secrets and log groups |
| **Trust (real STS)** | 27/27 refused: `claude-munaxa-docs` (AdministratorAccess) assuming each of the 9 roles, with and without a source identity, and the deployer role assuming each. Only the AWS service principals can obtain these roles |
| **Deployer guardrail (real call)** | The deployer's attempt to remove `api-task`'s permissions boundary was refused (`AccessDenied`); the boundary remains attached |
| **Non-Prod** | The 44-document read-only fingerprint is **identical** before and after the apply, and identical to the baseline taken before the bootstrap apply |
| **CloudTrail writes** (management events, Claude identity and deployer, from 20:00 UTC) | **18**, all by the deployer session with source identity `claude-munaxa-docs`: 9 `CreateRole` and 9 `PutRolePolicy`, each on one of the 9 roles above. No other write |

## 4. Limitations and unproven behaviour

- **Service-side trust is not yet exercised.** Proving ECS and Scheduler can assume these roles needs a running task or a firing schedule, which belong to the service root. The ECS trust is AWS's documented condition (cluster-scoped `aws:SourceArn` is not supported) and identical to the Non-Prod roles ECS assumed on Fargate. The Scheduler trust is AWS's documented schedule-group form. Both are fail-closed: a mismatch would stop a task or schedule, never widen access.
- **The workload boundary** still permits KMS on any `Environment=Production` key, including the Terraform state key. Each execution role carries an explicit Deny on that key, and the state bucket policy admits only the deployer and the administrators. Tightening the boundary itself is a separate bootstrap change.
- **The roles assume the document bucket uses SSE-S3.** If the data root chooses a KMS key, `api-task` needs KMS permissions for it.
- **No AWS Backup role.** It is added with the data root's backup plan (ADR-0024 §2.12).
- **The denied boundary-removal test** had not yet appeared in CloudTrail event history at verification time (event history lags); its outcome was verified directly.
- **Both administrator users keep AdministratorAccess**, and this is the Organizations management account, so SCPs do not apply.
