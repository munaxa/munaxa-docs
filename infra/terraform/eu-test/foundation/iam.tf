# TEST workload IAM roles, under /munaxa-docs/eu-test/. Free to keep, so they are created once here
# rather than with every session. Same model as Production's core roles (eu-prod/core/iam.tf):
# every role carries the TEST workload boundary, execution roles read only their own secrets and
# logs, and only the API (and the provisioning task) has a task role.
#
# Not here: the scanner-refresh scheduler role. A TEST session lives hours, not days, so the
# scanner's start-up signature download is always fresh enough.

locals {
  ecs_source_arn_pattern = "arn:aws:ecs:${var.region}:${var.account_id}:*"

  log_group_arns = {
    for group in ["web", "api", "redis", "scanner", "ops"] : group => [
      "arn:aws:logs:${var.region}:${var.account_id}:log-group:${local.log_group_prefix}/${group}",
      "arn:aws:logs:${var.region}:${var.account_id}:log-group:${local.log_group_prefix}/${group}:*",
    ]
  }

  execution_roles = {
    web = {
      description = "Starts TEST web tasks: GHCR pull credential and web logs."
      secrets     = [local.secret_arns.ghcr_pull]
      rds_secret  = false
      log_groups  = ["web"]
    }
    api = {
      description = "Starts TEST API tasks: GHCR pull credential, application secret, API and Redis logs."
      secrets     = [local.secret_arns.ghcr_pull, local.secret_arns.app]
      rds_secret  = false
      log_groups  = ["api", "redis"]
    }
    scanner = {
      description = "Starts TEST scanner tasks: GHCR pull credential and scanner logs."
      secrets     = [local.secret_arns.ghcr_pull]
      rds_secret  = false
      log_groups  = ["scanner"]
    }
    ops-dbadmin = {
      description = "Starts the TEST database-administration task: RDS master and operator secrets, ops logs."
      secrets     = [local.secret_arns.operator]
      rds_secret  = true
      log_groups  = ["ops"]
    }
    ops-provision = {
      description = "Starts the TEST tenant-provisioning task: GHCR pull, application and provisioning secrets, ops logs."
      secrets     = [local.secret_arns.ghcr_pull, local.secret_arns.app, local.secret_arns.provision]
      rds_secret  = false
      log_groups  = ["ops"]
    }
    ops-tunnel = {
      description = "Starts the TEST migration tunnel task: ops logs only."
      secrets     = []
      rds_secret  = false
      log_groups  = ["ops"]
    }
  }
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
      sid       = "ReadTestingSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = each.value.secrets
    }
  }

  dynamic "statement" {
    for_each = each.value.rds_secret ? [1] : []
    content {
      sid       = "ReadTestingRdsManagedSecret"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [local.rds_managed_secret_arn]

      condition {
        test     = "StringEquals"
        variable = "aws:ResourceTag/Environment"
        values   = ["Testing"]
      }
    }
  }

  dynamic "statement" {
    for_each = length(each.value.secrets) > 0 || each.value.rds_secret ? [1] : []
    content {
      sid       = "DecryptTestingSecrets"
      actions   = ["kms:Decrypt"]
      resources = [aws_kms_key.data.arn]

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["secretsmanager.${var.region}.amazonaws.com"]
      }
    }
  }

  statement {
    sid       = "WriteTestingLogs"
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

# API and provisioning: the TEST document bucket, nothing else.
resource "aws_iam_role" "api_task" {
  name                 = "${local.prefix}-api-task"
  path                 = local.workload_path
  description          = "TEST API and tenant-provisioning tasks: read and write the TEST document bucket only."
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

# Migration tunnel: ECS Exec channels for the SSM port-forward the TEST session uses to migrate.
resource "aws_iam_role" "ops_tunnel_task" {
  name                 = "${local.prefix}-ops-tunnel-task"
  path                 = local.workload_path
  description          = "TEST migration tunnel task: ECS Exec session channels only."
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
