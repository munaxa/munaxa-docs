# Short-lived operator task definitions (ADR-0024 §2.10). Registered only; nothing here runs. An
# administrator starts each one by hand with `aws ecs run-task` (docs/operations/
# production-service-inputs.md §5), in the public subnets with the core `ops` security group
# (5432 to RDS and 443 out, nothing in) and a public IP, and each stops when its job is done.
#
# | Task           | Image                     | Execution role (core)    | Task role       | Does                                    |
# | -------------- | ------------------------- | ------------------------ | --------------- | --------------------------------------- |
# | ops-dbadmin    | postgres:16.12 (client)   | ops-dbadmin-execution    | none            | Cluster roles, the tenant database      |
# | ops-tunnel     | Amazon Linux 2023         | ops-tunnel-execution     | ops-tunnel-task | ECS Exec port-forward to RDS, 1 h max   |
# | ops-provision  | the API image + Redis     | ops-provision-execution  | api-task        | The tenant's first administrator (D-1)  |
#
# No credential is in this file. Passwords come from the `operator` bundle, the RDS-managed master
# secret, the `app` bundle and a temporary per-tenant provisioning secret, as ECS `secrets`.

data "aws_db_instance" "main" {
  db_instance_identifier = "${local.prefix}-pg"
}

locals {
  operator_secret_ref = {
    for key in ["EDMS_OWNER_PASSWORD", "EDMS_APP_PASSWORD", "EDMS_BACKUP_PASSWORD"] :
    key => "${aws_secretsmanager_secret.operator.arn}:${key}::"
  }

  master_secret_arn = data.aws_db_instance.main.master_user_secret[0].secret_arn

  # Temporary, created by the administrator for one provisioning run and deleted afterwards. The
  # random suffix is unknown in advance, so it is referenced by name (a partial ARN); the core
  # ops-provision execution role may read only munaxa-docs-eu-prod/provision/*.
  provision_secret_ref = {
    for key in ["TENANT_ID", "ADMIN_EMAIL", "ADMIN_NAME", "ADMIN_PASSWORD"] :
    key => "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${local.prefix}/provision/${var.bootstrap_tenant.slug}:${key}::"
  }

  ops_log = {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.service["ops"].name
      awslogs-region        = var.region
      awslogs-stream-prefix = "ops"
    }
  }

  # Run as the RDS master user. Idempotent: a re-run changes nothing but the three passwords. The
  # cluster roles are infra/sql/cluster/01-roles.sql verbatim; passwords are read with \getenv, so
  # they never appear in an argument list, in this file or in the task definition. Statement logging
  # of errors is turned off for the session where permitted, so a failed ALTER ROLE does not write a
  # password into the PostgreSQL log.
  dbadmin_sql = join("\n", [
    "\\set ON_ERROR_STOP on",
    "DO $$ BEGIN SET log_min_error_statement TO panic; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'log_min_error_statement unchanged'; END $$;",
    "-- infra/sql/cluster/01-roles.sql",
    file("${path.module}/../../../sql/cluster/01-roles.sql"),
    "\\getenv owner_pw EDMS_OWNER_PASSWORD",
    "\\getenv app_pw EDMS_APP_PASSWORD",
    "\\getenv backup_pw EDMS_BACKUP_PASSWORD",
    "\\getenv tenant_db TENANT_DATABASE",
    "ALTER ROLE edms_owner PASSWORD :'owner_pw';",
    "ALTER ROLE edms_app PASSWORD :'app_pw';",
    "-- Runbook §6 step 1b: reads through forced row-level security, writes nothing.",
    "SELECT 'CREATE ROLE edms_backup LOGIN BYPASSRLS' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edms_backup') \\gexec",
    "ALTER ROLE edms_backup PASSWORD :'backup_pw';",
    "GRANT pg_read_all_data TO edms_backup;",
    "-- PostgreSQL 16: the master needs SET on edms_owner before CREATE DATABASE ... OWNER (ADR-0024 probe).",
    "GRANT edms_owner TO CURRENT_USER WITH SET TRUE;",
    "SELECT format('CREATE DATABASE %I OWNER edms_owner', :'tenant_db') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'tenant_db') \\gexec",
    "SELECT current_setting('server_version') AS server_version, current_setting('max_connections') AS max_connections, current_setting('rds.force_ssl', true) AS force_ssl;",
    "SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname LIKE 'edms_%' ORDER BY rolname;",
    "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = :'tenant_db';",
  ])
}

resource "aws_ecs_task_definition" "ops_dbadmin" {
  family                   = "${local.prefix}-ops-dbadmin"
  skip_destroy             = true
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = data.aws_iam_role.ops["ops-dbadmin-execution"].arn

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
      PGHOST          = data.aws_db_instance.main.address
      PGPORT          = tostring(data.aws_db_instance.main.port)
      PGDATABASE      = "postgres"
      PGSSLMODE       = "require"
      PGAPPNAME       = "munaxa-docs-ops-dbadmin"
      TENANT_DATABASE = var.bootstrap_tenant.database
      DBADMIN_SQL     = local.dbadmin_sql
    } : { name = k, value = v }]
    secrets = concat(
      [
        { name = "PGUSER", valueFrom = "${local.master_secret_arn}:username::" },
        { name = "PGPASSWORD", valueFrom = "${local.master_secret_arn}:password::" },
      ],
      [for k, v in local.operator_secret_ref : { name = k, valueFrom = v }],
    )
    logConfiguration = local.ops_log
  }])
}

resource "aws_ecs_task_definition" "ops_tunnel" {
  family                   = "${local.prefix}-ops-tunnel"
  skip_destroy             = true
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = data.aws_iam_role.ops["ops-tunnel-execution"].arn
  task_role_arn            = data.aws_iam_role.ops["ops-tunnel-task"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  # Accepts no inbound traffic (no port mapping; the ops group admits nothing). The operator opens
  # an SSM port-forward to RDS through ECS Exec; the task stops itself after one hour.
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
  family                   = "${local.prefix}-ops-provision"
  skip_destroy             = true
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 2048
  execution_role_arn       = data.aws_iam_role.ops["ops-provision-execution"].arn
  task_role_arn            = data.aws_iam_role.core["api-task"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  # The API image running provision.js. Single-tenant form (finding D-1: the script cannot run beside
  # a catalogue), so the profile is ON_PREMISE for this one command; the tenant's storage prefix and
  # search index are its slug, matching the runtime catalogue. Queue consumers are off.
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
          for key in local.app_secret_keys : { name = key, valueFrom = local.app_secret_ref[key] }
          if !contains(["REDIS_PASSWORD", "TENANT_CATALOGUE"], key)
        ],
        [for k, v in local.provision_secret_ref : { name = k, valueFrom = v }],
      )
      dependsOn        = [{ containerName = "redis", condition = "HEALTHY" }]
      logConfiguration = local.ops_log
    },
    {
      name                   = "redis"
      image                  = var.redis_image
      essential              = false
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
      logConfiguration = local.ops_log
    },
  ])
}

data "aws_iam_role" "ops" {
  for_each = toset([
    "ops-dbadmin-execution",
    "ops-tunnel-execution",
    "ops-tunnel-task",
    "ops-provision-execution",
  ])

  name = "${local.prefix}-${each.key}"
}
