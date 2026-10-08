# One TEST session: everything that costs money by the hour, created when a release needs testing
# and destroyed after production promotion or at ExpiresAt, whichever comes first.
#
# | Created here (ephemeral)                       | Found by name/tag (persistent foundation)   |
# | ---------------------------------------------- | ------------------------------------------- |
# | PostgreSQL 16 db.t4g.micro (no backups)        | VPC, subnets, security groups               |
# | ALB, HTTPS listener, target groups             | ECS cluster, log groups                     |
# | DNS record test.docs.munaxa.com → ALB          | hosted zone, ACM certificate (ISSUED)       |
# | Cloud Map namespace                            | workload IAM roles, data key, doc bucket    |
# | Secret containers (values written by CI)       | DB subnet group, parameter group            |
# | web, API (+Redis), scanner services            |                                             |
# | operator task definitions                      |                                             |
#
# The database is disposable on purpose: every session starts from an empty database, migrated and
# provisioned automatically by the session workflow. Nothing here holds data worth keeping.

locals {
  prefix             = "munaxa-docs-eu-test"
  cloudmap_namespace = "test.munaxa-docs.internal"
  log_group_prefix   = "/munaxa-docs/eu-test"
  docs_bucket        = "${local.prefix}-docs-${var.account_id}"
  db_identifier      = "${local.prefix}-pg"

  bootstrap_tenant = {
    slug     = "munaxa-internal"
    name     = "Munaxa Internal (TEST)"
    database = "edms_munaxa_internal"
  }

  # Stable for the environment: every session's database is new, so one fixed id is enough and the
  # catalogue, the provisioning run and the database always agree.
  tenant_id = uuidv5("dns", "munaxa-internal.test.munaxa-docs.internal")

  # TEST never sends email (MAIL_DRIVER=NONE), so it needs no SMTP credential and cannot mail anyone.
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
  ]
}

# --- Persistent foundation, by name and tag ---------------------------------------------------

data "aws_vpc" "main" {
  tags = { Name = local.prefix, Environment = "Testing", Stack = "foundation" }
}

data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.main.id]
  }

  tags = { Tier = "public", Environment = "Testing" }
}

data "aws_subnet" "public" {
  for_each = toset(data.aws_subnets.public.ids)
  id       = each.value
}

data "aws_security_group" "tier" {
  for_each = toset(["alb", "web", "api", "scanner", "ops", "db"])

  vpc_id = data.aws_vpc.main.id
  name   = "${local.prefix}-${each.key}"
}

data "aws_iam_role" "workload" {
  for_each = toset([
    "web-execution", "api-execution", "scanner-execution", "api-task",
    "ops-dbadmin-execution", "ops-tunnel-execution", "ops-tunnel-task", "ops-provision-execution",
  ])

  name = "${local.prefix}-${each.key}"
}

data "aws_kms_alias" "data" {
  name = "alias/${local.prefix}"
}

data "aws_route53_zone" "test" {
  name         = var.test_hostname
  private_zone = false
}

# A session never starts before Cloudflare has delegated the name and ACM has issued the certificate.
data "aws_acm_certificate" "test" {
  domain      = var.test_hostname
  statuses    = ["ISSUED"]
  most_recent = true
}

data "aws_ecs_cluster" "main" {
  cluster_name = local.prefix
}

# --- The session's database -------------------------------------------------------------------

resource "aws_db_instance" "main" {
  identifier     = local.db_identifier
  engine         = "postgres"
  engine_version = "16.12"
  instance_class = "db.t4g.micro"

  auto_minor_version_upgrade  = false
  allow_major_version_upgrade = false

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true
  kms_key_id        = data.aws_kms_alias.data.target_key_arn

  username                      = "munaxa_master"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = data.aws_kms_alias.data.target_key_arn

  multi_az               = false
  availability_zone      = "${var.region}a"
  db_subnet_group_name   = "${local.prefix}-db"
  vpc_security_group_ids = [data.aws_security_group.tier["db"].id]
  publicly_accessible    = false
  port                   = 5432
  parameter_group_name   = "${local.prefix}-pg16"

  # Disposable: no backups, no final snapshot, no deletion protection. Nothing here is kept.
  backup_retention_period  = 0
  delete_automated_backups = true
  deletion_protection      = false
  skip_final_snapshot      = true

  performance_insights_enabled = false
  monitoring_interval          = 0
}

# --- The application ------------------------------------------------------------------------

module "app" {
  source = "../../modules/app-service"

  prefix          = local.prefix
  environment     = "Testing"
  account_id      = var.account_id
  region          = var.region
  web_hostname    = var.test_hostname
  certificate_arn = data.aws_acm_certificate.test.arn
  cluster_name    = data.aws_ecs_cluster.main.cluster_name

  vpc_id              = data.aws_vpc.main.id
  public_subnet_ids   = data.aws_subnets.public.ids
  public_subnet_cidrs = [for s in data.aws_subnet.public : s.cidr_block]
  security_group_ids  = { for k in ["alb", "web", "api", "scanner", "ops"] : k => data.aws_security_group.tier[k].id }
  role_arns           = { for k, r in data.aws_iam_role.workload : k => r.arn }

  kms_key_arn                 = data.aws_kms_alias.data.target_key_arn
  secret_recovery_window_days = 0
  log_group_prefix            = local.log_group_prefix
  cloudmap_namespace          = local.cloudmap_namespace
  docs_bucket                 = local.docs_bucket

  db_address        = aws_db_instance.main.address
  db_port           = aws_db_instance.main.port
  master_secret_arn = aws_db_instance.main.master_user_secret[0].secret_arn
  bootstrap_tenant  = local.bootstrap_tenant

  app_secret_keys       = local.app_secret_keys
  app_secret_version_id = null
  mail_environment      = { MAIL_DRIVER = "NONE" }

  web_image       = var.web_image
  api_image       = var.api_image
  antivirus_image = var.antivirus_image
  redis_image     = var.redis_image
  postgres_image  = var.postgres_image
  tunnel_image    = var.tunnel_image

  enable_services           = var.enable_services
  alb_deletion_protection   = false
  scanner_capacity_provider = "FARGATE_SPOT"
  alb_tags                  = { ReleaseCommit = var.release_commit }
}

# test.docs.munaxa.com → this session's load balancer. The name stays; only its target changes.
resource "aws_route53_record" "web" {
  zone_id = data.aws_route53_zone.test.zone_id
  name    = var.test_hostname
  type    = "A"

  alias {
    name                   = module.app.alb_dns_name
    zone_id                = module.app.alb_zone_id
    evaluate_target_health = false
  }
}
