output "execution_role_arns" {
  description = "ECS execution roles, by task: web, api, scanner, ops-dbadmin, ops-provision, ops-tunnel."
  value       = { for k, r in aws_iam_role.execution : k => r.arn }
}

output "api_task_role_arn" {
  description = "Task role for the API service and the tenant-provisioning task (Production document bucket only)."
  value       = aws_iam_role.api_task.arn
}

output "ops_tunnel_task_role_arn" {
  description = "Task role for the migration tunnel task (ECS Exec channels only)."
  value       = aws_iam_role.ops_tunnel_task.arn
}

output "scheduler_role_arn" {
  description = "EventBridge Scheduler role for the Production schedule group (scanner refresh)."
  value       = aws_iam_role.scheduler.arn
}
