# The bootstrap root stores its own state in the bucket it creates, under a key the deployer role
# can never read or write (see the state bucket policy and guardrail policy A).
#
# First run only: the bucket does not exist yet. Follow the "First bootstrap apply" procedure in
# ../README.md (apply with local state, then `terraform init -migrate-state`).
#
# This root is applied by an administrator identity, never by the deployer role, so the backend
# has no assume_role block.
terraform {
  backend "s3" {
    bucket              = "munaxa-docs-tfstate-eu-prod-800728620253"
    key                 = "bootstrap/terraform.tfstate"
    region              = "eu-central-1"
    encrypt             = true
    kms_key_id          = "arn:aws:kms:eu-central-1:800728620253:alias/munaxa-docs-eu-prod-tfstate"
    use_lockfile        = true
    allowed_account_ids = ["800728620253"]
  }
}
