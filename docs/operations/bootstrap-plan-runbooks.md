# Bootstrap plan runbooks (plan only)

**Purpose:** the exact steps to produce and check the two bootstrap plans of the two-environment
CI/CD design ([ci-cd-two-environments.md](ci-cd-two-environments.md)), **without changing
anything in AWS**. Applying is a separate, approved step. These runbooks replace the
Production-only runbook from #133 and match the layout of PR #134.

## Who runs the bootstraps

Bootstrap creates the identities and guardrails that everything else is held to, so it is run by
the **human administrator**, never by CI and never by an identity Claude can use.

| | Production bootstrap | TEST bootstrap |
| --- | --- | --- |
| Root | `infra/terraform/bootstrap` | `infra/terraform/bootstrap-eu-test` |
| Account | 800728620253 (management) | 657878534449 (`munaxa-nonprod`) |
| Principal | IAM user **`admin.tamer`** | **`admin.tamer`** → `arn:aws:iam::657878534449:role/OrganizationAccountAccessRole` |
| Where | AWS CloudShell, management account, eu-central-1 | the same CloudShell; the script assumes the role in a private temporary profile |
| State | existing S3 state, read only (`-lock=false`) | none yet: a scratch copy with local state, nothing written to AWS |
| Script | `scripts/bootstrap/plan-production.sh` | `scripts/bootstrap/plan-testing.sh` |
| Expected | 4 to add, 1 to change, 0 to destroy | plan A: 2 to add; plan B: 35 to add (34 without the budget) |

**Why `OrganizationAccountAccessRole`, and not the engineering role, for TEST:**

- **The engineering permission set is Claude's.** `MunaxaAWSEngineeringAdmin` is assigned to the
  same Identity Center group in both accounts, and it is the identity Claude's AWS connector
  signs in with. In Production that identity is deliberately kept away from bootstrap. Its inline
  guardrail `ProtectGuardrailBootstrapAndIdentityCenterIam` denies every write to
  `munaxa-docs/bootstrap/*`, and `RequireApprovedBoundaryInManagementAccount` constrains role
  creation.
- **Those guardrails stop at the management account.** They name only 800728620253 resources and
  principals. In 657878534449 the same permission set is plain `AdministratorAccess`. It *could*
  create every TEST bootstrap resource, but nothing intends it to. Using it would let a
  Claude-reachable identity create the TEST deployer, CI trust and guardrails, which breaks the
  rule that bootstrap is administrator-controlled.
- **`OrganizationAccountAccessRole` is the administrator's own path.** Organizations created it
  with the account on 2026-10-07 (CloudTrail `CreateAccount`, `roleName =
  OrganizationAccountAccessRole`). The `MunaxaNonProductionBaseline` SCP stops anyone in the
  account from changing it. `admin.tamer` reaches it from the management account, just as it
  bootstraps Production.
- **It is also the only state administrator.** The TEST state bucket admits the TEST deployer,
  the account root and the `state_admin_principal_arns` given at plan time. The script passes
  exactly this role.

**Not changed here; to decide separately:**
- The engineering permission set, being `AdministratorAccess` in the management account, can also
  assume `OrganizationAccountAccessRole` in member accounts.
- Closing that requires one of two changes, each with its own approval:
  - add a deny of `sts:AssumeRole` on `arn:aws:iam::*:role/OrganizationAccountAccessRole` to the
    `MunaxaAWSEngineeringAdmin` inline policy;
  - or narrow its assignment in 657878534449.

**Rules for both plans:**
- The scripts never run `terraform apply`, `import`, `state` or `force-unlock`.
- No Claude credentials are used, and no access key is created or typed.
- Every check that fails prints **STOP** and exits. Stop there and send the output for review.
- The output files (plan text, plan JSON, checker verdict) hold no secret values.

## 0. Once per CloudShell session: the code and Terraform

```bash
cd ~
git clone --branch claude/two-environment-cicd https://github.com/munaxa/munaxa-docs.git
#   git asks for a username and password: your GitHub username and a short-lived, read-only
#   fine-grained token. Never put it on the command line.
cd munaxa-docs
git rev-parse HEAD                       # must equal the PR head SHA in the PR description
bash scripts/bootstrap/install-terraform.sh
#   PASS: Terraform 1.16.5 … (HashiCorp signature by key C874 011F 0AB4 0511 0D02 1055 3436 5D94 72D7 468F,
#   and the archive's SHA-256, both verified)
export PATH="$HOME/tf:$PATH"
```

## 1. Production bootstrap plan (admin.tamer, 800728620253)

```bash
cd ~/munaxa-docs
bash scripts/bootstrap/plan-production.sh
```

The script does the following:

1. **Stops unless** the caller is exactly `arn:aws:iam::800728620253:user/admin.tamer`, the
   region is eu-central-1, and Terraform is 1.16.5.
2. **Plans** `infra/terraform/bootstrap` with `-lock=false`, against the existing state. The
   budget e-mail is the live value (`alerts@example.com`), so the budget shows no change.
3. **Prints in full** the new CI role's trust, its only permission, and the deployer's new trust.
4. **Runs `bootstrap-plan-check.sh production`** and writes `~/production-bootstrap-check.txt`.

**Expected:** `Plan: 4 to add, 1 to change, 0 to destroy.` and `RESULT: PASS`.

| Action | Address | What it is |
| --- | --- | --- |
| create | `module.production_ci.aws_iam_openid_connect_provider.github` | `token.actions.githubusercontent.com`, audience `sts.amazonaws.com` |
| create | `module.production_ci.aws_iam_policy.boundary` | `/munaxa-docs/bootstrap/munaxa-docs-eu-prod-ci-boundary` |
| create | `module.production_ci.aws_iam_role.ci` | `/munaxa-docs/bootstrap/munaxa-docs-eu-prod-ci`; trusts `repo:munaxa/munaxa-docs:environment:production` on `refs/heads/main` only |
| create | `module.production_ci.aws_iam_role_policy.ci` | `sts:AssumeRole` and `sts:SetSourceIdentity` on the Production deployer only |
| update | `aws_iam_role.deployer` | trust only: keeps its five statements, adds `GitHubActionsSessions` and `GitHubActionsSourceIdentity` |

**The checker stops on anything else**:
- any other resource, including the nine deployer policies, both boundaries, the state bucket
  and key, the trail and the budget;
- a deployer change other than its trust;
- a trust statement missing;
- a trust that is only known after apply.

The nine policies and two boundaries as rendered by #134 were compared with the live IAM documents
on 2026-10-08: all 11 are identical.

Send `~/production-bootstrap-check.txt` for review.

## 2. TEST bootstrap plan (admin.tamer → OrganizationAccountAccessRole, 657878534449)

```bash
cd ~/munaxa-docs
ALERT_EMAIL=<address for TEST budget alerts> bash scripts/bootstrap/plan-testing.sh
```

The script does the following:

1. **Checks the caller and Terraform.** It stops unless the caller is
   `arn:aws:iam::800728620253:user/admin.tamer` and Terraform is 1.16.5.
2. **Assumes `OrganizationAccountAccessRole`** in 657878534449 through a private, temporary AWS
   config file. The session is named `admin.tamer-bootstrap-eu-test` and lasts at most one hour.
   It stops unless the new identity is exactly that role session in that account, in
   eu-central-1.
3. **Lists what the account holds today, read only:** OIDC providers, `/munaxa-docs/` roles,
   buckets, KMS aliases, VPCs, NAT gateways, RDS, load balancers, ECS clusters and trails. The
   list is saved to `~/test-bootstrap-inventory.txt`. Expected: no Munaxa resource yet.
4. **Checks, read only, whether the account's roles may use the Budgets API.** The account was
   created with IAM access to billing denied. If they may not, the budget is left out of the plan
   (`create_budget = false`) and is created later from the management account (§4).
5. **Copies the root to a scratch directory** without `backend.tf`. The state bucket does not
   exist yet.
6. **Plans twice:**
   - **plan A**, `-target` the state key and alias: the first step of the eventual apply;
   - **plan B**, everything, as a preview.
7. **Prints in full** the state key policy, the Testing CI role's trust and its only permission,
   and the TEST deployer's trust.
8. **Runs the checker** on both plans (`testing-key`, then `testing`) and writes
   `~/test-bootstrap-check.txt`, ending in `OVERALL: PASS` or `OVERALL: STOP`.

**Expected:**

Plan A: 2 to add, no IAM resource. The key policy names only `arn:aws:iam::657878534449:root`.

Plan B: 35 to add, 0 to change, 0 to destroy (34 without the budget):

| Group | Resources (all `create`) |
| --- | --- |
| State | `aws_kms_key.state`, `aws_kms_alias.state` (`alias/munaxa-docs-eu-test-tfstate`), `aws_s3_bucket.state` (`munaxa-docs-tfstate-eu-test-657878534449`) with ownership controls, public access block, versioning, SSE-KMS, lifecycle, bucket policy |
| GitHub OIDC | `module.testing_ci`: OIDC provider, `munaxa-docs-eu-test-ci` role (trusts `repo:munaxa/munaxa-docs:environment:testing` on `refs/heads/main` only), its inline policy, its boundary |
| TEST deployer | `aws_iam_role.deployer` (`munaxa-docs-eu-test-deployer`, trusts the Testing CI role with source identity `github-actions`, session `gha-run-*`), `aws_iam_policy.deployer_boundary`, `aws_iam_policy.workload_boundary`, nine `aws_iam_policy.deployer[…]` and their attachments (`deployer-read`, `deployer-state`, `deployer-guardrails-environment`, `deployer-guardrails-identity`, and the TEST-only `deployer-testing-session`, `-compute`, `-data`, `-iam`, `-foundation-guard`) |
| Budget | `aws_budgets_budget.testing[0]` (`munaxa-docs-eu-test-account-monthly`, USD 15), unless `create_budget = false` |

The checker stops on anything else. Nothing application- or runtime-specific can pass it: no VPC,
cluster, DNS zone, certificate, database, load balancer, ECS service or TEST session, and nothing
in Production.

The TEST deployer is **session-only**: it can build and destroy TEST sessions (database, load
balancer, ECS services and tasks, session secrets, the `test.docs.munaxa.com` record) and nothing
else. `deployer-testing-foundation-guard` denies every change to the persistent foundation, and its
state access is `eu-test/session/*` only. It has nine managed policies attached (quota: ten).

Send `~/test-bootstrap-check.txt` (and `~/test-bootstrap-inventory.txt`) for review, with the
review file from §6.

## 2a. TEST foundation plan (after the TEST bootstrap is applied)

The persistent foundation (network, cluster, DNS zone, certificate, data key, document bucket,
Cloud Map, workload roles) is applied by the same administrator path, never by CI:

```bash
bash scripts/bootstrap/plan-test-foundation.sh
```

The script:
- stops unless the caller is `arn:aws:iam::800728620253:user/admin.tamer`, and unless the assumed
  identity is exactly
  `arn:aws:sts::657878534449:assumed-role/OrganizationAccountAccessRole/admin.tamer-foundation-eu-test`
  (one hour, eu-central-1, private temporary AWS config file);
- uses the real backend, state key `eu-test/foundation/terraform.tfstate` in
  `munaxa-docs-tfstate-eu-test-657878534449`. Only the administrator may read it: the bucket policy
  admits the TEST deployer to `eu-test/session/*` only;
- plans with `-lock=false` (nothing is written to AWS, not even a lock) and never applies;
- checks the plan with `plan-guard.sh infra`, which refuses any delete or replace of a persistent
  resource, and writes `~/test-foundation-plan.txt`, `.json` and `~/test-foundation-check.txt`.

The first foundation plan is creates only. The Cloud Map namespace `test.munaxa-docs.internal` and
its `api` and `scanner` services are part of it (approved: about $0.50 a month, idle TEST total
about $3–3.50 a month, see [ci-cd-two-environments.md](ci-cd-two-environments.md) §2).

## 3. The three "known after apply" documents in plan B, and why the apply has two steps

Three TEST deployer documents name the state key by its full ARN:
- `deployer-state`, which may use this one key;
- `deployer-guardrails-environment` and `deployer-boundary`, which deny everything on this key
  except encrypt and decrypt.

A KMS key ARN contains a key ID that AWS generates when the key is created. So these three
documents cannot be known before the key exists.

They are not made visible by any other means, because each would weaken the model or change
Production:
- **Naming the key by alias.** IAM authorizes key use against the key ARN. An alias condition
  (`kms:RequestAlias`) does not bind the protection to this one key the way the ARN does.
- **A wildcard key ARN.** That would grant or deny every key in the account.
- **Changing the shared templates.** Production's rendering is proven identical to the live
  policies, and these templates produce it.

So the first apply has two steps, and every policy is reviewed in full before it exists:

| Step | What is created | Why it is safe |
| --- | --- | --- |
| A | `aws_kms_key.state` and `aws_kms_alias.state` only (`-target`) | No IAM resource. The key policy is fully visible: account root only, so access is decided by IAM in that account, as for any key. Nothing new can use it until step B. The checker refuses plan A if anything else appears or if the key policy names any other principal. |
| B | everything else | Planned after A exists. Every document now names the real key ARN, and the checker **requires** that no policy is "known after apply". |

The commands of the eventual apply (not part of this runbook) are in
[`infra/terraform/README.md`](../../infra/terraform/README.md) §4.

## 4. If the TEST budget cannot be created inside 657878534449

If plan-testing reports that budgets are refused, the same budget is created from the management
account, filtered to the linked account:
- name `munaxa-docs-eu-test-account-monthly`, cost, monthly, USD 15;
- filter Linked account = 657878534449;
- alerts at 50 % actual, 100 % actual and 100 % forecast.

This is a separate AWS write that needs its own approval.

## 5. Later, separately: the Production budget's alert address

The live Production budget alerts `alerts@example.com`, the example value, so nobody receives
them. The fix is its own small change, after the Production bootstrap:
1. Plan `infra/terraform/bootstrap` as in §1, but with the new recipients:
   `-var='budget_alert_emails=["<address>", …]'`.
2. Check it with `scripts/ci/bootstrap-plan-check.sh production-budget`. It passes only if the
   plan changes the budget's alert recipients and nothing else.
3. Apply after approval.

## 6. Sending the plans for review

After the plans above, in the same CloudShell:

```bash
bash scripts/bootstrap/export-plan-review.sh
```

It reads the saved plan and check files in `$HOME` (read-only; no AWS or Terraform call) and writes
`~/bootstrap-plan-review.json`. Per plan: account, principal, region, change counts, every changed
address, every IAM, key and bucket policy document in full (or "known after apply") and the
checker's verdict. A plan that was not run is listed as `NOT RUN`. Send that one file.

## 7. Validation gates: what each one proves

Four kinds of evidence, never interchangeable. Each gate needs its own evidence, and no later step
starts until the gates before it pass.

| Gate | Evidence | Run by | Proves | Does not prove |
| --- | --- | --- | --- | --- |
| 1. Offline validation | `fmt`/`validate` of every root, actionlint, ShellCheck, Prettier, the checker fixtures (`infrastructure-checks.yml`), an offline plan with fake credentials, a local IAM evaluator | CI, Claude | The code is consistent; the rendered documents have the intended shape; the checkers accept the agreed sets and refuse the bad ones | Anything about the real accounts. An offline plan is not a plan |
| 2. Real Terraform plans | §1, §2, §2a, then §6 | `admin.tamer` (CloudShell) | The real accounts hold what we think; the change sets are exactly the agreed ones; every document in full | That AWS accepts and evaluates the documents as intended |
| 3. AWS-native policy validation | IAM Access Analyzer `ValidatePolicy` on every rendered document (identity policies, boundaries, trusts, the state bucket policy, the key policy) with no error or security warning; `SimulateCustomPolicy` with each document set (identity policies plus boundary) on the agreed allow and deny cases | an authorized AWS identity, read only | AWS's own parser and evaluator agree with the design | That a TEST session really works end to end |
| 4. First real TEST session | after the TEST bootstrap and foundation are applied: **TEST environment → start**, URL check, **stop** | GitHub Actions, approved | The session-only deployer is enough: the load balancer, database and Fargate tasks get their network interfaces through the ECS, Elastic Load Balancing and RDS service-linked roles, with no EC2 write in the deployer. The foundation guard denies nothing the session needs | — |

A local evaluator result is gate 1, never gate 3. A gate is PASS only with its own evidence.

**The TEST bootstrap apply needs gates 1, 2 and 3.** Gate 3 runs on plan B's documents; the three
that name the state key (§3) are validated with the real key ARN once step A exists, before step
B is applied. Gate 4 can only run after the bootstrap and the foundation are applied. Its single known
risk is the service-linked roles: if a session fails to create a network interface, the fix is a
reviewed, narrow deployer change, never EC2 write on `*` and never a NAT or Elastic IP permission.

