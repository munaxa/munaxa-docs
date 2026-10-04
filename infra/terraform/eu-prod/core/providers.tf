# Every Production root runs as the deployer role, never as an IAM user directly.
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]

  assume_role {
    role_arn        = "arn:aws:iam::${var.account_id}:role/munaxa-docs/bootstrap/munaxa-docs-eu-prod-deployer"
    session_name    = var.deployer_session_name
    source_identity = var.deployer_source_identity
  }

  default_tags {
    tags = {
      Project     = "MunaxaDocs"
      Environment = "Production"
      ManagedBy   = "Terraform"
      Stack       = "core"
    }
  }
}
