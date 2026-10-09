#!/usr/bin/env bash
# PLAN ONLY: the TEST bootstrap (infra/terraform/bootstrap-eu-test, account 657878534449).
#
# Run by admin.tamer in AWS CloudShell of the management account (eu-central-1), from the
# repository root, after scripts/bootstrap/install-terraform.sh. It reaches the TEST account the
# administrator way: admin.tamer assumes OrganizationAccountAccessRole in 657878534449 (the role
# AWS Organizations created with the account; the MunaxaNonProductionBaseline SCP prevents anyone
# in that account from changing it). The role is configured in a private, temporary AWS config
# file; ~/.aws is not touched and no credential is ever printed or typed.
#
# Never applies anything. The state bucket does not exist yet, so the plan uses a temporary local
# state in a scratch copy of the root: nothing is written to AWS, not even a lock.
#
# Two plans, each checked (scripts/ci/bootstrap-plan-check.sh):
#   A  the first apply step: the state key and its alias only           → testing-key
#   B  everything, as a preview                                          → testing
# In B the three deployer documents that name the state key are "known after apply" because the
# key does not exist yet; after step A is applied, the same plan shows every document in full and
# the checker then requires that.
#
#   ALERT_EMAIL=<address> bash scripts/bootstrap/plan-testing.sh
#
# Writes to $HOME only: test-bootstrap-*.txt / .json. None of them holds a secret value.
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

# 1. Who is asking: admin.tamer, in the management account, and nobody else
unset AWS_PROFILE
base=$(aws sts get-caller-identity --query Arn --output text)
[ "$base" = "$ADMIN_ARN" ] || stop "signed in as $base; the TEST bootstrap is planned by $ADMIN_ARN only"

# 2. Into the TEST account through OrganizationAccountAccessRole (temporary config, 1 hour)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/aws-config" <<EOF
[profile test-bootstrap]
role_arn = ${ROLE_ARN}
credential_source = EcsContainer
role_session_name = admin.tamer-bootstrap-eu-test
duration_seconds = 3600
region = eu-central-1
EOF
export AWS_CONFIG_FILE="$work/aws-config" AWS_PROFILE=test-bootstrap
read -r account arn < <(aws sts get-caller-identity --query '[Account,Arn]' --output text)
[ "$account" = "$ACCOUNT" ] || stop "this is account $account, not $ACCOUNT"
case "$arn" in
  "arn:aws:sts::${ACCOUNT}:assumed-role/OrganizationAccountAccessRole/admin.tamer-bootstrap-eu-test") ;;
  *) stop "unexpected identity $arn" ;;
esac
region=$(aws ec2 describe-availability-zones --query 'AvailabilityZones[0].RegionName' --output text)
[ "$region" = eu-central-1 ] || stop "region is $region, not eu-central-1"
echo "identity:  $arn ($account, $region)"

# 3. What the account holds today (read only). Expected: no Munaxa resource yet.
inventory() {
  echo "OIDC providers:      $(aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text)"
  echo "roles /munaxa-docs/: $(aws iam list-roles --path-prefix /munaxa-docs/ --query 'Roles[].RoleName' --output text)"
  echo "buckets:             $(aws s3api list-buckets --query 'Buckets[].Name' --output text)"
  echo "KMS aliases munaxa:  $(aws kms list-aliases --query "Aliases[?starts_with(AliasName,'alias/munaxa')].AliasName" --output text)"
  echo "VPCs:                $(aws ec2 describe-vpcs --query 'Vpcs[].[VpcId,IsDefault]' --output text | tr '\n' ' ')"
  echo "NAT gateways:        $(aws ec2 describe-nat-gateways --query 'NatGateways[?State==`available`].NatGatewayId' --output text)"
  echo "RDS:                 $(aws rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier' --output text)"
  echo "load balancers:      $(aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName' --output text)"
  echo "ECS clusters:        $(aws ecs list-clusters --query 'clusterArns' --output text)"
  echo "CloudTrail trails:   $(aws cloudtrail describe-trails --query 'trailList[].[Name,IsOrganizationTrail]' --output text | tr '\n' ' ')"
}
inventory | tee "$HOME/test-bootstrap-inventory.txt"

# 4. May roles in this account use the Budgets API? (The account was created with IAM access to
#    billing denied.) Read only.
if aws budgets describe-budgets --account-id "$ACCOUNT" >/dev/null 2>&1; then
  create_budget=true
  : "${ALERT_EMAIL:?set ALERT_EMAIL=<address for TEST budget alerts> and run again}"
  emails="[\"${ALERT_EMAIL}\"]"
  echo "budgets:   allowed in this account → the budget is part of this plan"
else
  create_budget=false
  emails="[]"
  echo "budgets:   refused in this account → create_budget = false; the TEST budget is made from the management account instead"
fi

# 5. A scratch copy of the root with no backend (the state bucket does not exist yet)
mkdir -p "$work/terraform"
cp -R infra/terraform/bootstrap-eu-test infra/terraform/modules "$work/terraform/"
rm -rf "$work/terraform/bootstrap-eu-test/.terraform" "$work/terraform/bootstrap-eu-test/backend.tf" \
       "$work/terraform/bootstrap-eu-test/terraform.tfvars" "$work/terraform/bootstrap-eu-test"/*.tfstate*
cd "$work/terraform/bootstrap-eu-test"
export TF_IN_AUTOMATION=1 TF_INPUT=0
vars=(
  "-var=state_admin_principal_arns=[\"${ROLE_ARN}\"]"
  "-var=create_budget=${create_budget}"
  "-var=budget_alert_emails=${emails}"
)
terraform init -input=false -lockfile=readonly >/dev/null

# 6. Plan A (first apply step) and plan B (everything)
terraform plan -input=false -lock=false "${vars[@]}" -target=aws_kms_key.state -target=aws_kms_alias.state -out="$work/key.tfplan"
terraform show -json "$work/key.tfplan" > "$HOME/test-bootstrap-key-plan.json"
terraform plan -input=false -lock=false "${vars[@]}" -out="$work/full.tfplan"
terraform show -no-color "$work/full.tfplan" > "$HOME/test-bootstrap-plan.txt"
terraform show -json "$work/full.tfplan" > "$HOME/test-bootstrap-plan.json"
cd "$repo"

# 7. The trust policies, the CI role's only permission and the state key policy, in full
show() { # <file> <address> <attribute>
  echo "--- $2 ($3)"
  jq --arg a "$2" --arg k "$3" '.resource_changes[] | select(.address == $a) | .change.after[$k] | fromjson' "$1"
}
show "$HOME/test-bootstrap-key-plan.json" aws_kms_key.state policy
show "$HOME/test-bootstrap-plan.json" module.testing_ci.aws_iam_role.ci assume_role_policy
show "$HOME/test-bootstrap-plan.json" module.testing_ci.aws_iam_role_policy.ci policy
show "$HOME/test-bootstrap-plan.json" aws_iam_role.deployer assume_role_policy

# 8. Verdicts
echo
rc=0
{
  echo "== plan A (state key)"
  scripts/ci/bootstrap-plan-check.sh testing-key "$HOME/test-bootstrap-key-plan.json" || rc=1
  echo "== plan B (everything)"
  scripts/ci/bootstrap-plan-check.sh testing "$HOME/test-bootstrap-plan.json" || rc=1
  [ "$rc" = 0 ] && echo "OVERALL: PASS" || echo "OVERALL: STOP. Do not apply; send test-bootstrap-check.txt for review."
} 2>&1 | tee "$HOME/test-bootstrap-check.txt"
grep -q '^OVERALL: PASS$' "$HOME/test-bootstrap-check.txt"
