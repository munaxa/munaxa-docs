locals {
  prefix = "munaxa-docs-eu-test"

  # Same path conventions as Production: the deployer and CI role live under bootstrap/ and can
  # never change it; the workload roles the Testing deployer manages live under eu-test/.
  bootstrap_path = "/munaxa-docs/bootstrap/"

  deployer_role_name     = "${local.prefix}-deployer"
  deployer_role_arn      = "arn:aws:iam::${var.account_id}:role${local.bootstrap_path}${local.deployer_role_name}"
  deployer_boundary_name = "${local.prefix}-deployer-boundary"
  workload_boundary_name = "${local.prefix}-workload-boundary"
  state_bucket           = "munaxa-docs-tfstate-eu-test-${var.account_id}"
  state_key_alias        = "alias/${local.prefix}-tfstate"
  # This account has no Munaxa trail bucket; the name is still denied to the deployer, so one can
  # never be created or taken over by it.
  cloudtrail_bucket  = "munaxa-docs-cloudtrail-${var.account_id}"
  cloudmap_namespace = "test.munaxa-docs.internal"

  state_admin_principal_arns = concat(var.state_admin_principal_arns, ["arn:aws:iam::${var.account_id}:root"])

  # The account's default VPC (if any) plus any extras. IAM rejects an empty resource list, so with
  # nothing to protect a well-formed ID that cannot exist stands in.
  protected_vpc_ids = coalescelist(
    concat(data.aws_vpcs.default.ids, var.extra_protected_vpc_ids),
    ["vpc-00000000000000000"],
  )

  policy_documents      = module.deployer_policies.documents
  deployer_policy_names = module.deployer_policies.deployer_policy_names
}

data "aws_vpcs" "default" {
  filter {
    name   = "is-default"
    values = ["true"]
  }
}
