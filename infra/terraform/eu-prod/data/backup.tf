# Monthly database snapshot kept 12 months (ADR-0024 §2.12), in addition to the 35 days of RDS
# automated backups and point-in-time recovery.
#
# The service role. Its trust is AWS's documented trust for an AWS Backup service role:
# backup.amazonaws.com and sts:AssumeRole, with no condition keys. AWS Backup documents
# aws:SourceArn/aws:SourceAccount for the resource policies it is granted (KMS keys, SNS topics),
# not for its service-role trust, so a condition here would be unproven and could silently stop
# the backups. The role cannot be borrowed from outside: AWS Backup only uses a role passed by
# a principal of this account with iam:PassRole, and only the deployer may pass it.
#
# Its permissions are inline and limited to what one RDS instance snapshot needs, instead of the
# AWS managed AWSBackupServiceRolePolicyForBackup (59 statements over 20 services, including
# iam:PassRole). The workload boundary caps it further, and it is explicitly denied the
# Terraform state key.

resource "aws_backup_vault" "main" {
  name        = local.backup_vault
  kms_key_arn = aws_kms_key.data.arn

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_backup_plan" "monthly" {
  name = "${local.prefix}-monthly"

  rule {
    rule_name         = "monthly-12-months"
    target_vault_name = aws_backup_vault.main.name

    # 03:00 UTC on the 1st: clear of the RDS backup window (00:30-01:00) and the Sunday
    # maintenance window (02:00-02:30).
    schedule                     = "cron(0 3 1 * ? *)"
    schedule_expression_timezone = "Etc/UTC"
    start_window                 = 60
    completion_window            = 720

    lifecycle {
      delete_after = 365
    }
  }
}

resource "aws_iam_role" "backup" {
  name                 = "${local.prefix}-backup"
  path                 = "/munaxa-docs/eu-prod/"
  description          = "AWS Backup service role: monthly snapshot of the Production database"
  permissions_boundary = local.workload_boundary_arn
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AwsBackupService"
      Effect    = "Allow"
      Principal = { Service = "backup.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

data "aws_iam_policy_document" "backup" {
  statement {
    sid = "SnapshotTheProductionDatabase"
    actions = [
      "rds:CreateDBSnapshot",
      "rds:AddTagsToResource",
      "rds:ListTagsForResource",
    ]
    resources = [
      aws_db_instance.main.arn,
      "arn:aws:rds:${var.region}:${var.account_id}:snapshot:awsbackup:*",
    ]
  }

  # Recovery points are deleted by AWS Backup when they reach the end of their retention.
  statement {
    sid       = "ExpireBackupSnapshots"
    actions   = ["rds:DeleteDBSnapshot"]
    resources = ["arn:aws:rds:${var.region}:${var.account_id}:snapshot:awsbackup:*"]
  }

  statement {
    sid = "DescribeDatabaseAndSnapshots"
    actions = [
      "rds:DescribeDBInstances",
      "rds:DescribeDBSnapshots",
      "tag:GetResources",
    ]
    resources = ["*"]
  }

  statement {
    sid = "ProductionVault"
    actions = [
      "backup:DescribeBackupVault",
      "backup:CopyIntoBackupVault",
    ]
    resources = [aws_backup_vault.main.arn]
  }

  # The database and its snapshots are encrypted with the data key; grants only for AWS
  # resources, never for a principal.
  statement {
    sid       = "DescribeDataKey"
    actions   = ["kms:DescribeKey"]
    resources = [aws_kms_key.data.arn]
  }

  statement {
    sid       = "GrantDataKeyToAwsResourcesOnly"
    actions   = ["kms:CreateGrant"]
    resources = [aws_kms_key.data.arn]

    condition {
      test     = "Bool"
      variable = "kms:GrantIsForAWSResource"
      values   = ["true"]
    }
  }

  statement {
    sid       = "NeverTheTerraformStateKey"
    effect    = "Deny"
    actions   = ["kms:*"]
    resources = [data.aws_kms_alias.terraform_state.target_key_arn]
  }
}

resource "aws_iam_role_policy" "backup" {
  name   = "${local.prefix}-backup-rds-snapshots"
  role   = aws_iam_role.backup.id
  policy = data.aws_iam_policy_document.backup.json
}

resource "aws_backup_selection" "database" {
  name         = "${local.prefix}-pg"
  plan_id      = aws_backup_plan.monthly.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_db_instance.main.arn]
}
