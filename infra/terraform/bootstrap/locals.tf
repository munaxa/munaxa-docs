locals {
  prefix = "munaxa-docs-eu-prod"

  # Paths: the deployer lives under bootstrap/ and can never change it; the workload roles it
  # manages live under eu-prod/.
  bootstrap_path = "/munaxa-docs/bootstrap/"
  workload_path  = "/munaxa-docs/eu-prod/"

  deployer_role_name         = "${local.prefix}-deployer"
  deployer_role_arn          = "arn:aws:iam::${var.account_id}:role${local.bootstrap_path}${local.deployer_role_name}"
  deployer_boundary_name     = "${local.prefix}-deployer-boundary"
  workload_boundary_name     = "${local.prefix}-workload-boundary"
  workload_boundary_arn      = "arn:aws:iam::${var.account_id}:policy${local.bootstrap_path}${local.workload_boundary_name}"
  state_bucket               = "munaxa-docs-tfstate-eu-prod-${var.account_id}"
  state_key_alias            = "alias/${local.prefix}-tfstate"
  cloudtrail_bucket          = "munaxa-docs-cloudtrail-${var.account_id}"
  cloudtrail_name            = "munaxa-docs-account-trail"
  cloudmap_namespace         = "prod.munaxa-docs.internal"
  state_admin_principal_arns = [var.claude_principal_arn, var.break_glass_principal_arn, "arn:aws:iam::${var.account_id}:root"]

  # The deployer's policies and both boundaries, rendered by the shared module (also used by the
  # Testing bootstrap). For Production the documents are byte-identical to the ones bootstrap
  # rendered before the templates moved into the module.
  policy_documents      = module.deployer_policies.documents
  deployer_policy_names = module.deployer_policies.deployer_policy_names
}
