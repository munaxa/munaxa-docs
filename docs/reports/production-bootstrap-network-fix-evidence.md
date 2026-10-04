# Production Terraform bootstrap — deployer network permission correction

**Date:** 2026-10-04. **Account** `800728620253`, **region** `eu-central-1`. **Applied by** the
administrator identity `claude-munaxa-docs`, through Terraform (`infra/terraform/bootstrap/`), never
by the deployer and never by an ad-hoc IAM edit. Production remains **NOT READY**.

## 1. The failure

The first `eu-prod/core` network apply (2026-10-04 20:33 UTC) created the VPC
`vpc-049f133b49fb662f4` and internet gateway `igw-011ce0a25ebdef008`. Every subnet, route table and
security group create was then refused:

```
UnauthorizedOperation: ... assumed-role/munaxa-docs-eu-prod-deployer/claude-terraform is not
authorized to perform: ec2:CreateSubnet on resource: arn:aws:ec2:eu-central-1:800728620253:vpc/vpc-049f133b49fb662f4
because no identity-based policy allows the ec2:CreateSubnet action.
```

**Cause.** `ec2:CreateSubnet`, `CreateRouteTable`, `CreateSecurityGroup` and `CreateVpcEndpoint` are
also authorized against the parent VPC (and, for a gateway endpoint, the route table). The
`CreateNetworkResourcesTaggedProduction` statement allows them only under `aws:RequestTag`, which
does not apply to those parent resources, and no statement allowed them on a Production-tagged VPC.
`simulate-principal-policy` on the live deployer reproduced `implicitDeny` for all four actions.

## 2. The change

| Item | Value |
| --- | --- |
| Commit | `37ffec5` on `claude/charming-cray-8jeacx`, [munaxa/munaxa-docs#130](https://github.com/munaxa/munaxa-docs/pull/130); all 18 CI checks green |
| File | `infra/terraform/bootstrap/policies/deployer-network.json.tftpl` only |
| Added | `CreateInsideProductionTaggedVpc`: the four actions on `vpc/*` with `aws:ResourceTag/Environment = Production`. `GatewayEndpointOnProductionTaggedRouteTables`: `ec2:CreateVpcEndpoint` on `route-table/*` with the same condition |
| Unchanged | Every deny, the deployer trust, both boundaries, the other ten policies, the state bucket and key, CloudTrail and the budget. The ten existing statements of `deployer-network` are byte-identical to live v1 |
| Size | 2,343 characters minified (limit 6,144) |

## 3. Validation before apply

- `terraform fmt -check`, `terraform validate`: pass. Access Analyzer `validate-policy`: **0 findings**.
- Simulation of the rendered policy with the **live** guardrail policies and the **live** deployer
  boundary:

| Action | Production VPC | Non-Prod VPC | Default VPC | Untagged VPC | `Environment=Staging` VPC | Production VPC, us-east-1 |
| --- | --- | --- | --- | --- | --- | --- |
| `ec2:CreateSubnet` | allowed | explicitDeny | explicitDeny | implicitDeny | implicitDeny | explicitDeny |
| `ec2:CreateRouteTable` | allowed | explicitDeny | explicitDeny | implicitDeny | implicitDeny | explicitDeny |
| `ec2:CreateSecurityGroup` | allowed | explicitDeny | explicitDeny | implicitDeny | implicitDeny | explicitDeny |
| `ec2:CreateVpcEndpoint` | allowed | explicitDeny | explicitDeny | implicitDeny | implicitDeny | explicitDeny |

  `CreateVpcEndpoint` on a route table: Production allowed, Non-Prod explicitDeny, untagged
  implicitDeny. Not granted by the change: `ec2:CreateNetworkAcl`, `ec2:RunInstances`.
- Bootstrap plan: **0 to add, 1 to change, 0 to destroy**, the in-place update of
  `aws_iam_policy.deployer["deployer-network"]` (attribute `policy` only).

## 4. Apply and verification

| Check | Result |
| --- | --- |
| Apply | 2026-10-04 20:57:40 UTC, re-planned after CI, document identical to the reviewed one: **0 added, 1 changed, 0 destroyed** |
| Post-apply plan | `-detailed-exitcode` → **0, "No changes."** |
| Live policy | `deployer-network` default version **v2** (created 20:57:46), identical to the reviewed document; v1 retained |
| Other bootstrap policies | `deployer-{boundary,read,state,compute,data,observability,iam,guardrails-environment,guardrails-identity}` and `workload-boundary` still **v1**, unchanged update dates. Deployer still has its boundary and 9 attached policies |
| State | `bootstrap/terraform.tfstate` rewritten at 20:57:48; SSE-KMS with the state key |
| CloudTrail (us-east-1, IAM) | One write: `CreatePolicyVersion` on `…/munaxa-docs-eu-prod-deployer-network` by `claude-munaxa-docs` (Terraform) |
| Effect | The resumed `eu-prod/core` network apply created all 39 remaining resources ([core network evidence](./production-core-network-evidence.md)) |
