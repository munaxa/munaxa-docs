output "documents" {
  description = "Minified policy documents by name: the deployer policies, deployer-boundary and workload-boundary."
  value       = local.documents
}

output "deployer_policy_names" {
  description = "The policies attached to the deployer (everything except the two boundaries)."
  value       = local.deployer_documents
}

output "workload_boundary_arn" {
  description = "The boundary every workload role in this environment must carry."
  value       = local.workload_boundary_arn
}
