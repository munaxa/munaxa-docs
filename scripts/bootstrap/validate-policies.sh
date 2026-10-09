#!/usr/bin/env bash
# AWS-native validation of the bootstrap policy documents (validation gate 3, see
# docs/operations/bootstrap-plan-runbooks.md §7). READ ONLY: it calls only IAM Access Analyzer
# ValidatePolicy and IAM SimulateCustomPolicy, which evaluate policy text and change nothing.
#
# Run by admin.tamer in AWS CloudShell of the management account (eu-central-1), from the
# repository root, after export-plan-review.sh has written ~/bootstrap-plan-review.json.
#
#   bash scripts/bootstrap/validate-policies.sh
#
#   1. Access Analyzer ValidatePolicy on every document in the review file: identity policies and
#      boundaries, role trusts, the state bucket policy and the state key policy.
#      Any ERROR or SECURITY_WARNING finding is a STOP.
#   2. The IAM policy simulator on the TEST deployer (its nine policies under deployer-boundary)
#      with the agreed cases in scripts/bootstrap/testdata/testing-deployer-cases.json. Any
#      decision other than the expected one is a STOP. Needs every TEST deployer document in full,
#      so it runs only on a plan B made after step A (the state key exists).
#
# Writes ~/policy-validation.json and ~/policy-validation.txt. Neither holds a secret value.
set -euo pipefail

ADMIN_ARN="arn:aws:iam::800728620253:user/admin.tamer"
export AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1
stop() { echo "STOP: $*"; exit 1; }

repo=$(git rev-parse --show-toplevel 2>/dev/null) || stop "run this from the munaxa-docs checkout"
cd "$repo"
review="$HOME/bootstrap-plan-review.json"
cases="scripts/bootstrap/testdata/testing-deployer-cases.json"
[ -s "$review" ] || stop "$review not found; run scripts/bootstrap/export-plan-review.sh first"

unset AWS_PROFILE
caller=$(aws sts get-caller-identity --query Arn --output text)
[ "$caller" = "$ADMIN_ARN" ] || stop "signed in as $caller; run this as $ADMIN_ARN"
# Everything below is also written to ~/policy-validation.txt.
exec > >(tee "$HOME/policy-validation.txt") 2>&1
echo "identity:  $caller (eu-central-1)"
echo "review:    $review (commit $(jq -r .commit "$review"))"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
results="$work/results.jsonl"
: > "$results"
fail=0

# --- 1. Access Analyzer ---------------------------------------------------------------------------
# One line per document: plan, address, kind (policy|trust), type, the document.
jq -c '.plans[] | select(.documents) | .plan as $p | .documents[]
  | (if .policy then {plan: $p, address, kind: "policy", doc: .policy} else empty end),
    (if .trust  then {plan: $p, address, kind: "trust",  doc: .trust}  else empty end)' "$review" \
  > "$work/docs.jsonl"

while IFS= read -r line; do
  plan=$(jq -r .plan <<<"$line"); addr=$(jq -r .address <<<"$line"); kind=$(jq -r .kind <<<"$line")
  if [ "$(jq -r '.doc | type' <<<"$line")" != object ]; then
    echo "NOT VALIDATED  $plan  $addr ($kind): known after apply"
    jq -nc --arg p "$plan" --arg a "$addr" --arg k "$kind" '{check: "validate-policy", plan: $p, address: $a, kind: $k, status: "NOT VALIDATED (known after apply)"}' >> "$results"
    continue
  fi
  jq -c .doc <<<"$line" > "$work/doc.json"
  case "$kind:$addr" in
    trust:*)                  args=(--policy-type RESOURCE_POLICY --validate-policy-resource-type AWS::IAM::AssumeRolePolicyDocument) ;;
    policy:aws_s3_bucket_policy.*) args=(--policy-type RESOURCE_POLICY --validate-policy-resource-type AWS::S3::Bucket) ;;
    policy:aws_kms_key.*)     args=(--policy-type RESOURCE_POLICY --validate-policy-resource-type AWS::KMS::Key) ;;
    *)                        args=(--policy-type IDENTITY_POLICY) ;;
  esac
  aws accessanalyzer validate-policy "${args[@]}" --policy-document "file://$work/doc.json" \
    --query 'findings[].{type: findingType, code: issueCode}' --output json > "$work/findings.json"
  blocking=$(jq '[.[] | select(.type == "ERROR" or .type == "SECURITY_WARNING")] | length' "$work/findings.json")
  summary=$(jq -r 'if length == 0 then "no findings" else (group_by(.type) | map("\(.[0].type) \(length): \(map(.code) | unique | join(","))") | join("; ")) end' "$work/findings.json")
  if [ "$blocking" -gt 0 ]; then status=STOP; fail=1; else status=PASS; fi
  printf '%-14s %s  %s (%s): %s\n' "$status" "$plan" "$addr" "$kind" "$summary"
  jq -nc --arg p "$plan" --arg a "$addr" --arg k "$kind" --arg s "$status" --slurpfile f "$work/findings.json" \
    '{check: "validate-policy", plan: $p, address: $a, kind: $k, status: $s, findings: $f[0]}' >> "$results"
done < "$work/docs.jsonl"

# --- 2. IAM policy simulator: the TEST deployer ---------------------------------------------------
planb='TEST bootstrap plan B (everything)'
jq -c --arg p "$planb" '.plans[] | select(.plan == $p) | .documents // []' "$review" > "$work/planb.json"
names=$(jq -r '.[] | select(.address | startswith("aws_iam_policy.deployer[")) | .address' "$work/planb.json" | wc -l)
unknown=$(jq -r '[.[] | select((.address | startswith("aws_iam_policy.deployer")) and (.policy | type) != "object")] | length' "$work/planb.json")
key_arn=$(jq -r '.[] | select(.address == "aws_iam_policy.deployer[\"deployer-state\"]") | .policy
  | if type == "object" then (.Statement[] | select(.Sid == "UseStateKey") | .Resource) else empty end' "$work/planb.json")
if [ "$names" -ne 9 ] || [ "$unknown" -ne 0 ] || [ -z "$key_arn" ]; then
  echo "NOT RUN        simulator: plan B does not show all nine TEST deployer documents and its boundary in full"
  echo "               (before step A the state key does not exist; re-run after step A's plan B)"
  jq -nc '{check: "simulate-custom-policy", status: "NOT RUN (documents known after apply)"}' >> "$results"
  sim=notrun
else
  jq -c '[.[] | select(.address | startswith("aws_iam_policy.deployer[")) | .policy | tojson]' "$work/planb.json" > "$work/identity.json"
  jq -c '[.[] | select(.address == "aws_iam_policy.deployer_boundary") | .policy | tojson]' "$work/planb.json" > "$work/boundary.json"
  total=0; bad=0
  while IFS= read -r c; do
    total=$((total + 1))
    jq -n --slurpfile i "$work/identity.json" --slurpfile b "$work/boundary.json" --argjson c "$c" --arg key "$key_arn" '
      def ctype($k): if $k | test("NormalizedRecordNames$") then "stringList"
                     elif $k == "kms:GrantIsForAWSResource" then "boolean"
                     elif $k | test("^(ecs:cluster|iam:PermissionsBoundary)$") then "arn"
                     else "string" end;
      ({"aws:RequestedRegion": ["eu-central-1"]} + $c.context) as $ctx
      | {PolicyInputList: $i[0], PermissionsBoundaryPolicyInputList: $b[0],
         ActionNames: [$c.action], ResourceArns: [$c.resource | sub("STATE_KEY_ARN"; $key)],
         ContextEntries: [$ctx | to_entries[]
           | {ContextKeyName: .key, ContextKeyValues: .value, ContextKeyType: ctype(.key)}]}' > "$work/req.json"
    decision=$(aws iam simulate-custom-policy --cli-input-json "file://$work/req.json" \
      --query 'EvaluationResults[0].EvalDecision' --output text)
    want=$(jq -r .expect <<<"$c")
    if { [ "$want" = allow ] && [ "$decision" = allowed ]; } || { [ "$want" = deny ] && [ "$decision" != allowed ]; }; then
      ok=true
    else
      ok=false; bad=$((bad + 1))
      echo "UNEXPECTED     simulator: expected $want, got $decision: $(jq -r '"\(.action) on \(.resource)"' <<<"$c")"
    fi
    jq -nc --argjson c "$c" --arg d "$decision" --argjson ok "$ok" '{check: "simulate-custom-policy", case: $c, decision: $d, as_expected: $ok}' >> "$results"
  done < <(jq -c '.cases[]' "$cases")
  if [ "$bad" -eq 0 ]; then echo "PASS           simulator: $total cases, all as expected"; sim=pass
  else echo "STOP           simulator: $total cases, $bad unexpected"; sim=stop; fail=1; fi
fi

jq -s --arg commit "$(jq -r .commit "$review")" --arg at "$(date -u +%FT%TZ)" --arg sim "$sim" \
  '{generated_at: $at, commit: $commit, kind: "AWS-native policy validation (Access Analyzer, IAM simulator)", simulator: $sim, results: .}' \
  "$results" > "$HOME/policy-validation.json"

if [ "$fail" -ne 0 ]; then echo "OVERALL: STOP. Send ~/policy-validation.json and ~/policy-validation.txt for review."
elif [ "$sim" = notrun ]; then echo "OVERALL: PARTIAL. Access Analyzer done; the simulator waits for plan B after step A."
else echo "OVERALL: PASS (evidence for review, not an approval)"; fi
[ "$fail" -eq 0 ]
