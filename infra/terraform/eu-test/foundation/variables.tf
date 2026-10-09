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

variable "test_hostname" {
  description = "Public TEST hostname. Its hosted zone is created here and delegated once from Cloudflare (see README)."
  type        = string
  default     = "test.docs.munaxa.com"
}
