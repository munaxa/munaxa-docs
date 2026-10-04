output "db_instance_identifier" {
  description = "The Production PostgreSQL instance."
  value       = aws_db_instance.main.identifier
}

output "db_endpoint" {
  description = "The instance endpoint (host:port). Connections require TLS."
  value       = aws_db_instance.main.endpoint
}

output "db_master_user_secret_arn" {
  description = "The RDS-managed master secret (ARN only; the value is never read by Terraform)."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "data_kms_key_arn" {
  description = "The Production data key (alias/munaxa-docs-eu-prod)."
  value       = aws_kms_key.data.arn
}

output "docs_bucket" {
  description = "The Production document bucket."
  value       = aws_s3_bucket.docs.bucket
}

output "backup_vault_arn" {
  description = "The AWS Backup vault holding the monthly snapshots."
  value       = aws_backup_vault.main.arn
}

output "backup_role_arn" {
  description = "The AWS Backup service role."
  value       = aws_iam_role.backup.arn
}
