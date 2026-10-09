#!/usr/bin/env bash
# Read-only ECS helper for the release and infrastructure workflows.
#
#   ecs-release.sh live                     print the image references the environment's services
#                                           run now: api_image=…, web_image=…, antivirus_image=…
#                                           (exit 3 when the services do not exist yet)
#   ecs-release.sh wait <web|api|scanner>…  wait until those services are stable
#
# The job's own credentials are its CI role, which can do nothing but assume the deployer. This
# script opens one short deployer session (source identity github-actions, session gha-run-…,
# 15 minutes) and keeps it inside this process only: the credentials are never written to a file,
# to GITHUB_ENV or to the log. It only calls ecs:Describe* (and the waiter, which polls Describe).
#
# Required environment: DEPLOYER_ROLE_ARN, PREFIX (munaxa-docs-eu-prod | munaxa-docs-eu-test),
# GITHUB_RUN_ID, AWS_REGION.
set -euo pipefail

: "${DEPLOYER_ROLE_ARN:?}" "${PREFIX:?}" "${GITHUB_RUN_ID:?}" "${AWS_REGION:?}"
case "$PREFIX" in munaxa-docs-eu-prod|munaxa-docs-eu-test) ;; *) echo "unknown prefix" >&2; exit 2 ;; esac
case "$DEPLOYER_ROLE_ARN" in
  arn:aws:iam::800728620253:role/munaxa-docs/bootstrap/munaxa-docs-eu-prod-deployer|arn:aws:iam::657878534449:role/munaxa-docs/bootstrap/munaxa-docs-eu-test-deployer) ;;
  *) echo "unknown deployer" >&2; exit 2 ;;
esac

open_session() {
  local creds
  creds=$(aws sts assume-role \
    --role-arn "$DEPLOYER_ROLE_ARN" \
    --role-session-name "gha-run-${GITHUB_RUN_ID}-$1" \
    --source-identity github-actions \
    --duration-seconds 900 \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
  read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN <<<"$creds"
  unset creds
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::add-mask::$AWS_SECRET_ACCESS_KEY"
    echo "::add-mask::$AWS_SESSION_TOKEN"
  fi
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
}

image_of() { # <service suffix> <container name>
  local td
  td=$(aws ecs describe-services --cluster "$PREFIX" --services "$PREFIX-$1" \
    --query 'services[?status==`ACTIVE`].taskDefinition | [0]' --output text)
  [ -n "$td" ] && [ "$td" != "None" ] || return 3
  aws ecs describe-task-definition --task-definition "$td" \
    --query "taskDefinition.containerDefinitions[?name=='$2'].image | [0]" --output text
}

case "${1:-}" in
  live)
    open_session live
    api=$(image_of api api) || exit 3
    web=$(image_of web web) || exit 3
    av=$(image_of scanner scanner) || exit 3
    for ref in "$api" "$web" "$av"; do
      printf '%s' "$ref" | grep -Eq '^ghcr\.io/munaxa/munaxa-docs-(api|web|antivirus)@sha256:[0-9a-f]{64}$' \
        || { echo "a running service is not pinned by digest: $ref" >&2; exit 4; }
    done
    printf 'api_image=%s\nweb_image=%s\nantivirus_image=%s\n' "$api" "$web" "$av"
    ;;
  wait)
    shift
    [ "$#" -gt 0 ] || { echo "usage: wait <web|api|scanner>…" >&2; exit 2; }
    services=()
    for s in "$@"; do
      case "$s" in web|api|scanner) services+=("$PREFIX-$s") ;; *) echo "unknown service $s" >&2; exit 2 ;; esac
    done
    open_session wait
    aws ecs wait services-stable --cluster "$PREFIX" --services "${services[@]}"
    echo "stable: ${services[*]}"
    ;;
  *)
    echo "usage: $0 live | wait <web|api|scanner>…" >&2
    exit 2
    ;;
esac
