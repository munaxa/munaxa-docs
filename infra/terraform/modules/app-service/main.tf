# The Munaxa Docs application stack on ECS Fargate: secret containers, Cloud Map, the ALB and its
# listeners, the web/API/scanner task definitions and services, and the three short-lived operator
# task definitions (database administration, migration tunnel, tenant provisioning).
#
# Derived from the Production service root in #131 (eu-prod/service: secrets.tf, ecs.tf, edge.tf,
# ops.tf) without changing what it builds; only environment-specific values are variables. TEST
# (eu-test/session) uses it today. Production keeps its own root until #131 merges, then moves onto
# this module with `moved` blocks, accepted only if its plan shows no changes.
#
# Every container image is pinned by digest. No VPC, subnet, security group, database, bucket, key
# or IAM role is created here.

locals {
  web_origin  = "https://${var.web_hostname}"
  api_dns     = "api.${var.cloudmap_namespace}"
  scanner_dns = "scanner.${var.cloudmap_namespace}"

  version_suffix = var.app_secret_version_id == null ? "" : var.app_secret_version_id
  app_secret_ref = {
    for key in var.app_secret_keys :
    key => "${aws_secretsmanager_secret.app.arn}:${key}::${local.version_suffix}"
  }

  repository_credentials = { credentialsParameter = aws_secretsmanager_secret.ghcr_pull.arn }

  log_options = {
    for name in ["web", "api", "redis", "scanner"] : name => {
      logDriver = "awslogs"
      options = {
        awslogs-group         = "${var.log_group_prefix}/${name}"
        awslogs-region        = var.region
        awslogs-stream-prefix = name
      }
    }
  }

  ops_log = {
    logDriver = "awslogs"
    options = {
      awslogs-group         = "${var.log_group_prefix}/ops"
      awslogs-region        = var.region
      awslogs-stream-prefix = "ops"
    }
  }

  api_environment = merge({
    NODE_ENV                   = "production"
    PORT                       = "3001"
    NODE_OPTIONS               = "--max-old-space-size=1280"
    LOG_LEVEL                  = "info"
    DEPLOYMENT_PROFILE         = "CLOUD"
    DATABASE_POOL_SIZE         = "5"
    QUEUE_CONSUMERS_ENABLED    = "true"
    CORS_ORIGINS               = local.web_origin
    WEB_BASE_URL               = local.web_origin
    TRUST_PROXY                = join(",", sort(var.public_subnet_cidrs))
    STORAGE_DRIVER             = "S3"
    STORAGE_BUCKET             = var.docs_bucket
    STORAGE_REGION             = var.region
    STORAGE_CREDENTIALS_SOURCE = "ECS_TASK_ROLE"
    STORAGE_PUBLIC_URL         = local.web_origin
    AV_DRIVER                  = "ICAP"
    AV_ICAP_URL                = "icap://${local.scanner_dns}:1344/avscan"
    OPENAPI_ENABLED            = "false"
    METRICS_DRIVER             = "PROMETHEUS"
  }, var.mail_environment)

  # Redis reads its password from the environment and writes it to a config file with a shell
  # built-in, so it never appears in a process argument list.
  redis_command = join(" && ", [
    "umask 077",
    "printf 'requirepass %s\\n' \"$REDIS_PASSWORD\" > /tmp/redis.conf",
    "exec redis-server /tmp/redis.conf --bind 127.0.0.1 --port 6379 --protected-mode yes --maxmemory 192mb --maxmemory-policy noeviction --save '' --appendonly no",
  ])

  redis_container = {
    name                   = "redis"
    image                  = var.redis_image
    memory                 = 256
    user                   = "999:999"
    readonlyRootFilesystem = false
    entryPoint             = ["sh", "-c"]
    command                = [local.redis_command]
    secrets                = [{ name = "REDIS_PASSWORD", valueFrom = local.app_secret_ref["REDIS_PASSWORD"] }]
    healthCheck = {
      command     = ["CMD-SHELL", "REDISCLI_AUTH=\"$REDIS_PASSWORD\" redis-cli -h 127.0.0.1 ping | grep -q PONG"]
      interval    = 10
      timeout     = 5
      retries     = 3
      startPeriod = 10
    }
  }

  task_network = {
    subnets          = sort(var.public_subnet_ids)
    assign_public_ip = true
  }

  tenant_secret_prefix = "${var.prefix}/provision/${var.bootstrap_tenant.slug}"
}

# --- Secret containers (no values; values are written outside Terraform) ---------------------

resource "aws_secretsmanager_secret" "ghcr_pull" {
  name                    = "${var.prefix}/ghcr-pull"
  description             = "Read-only GHCR pull identity for ghcr.io/munaxa/munaxa-docs-*: {\"username\",\"password\"}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${var.prefix}/app"
  description             = "API application bundle; keys: ${join(", ", var.app_secret_keys)}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret" "operator" {
  name                    = "${var.prefix}/operator"
  description             = "Operator bundle: EDMS_OWNER_PASSWORD, EDMS_APP_PASSWORD, EDMS_BACKUP_PASSWORD. Never read by the API"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.secret_recovery_window_days
}

# --- Service discovery ------------------------------------------------------------------------

resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = var.cloudmap_namespace
  description = "Munaxa Docs ${var.environment} service discovery"
  vpc         = var.vpc_id
}

resource "aws_service_discovery_service" "internal" {
  for_each = toset(["api", "scanner"])

  name = each.key

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

# --- Edge -------------------------------------------------------------------------------------

resource "aws_lb" "main" {
  name                       = "${var.prefix}-alb"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [var.security_group_ids["alb"]]
  subnets                    = sort(var.public_subnet_ids)
  ip_address_type            = "ipv4"
  enable_deletion_protection = var.alb_deletion_protection
  drop_invalid_header_fields = true
  idle_timeout               = 120

  tags = merge({ Name = var.prefix }, var.alb_tags)
}

resource "aws_lb_target_group" "web" {
  name                 = "${var.prefix}-web"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/login"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_target_group" "api" {
  name                 = "${var.prefix}-api"
  port                 = 3001
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/api/health/live"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "preview_stream" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  condition {
    path_pattern {
      values = ["/api/v1/preview/stream*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# There is never an HTTP-only listener: port 80 only redirects.
resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }

  depends_on = [aws_lb_listener.https]
}
