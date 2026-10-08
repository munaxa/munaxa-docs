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
