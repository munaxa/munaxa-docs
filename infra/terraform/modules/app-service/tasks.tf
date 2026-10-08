# Task definitions and services. Sizes, ports, health checks and deployment settings are those of the
# Production service root (#131), so TEST exercises exactly what Production will run.
#
# Every task definition sets skip_destroy: a replacement registers a new revision and leaves the old
# one ACTIVE (a rollback target). Registered task definitions cost nothing, so a destroyed TEST
# session leaves only inert revisions behind.

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.prefix}-web"
  skip_destroy             = true
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 1024
  execution_role_arn       = var.role_arns["web-execution"]

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name                   = "web"
    image                  = var.web_image
    essential              = true
    repositoryCredentials  = local.repository_credentials
    readonlyRootFilesystem = false
    portMappings           = [{ containerPort = 3000, protocol = "tcp" }]
    environment = [for k, v in {
      NODE_ENV            = "production"
      PORT                = "3000"
      NEXT_PUBLIC_API_URL = "http://${local.api_dns}:3001"
      WEB_TRUST_PROXY     = join(",", sort(var.public_subnet_cidrs))
    } : { name = k, value = v }]
    logConfiguration = local.log_options["web"]
  }])
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.prefix}-api"
  skip_destroy             = true
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 2048
  execution_role_arn       = var.role_arns["api-execution"]
  task_role_arn            = var.role_arns["api-task"]

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
      repositoryCredentials  = local.repository_credentials
      readonlyRootFilesystem = false
      portMappings           = [{ containerPort = 3001, protocol = "tcp" }]
      environment            = [for k, v in local.api_environment : { name = k, value = v }]
      secrets = [
        for key in var.app_secret_keys : { name = key, valueFrom = local.app_secret_ref[key] }
        if key != "REDIS_PASSWORD"
      ]
      dependsOn = [{ containerName = "redis", condition = "HEALTHY" }]
      healthCheck = {
        command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/api/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
      logConfiguration = local.log_options["api"]
    },
    merge(local.redis_container, { essential = true, logConfiguration = local.log_options["redis"] }),
  ])
}

resource "aws_ecs_task_definition" "scanner" {
  family                   = "${var.prefix}-scanner"
  skip_destroy             = true
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 2048
  execution_role_arn       = var.role_arns["scanner-execution"]

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name                  = "scanner"
    image                 = var.antivirus_image
    essential             = true
    repositoryCredentials = local.repository_credentials
    portMappings          = [{ containerPort = 1344, protocol = "tcp" }]
    # A real scan through c-icap and clamd, not an ICAP OPTIONS ping. The start period covers the
    # first signature download into the task's own storage.
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

# --- Operator tasks (registered; started by the session workflow or an operator) -------------

locals {
  operator_secret_ref = {
    for key in ["EDMS_OWNER_PASSWORD", "EDMS_APP_PASSWORD", "EDMS_BACKUP_PASSWORD"] :
    key => "${aws_secretsmanager_secret.operator.arn}:${key}::"
  }

  # A temporary per-run secret, referenced by name because its random suffix is unknown in advance.
  provision_secret_ref = {
    for key in ["TENANT_ID", "ADMIN_EMAIL", "ADMIN_NAME", "ADMIN_PASSWORD"] :
    key => "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${local.tenant_secret_prefix}:${key}::"
  }

  # Run as the RDS master user; idempotent. infra/sql/cluster/01-roles.sql verbatim, passwords read
  # with \getenv so they never appear in an argument list or in the task definition.
  dbadmin_sql = join("\n", [
    "\\set ON_ERROR_STOP on",
    "DO $$ BEGIN SET log_min_error_statement TO panic; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'log_min_error_statement unchanged'; END $$;",
    "-- infra/sql/cluster/01-roles.sql",
    file("${path.module}/../../../sql/cluster/01-roles.sql"),
    "\\getenv owner_pw EDMS_OWNER_PASSWORD",
    "\\getenv app_pw EDMS_APP_PASSWORD",
    "\\getenv backup_pw EDMS_BACKUP_PASSWORD",
    "\\getenv tenant_db TENANT_DATABASE",
    "-- A password given as KEEP is left as it is (a TEST session rotating only the owner password).",
    "SELECT :'owner_pw' <> 'KEEP' AS set_owner, :'app_pw' <> 'KEEP' AS set_app, :'backup_pw' <> 'KEEP' AS set_backup \\gset",
    "\\if :set_owner",
    "ALTER ROLE edms_owner PASSWORD :'owner_pw';",
    "\\endif",
    "\\if :set_app",
    "ALTER ROLE edms_app PASSWORD :'app_pw';",
    "\\endif",
    "SELECT 'CREATE ROLE edms_backup LOGIN BYPASSRLS' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edms_backup') \\gexec",
    "\\if :set_backup",
    "ALTER ROLE edms_backup PASSWORD :'backup_pw';",
    "\\endif",
    "GRANT pg_read_all_data TO edms_backup;",
    "GRANT edms_owner TO CURRENT_USER WITH SET TRUE;",
    "SELECT format('CREATE DATABASE %I OWNER edms_owner', :'tenant_db') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'tenant_db') \\gexec",
    "SELECT current_setting('server_version') AS server_version, current_setting('max_connections') AS max_connections, current_setting('rds.force_ssl', true) AS force_ssl;",
    "SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname LIKE 'edms_%' ORDER BY rolname;",
    "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = :'tenant_db';",
  ])
}

resource "aws_ecs_task_definition" "ops_dbadmin" {
  family                   = "${var.prefix}-ops-dbadmin"
  skip_destroy             = true
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = var.role_arns["ops-dbadmin-execution"]

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name       = "dbadmin"
    image      = var.postgres_image
    essential  = true
    user       = "999:999"
    entryPoint = ["sh", "-c"]
    command    = ["printf '%s\\n' \"$DBADMIN_SQL\" | psql -X -q"]
    environment = [for k, v in {
      PGHOST          = var.db_address
      PGPORT          = tostring(var.db_port)
      PGDATABASE      = "postgres"
      PGSSLMODE       = "require"
      PGAPPNAME       = "munaxa-docs-ops-dbadmin"
      TENANT_DATABASE = var.bootstrap_tenant.database
      DBADMIN_SQL     = local.dbadmin_sql
    } : { name = k, value = v }]
    secrets = concat(
      [
        { name = "PGUSER", valueFrom = "${var.master_secret_arn}:username::" },
        { name = "PGPASSWORD", valueFrom = "${var.master_secret_arn}:password::" },
      ],
      [for k, v in local.operator_secret_ref : { name = k, valueFrom = v }],
    )
    logConfiguration = local.ops_log
  }])
}

resource "aws_ecs_task_definition" "ops_tunnel" {
  family                   = "${var.prefix}-ops-tunnel"
  skip_destroy             = true
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = var.role_arns["ops-tunnel-execution"]
  task_role_arn            = var.role_arns["ops-tunnel-task"]

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  # No inbound traffic; an SSM port-forward through ECS Exec reaches the database. Stops itself
  # after one hour.
  container_definitions = jsonencode([{
    name             = "tunnel"
    image            = var.tunnel_image
    essential        = true
    command          = ["sleep", "3600"]
    linuxParameters  = { initProcessEnabled = true }
    logConfiguration = local.ops_log
  }])
}

resource "aws_ecs_task_definition" "ops_provision" {
  family                   = "${var.prefix}-ops-provision"
  skip_destroy             = true
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 2048
  execution_role_arn       = var.role_arns["ops-provision-execution"]
  task_role_arn            = var.role_arns["api-task"]

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  # The API image running provision.js in its single-tenant form (finding D-1).
  container_definitions = jsonencode([
    {
      name                  = "provision"
      image                 = var.api_image
      essential             = true
      memory                = 1792
      repositoryCredentials = local.repository_credentials
      command               = ["node", "apps/api/dist/provision.js"]
      environment = [for k, v in merge(local.api_environment, {
        DEPLOYMENT_PROFILE      = "ON_PREMISE"
        QUEUE_CONSUMERS_ENABLED = "false"
        TENANT_SLUG             = var.bootstrap_tenant.slug
        TENANT_NAME             = var.bootstrap_tenant.name
      }) : { name = k, value = v }]
      secrets = concat(
        [
          for key in var.app_secret_keys : { name = key, valueFrom = local.app_secret_ref[key] }
          if !contains(["REDIS_PASSWORD", "TENANT_CATALOGUE"], key)
        ],
        [for k, v in local.provision_secret_ref : { name = k, valueFrom = v }],
      )
      dependsOn        = [{ containerName = "redis", condition = "HEALTHY" }]
      logConfiguration = local.ops_log
    },
    merge(local.redis_container, { essential = false, logConfiguration = local.ops_log }),
  ])
}

# --- Services ---------------------------------------------------------------------------------

resource "aws_ecs_service" "web" {
  count = var.enable_services ? 1 : 0

  name                              = "${var.prefix}-web"
  cluster                           = var.cluster_name
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
    security_groups  = [var.security_group_ids["web"]]
    assign_public_ip = local.task_network.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "api" {
  count = var.enable_services ? 1 : 0

  name                              = "${var.prefix}-api"
  cluster                           = var.cluster_name
  task_definition                   = aws_ecs_task_definition.api.arn
  desired_count                     = 1
  health_check_grace_period_seconds = 120
  propagate_tags                    = "SERVICE"
  enable_ecs_managed_tags           = true

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  # Stop-first: queue consumers never run in two API processes at once (Redis lives in the task).
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.task_network.subnets
    security_groups  = [var.security_group_ids["api"]]
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
}

resource "aws_ecs_service" "scanner" {
  count = var.enable_services ? 1 : 0

  name                    = "${var.prefix}-scanner"
  cluster                 = var.cluster_name
  task_definition         = aws_ecs_task_definition.scanner.arn
  desired_count           = 1
  propagate_tags          = "SERVICE"
  enable_ecs_managed_tags = true

  capacity_provider_strategy {
    capacity_provider = var.scanner_capacity_provider
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
    security_groups  = [var.security_group_ids["scanner"]]
    assign_public_ip = local.task_network.assign_public_ip
  }

  service_registries {
    registry_arn = aws_service_discovery_service.internal["scanner"].arn
  }
}
