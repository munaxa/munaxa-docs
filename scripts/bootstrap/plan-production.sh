#!/usr/bin/env bash
# PLAN ONLY: the Production bootstrap (infra/terraform/bootstrap, account 800728620253).
#
# Run by admin.tamer in AWS CloudShell (eu-central-1), from the repository root, after
# scripts/bootstrap/install-terraform.sh. Never applies, imports or unlocks anything: Terraform
# reads the existing state and AWS with -lock=false, so not even a lock file is written. Ends
# with the checker's PASS or STOP (scripts/ci/bootstrap-plan-check.sh production).
#
# Writes to $HOME only: production-bootstrap-plan.txt, -plan.json, -check.txt. None of them holds a
# secret value.
set -euo pipefail

ACCOUNT=800728620253
ADMIN_ARN="arn:aws:iam::${ACCOUNT}:user/admin.tamer"
export AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1
stop() { echo "STOP: $*"; exit 1; }

repo=$(git rev-parse --show-toplevel 2>/dev/null) || stop "run this from the munaxa-docs checkout"
cd "$repo"
echo "commit:    $(git rev-parse HEAD)"

# 1. Who, where, which Terraform
read -r account arn < <(aws sts get-caller-identity --query '[Account,Arn]' --output text)
[ "$account" = "$ACCOUNT" ] || stop "this is account $account, not $ACCOUNT"
[ "$arn" = "$ADMIN_ARN" ] || stop "signed in as $arn; the Production bootstrap is planned by $ADMIN_ARN only"
region=$(aws ec2 describe-availability-zones --query 'AvailabilityZones[0].RegionName' --output text)
[ "$region" = eu-central-1 ] || stop "region is $region, not eu-central-1"
[ "$(terraform version -json | jq -r .terraform_version)" = 1.16.5 ] \
  || stop "terraform 1.16.5 is not first on PATH (run scripts/bootstrap/install-terraform.sh)"
echo "identity:  $arn ($account, $region)"

# 2. Today, read only: no GitHub OIDC provider and no CI role yet
echo "OIDC providers today: $(aws iam list-open-id-connect-providers --query 'length(OpenIDConnectProviderList)' --output text)"
if aws iam get-role --role-name munaxa-docs-eu-prod-ci >/dev/null 2>&1; then
  echo "note: munaxa-docs-eu-prod-ci already exists; the checker decides whether the plan is still right"
fi

# 3. Plan. budget_alert_emails is the value the live budget has, so the budget shows no change
#    (replacing that address is a separate, approved change; see ci-cd-two-environments.md §12).
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export TF_DATA_DIR="$work/.terraform" TF_IN_AUTOMATION=1 TF_INPUT=0
cd infra/terraform/bootstrap
terraform init -input=false -lockfile=readonly >/dev/null
terraform plan -input=false -lock=false -out="$work/plan" -var='budget_alert_emails=["alerts@example.com"]'
terraform show -no-color "$work/plan" > "$HOME/production-bootstrap-plan.txt"
terraform show -json "$work/plan" > "$HOME/production-bootstrap-plan.json"
cd "$repo"

# 4. The trust policies and the CI role's only permission, in full
show() { # <address> <attribute>
  echo "--- $1 ($2)"
  jq --arg a "$1" --arg k "$2" '.resource_changes[] | select(.address == $a) | .change.after[$k] | fromjson' \
    "$HOME/production-bootstrap-plan.json"
}
show module.production_ci.aws_iam_role.ci assume_role_policy
show module.production_ci.aws_iam_role_policy.ci policy
show aws_iam_role.deployer assume_role_policy

# 5. Verdict
echo
scripts/ci/bootstrap-plan-check.sh production "$HOME/production-bootstrap-plan.json" | tee "$HOME/production-bootstrap-check.txt"
