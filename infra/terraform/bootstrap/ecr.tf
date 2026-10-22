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

# Only the publishing workflow, run from an image/<sha> tag of this repository (immutable IDs,
# as for the CI role), may assume the publisher.
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
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${local.github_owner}@${var.github_owner_id}/${local.github_repository_name}@${var.github_repository_id}:ref:refs/tags/image/*"]
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

    # The workflow file itself, so no other workflow running on an image tag can push.
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
