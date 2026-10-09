# TEST names. Every TEST resource is found by these names or its tags; the session root
# (../session) looks them up the same way, never through another root's state.
locals {
  prefix           = "munaxa-docs-eu-test"
  workload_path    = "/munaxa-docs/eu-test/"
  log_group_prefix = "/munaxa-docs/eu-test"
  docs_bucket      = "${local.prefix}-docs-${var.account_id}"
  web_origin       = "https://${var.test_hostname}"

  # Created by the TEST bootstrap; referenced by its fixed ARN.
  workload_boundary_arn = "arn:aws:iam::${var.account_id}:policy/munaxa-docs/bootstrap/${local.prefix}-workload-boundary"

  secret_arn_prefix = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${local.prefix}"
  # Session secrets are created and destroyed with each TEST session; the trailing -* matches the
  # random suffix Secrets Manager appends.
  secret_arns = {
    ghcr_pull = "${local.secret_arn_prefix}/ghcr-pull-*"
    app       = "${local.secret_arn_prefix}/app-*"
    operator  = "${local.secret_arn_prefix}/operator-*"
    provision = "${local.secret_arn_prefix}/provision/*"
  }
  rds_managed_secret_arn = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:rds!*"

  azs = ["${var.region}a", "${var.region}b"]
}
