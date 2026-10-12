# The ECS cluster and log groups cost nothing while nothing runs, so they stay. Logs are kept for 7
# days, which is long enough to troubleshoot a session after it has been destroyed.

resource "aws_ecs_cluster" "main" {
  name = local.prefix

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

resource "aws_cloudwatch_log_group" "service" {
  for_each = toset(["web", "api", "redis", "scanner", "ops"])

  name              = "${local.log_group_prefix}/${each.key}"
  retention_in_days = 7
}
