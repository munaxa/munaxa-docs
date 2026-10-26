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
#   ENCRYPTION            the stored object's ServerSideEncryption, as S3 reports it
#   ACTUAL_KMS_KEY_ID     the stored object's SSEKMSKeyId, as S3 reports it (a key ARN)
#   EXPECTED_KMS_KEY_ARN  the state key's canonical key ARN, resolved from its alias by KMS
#                         (resolve-kms-key.sh); never the alias itself
#   MAX_PLAN_AGE_SECONDS  the oldest plan that may be applied
#   NOW                   optional, Unix seconds (tests); defaults to the current time
set -euo pipefail

fail() {
  echo "::error::Saved plan refused: $*"
  exit 1
}

for name in PLAN_FILE EXPECTED_SHA256 EXPECTED_COMMIT EXPECTED_ROOT PLAN_CREATED_AT \
  CURRENT_COMMIT CURRENT_ROOT CURRENT_RUN_ID META_SHA256 META_COMMIT META_ROOT META_RUN_ID \
  ENCRYPTION ACTUAL_KMS_KEY_ID EXPECTED_KMS_KEY_ARN MAX_PLAN_AGE_SECONDS; do
  [ -n "${!name:-}" ] || fail "$name is not set"
done

hex64='^[0-9a-f]{64}$'
sha40='^[0-9a-f]{40}$'
digits='^[0-9]+$'
[[ "$EXPECTED_SHA256" =~ $hex64 ]] || fail "the reviewed hash is not a SHA-256"
[[ "$EXPECTED_COMMIT" =~ $sha40 ]] || fail "the reviewed commit is not a full SHA"
[[ "$PLAN_CREATED_AT" =~ $digits ]] || fail "the plan creation time is not a number"
[[ "$MAX_PLAN_AGE_SECONDS" =~ $digits ]] || fail "the maximum plan age is not a number"

# The plan must be encrypted with the state key itself. The expected key is a canonical key ARN
# (an alias is never accepted here: it is resolved by KMS first). S3 reports a key ARN; a bare key
# ID is accepted only as that same key. Both sides are compared by account, region and key ID, so
# an alias, another key, or a key in another account or region is refused.
key_id='(mrk-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
key_arn="^arn:aws:kms:([a-z0-9-]+):([0-9]{12}):key/${key_id}$"
[ "$ENCRYPTION" = "aws:kms" ] || fail "it is not stored with SSE-KMS (got '$ENCRYPTION')"
[[ "$EXPECTED_KMS_KEY_ARN" =~ $key_arn ]] ||
  fail "the expected state key '$EXPECTED_KMS_KEY_ARN' is not a resolved key ARN"
expected_key="${BASH_REMATCH[1]}:${BASH_REMATCH[2]}:${BASH_REMATCH[3]}"
if [[ "$ACTUAL_KMS_KEY_ID" =~ $key_arn ]]; then
  actual_key="${BASH_REMATCH[1]}:${BASH_REMATCH[2]}:${BASH_REMATCH[3]}"
elif [[ "$ACTUAL_KMS_KEY_ID" =~ ^${key_id}$ ]]; then
  actual_key="${expected_key%:*}:${BASH_REMATCH[1]}"
else
  fail "S3 reports key '$ACTUAL_KMS_KEY_ID', which is not a key ARN or key ID"
fi
[ "$actual_key" = "$expected_key" ] ||
  fail "it is encrypted with key '$ACTUAL_KMS_KEY_ID', not the state key '$EXPECTED_KMS_KEY_ARN'"

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

echo "Saved plan accepted: sha256 $actual_sha256, commit $EXPECTED_COMMIT, root $EXPECTED_ROOT, run $CURRENT_RUN_ID, ${age}s old, encrypted with $EXPECTED_KMS_KEY_ARN."
