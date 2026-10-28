# Munaxa Docs — Production infrastructure (Terraform)

Terraform for the **Production** environment of Munaxa Docs in AWS account `229251310592`,
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

**Moved to account `229251310592` on 2026-10-21.** The original account `800728620253` became
inaccessible; nothing was carried over from it. The evidence reports linked below describe the
applies in that original account and are kept as history. In `229251310592`:

| Root | Contents | Status |
| --- | --- | --- |
| `bootstrap/` | State bucket and key, deployer role, boundaries and policies, GitHub OIDC provider and CI role, CloudTrail, Production and whole-account budgets | **Applied 2026-10-21** by root in AWS CloudShell (46 + 1 resources); post-apply plan: no changes. Verified read-only: state bucket versioned, public access blocked, SSE-KMS with rotating key; trail multi-region, logging, file validation; deployer trusts only the CI role; CI role trusts only `munaxa/munaxa-docs`, environment `production`, `refs/heads/main`; both $10 budgets present. Cost allocation tags not yet activated (`activate_cost_allocation_tags`, once the keys appear in Billing) |
| `eu-prod/core/` | Production workload IAM roles and the network (VPC `10.121.0.0/16`, public and isolated DB subnets, IGW, S3 gateway endpoint, security groups) | **Applied 2026-10-21** by GitHub Actions ([run 39668262903](https://github.com/munaxa/munaxa-docs/actions/runs/39668262903), `main` at `0181d4e`): 59 added, 0 changed, 0 destroyed. Verified read-only: VPC `vpc-06ed50fc514fb4f21`, five subnets with no automatic public IPs, the only internet route on the public route table, S3 gateway endpoint, six tier security groups (8 ingress, 11 egress; only the ALB open to the internet, on 80 and 443), no NAT gateway or Elastic IP, nine roles under `/munaxa-docs/eu-prod/` each with the workload boundary |
| `eu-prod/data/` | Data KMS key, RDS PostgreSQL 16, document bucket, AWS Backup | **Applied 2026-10-22** by GitHub Actions ([run 39738966834](https://github.com/munaxa/munaxa-docs/actions/runs/39738966834), `main` at `472fd8a`): 19 added, 0 changed, 0 destroyed. Verified read-only: `munaxa-docs-eu-prod-pg` available, PostgreSQL 16.12 `db.t4g.micro` Single-AZ (eu-central-1a), 20 GB gp3, encrypted with the data key, not publicly accessible, in the three DB subnets behind the rds security group only, `rds.force_ssl=1`, master password managed by RDS in Secrets Manager, 35-day backups, deletion protection; data KMS key enabled with rotation; backup vault on the data key with the monthly 365-day rule and the database selected; `munaxa-docs-eu-prod-docs-229251310592` with all public access blocked, not public, versioned, SSE-S3. Extended support is AWS's default (`open-source-rds-extended-support`); it costs nothing until PostgreSQL 16 leaves standard support |
| `eu-prod/service/` | ALB/ACM, ECS task definitions and services, schedules, alarms | **Default stage applied 2026-10-26** by GitHub Actions through the reviewed saved plan ([run 40289111146](https://github.com/munaxa/munaxa-docs/actions/runs/40289111146), `main` at `de4ce3f`): 22 added, 0 changed, 0 destroyed. Verified read-only: certificate for `docs.munaxa.com` requested (since ISSUED), ALB and two target groups with no listener, cluster and six task definitions on the release digests, two empty secrets, five log groups, Cloud Map; no service, task or schedule. **HTTPS stage applied 2026-10-26** ([run 40305141933](https://github.com/munaxa/munaxa-docs/actions/runs/40305141933), `main` at `d19d04c`): the four intended creates (certificate validation, HTTPS listener, preview rule, HTTP redirect) plus four undeclared task-definition replacements (api, ops_provision, scanner, web: ECS-stored defaults the code did not state; revision 2 has the same configuration as revision 1). The task definitions now state those defaults and every apply is checked against `expected-changes.json`; a plan-only run on `main` should show no change. `enable_services` is false |
| `modules/ecs-service/` | Input contract for the three ECS services | Variables only |

**Images moved to ECR on 2026-10-22** (§5, ADR-0024 amendment), on top of the applies above:

- **`bootstrap/`:** applied by root in AWS CloudShell from `72cbc8e` (the head of #141, which `main`
  now carries).
  - Result: 9 added, 1 changed, 0 destroyed; the post-apply plan shows no changes.
  - Verified read-only:
    - `munaxa-docs/{api,web,antivirus}` have immutable tags, scan on push, AES256, 2 lifecycle rules
      each, no repository policy, and no images yet;
    - the image publisher role is at `/munaxa-docs/bootstrap/`, with its own boundary, 1-hour
      sessions, and the trust in §5;
    - the workload boundary has 15 statements, including the 2 ECR statements limited to the four
      image-pulling execution roles.
- **`eu-prod/core/`:** applied by GitHub Actions
  ([run 39849287105](https://github.com/munaxa/munaxa-docs/actions/runs/39849287105), `main` at
  `a04723a`).
  - Result: 0 added, 12 changed, 0 destroyed. The 12 are 4 execution-role descriptions, 3 egress-rule
    descriptions, 4 execution-role policies and the S3 endpoint policy.
  - Verified read-only:
    - the web, api, scanner and ops-provision execution policies grant ECR sign-in and pulls from
      their own image's repository only;
    - no role reads `ghcr-pull`;
    - web and scanner read no secret at all;
    - the S3 endpoint adds read-only `s3:GetObject` on `prod-eu-central-1-starport-layer-bucket/*`;
    - `simulate-principal-policy` (§5 step 4) gives exactly the expected allows and denies, and a
      request from another region is still explicitly denied.
- **Not yet done:** no image has been published to ECR, and the first real pull through the S3
  endpoint is untested until the first task runs.

**No IAM users and no access keys exist in this account, by owner decision.** Until the build is
finished, the only human identity is root (MFA on). Root cannot call `sts:AssumeRole`, so:

- `bootstrap/` is planned and applied by root in AWS CloudShell, with no credentials copied anywhere;
- every `eu-prod/` root runs only through GitHub Actions (OIDC → CI role → deployer);
- `claude_principal_arn`, `break_glass_principal_arn` and `engineering_principal_arn` default to
  `null`, which leaves their deployer trust statements and state-bucket entries out. Set one and
  re-apply bootstrap once that identity exists.

The account is the AWS Organizations management account (`o-6i2zz7t70i`), so service control
policies do not apply to it.

History in `800728620253`: bootstrap applied 2026-10-04 at `6dac383`
([evidence](../../docs/reports/production-bootstrap-apply-evidence.md),
[network fix](../../docs/reports/production-bootstrap-network-fix-evidence.md)); core at `4e728bb`
and `2b214e9` ([roles](../../docs/reports/production-core-apply-evidence.md),
[network](../../docs/reports/production-core-network-evidence.md)); data at `8a8c240`
([evidence](../../docs/reports/production-data-apply-evidence.md)).

Production remains **NOT READY**.

## Layout and state

```
infra/terraform/
├── bootstrap/            applied once by an administrator identity; never by CI
├── eu-prod/
│   ├── ci.s3.tfbackend       partial backend config: assume the deployer from the GitHub
│   │                         Actions CI role (source identity github-actions)
│   ├── engineering.s3.tfbackend   partial backend config: assume the deployer as Claude's
│   │                              engineering role (source identity munaxa-org-operator)
│   ├── claude.s3.tfbackend   partial backend config: assume the deployer as the Claude IAM
│   │                         user (fallback until it is retired)
│   ├── core/             applied by the deployer role
│   ├── data/             applied by the deployer role
│   └── service/          applied by the deployer role
└── modules/ecs-service/
```

| Root | State object (bucket `munaxa-docs-tfstate-eu-prod-229251310592`) | Applied by |
| --- | --- | --- |
| `bootstrap` | `bootstrap/terraform.tfstate` | An administrator (`admin.tamer`, or `claude-munaxa-docs` until it is retired), **never the deployer, the engineering role or CI** |
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
`arn:aws:iam::229251310592:role/munaxa-docs/bootstrap/munaxa-docs-eu-prod-deployer`.

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

### 4. Who runs what (migration away from the `claude-munaxa-docs` IAM user)

| Path | Used for | Identity chain |
| --- | --- | --- |
| **GitHub Actions** (`.github/workflows/terraform-eu-prod.yml`) | Terraform `plan` and `apply` of `eu-prod/core`, `eu-prod/data` and `eu-prod/service`: the Production execution path | GitHub OIDC → `munaxa-docs-eu-prod-ci` → deployer (source identity `github-actions`, session `gha-run-*`) |
| **Claude engineering role** (`MunaxaAWSEngineeringAdmin`, user `munaxa-org-operator`) | Interactive work: reading, inspecting, operator checks; may assume the deployer | Identity Center → engineering role → deployer (source identity `munaxa-org-operator`, session `claude-*`) |
| **`admin.tamer`** in AWS CloudShell | `bootstrap/` plans and applies, and break-glass | IAM user console session; no access keys copied anywhere |
| **`claude-munaxa-docs`** | **Temporary fallback during the migration only.** It stays active, with its trust statements and state access, until the CI path has been proven; it is removed in a later stage | IAM user access key → deployer (source identity `claude-munaxa-docs`) |

**The CI role** (`bootstrap/github_oidc.tf`):

- **Trust:** GitHub's OIDC provider, with `aud = sts.amazonaws.com`,
  `sub = repo:munaxa@311481412/munaxa-docs@1318346271:environment:production`,
  `repository_owner_id = 311481412`, `repository_id = 1318346271` and `ref = refs/heads/main`,
  all exact. GitHub issues this repository the immutable subject form (owner and repository
  names with their numeric IDs), which is what AWS receives; the plain-name form never matches.
  Only jobs in the protected `production` environment of this repository, running on `main`, can
  use it. No other repository, branch, pull-request or wildcard subject can, nor a re-created
  organization or repository that reuses the name.
- **Permissions:** `sts:AssumeRole` and `sts:SetSourceIdentity` on the deployer, nothing else.
  The same document is its permissions boundary.
- **No direct access:** none to Terraform state, the state key, any service or bootstrap.
- **Protected:** it lives under `/munaxa-docs/bootstrap/`, so the deployer is denied every
  action on it, as it is on the OIDC provider.
- **Sessions:** last at most one hour. The deployer session Terraform opens from it is role
  chaining, so it also lasts at most one hour.

**The workflow:**

- **How it starts:** it is dispatched by hand, with a root from a fixed list (`core`, `data`,
  `service`) and `plan` or `apply`.
- **Credentials:** `configure-aws-credentials` assumes the CI role through OIDC (no stored AWS
  credentials). Terraform's own `assume_role` (provider and `ci.s3.tfbackend`) then opens the
  deployer session with source identity `github-actions`, because the action cannot set a source
  identity.
- **Approval:** every job that can obtain credentials runs in the `production` environment and
  waits for its required reviewers.
- **Branch:** `plan` and `apply` run only from `main`. The workflow refuses other branches
  before approval, and the CI role's trust refuses them in AWS.
- **Apply: plan, review, then apply that exact plan.** An `apply` run has three jobs:
  - `plan`: saves the plan and keeps it for review (below);
  - a **review gate**: the second approval;
  - `apply`: applies only the kept plan.

  It never re-plans before applying (see "Production plan and apply" below).
- **Summary:** the job summary lists the planned actions and resource addresses only, never
  attribute values. Replacements are counted separately from additions and destructions.
- **Never** runs `bootstrap/`.

GitHub settings the workflow relies on (not stored in this repository):

- the `production` environment;
- required reviewers on it, and no option to bypass them;
- its deployment branches limited to `main`.

#### Production plan and apply (the reviewed-plan gate)

**The sequence for every Production change:**

0. **Declare the change in the PR.** Every root has an `expected-changes.json` next to its code.
   The PR that makes a change also sets that file to exactly the resource actions the change
   should plan, and both are reviewed together:

   ```json
   {
     "root": "service",
     "intent": "HTTPS stage: listener, preview rule and redirect (PR #158)",
     "changes": [
       { "address": "aws_acm_certificate_validation.web[0]", "actions": ["create"] },
       { "address": "aws_lb_listener.https[0]", "actions": ["create"] },
       { "address": "aws_lb_listener_rule.preview_stream[0]", "actions": ["create"] },
       { "address": "aws_lb_listener.http_redirect[0]", "actions": ["create"] }
     ]
   }
   ```

   - **The rules.** Each entry is a Terraform resource address and its action list as Terraform
     plans it: `["create"]`, `["update"]`, `["delete"]`, or a replacement as `["delete", "create"]`
     (or `["create", "delete"]` for create-before-destroy). Reads and no-ops are not listed.
   - **How the workflow uses it.** `scripts/terraform/check-plan-intent.sh` compares the plan's
     changes with it, address by address and action by action. Counts are never compared.
     - In an `apply` run, any extra, missing or different action fails the `plan` job, so the plan
       is never kept and approval 2 is never asked for. The `apply` job runs the same check on the
       fetched plan before `terraform apply`.
     - A missing, malformed or empty declaration fails an apply. An empty `changes` list means
       "nothing may be applied".
     - A `plan` run only reports how the plan compares.
   - **Why it is safe to reuse.** The file is part of the commit the plan is bound to, so a
     declaration cannot outlive its review. After an apply, the next PR either declares its own
     changes or resets the list to `[]`.
   - **When the addresses are uncertain.** The workflow runs only on `main`, so merge the change
     with your best declaration and run `action=plan`: its summary reports the difference without
     applying anything. Correct the code or the declaration in a follow-up PR, then plan again.
     Never widen a declaration just to make a plan pass.

1. **Run the plan.** Dispatch "Terraform eu-prod" on `main` with the root and `action=plan`, and
   approve the `plan` job's `production` environment. A `plan` run keeps nothing and has no apply
   job.
2. **Review the exact plan.** Read the run summary: the commit, every resource address and its
   action, and the counts to add, change, replace and destroy. Compare them with the change you
   intend.
3. **Approve the reviewed plan.** When you are ready to apply:
   - dispatch again with `action=apply`;
   - approve the `plan` job (approval 1);
   - read the plan it publishes;
   - only if it is the reviewed change, approve the `apply` job (approval 2).

   Rejecting approval 2, or letting it wait past four hours, applies nothing.
4. **Apply that exact plan.** The `apply` job applies the plan the `plan` job saved, after
   verifying it. It never runs `terraform plan`.
5. **Verify the resources** with read-only checks (the release package lists them).
6. **Then continue** with each later step only through its own documented gate: certificate
   DNS validation, the ECS image-pull test, `enable_https`, `enable_services`.

**How the reviewed plan is kept and bound to the review:**

- **Storage.** A saved plan can contain sensitive values in plain text, so it never becomes a
  workflow artifact and never leaves AWS. The `plan` job stores it in the state bucket:
  - key `eu-prod/plans/<root>/<run id>-<attempt>/tfplan`, written only if no object exists there;
  - encrypted with the state key (SSE-KMS);
  - readable only by the deployer and administrators, as the bucket policy and the deployer's
    `eu-prod/*` grant already allow. No IAM or trust change was needed.
- **Binding.** The `plan` job records, as job outputs that only GitHub holds:
  - the plan's SHA-256;
  - the commit and the root;
  - the run;
  - the time it was created.

  It writes the same values to the object's metadata.
- **Checks in the `apply` job.** It fetches the object and runs
  `scripts/terraform/verify-saved-plan.sh`, which refuses the plan if any of these fail:
  - the hash matches the reviewed hash;
  - the commit, root and run match;
  - the object is encrypted with the state key itself. KMS resolves the state key's alias
    (`aws kms describe-key`) to its key ARN, which must be a customer-managed, enabled key in
    this account and region (`scripts/terraform/resolve-kms-key.sh`). It is then compared, by
    account, region and key ID, with the key S3 reports for the object; an alias or another key
    is refused;
  - the plan is no older than four hours (`MAX_PLAN_AGE_SECONDS`) and not from the future.

  It then checks the fetched plan against `expected-changes.json` from the same commit, and stops
  unless its addresses and actions are exactly the declared ones. It also re-reads the counts
  and stops if they differ from the plan job's; that is only an integrity check between the two
  jobs, never proof that the plan is the intended change (run 40305141933 passed it while
  replacing four undeclared task definitions).
- **Recording.** The apply job's summary records:
  - the commit and the plan's key and hash;
  - the addresses applied;
  - each approval, read from the run's approvals;
  - the result.
- **Clean-up.** The kept plan is deleted whatever the result. The bucket is versioned, so its
  version remains, encrypted and private, for the bucket's 365-day noncurrent retention.
- **Stale plans fail.** If the Terraform state changed after the plan was made (another apply of
  the same root, or a state change by an administrator), Terraform refuses the saved plan as stale. The job then fails without
  re-planning: run a new plan, review it and approve again. The same applies past the age limit.
- **Not covered by Terraform's stale check:** a change made outside Terraform between plan and
  apply. Keep the window short and re-check the live AWS state before planning.
- **Plan log.** The `plan` step's log shows Terraform's normal plan output, with sensitive values
  redacted as `(sensitive value)`. Anyone who can read the repository's Actions logs can see it.

**Optional settings, for the owner to choose:**

- **Prevent self-review on `production`.** It forces a second person to approve. With one owner,
  this would block every run, so it is not required today.
- **A narrower environment for approval 2.** The CI role's trust names the `production`
  environment, so the `apply` job must run in it. A separate apply environment would need a
  bootstrap trust change, which is not part of this change.

**Tests.** `scripts/terraform/tests/run.sh` runs in CI as the "Production Terraform workflow"
job, without AWS. It checks:
- the workflow's safety properties (`scripts/terraform/check-workflow-policy.sh`):
  - the plan job cannot apply;
  - the apply job cannot plan, and needs the plan job, action `apply`, `main` and the `production`
    environment;
  - the plan is verified before the one `terraform apply`, and discarded afterwards;
  - the plan is checked against the declared intent in the plan job, before it is kept, and
    again in the apply job, before the apply;
  - no artifact is uploaded;
  - only `main` is accepted;
- the saved-plan verification against missing, altered, expired, future and foreign plans;
- the intent check (`check-plan-intent.sh`):
  - the HTTPS stage's four creates pass;
  - the same four plus run 40305141933's four task-definition replacements fail;
  - an undeclared addition, update, delete or replacement fails, and so does a missing change;
  - a missing, malformed, empty or other-root declaration fails;
  - every committed declaration is valid;
- that the plan summary never prints an attribute value.

The role ARN is not a secret and is written in the workflow. No AWS secret is stored in GitHub.

The `bootstrap/` changes that create the OIDC provider and the CI role, and add the
`GitHubActionsSessions` and `GitHubActionsSourceIdentity` statements to the deployer trust, are
applied by `admin.tamer` like any other bootstrap change. Until then the workflow cannot obtain
credentials.

### 5. Images in ECR (ADR-0024 amendment, 2026-10-22)

Production images are in ECR in this account: `munaxa-docs/api`, `munaxa-docs/web` and
`munaxa-docs/antivirus` (`bootstrap/ecr.tf`). There is no registry credential anywhere.

**Who may push.** `.github/workflows/publish-images.yml` assumes the image publisher role
(`/munaxa-docs/bootstrap/munaxa-docs-eu-prod-image-publisher`) through GitHub OIDC. Its trust
requires, all exactly:

- `aud` = `sts.amazonaws.com`;
- `sub` = `repo:munaxa@311481412/munaxa-docs@1318346271:environment:image-release`;
- `repository_owner_id` = `311481412` and `repository_id` = `1318346271`;
- `ref` like `refs/tags/image/*`;
- `job_workflow_ref` like `munaxa/munaxa-docs/.github/workflows/publish-images.yml@refs/tags/image/*`.

These claim names and formats were observed in this repository's own tokens on 2026-10-22, from a
temporary probe on the PR branch that never touched AWS. `sub` uses the immutable owner and
repository IDs. `job_workflow_ref` is present for an ordinary workflow and uses names. AWS documents
`ref`, `environment` and `job_workflow_ref` as GitHub condition keys.

The role may push to, read back and describe those three repositories only. `ecr:GetAuthorizationToken`
is on `*`, because AWS has no resource for it.

**Release authorisation.** A tag runs the workflow file as it is at the tagged commit. A check inside
the workflow is therefore advisory: whoever creates the tag can edit it. Enforcement sits outside the
workflow, in three layers:

1. **Tag ruleset** (GitHub, to be created by a repository admin). Target: tags, `refs/tags/image/*`.
   Rules: restrict creations, restrict updates, restrict deletions, block force pushes. Bypass: the
   Repository admin role only. Proposed definition:
   ```json
   {
     "name": "Release image tags",
     "target": "tag",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["refs/tags/image/*"], "exclude": [] } },
     "rules": [
       { "type": "creation" }, { "type": "update" }, { "type": "deletion" }, { "type": "non_fast_forward" }
     ],
     "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ]
   }
   ```
2. **Environment `image-release`** (GitHub, to be created by a repository admin). Required reviewer:
   the release owner. Deployment branches and tags: selected, the tag pattern `image/*` only.
   - Every job that touches ECR declares it.
   - GitHub issues the `environment:image-release` subject only after approval, and only on an
     allowed ref.
   - Until this environment and the ruleset exist, publishing cannot obtain AWS credentials.
3. **The publisher trust above.** It requires that environment, an `image/*` tag and this workflow
   file.

The workflow adds two checks on top: the tag must point at the commit it names, and that commit must
be on `main`, which accepts only reviewed pull requests (ruleset "Protect main"). Together they
mean the workflow that runs is itself reviewed code.

**Limits.**

- This repository has one admin. The same person can create the tag and approve the environment, so
  the controls ensure a deliberate act by an authorised person, not two-person review. "Prevent
  self-review" can be turned on once there is a second reviewer.
- AWS cannot check a commit's ancestry, and `job_workflow_sha` is not an AWS condition key.

**Who may pull.**

- **Workload boundary:** admits ECR sign-in and pulls (three repositories) only for the four
  execution roles that start an image from these repositories: web, API, scanner and ops-provision.
- **No ECR at all for the other six workload roles**, whatever their own policies say: the ops-dbadmin
  and ops-tunnel execution roles (other images), the API and tunnel task roles, the scheduler role
  and the backup role.
- **Each execution role's own policy** names only its own image's repository: web → `web`; API and
  ops-provision → `api`; scanner → `antivirus`.
- **S3 gateway endpoint:** allows read-only `s3:GetObject` on
  `arn:aws:s3:::prod-eu-central-1-starport-layer-bucket/*`, where ECR serves image layers. Without it,
  every pull from the public subnets would be refused at the layer download.

**Verified before any apply** (2026-10-22, IAM `SimulateCustomPolicy`, read-only, on the rendered
draft boundary):

- The four execution roles may sign in and pull from the three repositories, and nothing else, even
  under an `ecr:*` grant.
- A repository outside the three is refused.
- The other six roles are refused every ECR action, even under an `ecr:*` on `*` grant.

The S3 endpoint and a real pull cannot be simulated; see step 4 below.

**Repositories:** tags are immutable, basic scanning runs on push, and a lifecycle rule removes
untagged images after 7 days and keeps the newest 20 releases.

**Rollout.** Each stage needs the owner's approval, and nothing is applied before its plan is
reviewed.

Progress as of 2026-10-22:

- **Done:** stages 1, 2, 3 and 4, recorded under Status.
- **Not started:** stages 5 and 6.

1. **Bootstrap, as root in AWS CloudShell** (eu-central-1). First update `~/bootstrap` to this
   change's `infra/terraform/bootstrap/`; it already holds the S3 backend and `terraform.tfvars`.
   ```bash
   cd ~/bootstrap
   terraform init -input=false
   terraform plan -input=false -no-color -out=ecr.tfplan
   # Review: about 9 to add (3 repositories, 3 lifecycle policies, the publisher role, its policy
   # and boundary), 1 to change (the workload boundary policy), 0 to destroy.
   terraform apply -input=false ecr.tfplan   # only after the plan is reviewed and approved
   terraform plan -input=false -detailed-exitcode -no-color | tail -3   # expect "No changes"
   ```
2. **GitHub settings, by a repository admin:** the tag ruleset and the `image-release` environment
   above.
3. **Core, through GitHub Actions**, once this change is on `main`: run **Terraform eu-prod** with
   root `core` and action `plan`.
   - Review: about 12 in-place changes and nothing added or destroyed. That is 4 execution-role
     policies, 4 execution-role descriptions, the S3 endpoint policy, and 3 HTTPS egress-rule
     descriptions.
   - Then run `core` / `apply`, after approval.
4. **Verify pulls, read-only, after stages 1 and 3.** As root in CloudShell.
   - **Context entries are required.** The workload boundary denies every request whose
     `aws:RequestedRegion` is not `eu-central-1` (`StringNotEquals`). The simulator leaves that key
     unset unless it is given, and IAM treats a missing key as not equal. So a run without
     `--context-entries` reports `explicitDeny` for everything, from the boundary.
   - Real requests from the ECS agent always carry the region and the role's ARN; the command below
     supplies both.
   ```bash
   for r in web api scanner ops-provision ops-dbadmin ops-tunnel; do
     arn="arn:aws:iam::229251310592:role/munaxa-docs/eu-prod/munaxa-docs-eu-prod-$r-execution"
     echo "== $r"
     aws iam simulate-principal-policy \
       --policy-source-arn "$arn" \
       --context-entries "ContextKeyName=aws:RequestedRegion,ContextKeyValues=eu-central-1,ContextKeyType=string" \
                         "ContextKeyName=aws:PrincipalArn,ContextKeyValues=$arn,ContextKeyType=string" \
       --action-names ecr:GetAuthorizationToken ecr:BatchGetImage ecr:GetDownloadUrlForLayer \
       --resource-arns "arn:aws:ecr:eu-central-1:229251310592:repository/munaxa-docs/web" \
                       "arn:aws:ecr:eu-central-1:229251310592:repository/munaxa-docs/api" \
                       "arn:aws:ecr:eu-central-1:229251310592:repository/munaxa-docs/antivirus" \
       --query 'EvaluationResults[].[EvalActionName,EvalDecision,ResourceSpecificResults[].[EvalResourceName,EvalResourceDecision]]' \
       --output json
   done
   ```
   Expected:
   - each of web, API, scanner and ops-provision is allowed sign-in and its own repository only;
   - ops-dbadmin and ops-tunnel are refused everything.
   - Run with `aws:RequestedRegion=us-east-1` instead, every role must be `explicitDeny`, which
     shows the region guard.

   The first real pull, through the S3 endpoint, is the first task started during launch
   preparation. It is not tested by publishing a release now.
5. **Publish** a release, after approval: push the tag `image/<full SHA of a commit on main>`, approve
   the `image-release` environment for the run's jobs, and record the ECR digests in a new release
   package.
6. **Remove the old credentials**, after the first ECR release: the repository secrets
   `DOCS_PRODUCTION_PULL_USER` and `DOCS_PRODUCTION_PULL_TOKEN`, and the GitHub token behind them.

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
