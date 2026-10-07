# Munaxa Docs — Production infrastructure (Terraform)

Terraform for the **Production** environment of Munaxa Docs in AWS account `800728620253`,
region `eu-central-1`, as decided in ADR-0022, ADR-0023, ADR-0024 and ADR-0025.

> **Non-Production must never be referenced.** No root, module, variable or data source in this
> tree may read, import, modify or depend on a Non-Production resource. The only Non-Production
> identifiers here are the deny-list entries in `bootstrap/` (the Non-Production and default VPC
> IDs, and `*nonprod*` name patterns), which exist solely so the deployer is refused access to
> them. Non-Production was created outside Terraform and stays outside it; a future Non-Production
> Terraform gets its own state bucket, never this one.

> **Never create Production infrastructure with ad-hoc AWS CLI commands.** Every Production
> resource is created by a reviewed `terraform plan`, applied by the identity named below.

## Status

| Root | Contents | Status |
| --- | --- | --- |
| `bootstrap/` | State bucket and key, deployer role, boundaries and policies, CloudTrail, budget | **Applied 2026-10-04** at `6dac383` ([evidence](../../docs/reports/production-bootstrap-apply-evidence.md)); `deployer-network` corrected at `37ffec5` ([evidence](../../docs/reports/production-bootstrap-network-fix-evidence.md)) |
| `eu-prod/core/` | Production workload IAM roles (`/munaxa-docs/eu-prod/`): web, API, scanner and three operator-task execution roles; API and tunnel task roles; Scheduler role. Every role carries the workload boundary. The network: VPC `10.121.0.0/16`, public and isolated DB subnets, IGW, route tables, S3 gateway endpoint, one security group per tier | **Applied 2026-10-04**: roles at `4e728bb` ([evidence](../../docs/reports/production-core-apply-evidence.md)), network at `2b214e9` ([evidence](../../docs/reports/production-core-network-evidence.md)) |
| `eu-prod/data/` | Production data KMS key, RDS PostgreSQL 16, document bucket, AWS Backup (monthly, 12 months) and its service role | **Applied 2026-10-04** at `8a8c240` ([evidence](../../docs/reports/production-data-apply-evidence.md)) |
| `eu-prod/service/` | ALB/ACM, ECS task definitions and services, schedules, alarms | Backend, conventions and release inputs only |
| `modules/ecs-service/` | Input contract for the three ECS services | Variables only |

`bootstrap/`, `eu-prod/core/` and `eu-prod/data/` have been applied; `eu-prod/service/` has not been started. Production remains **NOT READY**.

## Layout and state

```
infra/terraform/
├── bootstrap/            applied once by an administrator identity
├── eu-prod/
│   ├── engineering.s3.tfbackend   partial backend config: assume the deployer as Claude's
│   │                              engineering role (source identity munaxa-org-operator)
│   ├── claude.s3.tfbackend   partial backend config: assume the deployer as the Claude IAM
│   │                         user (fallback until it is retired)
│   ├── core/             applied by the deployer role
│   ├── data/             applied by the deployer role
│   └── service/          applied by the deployer role
└── modules/ecs-service/
```

| Root | State object (bucket `munaxa-docs-tfstate-eu-prod-800728620253`) | Applied by |
| --- | --- | --- |
| `bootstrap` | `bootstrap/terraform.tfstate` | An administrator (`admin.tamer`, or `claude-munaxa-docs` until it is retired), **never the deployer and never the engineering role** |
| `eu-prod/core` | `eu-prod/core/terraform.tfstate` | Deployer role |
| `eu-prod/data` | `eu-prod/data/terraform.tfstate` | Deployer role |
| `eu-prod/service` | `eu-prod/service/terraform.tfstate` | Deployer role |

- **Bucket:** versioned, Block Public Access on, ACLs disabled, HTTPS only, SSE-KMS with the
  dedicated key `alias/munaxa-docs-eu-prod-tfstate`. Only the deployer and the administrator
  identities may use it; the deployer may never touch `bootstrap/`.
- **Locking:** Terraform's native S3 lock file (`use_lockfile = true`); no DynamoDB table.
- **No secrets in state.** No `random_password` resources. RDS uses
  `manage_master_user_password` (AWS generates and stores the password). Terraform creates secret
  *containers* only; their values are written outside Terraform.
- **No `terraform_remote_state`.** Roots find each other's resources by name or by tags
  (`Environment=Production`, `Stack=<root>`), never by reading another root's state.

**Versions.** Terraform `~> 1.16.5` (see `.terraform-version`), AWS provider `~> 6.67`. Each root
commits its `.terraform.lock.hcl` (linux/darwin/windows, amd64/arm64).

**Default tags** on every resource: `Project=MunaxaDocs`, `Environment=Production`,
`ManagedBy=Terraform`, `Stack=<root>`. The deployer's permissions depend on them: most create
actions require `Environment=Production` in the request.

## Apply order

`bootstrap` → `eu-prod/core` → `eu-prod/data` → `eu-prod/service`. Each step is a reviewed plan,
then an apply of exactly that plan.

### 1. First bootstrap apply (once, administrator identity)

The state bucket does not exist yet, so the first apply uses local state and then migrates it.

```bash
cd infra/terraform/bootstrap
cp terraform.tfvars.example terraform.tfvars        # set budget_alert_emails; not committed
mv backend.tf backend.tf.off
terraform init
terraform plan -out=bootstrap.tfplan                # review: everything is a create
terraform apply bootstrap.tfplan
mv backend.tf.off backend.tf
terraform init -migrate-state                       # copies state to bootstrap/terraform.tfstate
rm -f terraform.tfstate terraform.tfstate.backup bootstrap.tfplan
```

Later bootstrap changes run with the S3 backend as normal, by an administrator identity.

### 2. Test the deployer before using it

Before any Production root is applied, assume the deployer (as below) and confirm with
`aws iam simulate-principal-policy` that Production actions are allowed and Non-Production,
bootstrap, IAM-user and secret-value actions are denied. Run a `terraform plan` of
`eu-prod/core` to prove state access and locking.

### 3. Production roots (deployer role)

```bash
cd infra/terraform/eu-prod/core
cp ../engineering.auto.tfvars.example engineering.auto.tfvars # not committed
terraform init -backend-config=../engineering.s3.tfbackend
terraform plan -out=core.tfplan
terraform apply core.tfplan
```

The provider and backend both assume
`arn:aws:iam::800728620253:role/munaxa-docs/bootstrap/munaxa-docs-eu-prod-deployer`.

| Caller | Source identity | Session name | Files |
| --- | --- | --- | --- |
| Claude engineering role `AWSReservedSSO_MunaxaAWSEngineeringAdmin_94ab1f7586187adb` (Identity Center permission set `MunaxaAWSEngineeringAdmin`, user `munaxa-org-operator`); the permanent caller | `munaxa-org-operator` (required) | must start with `claude-` | `engineering.s3.tfbackend`, `engineering.auto.tfvars.example` |
| `claude-munaxa-docs` (IAM user; fallback until it is retired) | `claude-munaxa-docs` (required) | must start with `claude-` | `claude.s3.tfbackend`, `claude.auto.tfvars.example` |
| `admin.tamer` (break-glass) | `admin.tamer` (required) | any | copies of the above with `admin.tamer` values |

Each caller is trusted by its exact principal ARN together with its source identity, and the
two Claude callers also by the `claude-*` session name (`bootstrap/iam.tf`, `deployer_trust`);
there is no account-root or wildcard principal. The engineering role reaches state only
through the deployer, so it is not in the state bucket's administrator list.

The engineering role's ARN carries a suffix generated by Identity Center. If the permission set
is ever re-provisioned under a new suffix, update `engineering_principal_arn` and re-apply
bootstrap. Its deployer sessions are role chaining and last at most one hour.

For break-glass, copy `claude.s3.tfbackend` and `claude.auto.tfvars.example` and set the
`admin.tamer` values. No MFA condition is applied, by owner decision.

## The deployer's permission model

The account is the AWS Organizations management account, so service control policies do not
apply to it. Isolation is enforced entirely in IAM, in four layers:

1. **Seven scoped allow policies** (`deployer-read`, `-state`, `-network`, `-compute`, `-data`,
   `-observability`, `-iam`). Resources are limited by name (`munaxa-docs-eu-prod-*`,
   `/munaxa-docs/eu-prod/*`) or by the `Environment=Production` tag.
2. **Two guardrail deny policies** (`deployer-guardrails-environment`, `-identity`). They refuse:
   - other regions;
   - anything tagged `Environment=NonProduction`/`nonprod`, or named `*nonprod*`;
   - EC2 changes inside the Non-Production or default VPC;
   - re-tagging another environment's resources;
   - the default RDS groups;
   - the bootstrap role, policies, state key, `bootstrap/` state and CloudTrail bucket;
   - reading Production document objects and **any** secret value;
   - IAM writes outside `/munaxa-docs/eu-prod/`;
   - roles without the workload boundary;
   - `iam:PassRole` to anything but ECS tasks, Scheduler, Backup and EventBridge;
   - IAM users, access keys and identity providers;
   - Organizations, billing, CloudTrail and account-wide security settings;
   - assuming other roles.
3. **The deployer permissions boundary**, a ceiling of the services above plus the critical
   denies, so a mistakenly broad allow is still capped.
4. **The workload permissions boundary**, which every Production workload role must carry. Even
   a workload role granted `*:*` reaches only Production storage, secrets, keys, logs and the
   Production services, and never IAM, STS, Organizations or Non-Production.

Policies are templates in `bootstrap/policies/`, rendered and minified by Terraform; each has a
precondition enforcing the 6,144-character managed-policy limit.

**Known limits, accepted:**

- Both administrator users keep AdministratorAccess and can bypass all of this.
- Some services do not evaluate `aws:ResourceTag` for every action. Bootstrap resources are
  therefore also denied by explicit ARN.
- Where a needed action turns out not to support the scoping used, the deployer is refused
  (fail-closed) and the policy is widened by a reviewed change to `bootstrap/`, never ad hoc.
