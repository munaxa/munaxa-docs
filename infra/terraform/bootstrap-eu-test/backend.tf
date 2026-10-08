# The Testing bootstrap root stores its own state in the bucket it creates (account 657878534449),
# under a key the Testing deployer can never read or write.
#
# First run only: the bucket does not exist yet. Follow "Testing bootstrap" in ../README.md (apply
# with local state, then `terraform init -migrate-state`), exactly as for Production.
#
# Applied by an administrator identity in the munaxa-nonprod account, never by a deployer or by CI,
# so the backend has no assume_role block.
terraform {
  backend "s3" {
    bucket              = "munaxa-docs-tfstate-eu-test-657878534449"
    key                 = "bootstrap/terraform.tfstate"
    region              = "eu-central-1"
    encrypt             = true
    kms_key_id          = "arn:aws:kms:eu-central-1:657878534449:alias/munaxa-docs-eu-test-tfstate"
    use_lockfile        = true
    allowed_account_ids = ["657878534449"]
  }
}
