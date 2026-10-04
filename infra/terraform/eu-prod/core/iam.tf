# Production workload IAM roles, under /munaxa-docs/eu-prod/. Every role carries the workload
# permissions boundary created by bootstrap; the deployer cannot create a role without it.
#
# Roles only. The task definitions, services and schedules that use them belong to the service
# root and are added by later changes. Each role below exists because the application or an
# accepted ADR requires it (ADR-0024 §2.1, §2.7, §2.8, §2.10):
#
# | Role                       | Used by                                   | Why                                    |
# | -------------------------- | ----------------------------------------- | -------------------------------------- |
# | web-execution              | Web service                               | GHCR pull, web logs                    |
# | api-execution              | API service (API + Redis containers)      | GHCR pull, app secret, API/Redis logs  |
# | scanner-execution          | Scanner service                           | GHCR pull, scanner logs                |
# | api-task                   | API service; tenant provisioning task     | The document bucket (S3 adapter)       |
# | ops-dbadmin-execution      | Short-lived database-administration task  | RDS master and operator secrets, logs  |
# | ops-provision-execution    | Short-lived tenant provisioning task      | GHCR pull, app and provisioning secret |
# | ops-tunnel-execution       | Short-lived migration tunnel task         | Logs only                              |
# | ops-tunnel-task            | Short-lived migration tunnel task         | ECS Exec channels (SSM port forward)   |
# | scheduler                  | EventBridge Scheduler                     | Daily scanner replacement              |
#
# Web, scanner and the database-administration task have no task role: they call no AWS API.
#
# Not here, deliberately: an AWS Backup role. ADR-0024 §2.12 requires a monthly snapshot kept 12
# months but not the mechanism; the role is added with the data root's backup plan, where its
# trust conditions can be proven.

locals {
  # ECS supplies aws:SourceAccount and aws:SourceArn when it assumes a task or execution role.
  # This is AWS's documented trust for ECS task roles (ArnLike arn:aws:ecs:<region>:<account>:*
  # plus aws:SourceAccount); the ECS developer guide states that scoping aws:SourceArn to a
  # specific cluster "is not currently supported". The same conditions are on the
  # Non-Production roles, which ECS assumed on Fargate in this account for both the RunTask role
  # check and the running task.
  ecs_source_arn_pattern = "arn:aws:ecs:${var.region}:${var.account_id}:*"

  log_group_arns = {
    for group in ["web", "api", "redis", "scanner", "ops"] : group => [
      "arn:aws:logs:${var.region}:${var.account_id}:log-group:${local.log_group_prefix}/${group}",
      "arn:aws:logs:${var.region}:${var.account_id}:log-group:${local.log_group_prefix}/${group}:*",
    ]
  }

  # Execution roles: what the ECS agent needs to start a task. Their credentials are never given
  # to the containers.
  execution_roles = {
    web = {
      description = "Starts Production web tasks: GHCR pull credential and web logs. No application secrets."
      secrets     = [local.secret_arns.ghcr_pull]
      rds_secret  = false
      log_groups  = ["web"]
    }
    api = {
      description = "Starts Production API tasks: GHCR pull credential, application secret, API and Redis logs."
      secrets     = [local.secret_arns.ghcr_pull, local.secret_arns.app]
      rds_secret  = false
      log_groups  = ["api", "redis"]
    }
    scanner = {
      description = "Starts Production scanner tasks: GHCR pull credential and scanner logs. No application secrets."
      secrets     = [local.secret_arns.ghcr_pull]
      rds_secret  = false
      log_groups  = ["scanner"]
    }
    ops-dbadmin = {
      description = "Starts the short-lived Production database-administration task: RDS master and operator secrets, ops logs. Never the API secret."
      secrets     = [local.secret_arns.operator]
      rds_secret  = true
      log_groups  = ["ops"]
    }
    ops-provision = {
      description = "Starts the short-lived Production tenant-provisioning task: GHCR pull credential, application and provisioning secrets, ops logs."
      secrets     = [local.secret_arns.ghcr_pull, local.secret_arns.app, local.secret_arns.provision]
      rds_secret  = false
      log_groups  = ["ops"]
    }
    ops-tunnel = {
      description = "Starts the short-lived Production migration tunnel task: ops logs only."
      secrets     = []
      rds_secret  = false
      log_groups  = ["ops"]
    }
  }
}

# The Terraform state key, owned by bootstrap. Looked up read-only (never managed here) so every
# execution policy can deny it by ARN: it carries Environment=Production like workload keys, and
# a tag condition alone cannot be proven to exclude it.
data "aws_kms_alias" "terraform_state" {
  name = "alias/${local.prefix}-tfstate"
}

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    sid     = "EcsTasksInThisAccountAndRegion"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.ecs_source_arn_pattern]
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Execution roles
# ---------------------------------------------------------------------------------------------

resource "aws_iam_role" "execution" {
  for_each = local.execution_roles

  name                 = "${local.prefix}-${each.key}-execution"
  path                 = local.workload_path
  description          = each.value.description
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_trust.json
  permissions_boundary = local.workload_boundary_arn
}

data "aws_iam_policy_document" "execution" {
  for_each = local.execution_roles

  dynamic "statement" {
    for_each = length(each.value.secrets) > 0 ? [1] : []

    content {
      sid       = "ReadProductionSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = each.value.secrets
    }
  }

  dynamic "statement" {
    for_each = each.value.rds_secret ? [1] : []

    content {
      sid       = "ReadProductionRdsManagedSecret"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [local.rds_managed_secret_arn]

      condition {
        test     = "StringEquals"
        variable = "aws:ResourceTag/Environment"
        values   = ["Production"]
      }
    }
  }

  # Secrets encrypted with a Production customer-managed key; only through Secrets Manager, and
  # never a bootstrap key (the Terraform state key is also tagged Environment=Production).
  dynamic "statement" {
    for_each = length(each.value.secrets) > 0 || each.value.rds_secret ? [1] : []

    content {
      sid       = "DecryptProductionSecrets"
      actions   = ["kms:Decrypt"]
      resources = ["arn:aws:kms:${var.region}:${var.account_id}:key/*"]

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["secretsmanager.${var.region}.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:ResourceTag/Environment"
        values   = ["Production"]
      }

      condition {
        test     = "StringNotEquals"
        variable = "aws:ResourceTag/Stack"
        values   = ["bootstrap"]
      }
    }
  }

  statement {
    sid       = "NeverTheTerraformStateKey"
    effect    = "Deny"
    actions   = ["kms:*"]
    resources = [data.aws_kms_alias.terraform_state.target_key_arn]
  }

  statement {
    sid       = "WriteProductionLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = flatten([for group in each.value.log_groups : local.log_group_arns[group]])
  }
}

resource "aws_iam_role_policy" "execution" {
  for_each = local.execution_roles

  name   = "${local.prefix}-${each.key}-execution"
  role   = aws_iam_role.execution[each.key].id
  policy = data.aws_iam_policy_document.execution[each.key].json
}

# ---------------------------------------------------------------------------------------------
# Task roles
# ---------------------------------------------------------------------------------------------

# API (and the tenant-provisioning task, which boots the same application): the document bucket.
# These are exactly the operations apps/api/src/infrastructure/storage/s3.adapter.ts issues:
# GET/HEAD and copy source (GetObject); PUT, multipart create/upload/complete and copy target
# (PutObject); DELETE (DeleteObject); multipart abort (AbortMultipartUpload); ListObjectsV2
# (ListBucket). Tenant isolation inside the bucket is enforced by the application.
resource "aws_iam_role" "api_task" {
  name                 = "${local.prefix}-api-task"
  path                 = local.workload_path
  description          = "Production API and tenant-provisioning tasks: read and write the Production document bucket only."
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_trust.json
  permissions_boundary = local.workload_boundary_arn
}

data "aws_iam_policy_document" "api_task" {
  statement {
    sid       = "DocumentObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
    resources = ["arn:aws:s3:::${local.docs_bucket}/*"]
  }

  statement {
    sid       = "DocumentBucketListing"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${local.docs_bucket}"]
  }
}

resource "aws_iam_role_policy" "api_task" {
  name   = "${local.prefix}-api-task-documents"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_task.json
}

# Migration tunnel task: ECS Exec channels for an SSM port-forwarding session, nothing else.
resource "aws_iam_role" "ops_tunnel_task" {
  name                 = "${local.prefix}-ops-tunnel-task"
  path                 = local.workload_path
  description          = "Short-lived Production migration tunnel task: ECS Exec session channels only."
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_trust.json
  permissions_boundary = local.workload_boundary_arn
}

data "aws_iam_policy_document" "ops_tunnel_task" {
  statement {
    sid = "EcsExecSessionChannels"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    # ssmmessages has no resource-level permissions.
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ops_tunnel_task" {
  name   = "${local.prefix}-ops-tunnel-task-exec"
  role   = aws_iam_role.ops_tunnel_task.id
  policy = data.aws_iam_policy_document.ops_tunnel_task.json
}

# ---------------------------------------------------------------------------------------------
# EventBridge Scheduler: replaces the scanner task daily so it downloads fresh signatures
# (ADR-0024 §2.7).
# ---------------------------------------------------------------------------------------------

data "aws_iam_policy_document" "scheduler_trust" {
  statement {
    sid     = "SchedulerProductionGroupOnly"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }

    # EventBridge Scheduler sets aws:SourceArn to the schedule group's ARN (its documented
    # confused-deputy guidance: scope to a schedule group, never to a schedule).
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.schedule_group_arn]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name                 = "${local.prefix}-scheduler"
  path                 = local.workload_path
  description          = "EventBridge Scheduler (Production schedule group): force a new deployment of the Production scanner service."
  assume_role_policy   = data.aws_iam_policy_document.scheduler_trust.json
  permissions_boundary = local.workload_boundary_arn
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    sid       = "ReplaceScannerTask"
    actions   = ["ecs:UpdateService"]
    resources = ["arn:aws:ecs:${var.region}:${var.account_id}:service/${local.prefix}/${local.prefix}-scanner"]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "${local.prefix}-scheduler-scanner-refresh"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}
