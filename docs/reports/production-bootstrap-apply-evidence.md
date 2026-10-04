# Production Terraform bootstrap — apply evidence

**Date:** 2026-10-04. **Account** `800728620253`, **region** `eu-central-1`. **Applied by** the
dedicated `claude-munaxa-docs` identity. This records the apply of `infra/terraform/bootstrap/` only.
**No Production application infrastructure was created**, and Production remains **NOT READY**.

## 1. What was applied

| Item | Value |
| --- | --- |
| Configuration in force | **`6dac383`** (`infra/terraform/bootstrap/`, PR #128). Created in three applies: `bc41726` (28 resources), `2af6941` (13), `6dac383` (trust update). The fixes are §4 |
| Resources | **41**, all in the bootstrap root. No VPC, subnet, ECS, RDS, ALB, ACM, Cloud Map, application bucket, application secret or workload role |
| State | `s3://munaxa-docs-tfstate-eu-prod-800728620253/bootstrap/terraform.tfstate`, SSE-KMS with the state key. It is the only object in the bucket. Migrated from local state with `terraform init -migrate-state`; every local copy was deleted. Nothing was committed |
| Post-apply plan | `terraform plan -detailed-exitcode` → **exit 0, "No changes. Your infrastructure matches the configuration."** |

## 2. Resources (non-secret identifiers)

| Resource | Identifier |
| --- | --- |
| State bucket | `munaxa-docs-tfstate-eu-prod-800728620253` |
| State key | `arn:aws:kms:eu-central-1:800728620253:key/a5ca1289-0ffd-4271-bd19-996013ab647d`, alias `alias/munaxa-docs-eu-prod-tfstate` |
| Deployer role | `arn:aws:iam::800728620253:role/munaxa-docs/bootstrap/munaxa-docs-eu-prod-deployer` (max session 1 h) |
| Deployer boundary | `arn:aws:iam::800728620253:policy/munaxa-docs/bootstrap/munaxa-docs-eu-prod-deployer-boundary` |
| Workload boundary | `arn:aws:iam::800728620253:policy/munaxa-docs/bootstrap/munaxa-docs-eu-prod-workload-boundary` (no workload roles yet) |
| Deployer policies (attached) | `…/munaxa-docs/bootstrap/munaxa-docs-eu-prod-deployer-{read,state,network,compute,data,observability,iam,guardrails-environment,guardrails-identity}` |
| CloudTrail | `arn:aws:cloudtrail:eu-central-1:800728620253:trail/munaxa-docs-account-trail` |
| CloudTrail bucket | `munaxa-docs-cloudtrail-800728620253` |
| Budget | `munaxa-docs-eu-prod-monthly` |
| Cost allocation tags | `Environment`, `Project`: Active |

## 3. Verification (read-only)

| Area | Result |
| --- | --- |
| **IAM** | Role at `/munaxa-docs/bootstrap/` with the deployer boundary. Exactly 9 attached policies, 0 inline. Trust allows only `claude-munaxa-docs` (`sts:AssumeRole` with source identity `claude-munaxa-docs` **and** session `claude-*`; `sts:SetSourceIdentity` with that value only) and `admin.tamer` (source identity `admin.tamer`, no MFA condition, by owner decision). No role exists under `/munaxa-docs/eu-prod/` |
| **State bucket** | Versioning Enabled. All four public-access-block settings true. `BucketOwnerEnforced`. SSE-KMS with the state key and bucket keys. Policy denies non-TLS access and every principal except the deployer, `claude-munaxa-docs`, `admin.tamer` and root; denies the deployer `bootstrap/*` and any object outside `eu-prod/*`. Noncurrent state versions kept 365 days |
| **State key** | Customer managed, enabled, rotation on. Key policy delegates to IAM (account root) only |
| **CloudTrail** | One trail in the account: multi-region, global service events, log-file validation, management events Read+Write, not an organization trail. **Logging**, delivering to its bucket with no error (11 objects at verification). Bucket: versioned, public access blocked, SSE-S3, writes accepted only from this trail, HTTPS only, logs expire after 365 days |
| **Budget** | $130.00 USD, MONTHLY, COST, filter `user:Environment$Production`. Alerts: actual >80%, actual >100%, forecast >100%, all to the existing placeholder `alerts@example.com` |
| **No application infrastructure** | 0 buckets named `munaxa-docs-eu-prod-*`. No new VPC, ECS, RDS, ALB, ACM, Secrets Manager or Cloud Map resource (Non-Prod fingerprint below) |
| **Non-Prod untouched** | A normalised fingerprint of 44 read-only documents (VPCs, subnets, route tables, security groups, NAT, endpoints, Elastic IPs, RDS, its subnet and parameter groups, the ECS cluster and task definitions, the five Non-Prod IAM roles and their policies, the Non-Prod bucket's policy and settings, secrets metadata, log groups, account public-access block, IAM users and their policies, the me-central-1 VPC) is **identical before and after** |
| **Writes by the Claude identity** | CloudTrail event history: only the bootstrap resources above, plus the rejected `CreatePolicy` attempts (§4) and the budget's notification contact (§5) |

**Isolation, evaluated by IAM against the live resources:**

| Check | Result |
| --- | --- |
| Deployer (`simulate-principal-policy` on the real role: attached policies and live boundary) | **114/114 as expected** (77 deny cases, 37 allow cases) |
| Refused | Every Non-Prod resource tested (VPC, untagged main route table and default security group, security groups, NAT, Elastic IP, RDS, `default.postgres16`, both Non-Prod secrets, bucket and objects, ECS cluster, services and task definitions, log group, Non-Prod roles including `PassRole`). Production document contents and any secret value. Its own role, boundary and policies, the workload boundary, `bootstrap/` state, state bucket configuration, the state key and its alias, the trail and its bucket. IAM users and access keys, OIDC, Organizations, account-level controls, `sts:AssumeRole`, other regions |
| Workload boundary (the policy version stored in IAM, identical to the reviewed render) | **29/29**: a role granted `*:*` is still refused IAM, STS, Organizations, the state and CloudTrail buckets, other regions and every Non-Prod resource |
| End-to-end (real STS) | The Claude identity assumed the deployer with source identity `claude-munaxa-docs` and session `claude-bootstrap-verify`. Refused without a source identity, with a wrong session name, and with a wrong source identity. Inside the session: listing state keys allowed; reading `bootstrap/terraform.tfstate`, reading Non-Prod secret metadata, listing the Non-Prod bucket and reading its own boundary all **refused** |

## 4. Corrections made during the apply

Each was a minimal, reviewed change committed to PR #128 before it was applied. No allow was widened and no deny removed.

| Commit | Rejected operation | Fix |
| --- | --- | --- |
| `176e81f` | `iam:CreatePolicy` for `…-deployer-boundary`, `…-workload-boundary`, `…-deployer-guardrails-environment`: `MalformedPolicyDocument: Resource vendor must be fully qualified` | The `*nonprod*` deny used `arn:aws:*:*:<account>:*nonprod*`. Now listed per service (every service reachable under the boundaries) |
| `2af6941` | The same three policies: `IAM resource path must … start with … role/, … policy/` | The IAM entry now names `role/`, `policy/`, `user/`, `group/` and `instance-profile/`. Every rendered ARN was linted before re-applying |
| `6dac383` | Post-apply end-to-end test: `not authorized to perform: sts:SetSourceIdentity` | `sts:RoleSessionName` is evaluated only for `AssumeRole`, so `SetSourceIdentity` became its own statement. The session-name condition stays on `AssumeRole` |

Neither IAM Access Analyzer `validate-policy` nor the policy simulator detected the first two issues. The third was missed because only `sts:AssumeRole` had been simulated. Policies are now also linted for ARN form, and trust is simulated for both actions.

## 5. Known limitations

- **Budget alerts are not delivered.** `alerts@example.com` is a placeholder in reserved `example.com`. AWS Budgets registered it as an AWS User Notifications email contact and sent it activation codes. Set a real address in `terraform.tfvars` (not committed) and re-apply bootstrap to receive alerts.
- **Cost attribution starts now.** Cost allocation tags are not retroactive.
- **Both administrator users keep AdministratorAccess**, and the account is the Organizations management account (SCPs do not apply). The isolation deny on `claude-munaxa-docs` is deferred until the deployer is tested in use, as decided.
- **Fail-closed items** remain unproven until the Production roots are applied: Cloud Map management by resource tag, ECS task-definition deregistration by ARN, and the ECS task-role source-ARN pattern.
- The state bucket's principal allow-list names the two IAM users. Renaming either requires a bootstrap change; root keeps access.

## 6. Not started

`eu-prod/core`, `eu-prod/data` and `eu-prod/service` were **not** applied, planned or extended.
