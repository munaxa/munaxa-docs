# The TEST foundation is persistent and administrator-controlled, like the bootstrap: it is planned and
# applied by admin.tamer through arn:aws:iam::657878534449:role/OrganizationAccountAccessRole
# (docs/operations/bootstrap-plan-runbooks.md), never by the TEST deployer or by CI. The TEST
# deployer may only read it; it builds and destroys TEST sessions on top of it
# (infra/terraform/eu-test/session). The provider refuses every account but 657878534449.
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project     = "MunaxaDocs"
      Environment = "Testing"
      ManagedBy   = "Terraform"
      Stack       = "foundation"
      Lifecycle   = "persistent"
      Owner       = "munaxa-docs-admin"
    }
  }
}
