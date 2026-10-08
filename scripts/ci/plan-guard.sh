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
#   plan-guard.sh none <plan.json>     the plan must contain no change at all.
#
# Prints the planned actions (addresses only, never attribute values) and exits 1 on a violation.
set -euo pipefail
mode="${1:?mode}"; plan="${2:?plan.json}"

changes=$(jq -r '.resource_changes[]? | select(.change.actions != ["no-op"] and .change.actions != ["read"]) | "\(.change.actions | join(",")) \(.address)"' "$plan")
echo "${changes:-no changes}"

violations=""
case "$mode" in
  release)
    violations=$(jq -r '
      .resource_changes[]? | select(.change.actions != ["no-op"] and .change.actions != ["read"])
      | select(
          ((.address | test("^aws_ecs_task_definition\\.(web|api|scanner|ops_provision)$")))
          or ((.address | test("^aws_ecs_service\\.(web|api|scanner)$")) and .change.actions == ["update"])
          | not)
      | "\(.change.actions | join(",")) \(.address)"' "$plan")
    ;;
  infra)
    violations=$(jq -r '
      .resource_changes[]? | select(.change.actions | index("delete"))
      | select(.type | test("^aws_(db_instance|db_subnet_group|rds_cluster|s3_bucket|kms_key|vpc|subnet|internet_gateway|lb|ecs_cluster|ecs_service|secretsmanager_secret|backup_vault|iam_role|service_discovery_private_dns_namespace|acm_certificate)$"))
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
