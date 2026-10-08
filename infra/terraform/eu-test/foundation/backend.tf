# TEST foundation state, in the TEST account's bucket under eu-test/, which the TEST deployer may use
# and nothing Production can reach. The deployer role is assumed through partial backend
# configuration (../ci.s3.tfbackend for GitHub Actions).
terraform {
  backend "s3" {
    bucket              = "munaxa-docs-tfstate-eu-test-657878534449"
    key                 = "eu-test/foundation/terraform.tfstate"
    region              = "eu-central-1"
    encrypt             = true
    kms_key_id          = "arn:aws:kms:eu-central-1:657878534449:alias/munaxa-docs-eu-test-tfstate"
    use_lockfile        = true
    allowed_account_ids = ["657878534449"]
  }
}
