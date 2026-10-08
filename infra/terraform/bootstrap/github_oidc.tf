# GitHub Actions OIDC and the Production CI role.
#
# The workflow .github/workflows/terraform-eu-prod.yml exchanges its GitHub OIDC token for a
# session on the CI role. The CI role can do exactly one thing: assume the Production deployer
# with source identity github-actions and a gha-run-* session name. Terraform performs that second
# hop itself (provider and backend assume_role), so every Production change still runs as the
# deployer, under its boundary and guardrails, and is attributable in CloudTrail.
#
# The CI role has no access to Terraform state, no service permissions and no bootstrap access.
# It lives under /munaxa-docs/bootstrap/, so the deployer is denied every action on it, and its
# permissions boundary is the same single-purpose document as its policy. Bootstrap is never run
# by CI.

# AWS validates GitHub's OIDC endpoint against its own trusted root CAs, so no certificate
# thumbprint is pinned here.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "ci_trust" {
  statement {
    sid     = "GitHubActionsProductionEnvironment"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Only jobs that run in the protected production environment of this one repository.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${var.github_environment}"]
    }

    # The environment subject does not carry the branch, so it is pinned here as well: AWS refuses
    # any run that is not on the main branch, whatever the GitHub environment settings say.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:ref"
      values   = [var.github_ref]
    }
  }
}

data "aws_iam_policy_document" "ci" {
  statement {
    sid       = "AssumeProductionDeployerOnly"
    actions   = ["sts:AssumeRole", "sts:SetSourceIdentity"]
    resources = [local.deployer_role_arn]
  }
}

resource "aws_iam_policy" "ci_boundary" {
  name        = local.ci_boundary_name
  path        = local.bootstrap_path
  description = "Permissions boundary of the Munaxa Docs Production CI role: assume the Production deployer only."
  policy      = data.aws_iam_policy_document.ci.json
}

resource "aws_iam_role" "ci" {
  name                 = local.ci_role_name
  path                 = local.bootstrap_path
  description          = "GitHub Actions (production environment) entry point; may only assume the Munaxa Docs Production deployer."
  assume_role_policy   = data.aws_iam_policy_document.ci_trust.json
  permissions_boundary = aws_iam_policy.ci_boundary.arn
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "ci" {
  name   = "assume-production-deployer"
  role   = aws_iam_role.ci.id
  policy = data.aws_iam_policy_document.ci.json
}
