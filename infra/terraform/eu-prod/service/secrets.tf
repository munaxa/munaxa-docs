# Secrets Manager containers (ADR-0024 §2.8). Terraform creates the containers only:
# no secret version, no value, nothing in state. Values are written by an operator from their own
# machine (docs/operations/production-service-inputs.md) and are never in git.
#
# | Secret                         | Read by (core execution roles)          | JSON keys            |
# | ------------------------------ | --------------------------------------- | -------------------- |
# | munaxa-docs-eu-prod/app        | api, ops-provision (never web/scanner)  | local.app_secret_keys|
# | munaxa-docs-eu-prod/operator   | ops-dbadmin only (never the API)        | see the inputs doc   |
#
# Images come from ECR and are pulled with IAM, so there is no registry secret. Email is sent with
# Resend (MAIL_DRIVER=RESEND, owner decision); its API key is a key of the application bundle, so
# the API reads it without any secret it does not already need. The RDS master secret is RDS-managed
# (data root) and read by ops-dbadmin only.

locals {
  # Every key the API and its Redis sidecar read from the application bundle. A missing key stops
  # the task at start, before the application runs.
  app_secret_keys = [
    "DATABASE_URL",
    "TENANT_CATALOGUE",
    "REDIS_URL",
    "REDIS_PASSWORD",
    "JWT_ACCESS_SECRET",
    "SIGNATURE_WITNESS_SECRET",
    "AUDIT_CHECKPOINT_SECRET",
    "MFA_TOTP_SEALING_KEY",
    "METRICS_SCRAPE_TOKEN",
    "MAIL_RESEND_API_KEY",
    # The Docs deployment's service credential from Munaxa Control (mxc_…, at least 32 characters;
    # LICENSING_MODE=CONTROL_PLANE in ecs.tf). Written to the bundle by an operator, like every key.
    "CONTROL_PLANE_TOKEN",
  ]
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.prefix}/app"
  description             = "API application bundle (ADR-0024 §2.8); keys listed in infra/terraform/eu-prod/service/secrets.tf"
  kms_key_id              = data.aws_kms_alias.data.target_key_arn
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret" "operator" {
  name                    = "${local.prefix}/operator"
  description             = "Operator bundle: edms_owner and edms_backup connection strings, operator catalogue. Never read by the API"
  kms_key_id              = data.aws_kms_alias.data.target_key_arn
  recovery_window_in_days = 30
}
