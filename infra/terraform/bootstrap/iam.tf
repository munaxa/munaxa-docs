# The Production deployer role, its permissions boundary, its seven scoped allow policies and two
# guardrail deny policies, and the workload boundary every Production workload role must carry.
#
# Everything here lives under /munaxa-docs/bootstrap/. The deployer manages only
# /munaxa-docs/eu-prod/ and is denied every action on this path, so it can never change itself,
# its boundary, its policies or the workload boundary.

data "aws_iam_policy_document" "deployer_trust" {
  # The Claude agent: only with its own source identity and a claude-* session name, so every
  # Production change in CloudTrail is attributable.
  statement {
    sid     = "ClaudeAgentSessions"
    actions = ["sts:AssumeRole", "sts:SetSourceIdentity"]

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
}

resource "aws_iam_role_policy_attachment" "deployer" {
  for_each = aws_iam_policy.deployer

  role       = aws_iam_role.deployer.name
  policy_arn = each.value.arn
}
