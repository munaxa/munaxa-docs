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
  description = "Source identity stamped on the deployer session: claude-munaxa-docs (Claude) or admin.tamer (break-glass)."
  type        = string

  validation {
    condition     = contains(["claude-munaxa-docs", "admin.tamer"], var.deployer_source_identity)
    error_message = "Use claude-munaxa-docs or admin.tamer; the deployer trust policy accepts no other."
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
