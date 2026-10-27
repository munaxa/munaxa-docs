# ECS on Fargate (ADR-0024 §2.1, §2.4, §2.6, §2.7).
#
# | Service | Size            | Capacity     | Roles (core)                          | Reached by           |
# | ------- | --------------- | ------------ | ------------------------------------- | -------------------- |
# | web     | 0.25 vCPU, 1 GB | FARGATE      | web-execution; no task role           | ALB :3000            |
# | api     | 0.5 vCPU, 2 GB  | FARGATE      | api-execution; api-task (S3 only)     | ALB (preview), web   |
# |         |   + Redis 7 sidecar on 127.0.0.1:6379, password from the app bundle                    |
# | scanner | 0.25 vCPU, 2 GB | FARGATE_SPOT | scanner-execution; no task role       | API :1344 (ICAP)     |
#
# Tasks run in the public subnets with a public IPv4 address and no NAT (§2.2); the core security
# groups are the only inbound control, and only the ALB group admits the internet.
#
# Images come from ECR by digest (ADR-0024 amendment, 2026-10-22). The execution roles pull them
# with IAM, so no container has repositoryCredentials and no registry credential exists. Image
# layers are fetched through the S3 gateway endpoint (core network.tf).

locals {
  # A secret reference with a JSON key, optionally pinned to a version (ADR-0022 consequence 8).
  app_secret_ref = {
    for key in local.app_secret_keys :
    key => "${aws_secretsmanager_secret.app.arn}:${key}::${var.app_secret_version_id}"
  }

  log_options = {
    for name in ["web", "api", "redis", "scanner"] : name => {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service[name].name
        awslogs-region        = var.region
        awslogs-stream-prefix = name
      }
    }
  }

  api_environment = {
    NODE_ENV                   = "production"
    PORT                       = "3001"
    NODE_OPTIONS               = "--max-old-space-size=1280"
    LOG_LEVEL                  = "info"
    DEPLOYMENT_PROFILE         = "CLOUD"
    DATABASE_POOL_SIZE         = "5"
    QUEUE_CONSUMERS_ENABLED    = "true"
    CORS_ORIGINS               = local.web_origin
    WEB_BASE_URL               = local.web_origin
    TRUST_PROXY                = join(",", local.public_subnet_cidrs)
    STORAGE_DRIVER             = "S3"
    STORAGE_BUCKET             = local.docs_bucket
    STORAGE_REGION             = var.region
    STORAGE_CREDENTIALS_SOURCE = "ECS_TASK_ROLE"
    STORAGE_PUBLIC_URL         = local.web_origin
    MAIL_DRIVER                = "RESEND"
    MAIL_FROM_ADDRESS          = var.mail_from_address
    AV_DRIVER                  = "ICAP"
    AV_ICAP_URL                = "icap://${local.scanner_dns}:1344/avscan"
    OPENAPI_ENABLED            = "false"
    METRICS_DRIVER             = "PROMETHEUS"
  }

  # Runtime hardening. Every service container drops all Linux capabilities: each runs as a non-root
  # user (web and api as `node`, the scanner as clamav 101:102, Redis as 999:999), none switches user
  # or binds a privileged port, and the images carry no setuid program. web and api also run on a
  # read-only root filesystem with no writable mount: neither writes to its filesystem in Production
  # (S3 storage, no LibreOffice or Tesseract in the api image). The scanner and Redis keep a writable
  # one: the scanner writes signatures, pid files, logs and scan files under /var and /tmp, and a
  # Fargate volume there would be root-owned unless the image declared it (a VOLUME), which is an
  # image change; Redis writes its password file to /tmp. The release smoke runs the stack the same
  # way (scripts/release-smoke/run.sh).
  #
  # Container definitions are written the way ECS stores them, so a plan compares like with like:
  # ECS records an empty `add` beside `drop`, and in awsvpc mode a hostPort equal to the
  # containerPort. Written any other way, every plan after the first replaces the task definition
  # (run 40305141933 replaced api, ops_provision, scanner and web for exactly these two fields).
  no_capabilities = { capabilities = { add = [], drop = ["ALL"] } }

  # Redis reads its password from the environment and writes it to a config file with a shell
  # built-in, so it never appears in a process argument list.
  redis_command = join(" && ", [
    "umask 077",
    "printf 'requirepass %s\\n' \"$REDIS_PASSWORD\" > /tmp/redis.conf",
    "exec redis-server /tmp/redis.conf --bind 127.0.0.1 --port 6379 --protected-mode yes --maxmemory 192mb --maxmemory-policy noeviction --save '' --appendonly no",
  ])
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = toset(["web", "api", "redis", "scanner", "ops"])

  name              = "${local.log_group_prefix}/${each.key}"
  retention_in_days = 30
}

resource "aws_ecs_cluster" "main" {
  name = local.cluster_name

  # Container Insights is not deployed at launch (ADR-0024 §2.11).
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = local.cloudmap_namespace
  description = "Munaxa Docs Production service discovery"
  vpc         = data.aws_vpc.production.id
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

# --- Task definitions -------------------------------------------------------------------------

# Every task definition sets skip_destroy: a replacement registers a new revision and leaves the
# old one ACTIVE (a rollback target). The deployer has no ecs:DeregisterTaskDefinition, which AWS
# evaluates on "*" and so could not be kept away from Non-Prod.

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.prefix}-web"
  skip_destroy             = true
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 1024
  execution_role_arn       = data.aws_iam_role.core["web-execution"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name                   = "web"
    image                  = var.web_image
    essential              = true
    readonlyRootFilesystem = true
    linuxParameters        = local.no_capabilities
    portMappings           = [{ containerPort = 3000, hostPort = 3000, protocol = "tcp" }]
    environment = [for k, v in {
      NODE_ENV            = "production"
      PORT                = "3000"
      NEXT_PUBLIC_API_URL = "http://${local.api_dns}:3001"
      WEB_TRUST_PROXY     = join(",", local.public_subnet_cidrs)
    } : { name = k, value = v }]
    logConfiguration = local.log_options["web"]
  }])
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.prefix}-api"
  skip_destroy             = true
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 2048
  execution_role_arn       = data.aws_iam_role.core["api-execution"].arn
  task_role_arn            = data.aws_iam_role.core["api-task"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name                   = "api"
      image                  = var.api_image
      essential              = true
      memory                 = 1792
      readonlyRootFilesystem = true
      linuxParameters        = local.no_capabilities
      portMappings           = [{ containerPort = 3001, hostPort = 3001, protocol = "tcp" }]
      environment            = [for k, v in local.api_environment : { name = k, value = v }]
      secrets = [
        for key in local.app_secret_keys : { name = key, valueFrom = local.app_secret_ref[key] }
        if key != "REDIS_PASSWORD"
      ]
      dependsOn = [{ containerName = "redis", condition = "HEALTHY" }]
      # The image's own HEALTHCHECK, which ECS does not read from the image.
      healthCheck = {
        command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/api/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
      logConfiguration = local.log_options["api"]
    },
    {
      name                   = "redis"
      image                  = var.redis_image
      essential              = true
      memory                 = 256
      user                   = "999:999"
      readonlyRootFilesystem = false # it writes its password file to /tmp (redis_command)
      linuxParameters        = local.no_capabilities
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
      logConfiguration = local.log_options["redis"]
    },
  ])
}

resource "aws_ecs_task_definition" "scanner" {
  family                   = "${local.prefix}-scanner"
  skip_destroy             = true
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 2048
  execution_role_arn       = data.aws_iam_role.core["scanner-execution"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name            = "scanner"
    image           = var.antivirus_image
    essential       = true
    linuxParameters = local.no_capabilities
    portMappings    = [{ containerPort = 1344, hostPort = 1344, protocol = "tcp" }]
    # A real scan through c-icap and clamd, not an ICAP OPTIONS ping (§2.7). The start period covers
    # the first signature download into the task's own storage (no EFS).
    healthCheck = {
      command     = ["CMD-SHELL", "c-icap-client -i 127.0.0.1 -p 1344 -s avscan -f /etc/hostname -resp http://probe/ -v 2>&1 | grep -q 'ICAP/1.0 204'"]
      interval    = 30
      timeout     = 10
      retries     = 5
      startPeriod = 300
    }
    logConfiguration = local.log_options["scanner"]
  }])
}

# --- Services (enable_services only) ------------------------------------------------------------

locals {
  task_network = {
    subnets          = sort(data.aws_subnets.public.ids)
    assign_public_ip = true
  }
}

resource "aws_ecs_service" "web" {
  count = var.enable_services ? 1 : 0

  name                              = "${local.prefix}-web"
  cluster                           = aws_ecs_cluster.main.arn
  task_definition                   = aws_ecs_task_definition.web.arn
  desired_count                     = 1
  health_check_grace_period_seconds = 60
  propagate_tags                    = "SERVICE"
  enable_ecs_managed_tags           = true

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.task_network.subnets
    security_groups  = [data.aws_security_group.tier["web"].id]
    assign_public_ip = local.task_network.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.https]

  lifecycle {
    precondition {
      condition     = var.enable_https
      error_message = "enable_services requires enable_https: services are never exposed without the HTTPS listener."
    }
  }
}

resource "aws_ecs_service" "api" {
  count = var.enable_services ? 1 : 0

  name                              = "${local.prefix}-api"
  cluster                           = aws_ecs_cluster.main.arn
  task_definition                   = aws_ecs_task_definition.api.arn
  desired_count                     = 1
  health_check_grace_period_seconds = 120
  propagate_tags                    = "SERVICE"
  enable_ecs_managed_tags           = true

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  # Stop-first: queue consumers never run in two API processes at once, and Redis lives in the task
  # (ADR-0024 §2.1, §2.6).
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.task_network.subnets
    security_groups  = [data.aws_security_group.tier["api"].id]
    assign_public_ip = local.task_network.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3001
  }

  service_registries {
    registry_arn = aws_service_discovery_service.internal["api"].arn
  }

  depends_on = [aws_lb_listener_rule.preview_stream, aws_ecs_service.scanner]

  lifecycle {
    precondition {
      condition     = var.enable_https
      error_message = "enable_services requires enable_https."
    }
  }
}

resource "aws_ecs_service" "scanner" {
  count = var.enable_services ? 1 : 0

  name                    = "${local.prefix}-scanner"
  cluster                 = aws_ecs_cluster.main.arn
  task_definition         = aws_ecs_task_definition.scanner.arn
  desired_count           = 1
  propagate_tags          = "SERVICE"
  enable_ecs_managed_tags = true

  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.task_network.subnets
    security_groups  = [data.aws_security_group.tier["scanner"].id]
    assign_public_ip = local.task_network.assign_public_ip
  }

  service_registries {
    registry_arn = aws_service_discovery_service.internal["scanner"].arn
  }

  depends_on = [aws_ecs_cluster_capacity_providers.main]
}
