# Production Terraform `eu-prod/core` — network apply evidence

**Date:** 2026-10-04. **Account** `800728620253`, **region** `eu-central-1`. **Applied by** the
Production deployer role (session `claude-terraform`, source identity `claude-munaxa-docs`). Adds the
approved Production network (ADR-0024 §2.2) to the `core` root beside its IAM roles. Production
remains **NOT READY**.

## 1. What was applied

| Item | Value |
| --- | --- |
| Code | `infra/terraform/eu-prod/core/network.tf` and outputs, commit `2b214e9`, [munaxa/munaxa-docs#130](https://github.com/munaxa/munaxa-docs/pull/130) |
| First attempt | 20:33 UTC: plan 41 to add. VPC and internet gateway created; the other 39 refused by a gap in the deployer policy ([bootstrap correction](./production-bootstrap-network-fix-evidence.md)). Nothing was destroyed or recreated |
| Plan after the fix | **39 to add, 0 to change, 0 to destroy.** VPC and IGW adopted from state (no-op); the 18 IAM resources no-op; no Non-Prod or bootstrap identifier |
| Apply | 20:58:52–20:59:10 UTC: **39 added, 0 changed, 0 destroyed** |
| Post-apply plan | **exit 0, "No changes."** Core state now holds 59 resources (18 IAM, 41 network) |

## 2. The network

| Resource | Identifier | Configuration |
| --- | --- | --- |
| VPC `munaxa-docs-eu-prod` | `vpc-049f133b49fb662f4` | `10.121.0.0/16`, DNS support and hostnames on, no IPv6 |
| Internet gateway | `igw-011ce0a25ebdef008` | Attached to the VPC |
| Public subnet a / b | `subnet-01cfdd28b811dc45a` / `subnet-06a6112661ef3a157` | `10.121.0.0/24` 1a / `10.121.1.0/24` 1b |
| DB subnet a / b / c | `subnet-0cd8d041f1e096bb4` / `subnet-0c15ec302e0c30df8` / `subnet-013bc8910a22f96b4` | `10.121.64.0/24` 1a / `10.121.65.0/24` 1b / `10.121.66.0/24` 1c |
| `rt-public` | `rtb-060d2d69e20eafc3d` | local; `0.0.0.0/0` → IGW; S3 prefix list → endpoint. Both public subnets |
| `rt-db` | `rtb-0b7e1e8412edc9be9` | **local only.** All three DB subnets |
| Main route table | `rtb-05c820beaee3d0784` | local only, no subnet associated |
| S3 gateway endpoint | `vpce-05807434e24f3be79` | On `rt-public`; policy: object actions and `ListBucket` on `munaxa-docs-eu-prod-docs-800728620253` only |

Auto-assign public IP is off on all five subnets. No NAT Gateway. Every subnet, route table,
endpoint and group is tagged `Environment=Production`.

**Security groups** (19 rules; the default allow-all egress removed from each):

| Group | ID | Inbound | Outbound |
| --- | --- | --- | --- |
| `alb` | `sg-07f71b0d775b472f4` | 443, 80 from `0.0.0.0/0` | 3000 → web, 3001 → api |
| `web` | `sg-0496673ce341c92b2` | 3000 from alb | 3001 → api, 443 → `0.0.0.0/0` |
| `api` | `sg-0ac4f29bcf43b916d` | 3001 from alb and web | 5432 → rds, 1344 → scanner, 443 and 587 → `0.0.0.0/0` |
| `scanner` | `sg-0713a012430ac5ad3` | 1344 from api | 443 → `0.0.0.0/0` |
| `rds` | `sg-0f93fdd2718cd67de` | 5432 from api and ops | none |
| `ops` | `sg-0a946c040abf7deb2` | none | 5432 → rds, 443 → `0.0.0.0/0` |

Only the ALB group admits the internet. No group references anything outside this VPC.

## 3. Verification

| Check | Result |
| --- | --- |
| IAM roles | The 9 core roles' trust and inline policies are byte-identical to the reviewed core documents |
| Non-Prod | 44-document fingerprint, with Production-tagged and Production-named items excluded, **identical** to the baseline taken before the core apply |
| CloudTrail (eu-central-1, 20:58:40–21:00:40) | All by the deployer with source identity `claude-munaxa-docs`: 5 `CreateSubnet` (plus one throttled and retried), 2 `CreateRouteTable`, 1 `CreateRoute`, 5 `AssociateRouteTable`, 1 `CreateVpcEndpoint`, 6 `CreateSecurityGroup`, 8 `AuthorizeSecurityGroupIngress`, 11 `AuthorizeSecurityGroupEgress`, 6 `RevokeSecurityGroupEgress` (the default rules; 6 further idempotent `NotFound` retries). No other write |

## 4. Limitations

- The S3 endpoint policy admits only the Production bucket. Because the endpoint's prefix-list
  route is more specific than the internet route, a request from the public subnets to **any other
  eu-central-1 bucket** is refused by the endpoint policy (S3 in other regions is unaffected). The
  application images come from GHCR, not S3; whether any image pull (for example the Redis image
  from `public.ecr.aws`) reaches a regional S3 bucket is to be confirmed when the service root first
  starts tasks.
- The VPC's default security group keeps AWS's default rules; nothing is placed in it.
- No flow logs (ADR-0024 §2.11).
