# PostgreSQL 16, db.t4g.micro, Single-AZ (ADR-0024 §2.5). Private: isolated subnets with local
# routes only, not publicly accessible, reachable on 5432 only from the API and operator security
# groups (core). No NAT is involved.
#
# The master password is generated, stored and rotated by RDS in Secrets Manager
# (manage_master_user_password); it never appears in Terraform or its state. No application
# database, role or tenant database is created here: that is a later, controlled operator step
# (§2.10).

resource "aws_db_subnet_group" "main" {
  name        = local.db_subnet_grp
  description = "Munaxa Docs Production isolated database subnets"
  subnet_ids  = data.aws_subnets.db.ids

  lifecycle {
    precondition {
      condition     = length(data.aws_subnets.db.ids) == 3
      error_message = "Expected the three Production DB subnets from the core root."
    }
  }
}

# A custom group, so later parameter changes never need a group swap. rds.force_ssl=1: every
# connection must use TLS (sslmode=require, ADR-0024 §2.5).
resource "aws_db_parameter_group" "main" {
  name        = local.db_param_group
  family      = "postgres16"
  description = "Munaxa Docs Production PostgreSQL 16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

# Created before the instance so the exported PostgreSQL log has a bounded retention.
resource "aws_cloudwatch_log_group" "postgresql" {
  name              = "/aws/rds/instance/${local.db_identifier}/postgresql"
  retention_in_days = 30
}

resource "aws_db_instance" "main" {
  identifier     = local.db_identifier
  engine         = "postgres"
  engine_version = "16.12"
  instance_class = "db.t4g.micro"

  # Minor versions are applied deliberately, after Non-Production.
  auto_minor_version_upgrade  = false
  allow_major_version_upgrade = false

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.data.arn

  username                      = "munaxa_master"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.data.arn

  multi_az               = false
  availability_zone      = "${var.region}a"
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [data.aws_security_group.rds.id]
  publicly_accessible    = false
  port                   = 5432
  parameter_group_name   = aws_db_parameter_group.main.name

  backup_retention_period   = 35
  backup_window             = "00:30-01:00"
  maintenance_window        = "sun:02:00-sun:02:30"
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.db_identifier}-final"

  # Performance Insights at the free 7-day retention; no Enhanced Monitoring.
  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  performance_insights_kms_key_id       = aws_kms_key.data.arn
  monitoring_interval                   = 0

  enabled_cloudwatch_logs_exports = ["postgresql"]

  depends_on = [aws_cloudwatch_log_group.postgresql]

  lifecycle {
    prevent_destroy = true
  }
}
