# Production container images in ECR, and the GitHub Actions role that publishes them.
#
# Replaces the GHCR registry and its pull credential: the image publishing workflow
# (.github/workflows/publish-images.yml) pushes here through GitHub OIDC, and ECS execution roles
# pull with IAM. No registry credential exists anywhere.
#
# Repositories and the publisher live in bootstrap, so the deployer can neither change them nor
# push an image: what runs in Production is only what the publishing workflow built.

locals {
  ecr_repositories = ["api", "web", "antivirus"]
  ecr_prefix       = "munaxa-docs"
  ecr_repository_arns = [
    for name in local.ecr_repositories : "arn:aws:ecr:${var.region}:${var.account_id}:repository/${local.ecr_prefix}/${name}"
  ]
  image_publisher_role_name = "${local.prefix}-image-publisher"

  # The only workload roles the boundary lets reach ECR: the execution roles of the tasks that run
  # an image from these repositories (core, eu-prod/core/iam.tf). ops-dbadmin and ops-tunnel run
  # other images; task roles, the scheduler and the backup role never pull.
  ecr_pull_execution_roles = ["web", "api", "scanner", "ops-provision"]
  ecr_pull_role_arns = [
    for name in local.ecr_pull_execution_roles : "arn:aws:iam::${var.account_id}:role${local.workload_path}${local.prefix}-${name}-execution"
  ]
}

# IMMUTABLE: a tag can never be moved to another image once pushed. Production still deploys by
# digest only; the tags are for people.
resource "aws_ecr_repository" "images" {
  for_each = toset(local.ecr_repositories)

  name                 = "${local.ecr_prefix}/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true # basic scanning, no charge
  }

  encryption_configuration {
    encryption_type = "AES256" # no customer-managed key: no extra charge, nothing to share
  }
}

# Bounded storage cost. Untagged layers left by failed pushes go after 7 days; of the released
# images, the newest 20 are kept, which covers every release a rollback could need.
resource "aws_ecr_lifecycle_policy" "images" {
  for_each = aws_ecr_repository.images

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Remove untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the newest 20 released images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["sha-*"]
          countType      = "imageCountMoreThan"
          countNumber    = 20
        }
        action = { type = "expire" }
      },
    ]
  })
}

# Who may push. Claim names and formats were observed in this repository's own OIDC tokens
# (2026-10-22): `sub` uses the immutable owner@id/repo@id form, `job_workflow_ref` is present for an
# ordinary (non-reusable) workflow and uses names (owner/repo/.github/workflows/<file>@<ref>).
#
# A tag runs the workflow file as it is at the tagged commit, so checks inside the workflow can be
# edited away by whoever creates the tag. The controls that cannot be are here and in GitHub:
#
# - `sub` must be the protected `image-release` environment of this repository. GitHub only issues
#   that subject to a job that declares the environment, after its required reviewer approves and
#   only on a ref its deployment rules allow (image/* tags).
# - `ref` must be an image/* tag, and `job_workflow_ref` must be publish-images.yml on such a tag,
#   so no other workflow and no branch run can push even with the environment approved.
# - The repository and owner IDs, so a renamed or re-created repository can never match.
data "aws_iam_policy_document" "image_publisher_trust" {
  statement {
    sid     = "GitHubActionsImagePublishing"
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

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${local.github_owner}@${var.github_owner_id}/${local.github_repository_name}@${var.github_repository_id}:environment:${var.github_image_environment}"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_owner_id"
      values   = [var.github_owner_id]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_id"
      values   = [var.github_repository_id]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:ref"
      values   = ["refs/tags/image/*"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:job_workflow_ref"
      values   = ["${var.github_repository}/.github/workflows/publish-images.yml@refs/tags/image/*"]
    }
  }
}

data "aws_iam_policy_document" "image_publisher" {
  # GetAuthorizationToken has no resource-level permissions; AWS requires "*".
  statement {
    sid       = "EcrSignIn"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # Push, pull back by digest and look up a digest, for the workflow's own verification. No
  # delete, no policy or repository changes.
  statement {
    sid = "PushProductionImages"
    actions = [
      "ecr:DescribeImages",
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = local.ecr_repository_arns
  }
}

resource "aws_iam_policy" "image_publisher_boundary" {
  name        = "${local.image_publisher_role_name}-boundary"
  path        = local.bootstrap_path
  description = "Permissions boundary of the Munaxa Docs image publisher: push to the Production ECR repositories only."
  policy      = data.aws_iam_policy_document.image_publisher.json
}

resource "aws_iam_role" "image_publisher" {
  name                 = local.image_publisher_role_name
  path                 = local.bootstrap_path
  description          = "GitHub Actions image publishing (image/<sha> tags); may only push to the Munaxa Docs ECR repositories."
  assume_role_policy   = data.aws_iam_policy_document.image_publisher_trust.json
  permissions_boundary = aws_iam_policy.image_publisher_boundary.arn
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "image_publisher" {
  name   = "push-production-images"
  role   = aws_iam_role.image_publisher.id
  policy = data.aws_iam_policy_document.image_publisher.json
}
