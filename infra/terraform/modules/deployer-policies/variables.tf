variable "account_id" {
  description = "The account the deployer and its workloads live in."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "region" {
  description = "The only region the deployer may act in."
  type        = string
}

variable "environment" {
  description = "Environment tag value every managed resource carries (Environment=<value>), also used in statement IDs."
  type        = string

  validation {
    condition     = contains(["Production", "Testing"], var.environment)
    error_message = "environment must be Production or Testing."
  }
}

variable "env_path" {
  description = "The environment's path segment: IAM path /munaxa-docs/<env_path>/, log groups /munaxa-docs/<env_path>/*, state keys <env_path>/*."
  type        = string

  validation {
    condition     = contains(["eu-prod", "eu-test"], var.env_path)
    error_message = "env_path must be eu-prod or eu-test."
  }
}

variable "prefix" {
  description = "Resource name prefix, e.g. munaxa-docs-eu-prod."
  type        = string
}

variable "bootstrap_path" {
  description = "IAM path of the administrator-managed bootstrap identities and policies."
  type        = string
  default     = "/munaxa-docs/bootstrap/"
}

variable "state_bucket" {
  description = "The environment's Terraform state bucket."
  type        = string
}

variable "state_key_arn" {
  description = "ARN of the KMS key that encrypts the environment's Terraform state."
  type        = string
}

variable "cloudtrail_bucket" {
  description = "Bucket the deployer must never touch (the account trail's bucket)."
  type        = string
}

variable "cloudmap_namespace" {
  description = "The environment's private Cloud Map namespace."
  type        = string
}

variable "protected_vpc_ids" {
  description = "VPCs the deployer must never change. Used only as deny-list entries; must not be empty."
  type        = list(string)

  validation {
    condition     = length(var.protected_vpc_ids) > 0 && alltrue([for id in var.protected_vpc_ids : can(regex("^vpc-[0-9a-f]{8,17}$", id))])
    error_message = "Provide at least one vpc-… ID; IAM rejects an empty resource list."
  }
}
