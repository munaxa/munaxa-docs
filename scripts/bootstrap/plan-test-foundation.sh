#!/usr/bin/env bash
# PLAN ONLY: the persistent TEST foundation (infra/terraform/eu-test/foundation, account 657878534449).
#
# The foundation is administrator-controlled like the bootstrap: the TEST deployer can only build
# and destroy TEST sessions and is denied every change to it. Run by admin.tamer in AWS CloudShell of
# the management account, from the repository root, AFTER the TEST bootstrap has been applied (the
# state bucket must exist). Reaches 657878534449 through OrganizationAccountAccessRole in a private,
# temporary AWS config file. Never applies; -lock=false, so not even a lock file is written.
#
#   bash scripts/bootstrap/plan-test-foundation.sh
#
# Writes to $HOME only: test-foundation-plan.txt / .json and test-foundation-check.txt.
set -euo pipefail

ACCOUNT=657878534449
ADMIN_ARN="arn:aws:iam::800728620253:user/admin.tamer"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/OrganizationAccountAccessRole"
export AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1
stop() { echo "STOP: $*"; exit 1; }

repo=$(git rev-parse --show-toplevel 2>/dev/null) || stop "run this from the munaxa-docs checkout"
cd "$repo"
echo "commit:    $(git rev-parse HEAD)"
[ "$(terraform version -json | jq -r .terraform_version)" = 1.16.5 ] \
  || stop "terraform 1.16.5 is not first on PATH (run scripts/bootstrap/install-terraform.sh)"

unset AWS_PROFILE
base=$(aws sts get-caller-identity --query Arn --output text)
[ "$base" = "$ADMIN_ARN" ] || stop "signed in as $base; the TEST foundation is planned by $ADMIN_ARN only"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/aws-config" <<EOF
[profile test-foundation]
role_arn = ${ROLE_ARN}
credential_source = EcsContainer
role_session_name = admin.tamer-foundation-eu-test
duration_seconds = 3600
region = eu-central-1
EOF
export AWS_CONFIG_FILE="$work/aws-config" AWS_PROFILE=test-foundation
read -r account arn < <(aws sts get-caller-identity --query '[Account,Arn]' --output text)
[ "$account" = "$ACCOUNT" ] || stop "this is account $account, not $ACCOUNT"
[ "$arn" = "arn:aws:sts::${ACCOUNT}:assumed-role/OrganizationAccountAccessRole/admin.tamer-foundation-eu-test" ] \
  || stop "unexpected identity $arn"
echo "identity:  $arn"

export TF_DATA_DIR="$work/.terraform" TF_IN_AUTOMATION=1 TF_INPUT=0
cd infra/terraform/eu-test/foundation
terraform init -input=false -lockfile=readonly >/dev/null
terraform plan -input=false -lock=false -out="$work/plan"
terraform show -no-color "$work/plan" > "$HOME/test-foundation-plan.txt"
terraform show -json "$work/plan" > "$HOME/test-foundation-plan.json"
cd "$repo"

# Everything in the foundation is persistent: plan-guard foundation refuses any delete or replace.
scripts/ci/plan-guard.sh foundation "$HOME/test-foundation-plan.json" 2>&1 | tee "$HOME/test-foundation-check.txt"
