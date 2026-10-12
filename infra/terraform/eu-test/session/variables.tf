variable "account_id" {
  description = "The munaxa-nonprod account that hosts TEST. Never the Production account."
  type        = string
  default     = "657878534449"

  validation {
    condition     = var.account_id == "657878534449"
    error_message = "TEST is account 657878534449 only."
  }
}

variable "region" {
  description = "TEST runs in the same single region as Production."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = var.region == "eu-central-1"
    error_message = "TEST is eu-central-1 only."
  }
}

variable "deployer_source_identity" {
  description = "Source identity stamped on the TEST deployer session: github-actions (CI) or munaxa-org-operator (engineering role, when trusted)."
  type        = string

  validation {
    condition     = contains(["github-actions", "munaxa-org-operator"], var.deployer_source_identity)
    error_message = "Use github-actions or munaxa-org-operator; the TEST deployer trust accepts no other."
  }
}

variable "deployer_session_name" {
  description = "Session name for the TEST deployer: gha-run-* (CI) or claude-* (engineering)."
  type        = string

  validation {
    condition     = can(regex("^(gha-run-|claude-)[\\w+=,.@-]{1,56}$", var.deployer_session_name))
    error_message = "Session names start with gha-run- or claude-."
  }
}

variable "test_hostname" {
  description = "Public TEST hostname. Its hosted zone is created here and delegated once from Cloudflare (see README)."
  type        = string
  default     = "test.docs.munaxa.com"
}

# --- Session inputs ---------------------------------------------------------------------------

variable "expires_at" {
  description = "UTC time after which the hourly expiry check destroys this session (RFC 3339, e.g. 2026-10-09T18:00:00Z)."
  type        = string

  validation {
    condition     = can(regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$", var.expires_at))
    error_message = "expires_at must be an RFC 3339 UTC time like 2026-10-09T18:00:00Z."
  }
}

variable "enable_services" {
  description = "false while the session's database is bootstrapped, true once the services may start."
  type        = bool
  default     = false
}

variable "release_commit" {
  description = "The commit the three images were built from."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.release_commit))
    error_message = "release_commit must be a full commit SHA."
  }
}

variable "api_image" {
  type = string
}

variable "web_image" {
  type = string
}

variable "antivirus_image" {
  type = string
}

variable "redis_image" {
  type = string
}

variable "postgres_image" {
  type = string
}

variable "tunnel_image" {
  type = string
}
