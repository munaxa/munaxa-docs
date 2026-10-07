variable "account_id" {
  description = "The AWS account that hosts Munaxa Docs. The provider refuses to run against any other."
  type        = string
  default     = "800728620253"
}

variable "region" {
  description = "Production is eu-central-1 only (ADR-0023)."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = var.region == "eu-central-1"
    error_message = "Production is eu-central-1 only (ADR-0023)."
  }
}

variable "deployer_source_identity" {
  description = "Source identity stamped on the deployer session: munaxa-org-operator (Claude engineering role), claude-munaxa-docs (Claude IAM user, fallback) or admin.tamer (break-glass)."
  type        = string

  validation {
    condition     = contains(["claude-munaxa-docs", "admin.tamer", "munaxa-org-operator"], var.deployer_source_identity)
    error_message = "Use munaxa-org-operator, claude-munaxa-docs or admin.tamer; the deployer trust policy accepts no other."
  }
}

variable "deployer_session_name" {
  description = "Session name for the deployer role. Claude sessions must start with claude-."
  type        = string

  validation {
    condition     = can(regex("^[\\w+=,.@-]{2,64}$", var.deployer_session_name))
    error_message = "Session names are 2-64 characters of letters, digits and +=,.@_-."
  }
}

# ---------------------------------------------------------------------------------------------
# Release: immutable image references. Set in release.auto.tfvars from the release package.
# ---------------------------------------------------------------------------------------------

variable "api_image" {
  description = "API image, by digest: ghcr.io/munaxa/munaxa-docs-api@sha256:<64 hex>."
  type        = string

  validation {
    condition     = can(regex("^ghcr\\.io/munaxa/munaxa-docs-api@sha256:[0-9a-f]{64}$", var.api_image))
    error_message = "api_image must be ghcr.io/munaxa/munaxa-docs-api@sha256:<digest>; tags are not accepted."
  }
}

variable "web_image" {
  description = "Web image, by digest: ghcr.io/munaxa/munaxa-docs-web@sha256:<64 hex>."
  type        = string

  validation {
    condition     = can(regex("^ghcr\\.io/munaxa/munaxa-docs-web@sha256:[0-9a-f]{64}$", var.web_image))
    error_message = "web_image must be ghcr.io/munaxa/munaxa-docs-web@sha256:<digest>; tags are not accepted."
  }
}

variable "antivirus_image" {
  description = "Scanner image, by digest: ghcr.io/munaxa/munaxa-docs-antivirus@sha256:<64 hex>."
  type        = string

  validation {
    condition     = can(regex("^ghcr\\.io/munaxa/munaxa-docs-antivirus@sha256:[0-9a-f]{64}$", var.antivirus_image))
    error_message = "antivirus_image must be ghcr.io/munaxa/munaxa-docs-antivirus@sha256:<digest>; tags are not accepted."
  }
}

variable "release_commit" {
  description = "The full commit SHA the three images were built from."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.release_commit))
    error_message = "release_commit must be a full 40-character commit SHA."
  }
}

# ---------------------------------------------------------------------------------------------
# Supporting image and launch configuration. Set in launch.auto.tfvars.
# ---------------------------------------------------------------------------------------------

variable "redis_image" {
  description = "Redis 7 for the API sidecar, by digest: public.ecr.aws/docker/library/redis@sha256:<64 hex> (ADR-0024 §2.6)."
  type        = string

  validation {
    condition     = can(regex("^public\\.ecr\\.aws/docker/library/redis@sha256:[0-9a-f]{64}$", var.redis_image))
    error_message = "redis_image must be public.ecr.aws/docker/library/redis@sha256:<digest>; tags are not accepted."
  }
}

variable "mail_from_address" {
  description = "MAIL_FROM_ADDRESS: an address on the SES-verified sending domain (ADR-0025 §2, §6)."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[a-z0-9.-]+\\.[a-z]{2,}$", var.mail_from_address))
    error_message = "mail_from_address must be an email address."
  }
}

variable "app_secret_version_id" {
  description = "The application bundle version every API task is pinned to (ADR-0022 consequence 8). Empty means the current version; set it before enable_services."
  type        = string
  default     = ""

  validation {
    condition     = var.app_secret_version_id == "" || can(regex("^[0-9a-f-]{32,36}$", var.app_secret_version_id))
    error_message = "app_secret_version_id is a Secrets Manager version id, or empty."
  }
}

# ---------------------------------------------------------------------------------------------
# Stages (main.tf). Both off by default: nothing is listening and no task runs.
# ---------------------------------------------------------------------------------------------

variable "enable_https" {
  description = "Create the HTTPS listener, the preview rule and the HTTP redirect. Waits for the certificate to be ISSUED."
  type        = bool
  default     = false
}

variable "enable_services" {
  description = "Create the web, API and scanner services and the scanner refresh schedule. Requires enable_https and every input in docs/operations/production-service-inputs.md."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------------------------
# Operator tasks (ops.tf) and the first, internal tenant. Set in launch.auto.tfvars.
# ---------------------------------------------------------------------------------------------

variable "postgres_image" {
  description = "PostgreSQL 16 client for the db-admin task, by digest: public.ecr.aws/docker/library/postgres@sha256:<64 hex>."
  type        = string

  validation {
    condition     = can(regex("^public\\.ecr\\.aws/docker/library/postgres@sha256:[0-9a-f]{64}$", var.postgres_image))
    error_message = "postgres_image must be public.ecr.aws/docker/library/postgres@sha256:<digest>; tags are not accepted."
  }
}

variable "tunnel_image" {
  description = "Base image for the ECS Exec tunnel task, by digest: public.ecr.aws/amazonlinux/amazonlinux@sha256:<64 hex>."
  type        = string

  validation {
    condition     = can(regex("^public\\.ecr\\.aws/amazonlinux/amazonlinux@sha256:[0-9a-f]{64}$", var.tunnel_image))
    error_message = "tunnel_image must be public.ecr.aws/amazonlinux/amazonlinux@sha256:<digest>; tags are not accepted."
  }
}

variable "bootstrap_tenant" {
  description = "The first tenant the db-admin and provisioning tasks prepare. Its UUID is generated at bootstrap and never configured here."
  type = object({
    slug     = string
    name     = string
    database = string
  })

  validation {
    condition = (
      can(regex("^[a-z][a-z0-9-]{1,47}$", var.bootstrap_tenant.slug)) &&
      var.bootstrap_tenant.database == "edms_${replace(var.bootstrap_tenant.slug, "-", "_")}"
    )
    error_message = "slug is a tenant slug (lower case, digits, hyphens) and database is edms_<slug with _ for ->."
  }
}
