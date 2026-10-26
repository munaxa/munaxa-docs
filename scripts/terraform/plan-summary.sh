#!/usr/bin/env bash
# Sanitised summary of a saved Terraform plan, for the job summary and the plan review.
#
#   plan-summary.sh <plan.json>            Markdown: counts and one row per resource action
#   plan-summary.sh --counts <plan.json>   add=N, change=N, replace=N, destroy=N (for $GITHUB_OUTPUT)
#
# <plan.json> is `terraform show -json tfplan`. It can hold sensitive values in plain text, so this
# script reads only addresses and actions: no attribute value, before or after, is ever printed.
# shellcheck disable=SC2016 # the single-quoted strings are jq programs, not shell
set -euo pipefail

mode=markdown
if [ "${1:-}" = "--counts" ]; then
  mode=counts
  shift
fi
plan_json="${1:?usage: plan-summary.sh [--counts] <plan.json>}"
[ -s "$plan_json" ] || { echo "plan-summary: $plan_json is missing or empty" >&2; exit 1; }

# A replacement is one resource change whose actions include both create and delete, in either
# order. It is counted as a replacement only, not as an add and a destroy.
counts='
  [.resource_changes[]? | .change.actions] as $a
  | {
      add:     [$a[] | select(. == ["create"])] | length,
      change:  [$a[] | select(. == ["update"])] | length,
      replace: [$a[] | select(index("create") and index("delete"))] | length,
      destroy: [$a[] | select(. == ["delete"])] | length,
      other:   [$a[] | select(. != ["create"] and . != ["update"] and . != ["delete"]
                              and . != ["no-op"] and . != ["read"]
                              and ((index("create") and index("delete")) | not))] | length
    }'

if [ "$mode" = counts ]; then
  jq -r "$counts | \"add=\(.add)\", \"change=\(.change)\", \"replace=\(.replace)\", \"destroy=\(.destroy)\", \"other=\(.other)\"" "$plan_json"
  exit 0
fi

jq -r "
  ($counts) as \$n
  | [.resource_changes[]? | select(.change.actions != [\"no-op\"] and .change.actions != [\"read\"])] as \$c
  | \"**Plan:** \(\$n.add) to add, \(\$n.change) to change, \(\$n.replace) to replace, \(\$n.destroy) to destroy\"
    + (if \$n.other > 0 then \", \(\$n.other) other\" else \"\" end) + \".\",
    \"\",
    (if (\$c | length) == 0 then \"No changes.\" else
      \"| Action | Address |\", \"| --- | --- |\",
      (\$c[] | \"| \(if (.change.actions | index(\"create\")) and (.change.actions | index(\"delete\"))
                    then \"replace\" else (.change.actions | join(\", \")) end) | \`\(.address)\` |\")
    end)
" "$plan_json"
