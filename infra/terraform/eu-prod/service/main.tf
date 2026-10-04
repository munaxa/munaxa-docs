# The service root: edge, task definitions, services, schedules and alarms. NOT IMPLEMENTED YET:
# this change adds only the root's backend, provider, conventions and the release inputs.
#
# Every container image is referenced by immutable digest only (see variables.tf and
# release.auto.tfvars.example). Resources from other roots are found by name or tag, never with
# terraform_remote_state and never by a Non-Production identifier.

locals {
  prefix             = "munaxa-docs-eu-prod"
  cluster_name       = local.prefix
  cloudmap_namespace = "prod.munaxa-docs.internal"
  web_hostname       = "docs.munaxa.com"
}
