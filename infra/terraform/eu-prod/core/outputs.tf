output "execution_role_arns" {
  description = "ECS execution roles by tier."
  value       = { for k, r in aws_iam_role.execution : k => r.arn }
}

output "api_task_role_arn" {
  description = "The API task role (Production document bucket only)."
  value       = aws_iam_role.api_task.arn
}

output "ops_tunnel_task_role_arn" {
  description = "The operator tunnel task role (ECS Exec channels only)."
  value       = aws_iam_role.ops_tunnel_task.arn
}

output "scheduler_role_arn" {
  description = "The EventBridge Scheduler role (scanner refresh)."
  value       = aws_iam_role.scheduler.arn
}

output "backup_role_arn" {
  description = "The AWS Backup service role."
  value       = aws_iam_role.backup.arn
}
