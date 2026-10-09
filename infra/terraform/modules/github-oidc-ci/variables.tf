variable "account_id" {
  description = "The account the OIDC provider and CI role are created in."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "role_name" {
  description = "Name of the CI role, e.g. munaxa-docs-eu-prod-ci."
  type        = string

  validation {
    condition     = can(regex("^munaxa-docs-eu-(prod|test)-ci$", var.role_name))
    error_message = "role_name must be munaxa-docs-eu-prod-ci or munaxa-docs-eu-test-ci."
  }
}

variable "role_path" {
  description = "IAM path of the CI role and its boundary (administrator-managed, never the deployer's)."
  type        = string
  default     = "/munaxa-docs/bootstrap/"
}

variable "github_repository" {
  description = "owner/name of the only repository whose jobs may assume the role."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "Use owner/name, with no wildcard."
  }
}

variable "github_environment" {
  description = "The only GitHub environment whose jobs may assume the role."
  type        = string

  validation {
    condition     = contains(["production", "testing"], var.github_environment)
    error_message = "github_environment must be production or testing."
  }
}

variable "github_ref" {
  description = "The only Git ref whose runs may assume the role."
  type        = string
  default     = "refs/heads/main"

  validation {
    condition     = can(regex("^refs/heads/[A-Za-z0-9._/-]+$", var.github_ref)) && !strcontains(var.github_ref, "*")
    error_message = "Use one exact branch ref (refs/heads/<name>), with no wildcard."
  }
}

variable "deployer_role_arn" {
  description = "The one deployer role the CI role may assume, in the same account."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:role/munaxa-docs/bootstrap/munaxa-docs-eu-(prod|test)-deployer$", var.deployer_role_arn))
    error_message = "deployer_role_arn must be an exact munaxa-docs bootstrap deployer role ARN."
  }
}
