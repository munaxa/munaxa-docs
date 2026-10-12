#!/usr/bin/env bash
# Checks a saved bootstrap plan (`terraform show -json`) against the agreed change set, so the
# administrator running the plan-only runbook (docs/operations/bootstrap-plan-runbooks.md) gets a
# plain PASS or STOP instead of reading every line. Read-only: it never calls AWS or Terraform.
#
#   bootstrap-plan-check.sh production <plan.json>
#       infra/terraform/bootstrap in 800728620253. Exactly:
#         create  module.production_ci: OIDC provider, CI role, CI inline policy, CI boundary
#         update  aws_iam_role.deployer, its trust policy only, keeping every existing statement
#                 and adding GitHubActionsSessions and GitHubActionsSourceIdentity
#       Nothing else may change: no policy, boundary, bucket, key, trail or budget.
#   bootstrap-plan-check.sh production-budget <plan.json>
#       infra/terraform/bootstrap, a later, separate change: only the alert recipients of the
#       Production budget (aws_budgets_budget.production, notification blocks) may change.
#   bootstrap-plan-check.sh testing-key <plan.json>
#       infra/terraform/bootstrap-eu-test, first step: the state key and its alias only.
#   bootstrap-plan-check.sh testing <plan.json>
#       infra/terraform/bootstrap-eu-test, full: creates only, and only the TEST bootstrap set
#       (state bucket and key, OIDC provider, Testing CI role, TEST deployer, its policies and
#       boundaries, optionally the budget). Nothing application- or runtime-specific.
#
# In every mode, the trust policies of the CI role and the deployer must be fully known in the
# plan (no "known after apply"). Prints addresses and actions only, never attribute values.
set -euo pipefail
mode="${1:?mode}"; plan="${2:?plan.json}"

changes=$(jq -r '.resource_changes[]? | select(.change.actions != ["no-op"] and .change.actions != ["read"]) | "\(.change.actions | join(",")) \(.address)"' "$plan")
echo "${changes:-no changes}"
echo "--"

fail=0
stop() { echo "STOP: $*"; fail=1; }

# expected_set <"action address" lines>: the plan's change list must be exactly these lines.
expected_set() {
  local want got
  want=$(printf '%s\n' "$@" | sort)
  got=$(printf '%s\n' "$changes" | sed '/^$/d' | sort)
  if [ "$want" != "$got" ]; then
    stop "the plan's changes differ from the agreed set"
    { diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") || true; } | sed -n 's/^< /  missing:    /p; s/^> /  unexpected: /p'
  fi
}

# known_trust <address>: the resource's assume_role_policy must be known at plan time.
known_trust() {
  local unknown
  unknown=$(jq -r --arg a "$1" '.resource_changes[]? | select(.address == $a) | .change.after_unknown.assume_role_policy // false' "$plan")
  [ -z "$unknown" ] && return 0   # not in the plan at all: already reported by expected_set
  [ "$unknown" = false ] || stop "$1 has a trust policy that is only known after apply"
}

testing_policies=(
  deployer-read deployer-state deployer-testing-session deployer-testing-compute
  deployer-testing-data deployer-testing-iam deployer-testing-foundation-guard
  deployer-guardrails-environment deployer-guardrails-identity
)

case "$mode" in
  production)
    expected_set \
      "create module.production_ci.aws_iam_openid_connect_provider.github" \
      "create module.production_ci.aws_iam_policy.boundary" \
      "create module.production_ci.aws_iam_role.ci" \
      "create module.production_ci.aws_iam_role_policy.ci" \
      "update aws_iam_role.deployer"
    known_trust module.production_ci.aws_iam_role.ci
    known_trust aws_iam_role.deployer
    # The deployer update may change its trust policy and nothing else.
    other=$(jq -r '
      .resource_changes[]? | select(.address == "aws_iam_role.deployer")
      | (.change.before // {}) as $b | (.change.after // {}) as $a
      | [$b | keys[] | select(. != "assume_role_policy" and . != "tags_all" and . != "tags")
         | select($b[.] != $a[.])] | join(",")' "$plan")
    [ -z "$other" ] || stop "aws_iam_role.deployer would change more than its trust policy: $other"
    sids=$(jq -r '.resource_changes[]? | select(.address == "aws_iam_role.deployer")
      | [((.change.before.assume_role_policy // "{\"Statement\":[]}") | fromjson | (.Statement // [])[].Sid), "→",
         ((.change.after.assume_role_policy // "{\"Statement\":[]}") | fromjson | (.Statement // [])[].Sid)] | join(" ")' "$plan")
    echo "deployer trust statements: $sids"
    for sid in ClaudeAgentSessions ClaudeAgentSourceIdentity HumanBreakGlass EngineeringRoleSessions \
               EngineeringRoleSourceIdentity GitHubActionsSessions GitHubActionsSourceIdentity; do
      jq -e --arg s "$sid" '.resource_changes[]? | select(.address == "aws_iam_role.deployer")
        | (.change.after.assume_role_policy // "{\"Statement\":[]}") | fromjson | any((.Statement // [])[]; .Sid == $s)' "$plan" >/dev/null \
        || stop "the new deployer trust has no $sid statement"
    done
    ;;
  production-budget)
    expected_set "update aws_budgets_budget.production"
    other=$(jq -r '
      .resource_changes[]? | select(.address == "aws_budgets_budget.production")
      | (.change.before // {}) as $b | (.change.after // {}) as $a
      | [$b | keys[] | select(. != "notification" and . != "tags_all" and . != "tags") | select($b[.] != $a[.])] | join(",")' "$plan")
    [ -z "$other" ] || stop "the budget would change more than its alert recipients: $other"
    ;;
  testing-key)
    expected_set "create aws_kms_key.state" "create aws_kms_alias.state"
    # Step A grants nothing new: the key policy is known in full and names the account root only
    # (IAM in this account decides who may use the key), and no IAM resource is in the plan.
    jq -e '.resource_changes[]? | select(.address == "aws_kms_key.state")
      | (.change.after_unknown.policy // false) == false
        and ((.change.after.policy // "{}") | fromjson | [.Statement[].Principal.AWS] | unique == ["arn:aws:iam::657878534449:root"])' \
      "$plan" >/dev/null || stop "the state key policy is not exactly 'account 657878534449 root' or is not known at plan time"
    ;;
  testing)
    want=(
      "create aws_s3_bucket.state"
      "create aws_s3_bucket_ownership_controls.state"
      "create aws_s3_bucket_public_access_block.state"
      "create aws_s3_bucket_versioning.state"
      "create aws_s3_bucket_server_side_encryption_configuration.state"
      "create aws_s3_bucket_lifecycle_configuration.state"
      "create aws_s3_bucket_policy.state"
      "create module.testing_ci.aws_iam_openid_connect_provider.github"
      "create module.testing_ci.aws_iam_policy.boundary"
      "create module.testing_ci.aws_iam_role.ci"
      "create module.testing_ci.aws_iam_role_policy.ci"
      "create aws_iam_policy.deployer_boundary"
      "create aws_iam_policy.workload_boundary"
      "create aws_iam_role.deployer"
    )
    for p in "${testing_policies[@]}"; do
      want+=("create aws_iam_policy.deployer[\"$p\"]" "create aws_iam_role_policy_attachment.deployer[\"$p\"]")
    done
    # The key and alias are already created by the first step, or are part of this plan.
    if grep -qx 'create aws_kms_key.state' <<<"$changes"; then
      want+=("create aws_kms_key.state" "create aws_kms_alias.state")
      echo "note: preview only. The state key does not exist yet, so the documents that name it"
      echo "      (deployer-state, deployer-guardrails-environment, deployer-boundary) are known after apply."
      echo "      After step A is applied, this plan must show every document in full."
    else
      # Step B for real: the key exists, so every policy document must be fully visible now.
      hidden=$(jq -r '.resource_changes[]? | select(.type == "aws_iam_policy" or .type == "aws_iam_role_policy")
        | select(.change.after_unknown.policy == true) | .address' "$plan")
      [ -z "$hidden" ] || stop "policy documents still known only after apply: $(echo "$hidden" | tr '\n' ' ')"
    fi
    if grep -qx 'create aws_budgets_budget.testing\[0\]' <<<"$changes"; then
      want+=("create aws_budgets_budget.testing[0]")
    else
      echo "note: no budget in this plan (create_budget = false); create it from the management account."
    fi
    expected_set "${want[@]}"
    known_trust module.testing_ci.aws_iam_role.ci
    known_trust aws_iam_role.deployer
    ;;
  *)
    echo "usage: $0 production|production-budget|testing-key|testing <plan.json>" >&2
    exit 2
    ;;
esac

if [ "$fail" -ne 0 ]; then
  echo "RESULT: STOP. Do not apply; send this output for review."
  exit 1
fi
echo "RESULT: PASS. The plan contains exactly the agreed changes."
