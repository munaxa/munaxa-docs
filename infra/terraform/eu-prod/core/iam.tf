# Production workload IAM roles, under /munaxa-docs/eu-prod/. Every role carries the workload
# permissions boundary; the deployer cannot create a role without it.
#
# Roles only: the task definitions, services, schedules and backup plans that use them are added
# by later changes.

locals {
  ecs_task_trust_condition_arn = "arn:aws:ecs:${var.region}:${var.account_id}:*"

  # Execution roles: what ECS itself needs to start a task (pull the image with the GHCR
  # credential, inject secrets, write logs).
  execution_roles = {
    web = {
      description = "Starts Production web tasks: GHCR pull, web logs. No application secrets."
      secrets     = [local.secret_arns.ghcr_pull]
      log_groups  = ["web"]
      rds_secret  = false
    }
    api = {
      description = "Starts Production API tasks: GHCR pull, application secret, API and Redis logs."
      secrets     = [local.secret_arns.ghcr_pull, local.secret_arns.app]
      log_groups  = ["api", "redis"]
      rds_secret  = false
    }
    scanner = {
      description = "Starts Production scanner tasks: GHCR pull, scanner logs. No application secrets."
      secrets     = [local.secret_arns.ghcr_pull]
      log_groups  = ["scanner"]
      rds_secret  = false
    }
    ops = {
      description = "Starts short-lived Production operator tasks: GHCR pull, application, operator and provisioning secrets, RDS master secret, ops logs."
      secrets     = [local.secret_arns.ghcr_pull, local.secret_arns.app, local.secret_arns.operator, local.secret_arns.provision]
      log_groups  = ["ops"]
      rds_secret  = true
    }
  }
}

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
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
      values   = [local.ecs_task_trust_condition_arn]
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

  statement {
    sid       = "ReadProductionSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = each.value.secrets
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

  statement {
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
  }

  statement {
    sid     = "WriteProductionLogs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = flatten([
      for group in each.value.log_groups : [
        "arn:aws:logs:${var.region}:${var.account_id}:log-group:${local.log_group_prefix}/${group}",
        "arn:aws:logs:${var.region}:${var.account_id}:log-group:${local.log_group_prefix}/${group}:*",
      ]
    ])
  }
}

resource "aws_iam_role_policy" "execution" {
  for_each = local.execution_roles

  name   = "${local.prefix}-${each.key}-execution"
  role   = aws_iam_role.execution[each.key].id
  policy = data.aws_iam_policy_document.execution[each.key].json
}

# ---------------------------------------------------------------------------------------------
# Task roles. Web and scanner have none.
# ---------------------------------------------------------------------------------------------

# API: the document bucket only. Tenant isolation inside it is enforced by the application.
resource "aws_iam_role" "api_task" {
  name                 = "${local.prefix}-api-task"
  path                 = local.workload_path
  description          = "Production API tasks: read and write the Production document bucket only."
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

# Operator tunnel task: ECS Exec channels for an SSM port-forwarding session, nothing else.
resource "aws_iam_role" "ops_tunnel_task" {
  name                 = "${local.prefix}-ops-tunnel-task"
  path                 = local.workload_path
  description          = "Short-lived Production tunnel task: ECS Exec session channels only."
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
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ops_tunnel_task" {
  name   = "${local.prefix}-ops-tunnel-task-exec"
  role   = aws_iam_role.ops_tunnel_task.id
  policy = data.aws_iam_policy_document.ops_tunnel_task.json
}

# ---------------------------------------------------------------------------------------------
# Service roles
# ---------------------------------------------------------------------------------------------

# EventBridge Scheduler: replaces the scanner task daily to refresh its signatures.
data "aws_iam_policy_document" "scheduler_trust" {
  statement {
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
  }
}

resource "aws_iam_role" "scheduler" {
  name                 = "${local.prefix}-scheduler"
  path                 = local.workload_path
  description          = "EventBridge Scheduler: force a new deployment of the Production scanner service."
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

# AWS Backup: the monthly Production database snapshot plan.
data "aws_iam_policy_document" "backup_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_iam_role" "backup" {
  name                 = "${local.prefix}-backup"
  path                 = local.workload_path
  description          = "AWS Backup: snapshot the Production database. Bounded to Production resources."
  assume_role_policy   = data.aws_iam_policy_document.backup_trust.json
  permissions_boundary = local.workload_boundary_arn
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}
