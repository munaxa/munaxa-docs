output "deployer_role_arn" {
  description = "The role every Testing root assumes."
  value       = aws_iam_role.deployer.arn
}

output "ci_role_arn" {
  description = "The role GitHub Actions (testing environment, main) assumes through OIDC."
  value       = module.testing_ci.role_arn
}

output "ci_trust_policy" {
  description = "The Testing CI role's trust policy, for review."
  value       = module.testing_ci.trust_policy
}

output "deployer_trust_policy" {
  description = "The Testing deployer's trust policy, for review."
  value       = data.aws_iam_policy_document.deployer_trust.json
}

output "workload_boundary_arn" {
  description = "The boundary every Testing workload role must carry."
  value       = aws_iam_policy.workload_boundary.arn
}

output "state_bucket" {
  description = "The Testing Terraform state bucket."
  value       = aws_s3_bucket.state.id
}

output "state_kms_key_arn" {
  description = "The key that encrypts Testing Terraform state."
  value       = aws_kms_key.state.arn
}

output "protected_vpc_ids" {
  description = "VPCs the Testing deployer is denied."
  value       = local.protected_vpc_ids
}

output "policy_sizes" {
  description = "Minified size of each managed policy (limit 6,144)."
  value       = { for name, doc in local.policy_documents : name => length(doc) }
}
