# Bootstrap plan runbooks (plan only)

**Purpose:** the exact, copy-paste steps to produce and check the two bootstrap plans of the
two-environment CI/CD design ([ci-cd-two-environments.md](ci-cd-two-environments.md)), **without
changing anything in AWS**. Applying is a separate, approved step. These runbooks replace the
Production-only runbook from #133; they match the layout of PR #134.

| | Production bootstrap | TEST bootstrap |
| --- | --- | --- |
| Root | `infra/terraform/bootstrap` | `infra/terraform/bootstrap-eu-test` |
| Account | 800728620253 (management) | 657878534449 (`munaxa-nonprod`) |
| Who | `admin.tamer`, AWS CloudShell | you, signed in through the AWS access portal as `MunaxaAWSEngineeringAdmin` in `munaxa-nonprod`, AWS CloudShell |
| State | existing S3 state, read only (`-lock=false`) | none yet: local, nothing written to AWS |
| Expected plan | 4 to add, 1 to change, 0 to destroy | 37 to add (36 without the budget), 0 to change, 0 to destroy |
| Checker | `scripts/ci/bootstrap-plan-check.sh production` | `scripts/ci/bootstrap-plan-check.sh testing-key`, then `testing` |

**Rules for both:**
- Nothing here runs `terraform apply`, `import`, `state` or `force-unlock`.
- No Claude credentials are used. No access key is created or typed.
- `terraform plan -lock=false` reads state and AWS without writing a lock file. It changes nothing.
- If the checker prints **STOP**, stop and send its output for review. Do not work around it.
- Plan files hold no secret values for these roots, but delete them when done anyway.

## 0. Common: Terraform 1.16.5, verified

In CloudShell (either account):

```bash
set -euo pipefail
TF=1.16.5
ARCH=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
mkdir -p ~/tf && cd ~/tf
curl -fsSLO "https://releases.hashicorp.com/terraform/${TF}/terraform_${TF}_linux_${ARCH}.zip"
curl -fsSLO "https://releases.hashicorp.com/terraform/${TF}/terraform_${TF}_SHA256SUMS"
curl -fsSLO "https://releases.hashicorp.com/terraform/${TF}/terraform_${TF}_SHA256SUMS.sig"
curl -fsSL https://www.hashicorp.com/.well-known/pgp-key.txt | gpg --import
gpg --verify "terraform_${TF}_SHA256SUMS.sig" "terraform_${TF}_SHA256SUMS"
#   must say: Good signature from "HashiCorp Security (hashicorp.com/security) <security@hashicorp.com>"
#   primary key fingerprint: C874 011F 0AB4 0511 0D02  1055 3436 5D94 72D7 468F
grep "linux_${ARCH}.zip" "terraform_${TF}_SHA256SUMS" | sha256sum -c -
unzip -o "terraform_${TF}_linux_${ARCH}.zip" terraform
./terraform version      # Terraform v1.16.5
export PATH="$HOME/tf:$PATH"
```

## 1. Common: the code under review

```bash
cd ~
git clone --branch claude/two-environment-cicd https://github.com/munaxa/munaxa-docs.git
#   git asks for a username and password: give your GitHub username and a short-lived,
#   read-only fine-grained token. Never put it on the command line.
cd munaxa-docs
git rev-parse HEAD       # must equal the PR head SHA in the PR description
```

## 2. Production bootstrap plan (admin.tamer, 800728620253)

```bash
set -euo pipefail
export AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1

# 2.1 Who and where
aws sts get-caller-identity --query '[Account,Arn]' --output text
#   must be: 800728620253  arn:aws:iam::800728620253:user/admin.tamer   (otherwise stop)

# 2.2 What exists today (read only): no GitHub OIDC provider, no CI role
aws iam list-open-id-connect-providers --output text          # expect nothing
aws iam get-role --role-name munaxa-docs-eu-prod-ci 2>&1 | tail -1   # expect NoSuchEntity

# 2.3 Inputs: the SAME alert address the live budget has, so the plan shows no budget change.
#     (The live budget alerts alerts@example.com, which nobody reads. Changing it is a separate,
#     approved change; with a different address here the checker stops.)
cd ~/munaxa-docs/infra/terraform/bootstrap
printf 'budget_alert_emails = ["alerts@example.com"]\n' > terraform.tfvars

# 2.4 Plan (reads state and AWS; writes nothing, takes no lock)
terraform init -input=false -lockfile=readonly
terraform plan -input=false -lock=false -out=bootstrap.tfplan
terraform show -no-color bootstrap.tfplan > ~/production-bootstrap-plan.txt
terraform show -json bootstrap.tfplan > ~/production-bootstrap-plan.json

# 2.5 Check
~/munaxa-docs/scripts/ci/bootstrap-plan-check.sh production ~/production-bootstrap-plan.json \
  | tee ~/production-bootstrap-check.txt

# 2.6 Read the two trust policies in full (both must be complete, no "known after apply")
jq '.resource_changes[] | select(.address=="module.production_ci.aws_iam_role.ci") | .change.after.assume_role_policy | fromjson' ~/production-bootstrap-plan.json
jq '.resource_changes[] | select(.address=="aws_iam_role.deployer") | .change.after.assume_role_policy | fromjson' ~/production-bootstrap-plan.json

# 2.7 Clean up (plan only: nothing to undo in AWS)
rm -f bootstrap.tfplan terraform.tfvars
```

**Expected result:** `Plan: 4 to add, 1 to change, 0 to destroy.` and `RESULT: PASS`.

| Action | Address | What it is |
| --- | --- | --- |
| create | `module.production_ci.aws_iam_openid_connect_provider.github` | `token.actions.githubusercontent.com`, audience `sts.amazonaws.com` |
| create | `module.production_ci.aws_iam_policy.boundary` | `/munaxa-docs/bootstrap/munaxa-docs-eu-prod-ci-boundary` |
| create | `module.production_ci.aws_iam_role.ci` | `/munaxa-docs/bootstrap/munaxa-docs-eu-prod-ci`; trusts `repo:munaxa/munaxa-docs:environment:production` on `refs/heads/main` only |
| create | `module.production_ci.aws_iam_role_policy.ci` | `sts:AssumeRole` and `sts:SetSourceIdentity` on the Production deployer only |
| update | `aws_iam_role.deployer` | trust only: keeps its five statements, adds `GitHubActionsSessions` and `GitHubActionsSourceIdentity` |

Everything else must be unchanged: the nine deployer policies, both boundaries, the state bucket and
key, the trail and the budget. Their rendering in #134 was compared with the live IAM documents: all
11 are identical.

Send `~/production-bootstrap-check.txt` (and `~/production-bootstrap-plan.txt` if asked). No
secret values are in either.

## 3. TEST bootstrap plan (657878534449)

Sign in through the AWS access portal → `munaxa-nonprod` (657878534449) →
`MunaxaAWSEngineeringAdmin` → **CloudShell**, region **eu-central-1**. This is your own sign-in,
not Claude's. It is currently the only permission set in that account.

```bash
set -euo pipefail
export AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1

# 3.1 Who and where
aws sts get-caller-identity --query '[Account,Arn]' --output text
#   must be: 657878534449  arn:aws:sts::657878534449:assumed-role/AWSReservedSSO_MunaxaAWSEngineeringAdmin_…

# 3.2 What exists today (read only). Expected: none of the Munaxa resources yet.
aws iam list-open-id-connect-providers --output text
aws iam list-roles --path-prefix /munaxa-docs/ --query 'Roles[].Arn' --output text
aws s3api list-buckets --query 'Buckets[].Name' --output text
aws kms list-aliases --query "Aliases[?starts_with(AliasName,'alias/munaxa')].AliasName" --output text
aws ec2 describe-vpcs --query 'Vpcs[].[VpcId,IsDefault,CidrBlock]' --output text
aws ec2 describe-nat-gateways --query 'NatGateways[?State==`available`].NatGatewayId' --output text
aws rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier' --output text
aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName' --output text
aws cloudtrail describe-trails --query 'trailList[].[Name,IsOrganizationTrail]' --output text

# 3.3 May roles in this account use the Budgets API? (read only)
aws budgets describe-budgets --account-id 657878534449 --output text >/dev/null \
  && echo "budgets: allowed → create_budget = true" \
  || echo "budgets: refused → create_budget = false (budget is then made from the management account)"

# 3.4 Your role ARN in this account (the state bucket's administrator)
ADMIN_ROLE=$(aws iam list-roles --path-prefix /aws-reserved/sso.amazonaws.com/ \
  --query "Roles[?starts_with(RoleName,'AWSReservedSSO_MunaxaAWSEngineeringAdmin_')].Arn" --output text)
echo "$ADMIN_ROLE"

# 3.5 Inputs (not committed). Set CREATE_BUDGET from 3.3 and your alert address.
CREATE_BUDGET=true
ALERT_EMAIL=aws-nonprod@munaxa.com      # the account's own mailbox; add more if wanted
cd ~/munaxa-docs/infra/terraform/bootstrap-eu-test
cat > terraform.tfvars <<EOF
state_admin_principal_arns = ["$ADMIN_ROLE"]
create_budget              = $CREATE_BUDGET
budget_alert_emails        = ["$ALERT_EMAIL"]
EOF

# 3.6 Local state for the plan: the state bucket does not exist yet, and nothing is written to AWS
mv backend.tf backend.tf.off
terraform init -input=false -lockfile=readonly

# 3.7 Plan A, the first step of the eventual apply: the state key and its alias only
terraform plan -input=false -lock=false -target=aws_kms_key.state -target=aws_kms_alias.state -out=key.tfplan
terraform show -json key.tfplan > ~/test-bootstrap-key-plan.json
~/munaxa-docs/scripts/ci/bootstrap-plan-check.sh testing-key ~/test-bootstrap-key-plan.json | tee ~/test-bootstrap-check.txt

# 3.8 Plan B, everything (preview)
terraform plan -input=false -lock=false -out=full.tfplan
terraform show -no-color full.tfplan > ~/test-bootstrap-plan.txt
terraform show -json full.tfplan > ~/test-bootstrap-plan.json
~/munaxa-docs/scripts/ci/bootstrap-plan-check.sh testing ~/test-bootstrap-plan.json | tee -a ~/test-bootstrap-check.txt

# 3.9 The trust policies, in full
jq '.resource_changes[] | select(.address=="module.testing_ci.aws_iam_role.ci") | .change.after.assume_role_policy | fromjson' ~/test-bootstrap-plan.json
jq '.resource_changes[] | select(.address=="aws_iam_role.deployer") | .change.after.assume_role_policy | fromjson' ~/test-bootstrap-plan.json

# 3.10 Clean up: back to the committed layout, nothing in AWS to undo
rm -f key.tfplan full.tfplan terraform.tfstate terraform.tfstate.backup terraform.tfvars
mv backend.tf.off backend.tf
```

**Expected result:**
- Plan A: `2 to add` (state key, alias), and `RESULT: PASS`.
- Plan B: `37 to add, 0 to change, 0 to destroy` (36 with `create_budget = false`), and `RESULT: PASS`.

In Plan B, the policies that name the state key show `(known after apply)`:
- `deployer-state`, `deployer-guardrails-environment` and `deployer-boundary`;
- this is only because the key does not exist yet.

That is why the eventual apply has two steps:
1. Apply Plan A (key and alias only).
2. Plan again. Every document is then visible in full, and the trust policies are complete in both plans.

| Group | Resources (all `create`) |
| --- | --- |
| State | `aws_kms_key.state`, `aws_kms_alias.state` (`alias/munaxa-docs-eu-test-tfstate`), `aws_s3_bucket.state` (`munaxa-docs-tfstate-eu-test-657878534449`) with ownership controls, public access block, versioning, SSE-KMS, lifecycle, bucket policy |
| GitHub OIDC | `module.testing_ci`: OIDC provider, `munaxa-docs-eu-test-ci` role (trusts `repo:munaxa/munaxa-docs:environment:testing` on `refs/heads/main` only), its inline policy, its boundary |
| TEST deployer | `aws_iam_role.deployer` (`munaxa-docs-eu-test-deployer`, trusts the Testing CI role with source identity `github-actions`, session `gha-run-*`), `aws_iam_policy.deployer_boundary`, `aws_iam_policy.workload_boundary`, ten `aws_iam_policy.deployer[…]` and their attachments (the nine shared documents plus `deployer-testing-session`) |
| Budget | `aws_budgets_budget.testing[0]` (`munaxa-docs-eu-test-account-monthly`, USD 15) unless `create_budget = false` |

Nothing application- or runtime-specific is created by the TEST bootstrap: no VPC, cluster, DNS
zone, certificate, database or load balancer. Those belong to `eu-test/foundation` and
`eu-test/session`, run later by GitHub Actions.

The deployer has ten managed policies attached, exactly the default IAM quota of ten per role.

Send `~/test-bootstrap-check.txt` (and `~/test-bootstrap-plan.txt` if asked).

## 4. If the TEST budget cannot be created inside 657878534449

`munaxa-nonprod` was created with IAM access to billing denied. If step 3.3 says "refused", the
budget is created from the management account instead. It is the same budget, filtered to the
linked account:
- name `munaxa-docs-eu-test-account-monthly`, cost, monthly, USD 15;
- filter Linked account = 657878534449;
- alerts at 50 % actual, 100 % actual and 100 % forecast.

This is a separate AWS write, and it needs approval like the others.
