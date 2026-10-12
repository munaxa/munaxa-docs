# The Production deployer role, its permissions boundary, its seven scoped allow policies and two
# guardrail deny policies, and the workload boundary every Production workload role must carry.
# The policy documents are rendered by ../modules/deployer-policies; the GitHub Actions CI role
# that may assume the deployer is ../modules/github-oidc-ci.
#
# Everything here lives under /munaxa-docs/bootstrap/. The deployer manages only
# /munaxa-docs/eu-prod/ and is denied every action on this path, so it can never change itself,
# its boundary, its policies or the workload boundary.

module "deployer_policies" {
  source = "../modules/deployer-policies"

  account_id         = var.account_id
  region             = var.region
  environment        = "Production"
  env_path           = "eu-prod"
  prefix             = local.prefix
  bootstrap_path     = local.bootstrap_path
  state_bucket       = local.state_bucket
  state_key_arn      = aws_kms_key.state.arn
  cloudtrail_bucket  = local.cloudtrail_bucket
  cloudmap_namespace = local.cloudmap_namespace
  protected_vpc_ids  = var.protected_vpc_ids
}

# GitHub Actions OIDC provider and the Production CI role (production environment, main only).
module "production_ci" {
  source = "../modules/github-oidc-ci"

  account_id         = var.account_id
  role_name          = "${local.prefix}-ci"
  github_repository  = var.github_repository
  github_environment = var.github_environment
  github_ref         = var.github_ref
  deployer_role_arn  = local.deployer_role_arn
}

data "aws_iam_policy_document" "deployer_trust" {
  # The Claude agent: only with its own source identity and a claude-* session name, so every
  # Production change in CloudTrail is attributable.
  #
  # IAM authorises sts:SetSourceIdentity separately from sts:AssumeRole, and sts:RoleSessionName
  # is evaluated only for AssumeRole. The two actions are therefore separate statements: the
  # session-name condition stays on AssumeRole, and SetSourceIdentity is allowed only for the
  # claude-munaxa-docs value (it grants nothing on its own).
  statement {
    sid     = "ClaudeAgentSessions"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [var.claude_principal_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:SourceIdentity"
      values   = ["claude-munaxa-docs"]
    }

    condition {
      test     = "StringLike"
      variable = "sts:RoleSessionName"
      values   = ["claude-*"]
    }
  }

  statement {
    sid     = "ClaudeAgentSourceIdentity"
    actions = ["sts:SetSourceIdentity"]

    principals {
      type        = "AWS"
      identifiers = [var.claude_principal_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:SourceIdentity"
      values   = ["claude-munaxa-docs"]
    }
  }

  # Human break-glass. No MFA condition, by owner decision; the source identity still names the
  # person on every event.
  statement {
    sid     = "HumanBreakGlass"
    actions = ["sts:AssumeRole", "sts:SetSourceIdentity"]

    principals {
      type        = "AWS"
      identifiers = [var.break_glass_principal_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:SourceIdentity"
      values   = ["admin.tamer"]
    }
  }

  # Claude's permanent engineering role (Identity Center permission set MunaxaAWSEngineeringAdmin,
  # user munaxa-org-operator). Same shape as the Claude agent statements: the exact role ARN, its
  # own source identity, and a claude-* session name on AssumeRole.
  statement {
    sid     = "EngineeringRoleSessions"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [var.engineering_principal_arn]
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

  statement {
    sid     = "EngineeringRoleSourceIdentity"
    actions = ["sts:SetSourceIdentity"]

    principals {
      type        = "AWS"
      identifiers = [var.engineering_principal_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:SourceIdentity"
      values   = ["munaxa-org-operator"]
    }
  }

  # GitHub Actions, through the Production CI role (module.production_ci). Same shape again: the
  # exact role ARN, source identity github-actions, and a gha-run-* session name on AssumeRole (six
  # characters before the wildcard, as IAM Access Analyzer requires). The ARN is constructed, so
  # this whole trust policy is visible in the plan; aws_iam_role.deployer depends on the module so
  # the role exists before IAM is asked to trust it.
  statement {
    sid     = "GitHubActionsSessions"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [module.production_ci.role_arn]
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
      identifiers = [module.production_ci.role_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:SourceIdentity"
      values   = ["github-actions"]
    }
  }
}

resource "aws_iam_policy" "deployer_boundary" {
  name        = local.deployer_boundary_name
  path        = local.bootstrap_path
  description = "Permissions boundary of the Munaxa Docs Production deployer: Production services only, never Non-Production, never bootstrap."
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
  description = "Permissions boundary every Munaxa Docs Production workload role must carry."
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
  description = "Munaxa Docs Production deployer: ${each.key}."
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
  description          = "Creates and manages only the Munaxa Docs Production infrastructure (eu-central-1)."
  assume_role_policy   = data.aws_iam_policy_document.deployer_trust.json
  permissions_boundary = aws_iam_policy.deployer_boundary.arn
  max_session_duration = 3600

  # The trust names the CI role by its constructed ARN; IAM refuses a principal that does not exist.
  depends_on = [module.production_ci]
}

resource "aws_iam_role_policy_attachment" "deployer" {
  for_each = aws_iam_policy.deployer

  role       = aws_iam_role.deployer.name
  policy_arn = each.value.arn
}
