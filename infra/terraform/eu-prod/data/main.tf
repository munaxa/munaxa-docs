# The data root: everything that cannot be recreated (ADR-0024 §2.5 and §2.12).
#
# | File      | Contents                                                                           |
# | --------- | ---------------------------------------------------------------------------------- |
# | kms.tf    | The Production data key, alias/munaxa-docs-eu-prod                                  |
# | rds.tf    | PostgreSQL 16 db.t4g.micro, its subnet group, parameter group and log group        |
# | s3.tf     | The document bucket                                                                 |
# | backup.tf | AWS Backup vault, monthly plan (12 months), selection and the backup service role |
#
# Not here: managed Redis (Redis runs beside the API, §2.6), application secrets, tenant
# databases and roles (created later by short-lived operator tasks, §2.10).
#
# The network comes from the core root and is found by name and tag, never with
# terraform_remote_state and never by a Non-Production identifier. Every stateful resource
# carries lifecycle { prevent_destroy = true }.

locals {
  prefix         = "munaxa-docs-eu-prod"
  db_identifier  = "${local.prefix}-pg"
  db_subnet_grp  = "${local.prefix}-db"
  db_param_group = "${local.prefix}-pg16"
  docs_bucket    = "${local.prefix}-docs-${var.account_id}"
  backup_vault   = local.prefix
  web_origin     = "https://docs.munaxa.com"

  # Created by bootstrap; referenced by its fixed ARN rather than read from bootstrap state.
  workload_boundary_arn = "arn:aws:iam::${var.account_id}:policy/munaxa-docs/bootstrap/${local.prefix}-workload-boundary"
}

data "aws_vpc" "production" {
  tags = {
    Name        = local.prefix
    Environment = "Production"
    Stack       = "core"
  }
}

data "aws_subnets" "db" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.production.id]
  }

  tags = {
    Tier        = "db"
    Environment = "Production"
  }
}

data "aws_security_group" "rds" {
  vpc_id = data.aws_vpc.production.id
  name   = "${local.prefix}-rds"
}

# The Terraform state key, so the backup role can carry an explicit deny on it.
data "aws_kms_alias" "terraform_state" {
  name = "alias/${local.prefix}-tfstate"
}
