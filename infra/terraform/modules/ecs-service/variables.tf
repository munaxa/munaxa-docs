# Input contract for the one ECS service module reused by web, API and scanner. The resources
# (task definition, service, log group wiring) are added together with the service root; nothing
# instantiates this module yet.

variable "name" {
  description = "Service name; must start with munaxa-docs-eu-prod-."
  type        = string

  validation {
    condition     = can(regex("^munaxa-docs-eu-prod-[a-z0-9-]+$", var.name))
    error_message = "Production service names start with munaxa-docs-eu-prod-."
  }
}

variable "image" {
  description = "Container image by immutable digest (registry/repository@sha256:<64 hex>)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9.-]+/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$", var.image))
    error_message = "image must be pinned by digest; tags are not accepted."
  }
}

variable "cpu" {
  description = "Task CPU units (256 = 0.25 vCPU)."
  type        = number
}

variable "memory" {
  description = "Task memory in MiB."
  type        = number
}

variable "execution_role_arn" {
  description = "A /munaxa-docs/eu-prod/ execution role from the core root."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:role/munaxa-docs/eu-prod/munaxa-docs-eu-prod-", var.execution_role_arn))
    error_message = "Use a Production execution role under /munaxa-docs/eu-prod/."
  }
}

variable "task_role_arn" {
  description = "A /munaxa-docs/eu-prod/ task role, or null for tiers with no task role (web, scanner)."
  type        = string
  default     = null

  validation {
    condition     = var.task_role_arn == null || can(regex("^arn:aws:iam::[0-9]{12}:role/munaxa-docs/eu-prod/munaxa-docs-eu-prod-", var.task_role_arn))
    error_message = "Use a Production task role under /munaxa-docs/eu-prod/, or null."
  }
}

variable "capacity_provider" {
  description = "FARGATE, or FARGATE_SPOT (scanner only, ADR-0024 §2.7)."
  type        = string
  default     = "FARGATE"

  validation {
    condition     = contains(["FARGATE", "FARGATE_SPOT"], var.capacity_provider)
    error_message = "capacity_provider is FARGATE or FARGATE_SPOT."
  }
}
