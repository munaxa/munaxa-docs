variable "account_id" {
  description = "The AWS account that hosts Munaxa Docs. The provider refuses to run against any other."
  type        = string
  default     = "800728620253"
}

variable "region" {
  description = "The only region Production resources may be created in."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = var.region == "eu-central-1"
    error_message = "Production is eu-central-1 only (ADR-0023)."
  }
}

variable "claude_principal_arn" {
  description = "The Claude agent's IAM user. It may assume the deployer only with source identity claude-munaxa-docs and a claude-* session name."
  type        = string
  default     = "arn:aws:iam::800728620253:user/claude-munaxa-docs"
}

variable "break_glass_principal_arn" {
  description = "The human break-glass IAM user. It may assume the deployer with source identity admin.tamer. No MFA condition, by owner decision."
  type        = string
  default     = "arn:aws:iam::800728620253:user/admin.tamer"
}

variable "engineering_principal_arn" {
  description = "Claude's Identity Center engineering role. It may assume the deployer only with source identity munaxa-org-operator and a claude-* session name."
  type        = string
  default     = "arn:aws:iam::800728620253:role/aws-reserved/sso.amazonaws.com/eu-central-1/AWSReservedSSO_MunaxaAWSEngineeringAdmin_94ab1f7586187adb"
}

variable "github_repository" {
  description = "The GitHub repository (owner/name) whose production environment may assume the Production CI role."
  type        = string
  default     = "munaxa/munaxa-docs"

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "Use owner/name, with no wildcard."
  }
}

variable "github_environment" {
  description = "The protected GitHub environment whose jobs may assume the CI role."
  type        = string
  default     = "production"

  validation {
    condition     = var.github_environment == "production"
    error_message = "The Production CI role trusts the production GitHub environment only."
  }
}

variable "github_ref" {
  description = "The only Git ref whose runs may assume the CI role."
  type        = string
  default     = "refs/heads/main"

  validation {
    condition     = can(regex("^refs/heads/[A-Za-z0-9._/-]+$", var.github_ref)) && !strcontains(var.github_ref, "*")
    error_message = "Use one exact branch ref (refs/heads/<name>), with no wildcard."
  }
}

variable "protected_vpc_ids" {
  description = <<-EOT
    VPCs the deployer must never change: the Non-Production VPC and the account's default VPC in
    eu-central-1. They appear here only as deny-list entries. Nothing in this tree may reference
    them for any other purpose.
  EOT
  type        = list(string)
  default = [
    "vpc-0b749fc532d67e1cb", # munaxa-docs-nonprod (Non-Production)
    "vpc-03e938747ee50ab8e", # default VPC
  ]
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget for resources tagged Environment=Production."
  type        = number
  default     = 130
}

variable "budget_alert_emails" {
  description = "Addresses that receive budget alerts. Supplied in terraform.tfvars (not committed)."
  type        = list(string)

  validation {
    condition     = length(var.budget_alert_emails) > 0 && alltrue([for e in var.budget_alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "Provide at least one valid email address."
  }
}

variable "cloudtrail_retention_days" {
  description = "Days CloudTrail log files are kept in their bucket."
  type        = number
  default     = 365
}
