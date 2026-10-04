# Production names. Every Production resource is found by these names or by its tags, never by
# another root's state and never by anything Non-Production.
locals {
  prefix        = "munaxa-docs-eu-prod"
  workload_path = "/munaxa-docs/eu-prod/"

  # Created by bootstrap; referenced by its fixed ARN rather than read from bootstrap state.
  workload_boundary_arn = "arn:aws:iam::${var.account_id}:policy/munaxa-docs/bootstrap/${local.prefix}-workload-boundary"

  cluster_arn       = "arn:aws:ecs:${var.region}:${var.account_id}:cluster/${local.prefix}"
  docs_bucket       = "${local.prefix}-docs-${var.account_id}"
  log_group_prefix  = "/munaxa-docs/eu-prod"
  secret_arn_prefix = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${local.prefix}"

  # Secret containers (created later, values supplied outside Terraform). The trailing -* matches
  # the six random characters Secrets Manager appends to every secret ARN.
  secret_arns = {
    ghcr_pull = "${local.secret_arn_prefix}/ghcr-pull-*"
    app       = "${local.secret_arn_prefix}/app-*"
    operator  = "${local.secret_arn_prefix}/operator-*"
    provision = "${local.secret_arn_prefix}/provision/*"
  }

  # The RDS-managed master secret is named rds!db-<uuid>; it is only ever matched together with
  # the Environment=Production tag RDS copies onto it.
  rds_managed_secret_arn = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:rds!*"
}
