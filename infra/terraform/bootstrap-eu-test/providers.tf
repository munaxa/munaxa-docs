# The Testing bootstrap runs as an administrator identity in the munaxa-nonprod account
# (657878534449) directly. The provider refuses every other account, so it can never touch
# Production (800728620253).
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project     = "MunaxaDocs"
      Environment = "Testing"
      ManagedBy   = "Terraform"
      Stack       = "bootstrap"
    }
  }
}
