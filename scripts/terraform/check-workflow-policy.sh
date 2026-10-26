#!/usr/bin/env bash
# Checks that .github/workflows/terraform-eu-prod.yml keeps its Production safety properties.
#
#   check-workflow-policy.sh [workflow.yml]   reads the workflow
#   check-workflow-policy.sh --json file.json reads the workflow already converted to JSON (tests)
#
# The properties, each enforced below:
#   - manual dispatch only, a fixed list of roots, and plan or apply as the only actions;
#   - no default permissions, and runs of one root never overlap or cancel each other;
#   - an exact Terraform version and the committed provider lock file;
#   - the preflight job holds nothing and refuses any branch but main;
#   - the plan job saves its plan and never applies; nothing uploads a workflow artifact;
#   - the apply job runs only for action apply on main, after the plan job, in the protected
#     environment; it never plans; it verifies the kept plan, including the KMS key it is
#     encrypted with, before the one `terraform apply`,
#     which applies that saved file; and it discards the plan whatever the result.
# shellcheck disable=SC2016 # the single-quoted strings are jq programs, not shell
set -euo pipefail

if [ "${1:-}" = "--json" ]; then
  json="$(cat "${2:?usage: check-workflow-policy.sh --json <file.json>}")"
else
  workflow="${1:-.github/workflows/terraform-eu-prod.yml}"
  if python3 -c 'import yaml' 2>/dev/null; then
    json="$(python3 -c 'import json, sys, yaml; json.dump(yaml.safe_load(open(sys.argv[1])), sys.stdout)' "$workflow")"
  elif yq --version 2>/dev/null | grep -q mikefarah; then
    json="$(yq -o=json '.' "$workflow")"
  else
    echo "check-workflow-policy: needs PyYAML or mikefarah yq to read YAML" >&2
    exit 2
  fi
fi

failures=0
check() {
  local description="$1" filter="$2"
  # A filter that errors (a missing job or key) counts as a failure: the check fails closed.
  if [ "$(jq -r "$filter" <<<"$json" 2>/dev/null)" = "true" ]; then
    echo "ok   $description"
  else
    echo "FAIL $description"
    failures=$((failures + 1))
  fi
}

# PyYAML reads the bare key `on` as the boolean true (YAML 1.1); yq keeps "on".
triggers='(.on // .["true"])'
runs='[.steps[]?.run // empty] | join("\n")'

check "only manual dispatch starts the workflow" \
  "($triggers | keys) == [\"workflow_dispatch\"]"
check "roots are exactly core, data and service" \
  "$triggers.workflow_dispatch.inputs.root.options == [\"core\", \"data\", \"service\"]"
check "actions are exactly plan and apply, plan by default" \
  "($triggers.workflow_dispatch.inputs.action.options == [\"plan\", \"apply\"]) and ($triggers.workflow_dispatch.inputs.action.default == \"plan\")"
check "no default permissions" '.permissions == {}'
check "one run per root, never cancelled" \
  '(.concurrency.group | contains("inputs.root")) and (.concurrency["cancel-in-progress"] == false)'
check "Terraform version is exact" '(.env.TERRAFORM_VERSION | tostring | test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))'
check "the kept plan has a maximum age" '(.env.MAX_PLAN_AGE_SECONDS | tostring | test("^[0-9]+$"))'
check "jobs are exactly preflight, plan and apply" '(.jobs | keys) == ["apply", "plan", "preflight"]'

check "preflight holds no permissions and no environment" \
  '(.jobs.preflight.permissions == {}) and (.jobs.preflight.environment == null)'
check "preflight refuses any ref but refs/heads/main" \
  "(.jobs.preflight | $runs) | (contains(\"\\\"\$REF\\\" != \\\"refs/heads/main\\\"\") and contains(\"exit 1\"))"

check "plan runs after preflight in the production environment" \
  '(.jobs.plan.needs == "preflight" or .jobs.plan.needs == ["preflight"]) and (.jobs.plan.environment == "production")'
check "plan initialises with the committed lock file" \
  "(.jobs.plan | $runs) | contains(\"terraform init -lockfile=readonly\")"
check "plan saves its plan" "(.jobs.plan | $runs) | test(\"terraform plan [^\\n]*-out=tfplan\")"
check "plan never applies" "(.jobs.plan | $runs) | test(\"terraform\\\\s+apply\") | not"
check "plan keeps a plan only for action apply" \
  '[.jobs.plan.steps[] | select(.id == "keep")] | (length == 1) and (.[0].if | contains("inputs.action == '"'"'apply'"'"'"))'

check "apply needs the plan job" '(.jobs.apply.needs | if type == "array" then . else [.] end) | index("plan") != null'
check "apply runs only for action apply on main" \
  '(.jobs.apply.if | contains("inputs.action == '"'"'apply'"'"'")) and (.jobs.apply.if | contains("github.ref == '"'"'refs/heads/main'"'"'"))'
check "apply runs in the production environment" '.jobs.apply.environment == "production"'
check "apply initialises with the committed lock file" \
  "(.jobs.apply | $runs) | contains(\"terraform init -lockfile=readonly\")"
check "apply never plans" "(.jobs.apply | $runs) | test(\"terraform\\\\s+plan\") | not"
check "apply has exactly one terraform apply, on the saved plan file" \
  '[.jobs.apply.steps[] | select((.run // "") | test("terraform\\s+apply"))] | (length == 1) and (.[0].run | test("^terraform apply [^\\n]*tfplan\\s*$"))'
check "the apply command has no -auto-approve, -target, -replace or -refresh" \
  '[.. | strings | select(test("terraform\\s+apply"))] | all(test("-auto-approve|-target|-replace|-refresh") | not)'
check "apply verifies the plan before applying it" \
  '[.jobs.apply.steps[] | (.run // "")] as $s
   | ([$s | to_entries[] | select(.value | contains("verify-saved-plan.sh")) | .key] | min) as $verify
   | ([$s | to_entries[] | select(.value | test("terraform\\s+apply")) | .key] | min) as $apply
   | ($verify != null) and ($apply != null) and ($verify < $apply)'
check "apply checks the plan's key against the state key resolved by KMS" \
  '[.jobs.apply.steps[] | select((.run // "") | contains("verify-saved-plan.sh"))] | (length == 1)
   and (.[0].env.ACTUAL_KMS_KEY_ID | tostring | contains("steps.fetch.outputs.kms_key_id"))
   and (.[0].env.EXPECTED_KMS_KEY_ARN | tostring | contains("steps.fetch.outputs.expected_kms_key_arn"))
   and (.[0].env.ENCRYPTION | tostring | contains("steps.fetch.outputs.encryption"))'
check "the expected key is resolved by KMS, not taken from the alias string" \
  '[.jobs.apply.steps[] | select(.id == "fetch") | .run] | (length == 1)
   and (.[0] | test("aws kms describe-key[^\n]*STATE_KEY_ALIAS_ARN"))
   and (.[0] | contains("resolve-kms-key.sh"))
   and (.[0] | contains("SSEKMSKeyId"))'
check "apply discards the plan whatever the result" \
  '[.jobs.apply.steps[] | select((.if // "") == "always()" and ((.run // "") | contains("delete-object")))] | length == 1'
check "terraform apply appears nowhere but the apply job" \
  '[.jobs | to_entries[] | select(.key != "apply") | .value.steps[]? | (.run // "") | select(test("terraform\\s+apply"))] | length == 0'
check "nothing uploads a workflow artifact" \
  '[.. | objects | .uses? // empty | select(test("upload-artifact"))] | length == 0'
check "every job that can reach AWS runs in the production environment" \
  '[.jobs[] | select(.permissions["id-token"]? == "write") | .environment] | all(. == "production")'

if [ "$failures" -gt 0 ]; then
  echo "check-workflow-policy: $failures check(s) failed" >&2
  exit 1
fi
echo "check-workflow-policy: all checks passed"
