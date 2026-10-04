# State lives in the Production state bucket under eu-prod/core/. The deployer role is assumed
# through partial backend configuration, so the identity is chosen at init time:
#
#   terraform init -backend-config=../claude.s3.tfbackend
#
# (or a copy of it with the break-glass identity; see ../../README.md).
terraform {
  backend "s3" {
    bucket              = "munaxa-docs-tfstate-eu-prod-800728620253"
    key                 = "eu-prod/core/terraform.tfstate"
    region              = "eu-central-1"
    encrypt             = true
    kms_key_id          = "arn:aws:kms:eu-central-1:800728620253:alias/munaxa-docs-eu-prod-tfstate"
    use_lockfile        = true
    allowed_account_ids = ["800728620253"]
  }
}
