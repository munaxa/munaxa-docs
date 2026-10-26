#!/usr/bin/env bash
# Resolves the expected state key to its canonical key ARN from `aws kms describe-key` output:
#
#   aws kms describe-key --key-id "$STATE_KEY_ALIAS_ARN" --output json | resolve-kms-key.sh
#
# The workflow names the state key by its alias, but S3 reports the key an object was encrypted
# with by its key ARN, so the two cannot be compared as strings. KMS resolves the alias; this
# script accepts the result only if it is a customer-managed, enabled key in EXPECTED_ACCOUNT and
# EXPECTED_REGION, and prints its key ARN. Anything else, including an empty or unparsable answer,
# fails.
set -euo pipefail

fail() {
  echo "::error::The state key could not be resolved: $*" >&2
  exit 1
}

: "${EXPECTED_ACCOUNT:?EXPECTED_ACCOUNT is not set}"
: "${EXPECTED_REGION:?EXPECTED_REGION is not set}"

describe="$(cat "${1:-/dev/stdin}")"
[ -n "$describe" ] || fail "describe-key returned nothing"
arn="$(jq -r '.KeyMetadata.Arn // empty' <<<"$describe" 2>/dev/null)" || fail "describe-key output is not JSON"
manager="$(jq -r '.KeyMetadata.KeyManager // empty' <<<"$describe")"
state="$(jq -r '.KeyMetadata.KeyState // empty' <<<"$describe")"

key_arn="^arn:aws:kms:${EXPECTED_REGION}:${EXPECTED_ACCOUNT}:key/(mrk-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$"
[[ "$arn" =~ $key_arn ]] || fail "'$arn' is not a key ARN in $EXPECTED_ACCOUNT/$EXPECTED_REGION"
[ "$manager" = CUSTOMER ] || fail "the key is not customer managed (KeyManager '$manager')"
[ "$state" = Enabled ] || fail "the key is not enabled (KeyState '$state')"

echo "$arn"
