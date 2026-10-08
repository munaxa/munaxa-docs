# Renders the deployer's permission policies, its permissions boundary and the workload boundary
# for one environment, from the templates in ./policies. Pure computation: no resources.
#
# The same templates serve Production (account 800728620253, Environment=Production, eu-prod) and
# Testing (account 657878534449, Environment=Testing, eu-test). For Production the rendered
# documents are byte-identical to what bootstrap rendered before the templates moved here.

locals {
  workload_boundary_arn       = "arn:aws:iam::${var.account_id}:policy${var.bootstrap_path}${var.prefix}-workload-boundary"
  workload_pass_role_services = ["ecs-tasks.amazonaws.com", "scheduler.amazonaws.com", "backup.amazonaws.com", "events.amazonaws.com"]
  service_linked_role_names   = ["ecs.amazonaws.com", "elasticloadbalancing.amazonaws.com", "rds.amazonaws.com", "backup.amazonaws.com"]

  # Variables available to every policy template. Lists are passed pre-encoded as JSON.
  policy_vars = {
    account_id                    = var.account_id
    region                        = var.region
    prefix                        = var.prefix
    environment                   = var.environment
    env_path                      = var.env_path
    state_bucket                  = var.state_bucket
    state_key_arn                 = var.state_key_arn
    cloudtrail_bucket             = var.cloudtrail_bucket
    cloudmap_namespace            = var.cloudmap_namespace
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

  documents = {
    for name in [
      "deployer-read", "deployer-state", "deployer-network", "deployer-compute", "deployer-data",
      "deployer-observability", "deployer-iam", "deployer-guardrails-environment",
      "deployer-guardrails-identity", "deployer-boundary", "workload-boundary",
    ] : name => jsonencode(jsondecode(templatefile("${path.module}/policies/${name}.json.tftpl", local.policy_vars)))
  }
}
