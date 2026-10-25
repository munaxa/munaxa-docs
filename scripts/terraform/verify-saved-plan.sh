#!/usr/bin/env bash
# Refuses a saved Terraform plan unless it is exactly the plan that was reviewed in this run.
# The apply job runs this after fetching the plan and before `terraform apply`. Any failure stops
# the job: nothing re-plans, and no other plan is applied in its place.
#
# Inputs (environment):
#   PLAN_FILE             the fetched saved plan
#   EXPECTED_SHA256       the plan job's hash of the plan it reviewed (a job output, set in GitHub)
#   EXPECTED_COMMIT       the commit the plan job ran on (job output)
#   EXPECTED_ROOT         the root the plan job ran on (job output)
#   PLAN_CREATED_AT       when the plan job stored the plan, in Unix seconds (job output)
#   CURRENT_COMMIT        the commit this job runs on
#   CURRENT_ROOT          the root this job runs on
#   CURRENT_RUN_ID        this workflow run
#   META_SHA256, META_COMMIT, META_ROOT, META_RUN_ID
#                         the stored object's metadata, written by the plan job
#   MAX_PLAN_AGE_SECONDS  the oldest plan that may be applied
#   NOW                   optional, Unix seconds (tests); defaults to the current time
set -euo pipefail

fail() {
  echo "::error::Saved plan refused: $*"
  exit 1
}

for name in PLAN_FILE EXPECTED_SHA256 EXPECTED_COMMIT EXPECTED_ROOT PLAN_CREATED_AT \
  CURRENT_COMMIT CURRENT_ROOT CURRENT_RUN_ID META_SHA256 META_COMMIT META_ROOT META_RUN_ID \
  MAX_PLAN_AGE_SECONDS; do
  [ -n "${!name:-}" ] || fail "$name is not set"
done

hex64='^[0-9a-f]{64}$'
sha40='^[0-9a-f]{40}$'
digits='^[0-9]+$'
[[ "$EXPECTED_SHA256" =~ $hex64 ]] || fail "the reviewed hash is not a SHA-256"
[[ "$EXPECTED_COMMIT" =~ $sha40 ]] || fail "the reviewed commit is not a full SHA"
[[ "$PLAN_CREATED_AT" =~ $digits ]] || fail "the plan creation time is not a number"
[[ "$MAX_PLAN_AGE_SECONDS" =~ $digits ]] || fail "the maximum plan age is not a number"

[ -f "$PLAN_FILE" ] || fail "no plan file was fetched"
[ -s "$PLAN_FILE" ] || fail "the fetched plan file is empty"

actual_sha256="$(sha256sum "$PLAN_FILE" | cut -d' ' -f1)"
[ "$actual_sha256" = "$EXPECTED_SHA256" ] ||
  fail "its content does not hash to the reviewed plan (got $actual_sha256, reviewed $EXPECTED_SHA256)"
[ "$META_SHA256" = "$EXPECTED_SHA256" ] || fail "its stored hash does not match the reviewed plan"

[ "$EXPECTED_COMMIT" = "$CURRENT_COMMIT" ] ||
  fail "it was planned on $EXPECTED_COMMIT, but this job runs on $CURRENT_COMMIT"
[ "$META_COMMIT" = "$EXPECTED_COMMIT" ] || fail "its stored commit ($META_COMMIT) is not the reviewed commit"

[ "$EXPECTED_ROOT" = "$CURRENT_ROOT" ] ||
  fail "it was planned for root $EXPECTED_ROOT, but this job applies root $CURRENT_ROOT"
[ "$META_ROOT" = "$EXPECTED_ROOT" ] || fail "its stored root ($META_ROOT) is not the reviewed root"

[ "$META_RUN_ID" = "$CURRENT_RUN_ID" ] ||
  fail "it was stored by run $META_RUN_ID, not by this run ($CURRENT_RUN_ID)"

now="${NOW:-$(date -u +%s)}"
[[ "$now" =~ $digits ]] || fail "the current time is not a number"
# A minute of clock skew between runners is tolerated; a plan from the future is not.
[ "$PLAN_CREATED_AT" -le $((now + 60)) ] || fail "its creation time is in the future"
age=$((now - PLAN_CREATED_AT))
[ "$age" -le "$MAX_PLAN_AGE_SECONDS" ] ||
  fail "it is ${age}s old, older than the ${MAX_PLAN_AGE_SECONDS}s limit. Run a new plan and review it"

echo "Saved plan accepted: sha256 $actual_sha256, commit $EXPECTED_COMMIT, root $EXPECTED_ROOT, run $CURRENT_RUN_ID, ${age}s old."
