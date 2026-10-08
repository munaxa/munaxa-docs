variable "account_id" {
  description = "The munaxa-nonprod account (NonProduction OU) that hosts Munaxa Docs TEST. Never the Production account."
  type        = string
  default     = "657878534449"

  validation {
    condition     = var.account_id == "657878534449"
    error_message = "The Testing bootstrap is for account 657878534449 (munaxa-nonprod) only."
  }
}

variable "region" {
  description = "The only region Testing resources may be created in (same as Production)."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = var.region == "eu-central-1"
    error_message = "Testing is eu-central-1 only, like Production (ADR-0023)."
  }
}

variable "state_admin_principal_arns" {
  description = <<-EOT
    Exact IAM role ARNs (in 657878534449) of the administrators who apply this bootstrap. With the
    Testing deployer and the account root, they are the only principals the Testing state bucket
    admits. Supplied in terraform.tfvars (not committed); typically the Identity Center role the
    administrator signs in with in munaxa-nonprod.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.state_admin_principal_arns) > 0 && alltrue([for a in var.state_admin_principal_arns : can(regex("^arn:aws:iam::657878534449:role/[A-Za-z0-9+=,.@_/-]+$", a)) && !strcontains(a, "*")])
    error_message = "Provide at least one exact role ARN in 657878534449, with no wildcard."
  }
}

variable "engineering_principal_arn" {
  description = "Optional: Claude's engineering Identity Center role in 657878534449, allowed to assume the Testing deployer with source identity munaxa-org-operator and a claude-* session name. null adds no statement."
  type        = string
  default     = null

  validation {
    condition     = var.engineering_principal_arn == null || can(regex("^arn:aws:iam::657878534449:role/aws-reserved/sso\\.amazonaws\\.com/[a-z0-9-]+/AWSReservedSSO_MunaxaAWSEngineeringAdmin_[0-9a-f]{16}$", var.engineering_principal_arn))
    error_message = "Use the exact AWSReservedSSO_MunaxaAWSEngineeringAdmin_<suffix> role ARN in 657878534449, or null."
  }
}

variable "extra_protected_vpc_ids" {
  description = "VPCs, besides the account's default VPC, the Testing deployer must never change."
  type        = list(string)
  default     = []
}

variable "github_repository" {
  description = "The GitHub repository (owner/name) whose testing environment may assume the Testing CI role."
  type        = string
  default     = "munaxa/munaxa-docs"
}

variable "github_environment" {
  description = "The GitHub environment whose jobs may assume the Testing CI role."
  type        = string
  default     = "testing"

  validation {
    condition     = var.github_environment == "testing"
    error_message = "The Testing CI role trusts the testing GitHub environment only."
  }
}

variable "github_ref" {
  description = "The only Git ref whose runs may assume the Testing CI role. TEST deploys only what was merged to main."
  type        = string
  default     = "refs/heads/main"
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget for the whole munaxa-nonprod account (TEST). Alerts at 50 % and 100 % actual, 100 % forecast."
  type        = number
  default     = 15
}

variable "budget_alert_emails" {
  description = "Addresses that receive TEST budget alerts. Supplied in terraform.tfvars (not committed)."
  type        = list(string)

  validation {
    condition     = length(var.budget_alert_emails) > 0 && alltrue([for e in var.budget_alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "Provide at least one valid email address."
  }
}

variable "test_hostname" {
  description = "The public TEST hostname. The TEST deployer may change DNS records for this name (and below it) only."
  type        = string
  default     = "test.docs.munaxa.com"
}
