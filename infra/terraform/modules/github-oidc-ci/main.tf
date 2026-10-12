# GitHub Actions OIDC provider and one CI role, for one environment in one account.
#
# The CI role is an identity bridge only: a job in the named GitHub environment, on the named
# branch of the named repository, may exchange its OIDC token for a session on this role, and that
# session may do exactly one thing, assume the environment's deployer (Terraform's own assume_role
# sets source identity github-actions and a gha-run-* session name, which the deployer trust
# requires). The role has no access to Terraform state, KMS, services, secrets, IAM or
# Organizations.
#
# Plan reviewability: every ARN a trust or permission policy names is built from fixed parts
# (account, path, name), never read from a resource that does not exist yet, so `terraform plan`
# shows each policy in full. Creation order, which IAM needs (a principal must exist before a
# trust policy may name it), is kept with explicit depends_on, and postconditions prove the
# created ARNs are the ones the policies named.

locals {
  oidc_host     = "token.actions.githubusercontent.com"
  provider_arn  = "arn:aws:iam::${var.account_id}:oidc-provider/${local.oidc_host}"
  role_arn      = "arn:aws:iam::${var.account_id}:role${var.role_path}${var.role_name}"
  boundary_name = "${var.role_name}-boundary"
  subject       = "repo:${var.github_repository}:environment:${var.github_environment}"
}

# One per account. AWS validates GitHub's endpoint against its trusted root CAs, so no
# certificate thumbprint is pinned.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://${local.oidc_host}"
  client_id_list = ["sts.amazonaws.com"]

  lifecycle {
    postcondition {
      condition     = self.arn == local.provider_arn
      error_message = "The OIDC provider ARN is not the one the CI role trust names."
    }
  }
}

data "aws_iam_policy_document" "trust" {
  statement {
    sid     = "GitHubActionsEnvironmentOnBranch"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Only jobs in this one GitHub environment of this one repository.
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = [local.subject]
    }

    # The environment subject does not carry the branch, so it is pinned as well.
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:ref"
      values   = [var.github_ref]
    }
  }
}

data "aws_iam_policy_document" "permissions" {
  statement {
    sid       = "AssumeThisEnvironmentsDeployerOnly"
    actions   = ["sts:AssumeRole", "sts:SetSourceIdentity"]
    resources = [var.deployer_role_arn]
  }
}

resource "aws_iam_policy" "boundary" {
  name        = local.boundary_name
  path        = var.role_path
  description = "Permissions boundary of ${var.role_name}: assume ${var.deployer_role_arn} only."
  policy      = data.aws_iam_policy_document.permissions.json
}

resource "aws_iam_role" "ci" {
  name                 = var.role_name
  path                 = var.role_path
  description          = "GitHub Actions (${var.github_environment} environment, ${var.github_ref}) entry point; may only assume ${var.deployer_role_arn}."
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  permissions_boundary = aws_iam_policy.boundary.arn
  max_session_duration = 3600

  # The trust names the provider by its constructed ARN, so the dependency is stated explicitly.
  depends_on = [aws_iam_openid_connect_provider.github]

  lifecycle {
    precondition {
      condition     = startswith(var.deployer_role_arn, "arn:aws:iam::${var.account_id}:role/")
      error_message = "The CI role may only assume a deployer in its own account."
    }

    postcondition {
      condition     = self.arn == local.role_arn
      error_message = "The CI role ARN is not the one the deployer trust names."
    }
  }
}

resource "aws_iam_role_policy" "ci" {
  name   = "assume-deployer"
  role   = aws_iam_role.ci.id
  policy = data.aws_iam_policy_document.permissions.json
}
