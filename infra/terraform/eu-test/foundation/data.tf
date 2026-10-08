# TEST data that is cheap to keep and costly or impossible to recreate per session.
#
# - The data key (USD 1 a month): encrypts each session's database, its RDS-managed master secret and
#   its session secrets, exactly as Production's data key does, so the workload boundary's
#   "Environment=Testing keys only" rule applies unchanged.
# - The document bucket: the deployer may configure but never empty a document bucket (its guardrail
#   denies object access), so it cannot be destroyed per session. Instead every object expires after
#   7 days; an idle TEST stores nothing.

resource "aws_kms_key" "data" {
  description             = "Munaxa Docs TEST data (RDS, session secrets)"
  enable_key_rotation     = true
  deletion_window_in_days = 7
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.prefix}"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_s3_bucket" "docs" {
  bucket = local.docs_bucket
}

resource "aws_s3_bucket_ownership_controls" "docs" {
  bucket = aws_s3_bucket.docs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "docs" {
  bucket                  = aws_s3_bucket.docs.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id

  rule {
    id     = "test-documents-expire-after-7-days"
    status = "Enabled"

    filter {}

    expiration {
      days = 7
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# Browser uploads and downloads go straight to the bucket by presigned URL, from the TEST origin only.
resource "aws_s3_bucket_cors_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id

  cors_rule {
    allowed_origins = [local.web_origin]
    allowed_methods = ["GET", "PUT"]
    allowed_headers = ["content-type", "x-amz-checksum-sha256"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_policy" "docs" {
  bucket = aws_s3_bucket.docs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.docs.arn, "${aws_s3_bucket.docs.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.docs]
}

# Free to keep; each session's database uses it. Same TLS rule as Production: every connection uses
# TLS (sslmode=require).
resource "aws_db_parameter_group" "main" {
  name        = "${local.prefix}-pg16"
  family      = "postgres16"
  description = "Munaxa Docs TEST PostgreSQL 16"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
}
