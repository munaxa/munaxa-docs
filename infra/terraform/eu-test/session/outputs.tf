# Read by the session workflow (no secret values here).
output "test_url" {
  value = "https://${var.test_hostname}"
}

output "release_commit" {
  value = var.release_commit
}

output "expires_at" {
  value = var.expires_at
}

output "tenant_id" {
  value = local.tenant_id
}

output "tenant_slug" {
  value = local.bootstrap_tenant.slug
}

output "tenant_database" {
  value = local.bootstrap_tenant.database
}

output "db_address" {
  value = aws_db_instance.main.address
}

output "docs_bucket" {
  value = local.docs_bucket
}

output "secret_arns" {
  value = module.app.secret_arns
}

output "ops_network" {
  description = "awsvpc settings for operator tasks: public subnets, the ops group, a public IP (no NAT)."
  value = {
    subnets         = sort(data.aws_subnets.public.ids)
    security_groups = [data.aws_security_group.tier["ops"].id]
  }
}

output "task_definition_families" {
  value = module.app.task_definition_families
}
