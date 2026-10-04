# The data root: everything that cannot be recreated. NOT IMPLEMENTED YET: this change adds only
# the root's backend, provider and conventions.
#
# When resources are added here, each of these is required (ADR-0024 §2.5 and §2.12):
#
# - RDS PostgreSQL 16 `munaxa-docs-eu-prod-pg`: `manage_master_user_password = true` (no password
#   in Terraform or its state; no random_password resources), `storage_encrypted = true` with the
#   Production KMS key, `deletion_protection = true`, `backup_retention_period = 35`,
#   `skip_final_snapshot = false`, `publicly_accessible = false`, `copy_tags_to_snapshot = true`,
#   and `lifecycle { prevent_destroy = true }`.
# - S3 document bucket `munaxa-docs-eu-prod-docs-<account id>`: versioning, Block Public Access,
#   BucketOwnerEnforced, HTTPS-only policy, CORS for the Production web origin only,
#   `prevent_destroy`.
# - AWS Backup vault and monthly plan, using the backup role from the core root.
#
# Resources from other roots are found by name or tag (for example `data "aws_subnets"` filtered
# on `tag:Name` and `tag:Environment=Production`), never with terraform_remote_state and never by
# a Non-Production identifier.

locals {
  prefix         = "munaxa-docs-eu-prod"
  db_identifier  = "${local.prefix}-pg"
  db_subnet_grp  = "${local.prefix}-db"
  db_param_group = "${local.prefix}-pg16"
  docs_bucket    = "${local.prefix}-docs-${var.account_id}"
  backup_vault   = local.prefix
}
