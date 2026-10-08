output "deployer_role_arn" {
  description = "The role every Production root assumes."
  value       = aws_iam_role.deployer.arn
}

output "ci_role_arn" {
  description = "The role GitHub Actions (production environment) assumes through OIDC."
  value       = aws_iam_role.ci.arn
}

output "workload_boundary_arn" {
  description = "The boundary every Production workload role must carry."
  value       = aws_iam_policy.workload_boundary.arn
}

output "state_bucket" {
  description = "The Production Terraform state bucket."
  value       = aws_s3_bucket.state.id
}

output "state_kms_key_arn" {
  description = "The key that encrypts Production Terraform state."
  value       = aws_kms_key.state.arn
}

output "cloudtrail_bucket" {
  description = "The account trail's bucket."
  value       = aws_s3_bucket.cloudtrail.id
}

output "policy_sizes" {
  description = "Minified size of each managed policy (limit 6,144)."
  value       = { for name, doc in local.policy_documents : name => length(doc) }
}
