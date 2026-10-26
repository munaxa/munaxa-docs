#!/usr/bin/env bash
# Tests for the Production Terraform plan-review gate:
#   - plan-summary.sh: counts, replacements, and never an attribute value;
#   - verify-saved-plan.sh: the reviewed plan is accepted; a missing, altered, expired, future,
#     or other-commit, other-root or other-run plan is refused, as is one not encrypted with the
#     state key itself;
#   - resolve-kms-key.sh: the state key's alias resolves to its key ARN; an AWS-managed,
#     disabled, foreign or unparsable answer is refused;
#   - check-workflow-policy.sh: the committed workflow passes; workflows that apply from the plan
#     job, plan in the apply job, skip verification, run off main, upload an artifact or lose the
#     approval are refused.
# Needs bash, jq, sha256sum, and PyYAML or mikefarah yq. Run from anywhere: bash scripts/terraform/tests/run.sh
# shellcheck disable=SC2016 # the single-quoted strings are jq programs and Markdown
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(cd "$here/.." && pwd)"
repo="$(cd "$scripts/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
pass() { echo "ok   $1"; passed=$((passed + 1)); }
fail() { echo "FAIL $1"; failed=$((failed + 1)); }
expect_success() { local name="$1"; shift; if "$@" > "$work/out" 2>&1; then pass "$name"; else fail "$name"; sed 's/^/     /' "$work/out"; fi; }
expect_failure() { local name="$1"; shift; if "$@" > "$work/out" 2>&1; then fail "$name (it succeeded)"; else pass "$name"; fi; }

# ---------------------------------------------------------------------------------------------
echo "== plan-summary.sh"

secret_value='hunter2-SECRET-do-not-print'
cat > "$work/plan.json" <<EOF
{
  "resource_changes": [
    {"address": "aws_lb.main", "change": {"actions": ["create"], "after": {"name": "alb"}}},
    {"address": "aws_secretsmanager_secret_version.app", "change": {"actions": ["create"],
      "after": {"secret_string": "$secret_value"}, "after_sensitive": {"secret_string": true}}},
    {"address": "aws_ecs_task_definition.api", "change": {"actions": ["update"],
      "before": {"container_definitions": "$secret_value"}, "after": {"container_definitions": "x"}}},
    {"address": "aws_lb_target_group.web", "change": {"actions": ["delete", "create"]}},
    {"address": "aws_lb_target_group.api", "change": {"actions": ["create", "delete"]}},
    {"address": "aws_cloudwatch_log_group.old", "change": {"actions": ["delete"]}},
    {"address": "data.aws_vpc.production", "change": {"actions": ["read"]}},
    {"address": "aws_ecs_cluster.main", "change": {"actions": ["no-op"]}}
  ]
}
EOF
"$scripts/plan-summary.sh" --counts "$work/plan.json" > "$work/counts"
expect_success "counts: 2 add, 1 change, 2 replace, 1 destroy" \
  diff <(printf 'add=2\nchange=1\nreplace=2\ndestroy=1\nother=0\n') "$work/counts"
"$scripts/plan-summary.sh" "$work/plan.json" > "$work/summary.md"
expect_success "summary states the counts" \
  grep -qx '\*\*Plan:\*\* 2 to add, 1 to change, 2 to replace, 1 to destroy.' "$work/summary.md"
expect_success "summary lists a replacement as replace" grep -q '| replace | `aws_lb_target_group.web` |' "$work/summary.md"
expect_failure "summary omits reads and no-ops" grep -qE 'data.aws_vpc|aws_ecs_cluster.main' "$work/summary.md"
expect_failure "summary never prints an attribute value" grep -q "$secret_value" "$work/summary.md"
expect_failure "counts never print an attribute value" grep -q "$secret_value" "$work/counts"
echo '{"resource_changes": []}' > "$work/empty.json"
expect_success "an empty plan reads No changes" grep -qx 'No changes.' <("$scripts/plan-summary.sh" "$work/empty.json")
expect_failure "a missing plan file is an error" "$scripts/plan-summary.sh" "$work/missing.json"

# ---------------------------------------------------------------------------------------------
echo "== verify-saved-plan.sh"

printf 'saved plan bytes\n' > "$work/tfplan"
sha="$(sha256sum "$work/tfplan" | cut -d' ' -f1)"
commit="3095f82bf5d89b297d4ada79585b62065459a2f5"
now=2000000000
state_key_id="1234abcd-12ab-34cd-56ef-1234567890ab"
state_key="arn:aws:kms:eu-central-1:229251310592:key/$state_key_id"
other_key="arn:aws:kms:eu-central-1:229251310592:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
state_alias="arn:aws:kms:eu-central-1:229251310592:alias/munaxa-docs-eu-prod-tfstate"
base_env=(
  PLAN_FILE="$work/tfplan" EXPECTED_SHA256="$sha" EXPECTED_COMMIT="$commit" EXPECTED_ROOT=service
  PLAN_CREATED_AT=$((now - 600)) CURRENT_COMMIT="$commit" CURRENT_ROOT=service CURRENT_RUN_ID=42
  META_SHA256="$sha" META_COMMIT="$commit" META_ROOT=service META_RUN_ID=42
  MAX_PLAN_AGE_SECONDS=14400 "NOW=$now"
  ENCRYPTION=aws:kms ACTUAL_KMS_KEY_ID="$state_key" EXPECTED_KMS_KEY_ARN="$state_key"
)
verify() { env -i PATH="$PATH" "${base_env[@]}" "$@" "$scripts/verify-saved-plan.sh"; }

expect_success "the reviewed plan is accepted" verify
expect_failure "a missing plan file is refused" verify PLAN_FILE="$work/nothing"
: > "$work/empty-plan"
expect_failure "an empty plan file is refused" verify PLAN_FILE="$work/empty-plan"
cp "$work/tfplan" "$work/altered"
printf 'x' >> "$work/altered"
expect_failure "an altered plan is refused" verify PLAN_FILE="$work/altered"
expect_failure "a plan whose stored hash differs is refused" verify META_SHA256="$(printf '0%.0s' {1..64})"
expect_failure "a missing reviewed hash is refused" verify EXPECTED_SHA256=
expect_failure "a malformed reviewed hash is refused" verify EXPECTED_SHA256=abc
expect_failure "a plan older than the limit is refused" verify PLAN_CREATED_AT=$((now - 14401))
expect_success "a plan at the limit is accepted" verify PLAN_CREATED_AT=$((now - 14400))
expect_failure "a plan from the future is refused" verify PLAN_CREATED_AT=$((now + 3600))
expect_failure "a plan from another commit is refused" verify CURRENT_COMMIT="$(printf 'a%.0s' {1..40})"
expect_failure "a plan whose stored commit differs is refused" verify META_COMMIT="$(printf 'b%.0s' {1..40})"
expect_failure "a plan for another root is refused" verify CURRENT_ROOT=core
expect_failure "a plan whose stored root differs is refused" verify META_ROOT=data
expect_failure "a plan stored by another run is refused" verify META_RUN_ID=41
expect_failure "missing metadata is refused" verify META_RUN_ID=

# The KMS key the plan is encrypted with must be the state key itself.
expect_success "a plan encrypted with the expected state key is accepted" verify
expect_success "S3 reporting the same key as a bare key ID is accepted" verify ACTUAL_KMS_KEY_ID="$state_key_id"
expect_failure "a plan encrypted with a different key is refused" verify ACTUAL_KMS_KEY_ID="$other_key"
expect_failure "a different bare key ID is refused" verify ACTUAL_KMS_KEY_ID="${other_key##*/}"
expect_failure "the same key ID in another account is refused" \
  verify ACTUAL_KMS_KEY_ID="arn:aws:kms:eu-central-1:111122223333:key/$state_key_id"
expect_failure "the same key ID in another region is refused" \
  verify ACTUAL_KMS_KEY_ID="arn:aws:kms:eu-west-1:229251310592:key/$state_key_id"
expect_failure "a missing reported key is refused" verify ACTUAL_KMS_KEY_ID=
expect_failure "a missing expected key is refused" verify EXPECTED_KMS_KEY_ARN=
expect_failure "an unresolved alias as the expected key is refused" verify EXPECTED_KMS_KEY_ARN="$state_alias"
expect_failure "an alias reported by S3 is refused" verify ACTUAL_KMS_KEY_ID="$state_alias"
expect_failure "the AWS-managed S3 key alias is refused" verify ACTUAL_KMS_KEY_ID="alias/aws/s3"
expect_failure "SSE-S3 instead of SSE-KMS is refused" verify ENCRYPTION=AES256
expect_failure "missing encryption information is refused" verify ENCRYPTION=

# ---------------------------------------------------------------------------------------------
echo "== resolve-kms-key.sh"

describe() { # arn manager state
  jq -n --arg arn "$1" --arg m "$2" --arg s "$3" '{KeyMetadata: {Arn: $arn, KeyManager: $m, KeyState: $s}}'
}
resolve() { EXPECTED_ACCOUNT=229251310592 EXPECTED_REGION=eu-central-1 "$scripts/resolve-kms-key.sh"; }

describe "$state_key" CUSTOMER Enabled > "$work/describe.json"
expect_success "the alias resolves to the state key ARN" \
  diff <(echo "$state_key") <(resolve < "$work/describe.json")
expect_success "a resolved key passes the plan verification" \
  verify EXPECTED_KMS_KEY_ARN="$(resolve < "$work/describe.json")"
expect_failure "an AWS-managed key is refused" resolve < <(describe "$state_key" AWS Enabled)
expect_failure "a disabled key is refused" resolve < <(describe "$state_key" CUSTOMER Disabled)
expect_failure "a key pending deletion is refused" resolve < <(describe "$state_key" CUSTOMER PendingDeletion)
expect_failure "a key in another account is refused" \
  resolve < <(describe "arn:aws:kms:eu-central-1:111122223333:key/$state_key_id" CUSTOMER Enabled)
expect_failure "a key in another region is refused" \
  resolve < <(describe "arn:aws:kms:eu-west-1:229251310592:key/$state_key_id" CUSTOMER Enabled)
expect_failure "an alias ARN in place of a key ARN is refused" resolve < <(describe "$state_alias" CUSTOMER Enabled)
expect_failure "a describe-key answer without a key is refused" resolve < <(echo '{"KeyMetadata": {}}')
expect_failure "an empty describe-key answer is refused" resolve < /dev/null
expect_failure "an unparsable describe-key answer is refused" resolve < <(echo 'AccessDenied')

# ---------------------------------------------------------------------------------------------
echo "== check-workflow-policy.sh"

workflow="$repo/.github/workflows/terraform-eu-prod.yml"
expect_success "the committed workflow passes" "$scripts/check-workflow-policy.sh" "$workflow"

# Each mutation below breaks one safety property; the policy must refuse every one.
if python3 -c 'import yaml' 2>/dev/null; then
  python3 -c 'import json, sys, yaml; json.dump(yaml.safe_load(open(sys.argv[1])), sys.stdout)' "$workflow" > "$work/workflow.json"
else
  yq -o=json '.' "$workflow" > "$work/workflow.json"
fi
mutated() { jq "$1" "$work/workflow.json" > "$work/mutated.json" && "$scripts/check-workflow-policy.sh" --json "$work/mutated.json"; }

expect_failure "refuses: the plan job applies" \
  mutated '.jobs.plan.steps += [{"run": "terraform apply -lock-timeout=5m tfplan"}]'
expect_failure "refuses: the apply job re-plans" \
  mutated '.jobs.apply.steps |= [{"run": "terraform plan -out=tfplan"}] + .'
expect_failure "refuses: the apply job runs for action plan" \
  mutated '.jobs.apply.if = "github.ref == '"'"'refs/heads/main'"'"' && needs.plan.outputs.changes == '"'"'true'"'"'"'
expect_failure "refuses: the apply job runs without the plan job" \
  mutated '.jobs.apply.needs = ["preflight"]'
expect_failure "refuses: the apply job has no protected environment" \
  mutated 'del(.jobs.apply.environment)'
expect_failure "refuses: the apply job skips verification" \
  mutated '.jobs.apply.steps |= map(select((.run // "") | contains("verify-saved-plan.sh") | not))'
expect_failure "refuses: verification after the apply" \
  mutated '.jobs.apply.steps |= ([.[] | select((.run // "") | contains("verify-saved-plan.sh") | not)] + [.[] | select((.run // "") | contains("verify-saved-plan.sh"))])'
expect_failure "refuses: apply with -auto-approve" \
  mutated '(.jobs.apply.steps[] | select((.run // "") | test("terraform apply")) | .run) = "terraform apply -auto-approve"'
expect_failure "refuses: a second terraform apply" \
  mutated '.jobs.apply.steps += [{"run": "terraform apply tfplan"}]'
expect_failure "refuses: the plan is not discarded" \
  mutated '.jobs.apply.steps |= map(select((.run // "") | contains("delete-object") | not))'
expect_failure "refuses: an uploaded artifact" \
  mutated '.jobs.plan.steps += [{"uses": "actions/upload-artifact@v4", "with": {"path": "tfplan"}}]'
expect_failure "refuses: a branch other than main" \
  mutated '(.jobs.preflight.steps[0].run) |= gsub("refs/heads/main"; "refs/heads/release")'
expect_failure "refuses: a pull_request trigger" \
  mutated 'if has("on") then .on.pull_request = {} else .["true"].pull_request = {} end'
expect_failure "refuses: a plan run that keeps a plan" \
  mutated '(.jobs.plan.steps[] | select(.id == "keep") | .if) = "steps.plan.outputs.changes == '"'"'true'"'"'"'
expect_failure "refuses: a floating Terraform version" mutated '.env.TERRAFORM_VERSION = "latest"'
expect_failure "refuses: a cancellable run" mutated '.concurrency["cancel-in-progress"] = true'
expect_failure "refuses: verification without the expected key" \
  mutated '(.jobs.apply.steps[] | select((.run // "") | contains("verify-saved-plan.sh")) | .env) |= del(.EXPECTED_KMS_KEY_ARN)'
expect_failure "refuses: verification without the key S3 reports" \
  mutated '(.jobs.apply.steps[] | select((.run // "") | contains("verify-saved-plan.sh")) | .env) |= del(.ACTUAL_KMS_KEY_ID)'
expect_failure "refuses: the expected key taken from the alias string" \
  mutated '(.jobs.apply.steps[] | select((.run // "") | contains("verify-saved-plan.sh")) | .env.EXPECTED_KMS_KEY_ARN) = "${{ env.STATE_KEY_ALIAS_ARN }}"'
expect_failure "refuses: the key not resolved by KMS" \
  mutated '(.jobs.apply.steps[] | select(.id == "fetch") | .run) |= gsub("aws kms describe-key"; "echo")'

# ---------------------------------------------------------------------------------------------
echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
