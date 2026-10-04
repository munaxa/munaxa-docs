# The Production data key. It encrypts the database, its snapshots, Performance Insights, the
# RDS-managed master secret and the backup vault. A customer-managed key rather than aws/rds
# because an instance's key cannot be changed after creation, and snapshots under aws/rds cannot
# be shared with another account (a later move to a separate Production account).
#
# Not the Terraform state key: that is created by bootstrap, carries Stack=bootstrap, and every
# workload role is denied it. The document bucket uses SSE-S3 (s3.tf), so the API task role needs
# no KMS permission.
#
# The policy delegates to IAM only. Who may use the key is decided by identity policies and the
# boundaries: the deployer (Environment=Production keys), the ops-dbadmin execution role (decrypt
# through Secrets Manager) and the backup role.
resource "aws_kms_key" "data" {
  description             = "Munaxa Docs Production data: RDS, snapshots, RDS master secret, backup vault"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DelegateToIamPoliciesInThisAccount"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })

  tags = { Name = local.prefix }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.prefix}"
  target_key_id = aws_kms_key.data.key_id
}
