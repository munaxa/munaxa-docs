# Inputs of the application service stack. Built from the Production service root of #131 so TEST
# runs the same task definitions, health checks, ports, security groups and edge as Production;
# only what must differ between environments is a variable.

variable "prefix" {
  description = "Resource name prefix (munaxa-docs-eu-test or munaxa-docs-eu-prod)."
  type        = string

  validation {
    condition     = contains(["munaxa-docs-eu-test", "munaxa-docs-eu-prod"], var.prefix)
    error_message = "Unknown prefix."
  }
}

variable "environment" {
  description = "Testing or Production."
  type        = string

  validation {
    condition     = contains(["Testing", "Production"], var.environment)
    error_message = "environment must be Testing or Production."
  }
}

variable "account_id" {
  type = string
}

variable "region" {
  type = string
}

variable "web_hostname" {
  description = "Public hostname the ALB serves (and the web origin)."
  type        = string
}

variable "certificate_arn" {
  description = "An ISSUED ACM certificate for web_hostname."
  type        = string
}

variable "cluster_name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "public_subnet_cidrs" {
  description = "The only hops in front of the API and web (ALB and web tasks), for TRUST_PROXY."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Tier security groups: alb, web, api, scanner, ops."
  type        = map(string)
}

variable "role_arns" {
  description = "Workload roles by short name: web-execution, api-execution, scanner-execution, api-task, ops-dbadmin-execution, ops-tunnel-execution, ops-tunnel-task, ops-provision-execution."
  type        = map(string)
}

variable "kms_key_arn" {
  description = "Data key that encrypts the secret containers."
  type        = string
}

variable "secret_recovery_window_days" {
  description = "0 for TEST (secrets are recreated every session), 30 for Production."
  type        = number
}

variable "log_group_prefix" {
  type = string
}

variable "cloudmap_namespace" {
  type = string
}

variable "cloudmap_service_arns" {
  description = "Existing Cloud Map service ARNs for api and scanner (namespace owned elsewhere). null creates the namespace and both services here."
  type        = map(string)
  default     = null

  validation {
    condition     = var.cloudmap_service_arns == null || try(alltrue([for k in ["api", "scanner"] : can(regex("^arn:aws:servicediscovery:", var.cloudmap_service_arns[k]))]), false)
    error_message = "Give both api and scanner service ARNs, or null."
  }
}

variable "docs_bucket" {
  type = string
}

variable "db_address" {
  type = string
}

variable "db_port" {
  type = number
}

variable "master_secret_arn" {
  description = "The RDS-managed master secret (ops-dbadmin runs as the master user)."
  type        = string
}

variable "bootstrap_tenant" {
  type = object({
    slug     = string
    name     = string
    database = string
  })
}

variable "app_secret_keys" {
  description = "Keys of the application bundle injected into the API (a missing key stops the task)."
  type        = list(string)
}

variable "app_secret_version_id" {
  description = "Pin the API to one version of the application bundle (Production). null = the current version (TEST, where the bundle is rewritten each session)."
  type        = string
  default     = null
}

variable "mail_environment" {
  description = "Mail settings for the API. TEST uses MAIL_DRIVER=NONE (never sends); Production SMTP."
  type        = map(string)
}

variable "web_image" {
  type = string
  validation {
    condition     = can(regex("^ghcr\\.io/munaxa/munaxa-docs-web@sha256:[0-9a-f]{64}$", var.web_image))
    error_message = "web_image must be pinned by digest."
  }
}

variable "api_image" {
  type = string
  validation {
    condition     = can(regex("^ghcr\\.io/munaxa/munaxa-docs-api@sha256:[0-9a-f]{64}$", var.api_image))
    error_message = "api_image must be pinned by digest."
  }
}

variable "antivirus_image" {
  type = string
  validation {
    condition     = can(regex("^ghcr\\.io/munaxa/munaxa-docs-antivirus@sha256:[0-9a-f]{64}$", var.antivirus_image))
    error_message = "antivirus_image must be pinned by digest."
  }
}

variable "redis_image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.redis_image))
    error_message = "redis_image must be pinned by digest."
  }
}

variable "postgres_image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.postgres_image))
    error_message = "postgres_image must be pinned by digest."
  }
}

variable "tunnel_image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.tunnel_image))
    error_message = "tunnel_image must be pinned by digest."
  }
}

variable "enable_services" {
  description = "false: everything except the three services (database bootstrap runs in between). true: services running."
  type        = bool
  default     = false
}

variable "alb_deletion_protection" {
  description = "true in Production; false in TEST so a session can be destroyed."
  type        = bool
}

variable "scanner_capacity_provider" {
  type    = string
  default = "FARGATE_SPOT"
}

variable "alb_tags" {
  description = "Extra tags on the load balancer (TEST: ExpiresAt, read by the expiry check)."
  type        = map(string)
  default     = {}
}
