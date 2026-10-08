locals {
  prefix = "munaxa-docs-eu-prod"

  # Paths: the deployer lives under bootstrap/ and can never change it; the workload roles it
  # manages live under eu-prod/.
  bootstrap_path = "/munaxa-docs/bootstrap/"
  workload_path  = "/munaxa-docs/eu-prod/"

  deployer_role_name          = "${local.prefix}-deployer"
  deployer_role_arn           = "arn:aws:iam::${var.account_id}:role${local.bootstrap_path}${local.deployer_role_name}"
  deployer_boundary_name      = "${local.prefix}-deployer-boundary"
  ci_role_name                = "${local.prefix}-ci"
  ci_boundary_name            = "${local.prefix}-ci-boundary"
  workload_boundary_name      = "${local.prefix}-workload-boundary"
  workload_boundary_arn       = "arn:aws:iam::${var.account_id}:policy${local.bootstrap_path}${local.workload_boundary_name}"
  state_bucket                = "munaxa-docs-tfstate-eu-prod-${var.account_id}"
  state_key_alias             = "alias/${local.prefix}-tfstate"
  cloudtrail_bucket           = "munaxa-docs-cloudtrail-${var.account_id}"
  cloudtrail_name             = "munaxa-docs-account-trail"
  cloudmap_namespace          = "prod.munaxa-docs.internal"
  state_admin_principal_arns  = [var.claude_principal_arn, var.break_glass_principal_arn, "arn:aws:iam::${var.account_id}:root"]
  workload_pass_role_services = ["ecs-tasks.amazonaws.com", "scheduler.amazonaws.com", "backup.amazonaws.com", "events.amazonaws.com"]
  service_linked_role_names   = ["ecs.amazonaws.com", "elasticloadbalancing.amazonaws.com", "rds.amazonaws.com", "backup.amazonaws.com"]

  # Variables available to every policy template. Lists are passed pre-encoded as JSON.
  policy_vars = {
    account_id                    = var.account_id
    region                        = var.region
    prefix                        = local.prefix
    state_bucket                  = local.state_bucket
    state_key_arn                 = aws_kms_key.state.arn
    cloudtrail_bucket             = local.cloudtrail_bucket
    cloudmap_namespace            = local.cloudmap_namespace
    workload_boundary_arn         = local.workload_boundary_arn
    protected_vpc_ids_json        = jsonencode(var.protected_vpc_ids)
    protected_vpc_arns_json       = jsonencode([for id in var.protected_vpc_ids : "arn:aws:ec2:${var.region}:${var.account_id}:vpc/${id}"])
    pass_role_services_json       = jsonencode(local.workload_pass_role_services)
    service_linked_role_json      = jsonencode(local.service_linked_role_names)
    non_production_tag_values     = jsonencode(["NonProduction", "nonprod", "non-production"])
    non_production_name_arns_json = jsonencode(local.non_production_name_arns)
    tag_change_actions_json       = jsonencode(local.tag_change_actions)
    ec2_mutating_actions_json     = jsonencode(local.ec2_mutating_actions)
    iam_write_actions_json        = jsonencode(local.iam_write_actions)
    identity_escalation_json      = jsonencode(local.identity_escalation_actions)
    account_level_controls_json   = jsonencode(local.account_level_control_actions)
  }

  # "Anything named *nonprod*", one ARN pattern per service. IAM rejects a wildcard in an ARN's
  # service field, so the services are listed: every service the deployer or a workload role can
  # reach under its boundary, plus S3 (no account or region in its ARNs) and IAM (no region, and
  # the resource part must start with its type).
  non_production_name_services = [
    "ec2", "ecs", "elasticloadbalancing", "acm", "logs", "servicediscovery", "rds", "kms",
    "secretsmanager", "backup", "cloudwatch", "sns", "events", "scheduler", "ssm",
  ]
  non_production_name_arns = concat(
    [for svc in local.non_production_name_services : "arn:aws:${svc}:*:${var.account_id}:*nonprod*"],
    [for kind in ["role", "policy", "user", "group", "instance-profile"] : "arn:aws:iam::${var.account_id}:${kind}/*nonprod*"],
    ["arn:aws:s3:::*nonprod*"],
  )

  # Every action that adds, changes or removes a tag on the services the deployer uses.
  tag_change_actions = [
    "ec2:CreateTags", "ec2:DeleteTags",
    "ecs:TagResource", "ecs:UntagResource",
    "elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags",
    "acm:AddTagsToCertificate", "acm:RemoveTagsFromCertificate",
    "logs:TagResource", "logs:UntagResource", "logs:TagLogGroup", "logs:UntagLogGroup",
    "rds:AddTagsToResource", "rds:RemoveTagsFromResource",
    "kms:TagResource", "kms:UntagResource",
    "secretsmanager:TagResource", "secretsmanager:UntagResource",
    "backup:TagResource", "backup:UntagResource",
    "cloudwatch:TagResource", "cloudwatch:UntagResource",
    "sns:TagResource", "sns:UntagResource",
    "events:TagResource", "events:UntagResource",
    "scheduler:TagResource", "scheduler:UntagResource",
    "iam:TagRole", "iam:UntagRole", "iam:TagPolicy", "iam:UntagPolicy",
  ]

  ec2_mutating_actions = [
    "ec2:Create*", "ec2:Delete*", "ec2:Modify*", "ec2:Associate*", "ec2:Disassociate*",
    "ec2:Attach*", "ec2:Detach*", "ec2:Authorize*", "ec2:Revoke*", "ec2:Replace*",
    "ec2:Update*", "ec2:Release*", "ec2:Run*", "ec2:Terminate*",
  ]

  iam_write_actions = [
    "iam:Create*", "iam:Delete*", "iam:Put*", "iam:Attach*", "iam:Detach*", "iam:Update*",
    "iam:Tag*", "iam:Untag*", "iam:PassRole", "iam:Add*",
    "iam:Remove*", "iam:Upload*", "iam:Enable*", "iam:Deactivate*", "iam:Resync*",
    "iam:Set*", "iam:Change*", "iam:Reset*",
  ]

  # Long-lived credentials and identity providers: never created or changed by the deployer.
  identity_escalation_actions = [
    "iam:*User*", "iam:*AccessKey*", "iam:*LoginProfile*", "iam:*Group*", "iam:*MFADevice*",
    "iam:*OpenIDConnectProvider*", "iam:*SAMLProvider*", "iam:*ServiceSpecificCredential*",
    "iam:*SSHPublicKey*", "iam:*ServerCertificate*", "iam:*SigningCertificate*",
    "iam:*AccountPasswordPolicy*", "iam:*AccountAlias*", "iam:CreateInstanceProfile",
    "iam:AddRoleToInstanceProfile",
    "iam:SetSecurityTokenServicePreferences", "iam:DeleteRolePermissionsBoundary",
    "iam:DeleteServiceLinkedRole",
  ]

  # Organizations, billing and account-wide security settings.
  account_level_control_actions = [
    "organizations:*", "account:*", "billing:*", "budgets:*", "ce:*", "cur:*",
    "servicequotas:*", "ram:*", "directconnect:*", "sso:*", "sso-directory:*", "identitystore:*",
    "cloudtrail:*", "config:*", "guardduty:*", "securityhub:*", "access-analyzer:*",
    "s3:PutAccountPublicAccessBlock", "s3:PutStorageLensConfiguration",
    "ec2:*ByDefault", "ec2:Modify*Default*", "ec2:*SerialConsole*", "ec2:*BlockPublicAccess*",
    "ec2:*VpcPeering*", "ec2:*TransitGateway*", "ec2:*Vpn*", "ec2:*CustomerGateway*", "ec2:*Ipam*",
    "ecs:PutAccountSetting*", "ecs:DeleteAccountSetting", "rds:ModifyCertificates", "ses:PutAccount*",
  ]

  policy_documents = {
    for name in [
      "deployer-read", "deployer-state", "deployer-network", "deployer-compute", "deployer-data",
      "deployer-observability", "deployer-iam", "deployer-guardrails-environment",
      "deployer-guardrails-identity", "deployer-boundary", "workload-boundary",
    ] : name => jsonencode(jsondecode(templatefile("${path.module}/policies/${name}.json.tftpl", local.policy_vars)))
  }

  deployer_policy_names = [
    "deployer-read", "deployer-state", "deployer-network", "deployer-compute", "deployer-data",
    "deployer-observability", "deployer-iam", "deployer-guardrails-environment",
    "deployer-guardrails-identity",
  ]
}
