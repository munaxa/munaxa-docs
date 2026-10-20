# TEST foundation state, in the TEST account's bucket under eu-test/foundation/. Administrator only:
# the bucket policy admits the TEST deployer to eu-test/session/* and nothing else, so the deployer
# can neither read nor change this state. Nothing Production can reach it.
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
