output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "alb_zone_id" {
  value = aws_lb.main.zone_id
}

output "alb_arn" {
  value = aws_lb.main.arn
}

output "secret_arns" {
  description = "Secret containers whose values the session workflow writes (never read back)."
  value = {
    ghcr_pull = aws_secretsmanager_secret.ghcr_pull.arn
    app       = aws_secretsmanager_secret.app.arn
    operator  = aws_secretsmanager_secret.operator.arn
  }
}

output "task_definition_families" {
  value = {
    ops_dbadmin   = aws_ecs_task_definition.ops_dbadmin.family
    ops_tunnel    = aws_ecs_task_definition.ops_tunnel.family
    ops_provision = aws_ecs_task_definition.ops_provision.family
  }
}
