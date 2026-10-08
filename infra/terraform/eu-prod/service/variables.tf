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
  description = "Source identity stamped on the deployer session: github-actions (CI), munaxa-org-operator (Claude engineering role), claude-munaxa-docs (Claude IAM user, fallback) or admin.tamer (break-glass)."
  type        = string

  validation {
    condition     = contains(["claude-munaxa-docs", "admin.tamer", "munaxa-org-operator", "github-actions"], var.deployer_source_identity)
    error_message = "Use github-actions, munaxa-org-operator, claude-munaxa-docs or admin.tamer; the deployer trust policy accepts no other."
  }
}

variable "deployer_session_name" {
  description = "Session name for the deployer role. Claude sessions must start with claude-, GitHub Actions sessions with gha-."
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
