#!/usr/bin/env bash
# Sourced by the Terraform workflow's steps that keep, fetch or discard a saved plan:
#
#   source scripts/terraform/deployer-session.sh gha-run-<run id>-<purpose>
#
# The step already holds the CI role's session (GitHub OIDC). This assumes the Production deployer
# from it, exactly as Terraform's provider and backend do: source identity github-actions and a
# gha-run-* session name, which the deployer's trust requires. The deployer may read and write
# eu-prod/* in the state bucket and use the state key; the CI role cannot. The credentials are
# exported to the calling step only, masked, and last 15 minutes.

deployer_session_name="${1:?usage: source deployer-session.sh gha-run-<id>-<purpose>}"
case "$deployer_session_name" in
  gha-run-*) ;;
  *)
    echo "::error::The deployer session name must start with gha-run-"
    # Sourced, this returns to the step; run directly, it exits.
    # shellcheck disable=SC2317
    return 1 2>/dev/null || exit 1
    ;;
esac
: "${DEPLOYER_ROLE_ARN:?DEPLOYER_ROLE_ARN is not set}"

deployer_session_json="$(aws sts assume-role \
  --role-arn "$DEPLOYER_ROLE_ARN" \
  --role-session-name "$deployer_session_name" \
  --source-identity github-actions \
  --duration-seconds 900 \
  --output json)"

AWS_ACCESS_KEY_ID="$(jq -r .Credentials.AccessKeyId <<<"$deployer_session_json")"
AWS_SECRET_ACCESS_KEY="$(jq -r .Credentials.SecretAccessKey <<<"$deployer_session_json")"
AWS_SESSION_TOKEN="$(jq -r .Credentials.SessionToken <<<"$deployer_session_json")"
unset deployer_session_json
echo "::add-mask::$AWS_SECRET_ACCESS_KEY"
echo "::add-mask::$AWS_SESSION_TOKEN"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
