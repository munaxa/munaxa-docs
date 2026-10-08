# Every TEST root runs as the TEST deployer (account 657878534449), never as a user directly. The
# provider refuses every other account, so nothing here can ever reach Production.
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
      Stack       = "foundation"
      Lifecycle   = "persistent"
      Owner       = "munaxa-docs-ci"
    }
  }
}
