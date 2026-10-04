# The service root: edge, task definitions, services, schedules (ADR-0024 §2.1–§2.8).
#
# | File          | Contents                                                                        |
# | ------------- | ------------------------------------------------------------------------------- |
# | secrets.tf    | The three Secrets Manager containers (no values) and their key contract         |
# | ecs.tf        | Cluster, log groups, Cloud Map, the three task definitions and services          |
# | edge.tf       | ACM certificate, ALB, target groups, listeners                                  |
# | schedule.tf   | Daily scanner replacement (EventBridge Scheduler)                                |
#
# It is applied in stages, so nothing is created that would fail or loop while an input is missing:
#
# | Stage                    | Creates                                                               |
# | ------------------------ | --------------------------------------------------------------------- |
# | default                  | Secrets (empty), log groups, cluster, Cloud Map, certificate request, |
# |                          | ALB and target groups with no listener, task definitions              |
# | enable_https = true      | Waits for the certificate to be ISSUED; HTTPS listener, the preview   |
# |                          | rule and the HTTP→HTTPS redirect                                      |
# | enable_services = true   | The web, API and scanner services and the scanner refresh schedule    |
#
# Every container image is referenced by immutable digest only. Resources from other roots are found
# by name or tag, never with terraform_remote_state and never by a Non-Production identifier. No
# VPC, subnet, security group, database, bucket, key or IAM role is created here.

locals {
  prefix             = "munaxa-docs-eu-prod"
  cluster_name       = local.prefix
  cloudmap_namespace = "prod.munaxa-docs.internal"
  web_hostname       = "docs.munaxa.com"
  web_origin         = "https://${local.web_hostname}"
  docs_bucket        = "${local.prefix}-docs-${var.account_id}"
  log_group_prefix   = "/munaxa-docs/eu-prod"

  # The ALB and every task live in the public subnets. Both TRUST_PROXY settings name exactly those
  # ranges: the only hops in front of the API and web are the ALB and the web tasks.
  public_subnet_cidrs = sort([for s in data.aws_subnet.public : s.cidr_block])

  api_dns     = "api.${local.cloudmap_namespace}"
  scanner_dns = "scanner.${local.cloudmap_namespace}"
}

data "aws_vpc" "production" {
  tags = {
    Name        = local.prefix
    Environment = "Production"
    Stack       = "core"
  }
}

data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.production.id]
  }

  tags = {
    Tier        = "public"
    Environment = "Production"
  }
}

data "aws_subnet" "public" {
  for_each = toset(data.aws_subnets.public.ids)
  id       = each.value
}

data "aws_security_group" "tier" {
  for_each = toset(["alb", "web", "api", "scanner"])

  vpc_id = data.aws_vpc.production.id
  name   = "${local.prefix}-${each.key}"
}

# Roles from the core root, by name.
data "aws_iam_role" "core" {
  for_each = toset([
    "web-execution",
    "api-execution",
    "scanner-execution",
    "api-task",
    "scheduler",
  ])

  name = "${local.prefix}-${each.key}"
}

# The Production data key (data root). Secrets are encrypted with it so the execution roles' reviewed
# kms:Decrypt (Environment=Production, never Stack=bootstrap, via Secrets Manager only) applies.
data "aws_kms_alias" "data" {
  name = "alias/${local.prefix}"
}
