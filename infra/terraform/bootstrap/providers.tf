# Bootstrap runs as an administrator identity (claude-munaxa-docs or admin.tamer) directly.
# It is the only root that does not assume the deployer role: it creates that role.
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project     = "MunaxaDocs"
      Environment = "Production"
      ManagedBy   = "Terraform"
      Stack       = "bootstrap"
    }
  }
}

# Cost Explorer (cost allocation tags) is served from us-east-1 only.
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project     = "MunaxaDocs"
      Environment = "Production"
      ManagedBy   = "Terraform"
      Stack       = "bootstrap"
    }
  }
}
