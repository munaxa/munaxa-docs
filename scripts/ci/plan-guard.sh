#!/usr/bin/env bash
# Refuses a saved Terraform plan (as `terraform show -json`) that does more than its job allows.
#
#   plan-guard.sh release <plan.json>  an application release: only the four task definitions
#                                      (web, api, scanner, ops_provision) may be replaced, and only
#                                      the three services (web, api, scanner) may be updated.
#                                      Anything else in the plan, including any infrastructure
#                                      change or drift, fails the release.
#   plan-guard.sh infra <plan.json>    an infrastructure change: never deletes or replaces a
#                                      database, bucket, key, network, load balancer, cluster,
#                                      service, secret, backup vault or IAM role from CI. Those go
#                                      to the administrator path.
#   plan-guard.sh foundation <plan.json>
#                                      the persistent TEST foundation (infra/terraform/eu-test/
#                                      foundation, administrator-applied): everything in it is
#                                      persistent, so nothing may be deleted or replaced at all;
#                                      creates and in-place updates only.
#   plan-guard.sh session <plan.json>  a TEST session apply (infra/terraform/eu-test/session): only
#                                      the session's own resources (the database, the DNS record,
#                                      module.app.*) may change, and the database and the secret
#                                      containers are never deleted or replaced by an apply.
#   plan-guard.sh session-destroy <plan.json>
#                                      a TEST session teardown: deletes only, and only the session's
#                                      own resources.
#   plan-guard.sh none <plan.json>     the plan must contain no change at all.
#
# Prints the planned actions (addresses only, never attribute values) and exits 1 on a violation.
set -euo pipefail
mode="${1:?mode}"; plan="${2:?plan.json}"

changes=$(jq -r '.resource_changes[]? | select(.change.actions != ["no-op"] and .change.actions != ["read"]) | "\(.change.actions | join(",")) \(.address)"' "$plan")
echo "${changes:-no changes}"

violations=""
# Everything a TEST session owns. The persistent foundation is only ever read (data sources).
session_own='^(aws_db_instance\.main|aws_route53_record\.web|module\.app\..+)$'
case "$mode" in
  release)
    violations=$(jq -r '
      .resource_changes[]? | select(.change.actions != ["no-op"] and .change.actions != ["read"])
      | select(
          ((.address | test("^(module\\.app\\.)?aws_ecs_task_definition\\.(web|api|scanner|ops_provision)$")))
          or ((.address | test("^(module\\.app\\.)?aws_ecs_service\\.(web|api|scanner)(\\[0\\])?$")) and .change.actions == ["update"])
          | not)
      | "\(.change.actions | join(",")) \(.address)"' "$plan")
    ;;
  infra)
    violations=$(jq -r '
      .resource_changes[]? | select(.change.actions | index("delete"))
      | select(.type | test("^aws_(db_instance|db_subnet_group|rds_cluster|s3_bucket|kms_key|vpc|subnet|internet_gateway|lb|ecs_cluster|ecs_service|secretsmanager_secret|backup_vault|iam_role|service_discovery_private_dns_namespace|acm_certificate|route53_zone)$"))
      | "\(.change.actions | join(",")) \(.address)"' "$plan")
    ;;
  foundation)
    violations=$(jq -r '
      .resource_changes[]? | select(.change.actions | index("delete"))
      | "\(.change.actions | join(",")) \(.address)"' "$plan")
    ;;
  session)
    violations=$(jq -r --arg own "$session_own" '
      .resource_changes[]? | select(.change.actions != ["no-op"] and .change.actions != ["read"])
      | select((.address | test($own) | not)
          or ((.change.actions | index("delete")) and (.type | test("^aws_(db_instance|secretsmanager_secret)$"))))
      | "\(.change.actions | join(",")) \(.address)"' "$plan")
    ;;
  session-destroy)
    violations=$(jq -r --arg own "$session_own" '
      .resource_changes[]? | select(.change.actions != ["no-op"] and .change.actions != ["read"])
      | select((.address | test($own) | not) or .change.actions != ["delete"])
      | "\(.change.actions | join(",")) \(.address)"' "$plan")
    ;;
  none)
    violations="$changes"
    ;;
  *)
    echo "unknown mode $mode" >&2; exit 2 ;;
esac

if [ -n "$violations" ]; then
  echo "::error::plan-guard ($mode) refused these changes:"
  echo "$violations"
  exit 1
fi
echo "plan-guard ($mode): OK"
