# The Production document bucket (ADR-0024 §2.5, §2.12). Only the API task role (core) reads and
# writes objects, with ECS task-role credentials; browsers use presigned URLs from the web origin.
#
# SSE-S3: the storage adapter sends no encryption header and relies on the bucket default, as
# validated in Non-Production. The API task role therefore needs no KMS permission.

resource "aws_s3_bucket" "docs" {
  bucket = local.docs_bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "docs" {
  bucket = aws_s3_bucket.docs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "docs" {
  bucket = aws_s3_bucket.docs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "docs" {
  bucket = aws_s3_bucket.docs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Abort incomplete multipart uploads after a day. Noncurrent versions expire after 90 days, but
# the 3 newest noncurrent versions of every object are always kept (owner retention decision).
resource "aws_s3_bucket_lifecycle_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id

  rule {
    id     = "multipart-and-noncurrent-versions"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }

    noncurrent_version_expiration {
      noncurrent_days           = 90
      newer_noncurrent_versions = 3
    }
  }

  depends_on = [aws_s3_bucket_versioning.docs]
}

# Browser uploads and downloads through presigned URLs, from the Production web origin only.
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

# HTTPS only, and the bucket can never be deleted while this policy stands.
resource "aws_s3_bucket_policy" "docs" {
  bucket = aws_s3_bucket.docs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.docs.arn,
          "${aws_s3_bucket.docs.arn}/*",
        ]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "DenyBucketDeletion"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:DeleteBucket"
        Resource  = aws_s3_bucket.docs.arn
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.docs]
}
