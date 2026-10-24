# Daily scanner replacement (ADR-0024 §2.7): a fresh task downloads current signatures at start.
# EventBridge Scheduler calls ecs:UpdateService with forceNewDeployment on the scanner service only,
# as the core `scheduler` role, which is trusted only for this schedule group and allowed only
# ecs:UpdateService on service/munaxa-docs-eu-prod/munaxa-docs-eu-prod-scanner.

resource "aws_scheduler_schedule_group" "main" {
  count = var.enable_services ? 1 : 0

  name = local.prefix
}

resource "aws_scheduler_schedule" "scanner_refresh" {
  count = var.enable_services ? 1 : 0

  name       = "${local.prefix}-scanner-refresh"
  group_name = aws_scheduler_schedule_group.main[0].name

  # 04:30 UTC daily: after the RDS backup window (00:30–01:00) and maintenance (Sun 02:00–02:30).
  schedule_expression          = "cron(30 4 * * ? *)"
  schedule_expression_timezone = "Etc/UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ecs:updateService"
    role_arn = data.aws_iam_role.core["scheduler"].arn

    input = jsonencode({
      Cluster            = aws_ecs_cluster.main.name
      Service            = aws_ecs_service.scanner[0].name
      ForceNewDeployment = true
    })

    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 3600
    }
  }
}
