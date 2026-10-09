#!/usr/bin/env bash
# Collects the saved bootstrap plans into one file for review: ~/bootstrap-plan-review.json.
#
# Run in the same CloudShell, from the repository root, after plan-production.sh and plan-testing.sh
# (and, once the TEST bootstrap exists, plan-test-foundation.sh). Read-only: it reads the plan files
# in $HOME and never calls AWS or Terraform. For every plan it records the change counts, every
# changed address with its actions, every IAM, key and bucket policy document in full (or "known
# after apply"), and the checker's verdict. Plans hold no secret values; nothing else is read.
#
#   bash scripts/bootstrap/export-plan-review.sh
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
out="$HOME/bootstrap-plan-review.json"

# summarize <name> <account> <principal> <plan.json> <check.txt>
summarize() {
  local name=$1 account=$2 principal=$3 plan=$4 check=$5
  if [ ! -s "$plan" ]; then
    jq -n --arg n "$name" --arg p "$plan" '{plan: $n, status: "NOT RUN", missing: $p}'
    return
  fi
  jq --arg n "$name" --arg acct "$account" --arg who "$principal" --arg region eu-central-1 \
     --rawfile verdict <(cat "$check" 2>/dev/null || true) '
    def changed: [.resource_changes[]? | select(.change.actions != ["no-op"] and .change.actions != ["read"])];
    def doc($v): if $v == null then null else (try ($v | fromjson) catch $v) end;
    {
      plan: $n, account: $acct, principal: $who, region: $region,
      terraform_version: .terraform_version,
      counts: {
        create:  [changed[] | select(.change.actions == ["create"])] | length,
        update:  [changed[] | select(.change.actions == ["update"])] | length,
        delete:  [changed[] | select(.change.actions == ["delete"])] | length,
        replace: [changed[] | select(.change.actions | length == 2)] | length
      },
      changes: [changed[] | {address, actions: .change.actions}],
      documents: [changed[]
        | select(.type | IN("aws_iam_policy", "aws_iam_role_policy", "aws_iam_role", "aws_kms_key", "aws_s3_bucket_policy"))
        | {address,
           policy: (if .change.after_unknown.policy == true then "known after apply" else doc(.change.after.policy) end),
           trust:  (if .change.after_unknown.assume_role_policy == true then "known after apply" else doc(.change.after.assume_role_policy) end)}
        | with_entries(select(.value != null))],
      checker: ($verdict | split("\n") | map(select(test("^(STOP|RESULT|OVERALL|note|  missing|  unexpected|plan-guard|::error::)")))),
      status: (if ($verdict | test("STOP|::error::")) then "STOP"
               elif ($verdict | test("RESULT: PASS|plan-guard \\([a-z-]+\\): OK")) then "PASS"
               else "NOT CHECKED" end)
    }' "$plan"
}

prod="arn:aws:iam::800728620253:user/admin.tamer"
test_boot="arn:aws:sts::657878534449:assumed-role/OrganizationAccountAccessRole/admin.tamer-bootstrap-eu-test"
test_found="arn:aws:sts::657878534449:assumed-role/OrganizationAccountAccessRole/admin.tamer-foundation-eu-test"

# Plan A's and plan B's verdicts share one check file; split it at the "== plan B" heading.
split=$(mktemp -d)
trap 'rm -rf "$split"' EXIT
if [ -s "$HOME/test-bootstrap-check.txt" ]; then
  sed -n '/^== plan A/,/^== plan B/p' "$HOME/test-bootstrap-check.txt" > "$split/a.txt"
  sed -n '/^== plan B/,$p' "$HOME/test-bootstrap-check.txt" > "$split/b.txt"
fi

{
  summarize "production bootstrap" 800728620253 "$prod" \
    "$HOME/production-bootstrap-plan.json" "$HOME/production-bootstrap-check.txt"
  summarize "TEST bootstrap plan A (state key)" 657878534449 "$test_boot" \
    "$HOME/test-bootstrap-key-plan.json" "$split/a.txt"
  summarize "TEST bootstrap plan B (everything)" 657878534449 "$test_boot" \
    "$HOME/test-bootstrap-plan.json" "$split/b.txt"
  summarize "TEST foundation" 657878534449 "$test_found" \
    "$HOME/test-foundation-plan.json" "$HOME/test-foundation-check.txt"
} | jq -s --arg commit "$(git -C "$repo" rev-parse HEAD)" --arg at "$(date -u +%FT%TZ)" \
      '{generated_at: $at, commit: $commit, kind: "real terraform plans (admin.tamer)", plans: .}' > "$out"

jq -r '.plans[] | "\(.plan): \(.status)" + (if .counts then " (create \(.counts.create), update \(.counts.update), delete \(.counts.delete), replace \(.counts.replace))" else "" end)' "$out"
echo "written: $out"
