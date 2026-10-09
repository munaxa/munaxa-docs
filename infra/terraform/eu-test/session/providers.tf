# Runs as the TEST deployer (account 657878534449) only. Every resource carries Lifecycle=ephemeral
# and ExpiresAt, so anything left behind is recognisable and the expiry check can find it.
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]

  assume_role {
    role_arn        = "arn:aws:iam::${var.account_id}:role/munaxa-docs/bootstrap/munaxa-docs-eu-test-deployer"
    session_name    = var.deployer_session_name
    source_identity = var.deployer_source_identity
  }

  default_tags {
    tags = {
      Project     = "MunaxaDocs"
      Environment = "Testing"
      ManagedBy   = "Terraform"
      Stack       = "session"
      Lifecycle   = "ephemeral"
      Owner       = "munaxa-docs-ci"
      ExpiresAt   = var.expires_at
    }
  }
}
