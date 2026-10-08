# TEST session state. Created at the start of a TEST session and emptied by its destroy; nothing in
# it is meant to outlive the session.
terraform {
  backend "s3" {
    bucket              = "munaxa-docs-tfstate-eu-test-657878534449"
    key                 = "eu-test/session/terraform.tfstate"
    region              = "eu-central-1"
    encrypt             = true
    kms_key_id          = "arn:aws:kms:eu-central-1:657878534449:alias/munaxa-docs-eu-test-tfstate"
    use_lockfile        = true
    allowed_account_ids = ["657878534449"]
  }
}
