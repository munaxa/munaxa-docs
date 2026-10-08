# The Testing deployer role, its permissions boundary, its scoped allow policies and guardrail deny
# policies, the workload boundary every Testing workload role must carry, and the Testing CI role.
# The policy documents are the Production templates rendered for Environment=Testing and
# /munaxa-docs/eu-test/ (../modules/deployer-policies), so Testing has exactly Production's
# permission model, in its own account.
#
# Nothing here can reach Production: the provider only accepts 657878534449, every ARN is in that
# account, and the Production deployer's trust (in 800728620253) names no Testing principal.

module "deployer_policies" {
  source = "../modules/deployer-policies"

  account_id         = var.account_id
  region             = var.region
  environment        = "Testing"
  env_path           = "eu-test"
  prefix             = local.prefix
  bootstrap_path     = local.bootstrap_path
  state_bucket       = local.state_bucket
  state_key_arn      = aws_kms_key.state.arn
  cloudtrail_bucket  = local.cloudtrail_bucket
  cloudmap_namespace = local.cloudmap_namespace
  protected_vpc_ids  = local.protected_vpc_ids
}

# GitHub Actions OIDC provider (one per account) and the Testing CI role (testing environment, main).
module "testing_ci" {
  source = "../modules/github-oidc-ci"

  account_id         = var.account_id
  role_name          = "${local.prefix}-ci"
  github_repository  = var.github_repository
  github_environment = var.github_environment
  github_ref         = var.github_ref
  deployer_role_arn  = local.deployer_role_arn
}

data "aws_iam_policy_document" "deployer_trust" {
  # GitHub Actions through the Testing CI role: exact role ARN (constructed, so the whole policy is
  # visible in the plan), source identity github-actions, session name gha-run-*. IAM authorises
  # sts:SetSourceIdentity separately, so it is its own statement, as in Production.
  statement {
    sid     = "GitHubActionsSessions"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [module.testing_ci.role_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:SourceIdentity"
      values   = ["github-actions"]
    }

    condition {
      test     = "StringLike"
      variable = "sts:RoleSessionName"
      values   = ["gha-run-*"]
    }
  }

  statement {
    sid     = "GitHubActionsSourceIdentity"
    actions = ["sts:SetSourceIdentity"]

    principals {
      type        = "AWS"
      identifiers = [module.testing_ci.role_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:SourceIdentity"
      values   = ["github-actions"]
    }
  }

  # Optional: Claude's engineering role in this account, same shape as in Production.
  dynamic "statement" {
    for_each = var.engineering_principal_arn == null ? [] : [var.engineering_principal_arn]

    content {
      sid     = "EngineeringRoleSessions"
      actions = ["sts:AssumeRole"]

      principals {
        type        = "AWS"
        identifiers = [statement.value]
      }

      condition {
        test     = "StringEquals"
        variable = "sts:SourceIdentity"
        values   = ["munaxa-org-operator"]
      }

      condition {
        test     = "StringLike"
        variable = "sts:RoleSessionName"
        values   = ["claude-*"]
      }
    }
  }

  dynamic "statement" {
    for_each = var.engineering_principal_arn == null ? [] : [var.engineering_principal_arn]

    content {
      sid     = "EngineeringRoleSourceIdentity"
      actions = ["sts:SetSourceIdentity"]

      principals {
        type        = "AWS"
        identifiers = [statement.value]
      }

      condition {
        test     = "StringEquals"
        variable = "sts:SourceIdentity"
        values   = ["munaxa-org-operator"]
      }
    }
  }
}

resource "aws_iam_policy" "deployer_boundary" {
  name        = local.deployer_boundary_name
  path        = local.bootstrap_path
  description = "Permissions boundary of the Munaxa Docs Testing deployer: Testing services only, never bootstrap."
  policy      = local.policy_documents["deployer-boundary"]

  lifecycle {
    precondition {
      condition     = length(local.policy_documents["deployer-boundary"]) <= 6144
      error_message = "deployer-boundary exceeds the 6,144-character managed policy limit."
    }
  }
}

resource "aws_iam_policy" "workload_boundary" {
  name        = local.workload_boundary_name
  path        = local.bootstrap_path
  description = "Permissions boundary every Munaxa Docs Testing workload role must carry."
  policy      = local.policy_documents["workload-boundary"]

  lifecycle {
    precondition {
      condition     = length(local.policy_documents["workload-boundary"]) <= 6144
      error_message = "workload-boundary exceeds the 6,144-character managed policy limit."
    }
  }
}

resource "aws_iam_policy" "deployer" {
  for_each = toset(local.deployer_policy_names)

  name        = "${local.prefix}-${each.key}"
  path        = local.bootstrap_path
  description = "Munaxa Docs Testing deployer: ${each.key}."
  policy      = local.policy_documents[each.key]

  lifecycle {
    precondition {
      condition     = length(local.policy_documents[each.key]) <= 6144
      error_message = "${each.key} exceeds the 6,144-character managed policy limit."
    }
  }
}

resource "aws_iam_role" "deployer" {
  name                 = local.deployer_role_name
  path                 = local.bootstrap_path
  description          = "Creates and manages only the Munaxa Docs Testing infrastructure (eu-central-1, munaxa-nonprod)."
  assume_role_policy   = data.aws_iam_policy_document.deployer_trust.json
  permissions_boundary = aws_iam_policy.deployer_boundary.arn
  max_session_duration = 3600

  # The trust names the CI role by its constructed ARN; IAM refuses a principal that does not exist.
  depends_on = [module.testing_ci]

  lifecycle {
    postcondition {
      condition     = self.arn == local.deployer_role_arn
      error_message = "The Testing deployer ARN is not the one the CI role policy names."
    }
  }
}

resource "aws_iam_role_policy_attachment" "deployer" {
  for_each = aws_iam_policy.deployer

  role       = aws_iam_role.deployer.name
  policy_arn = each.value.arn
}
