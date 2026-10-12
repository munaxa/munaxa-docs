output "role_arn" {
  description = "The CI role ARN, known at plan time (constructed). Depend on this module before naming it in a trust policy."
  value       = local.role_arn
}

output "provider_arn" {
  description = "The GitHub OIDC provider ARN, known at plan time (constructed)."
  value       = local.provider_arn
}

output "trust_policy" {
  description = "The CI role's trust policy, for review."
  value       = data.aws_iam_policy_document.trust.json
}

output "permissions_policy" {
  description = "The CI role's only permission (also its boundary), for review."
  value       = data.aws_iam_policy_document.permissions.json
}
