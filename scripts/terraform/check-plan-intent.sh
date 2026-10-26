#!/usr/bin/env bash
# Checks a saved Terraform plan against the change its PR declared, resource by resource.
#
#   check-plan-intent.sh --enforce  <plan.json> <expected-changes.json>   fails unless they match
#   check-plan-intent.sh --report   <plan.json> <expected-changes.json>   prints the comparison only
#   check-plan-intent.sh --validate <expected-changes.json>               checks the declaration alone
#
# <plan.json> is `terraform show -json tfplan`. <expected-changes.json> is the root's committed
# declaration (infra/terraform/eu-prod/<root>/expected-changes.json), written and reviewed in the
# PR that makes the change, so it is bound to the reviewed commit like the code itself:
#
#   {
#     "root": "service",
#     "intent": "HTTPS stage: listener, preview rule and redirect (PR #158)",
#     "changes": [
#       {"address": "aws_lb_listener.https[0]", "actions": ["create"]}
#     ]
#   }
#
# The plan matches only if its resource changes, every one except no-op and read, are exactly the
# declared ones: the same addresses, each with the same action list (a replacement is
# ["delete", "create"] or ["create", "delete"], as Terraform plans it). An extra, a missing or a
# different action fails; counts are never compared. --enforce also refuses a declaration that is
# missing, malformed, for another root (EXPECTED_ROOT) or empty: an apply always declares what it
# changes. Only addresses and actions are printed, never an attribute value.
# shellcheck disable=SC2016 # the single-quoted strings are jq programs, not shell
set -euo pipefail
export LC_ALL=C # comm and jq's sort must agree on order

usage() {
  echo "usage: check-plan-intent.sh --enforce|--report <plan.json> <expected-changes.json>" >&2
  echo "       check-plan-intent.sh --validate <expected-changes.json>" >&2
  exit 2
}

mode="${1:-}"
case "$mode" in
  --enforce | --report)
    [ "$#" -eq 3 ] || usage
    plan_json="$2"
    expected_json="$3"
    ;;
  --validate)
    [ "$#" -eq 2 ] || usage
    plan_json=""
    expected_json="$2"
    ;;
  *) usage ;;
esac

refuse() {
  echo "::error::Plan intent check failed: $*"
  exit 1
}

# --- The declaration ---------------------------------------------------------------------------

[ -f "$expected_json" ] || refuse "no expected-change declaration at $expected_json"
[ -s "$expected_json" ] || refuse "the expected-change declaration $expected_json is empty"
jq -e . "$expected_json" > /dev/null 2>&1 || refuse "$expected_json is not valid JSON"

# Exactly root, intent and changes; each change exactly address and a non-empty list of create,
# update and delete; no address twice. Anything else is malformed.
problems="$(jq -r '
  def is_action: . == "create" or . == "update" or . == "delete";
  if type != "object" then "the declaration is not a JSON object"
  else
    ([keys[] | select(. != "root" and . != "intent" and . != "changes")] | map("unknown key \(.)")[]),
    (if (.root | type) != "string" or .root == "" then "root is missing or not a string" else empty end),
    (if (.intent | type) != "string" or (.intent | test("\\S") | not) then "intent is missing or blank" else empty end),
    (if (.changes | type) != "array" then "changes is missing or not a list"
     else
       (.changes | to_entries[] | .key as $i | .value |
         if type != "object" then "change \($i) is not an object"
         else
           ([keys[] | select(. != "address" and . != "actions")] | map("change \($i): unknown key \(.)")[]),
           (if (.address | type) != "string" or .address == "" then "change \($i): address is missing" else empty end),
           (if (.actions | type) != "array" or (.actions | length) == 0
              or ([.actions[] | (type == "string" and is_action)] | all | not)
              or ((.actions | length) != (.actions | unique | length))
            then "change \($i): actions must be a non-empty list of create, update and delete"
            else empty end)
         end),
       ([.changes[] | select(type == "object") | .address] | group_by(.)[] | select(length > 1)
         | "address \(.[0]) is declared more than once")
     end)
  end' "$expected_json")"
[ -z "$problems" ] || refuse "$expected_json is malformed:
$problems"

declared_root="$(jq -r '.root' "$expected_json")"
if [ -n "${EXPECTED_ROOT:-}" ] && [ "$declared_root" != "$EXPECTED_ROOT" ]; then
  refuse "$expected_json declares root '$declared_root', but this plan is for '$EXPECTED_ROOT'"
fi
declared_count="$(jq '.changes | length' "$expected_json")"

if [ "$mode" = --validate ]; then
  echo "Declaration valid: root $declared_root, $declared_count declared change(s)."
  exit 0
fi

if [ "$mode" = --enforce ] && [ "$declared_count" -eq 0 ]; then
  refuse "$expected_json declares no change, so there is nothing this apply may do"
fi

# --- The plan ----------------------------------------------------------------------------------

[ -s "$plan_json" ] || refuse "the plan $plan_json is missing or empty"
jq -e 'type == "object" and ((.resource_changes // []) | type) == "array"' "$plan_json" > /dev/null 2>&1 ||
  refuse "$plan_json is not a Terraform JSON plan"

# One line per change: "<address> <actions joined by commas>", sorted.
actual="$(jq -r '
  [(.resource_changes // [])[]
   | select(.change.actions != ["no-op"] and .change.actions != ["read"])
   | "\(.address) \(.change.actions | join(","))"] | sort[]' "$plan_json")"
expected="$(jq -r '[.changes[] | "\(.address) \(.actions | join(","))"] | sort[]' "$expected_json")"

unexpected="$(comm -23 <(printf '%s\n' "$actual" | sed '/^$/d') <(printf '%s\n' "$expected" | sed '/^$/d'))"
missing="$(comm -13 <(printf '%s\n' "$actual" | sed '/^$/d') <(printf '%s\n' "$expected" | sed '/^$/d'))"

echo "Declared intent ($declared_root): $(jq -r '.intent' "$expected_json")"
if [ -z "$unexpected" ] && [ -z "$missing" ]; then
  echo "The plan matches the declared changes exactly ($declared_count resource action(s))."
  exit 0
fi

if [ -n "$unexpected" ]; then
  echo "In the plan but not declared (address, actions):"
  while IFS= read -r line; do echo "  $line"; done <<<"$unexpected"
fi
if [ -n "$missing" ]; then
  echo "Declared but not in the plan (address, actions):"
  while IFS= read -r line; do echo "  $line"; done <<<"$missing"
fi
if [ "$mode" = --enforce ]; then
  refuse "the plan does not match $expected_json. Nothing may be applied: correct the code or the declaration in a reviewed PR, then plan again"
fi
echo "::warning::The plan does not match $expected_json (report only: this run applies nothing)."
