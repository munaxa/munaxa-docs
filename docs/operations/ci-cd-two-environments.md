# CI/CD: TEST and PRODUCTION

**Purpose:** how a change reaches Munaxa Docs TEST and PRODUCTION, which identity does what, and
what must exist before each step can run. The code is in `.github/workflows/`, `scripts/ci/` and
`infra/terraform/` (see its [README](../../infra/terraform/README.md)).

**Status:** the design is complete in the repository. **Nothing on the AWS side exists yet:** no
GitHub OIDC provider, no CI role and no TEST bootstrap. The release pipeline is **off** until
TEST exists (§8).

## 1. The flow

```
feature branch → pull request → CI (ci.yml, infrastructure-checks.yml) → merge to main
  → release.yml
      build once        publish-images.yml: three images from the merge commit, probed, pushed,
                        pinned by digest, pulled back with the production pull identity
      → TEST            deploy-release.yml, GitHub environment `testing`: automatic
                        deploy + health verification
      → approval        GitHub environment `production`: its required reviewers approve this run
      → PRODUCTION      deploy-release.yml, GitHub environment `production`: the SAME digests
```

A merge never deploys PRODUCTION on its own. The production job needs both of these:
- TEST succeeded;
- a reviewer approved.

The production job only gets AWS credentials after the approval.

## 2. Environments

The GitHub environments are configured by hand; see §7.

| | TEST | PRODUCTION |
| --- | --- | --- |
| GitHub environment | `testing` | `production` |
| Who may deploy | `main` only | `main` only |
| Approval | none: automatic after merge | required reviewers |
| AWS account | `munaxa-nonprod` 657878534449 (NonProduction OU) | 800728620253 (management account) |
| Names | `munaxa-docs-eu-test-*`, `Environment=Testing` | `munaxa-docs-eu-prod-*`, `Environment=Production` |
| Terraform | `infra/terraform/bootstrap-eu-test`, `eu-test/{core,data,service}` | `infra/terraform/bootstrap`, `eu-prod/{core,data,service}` |
| State bucket | `munaxa-docs-tfstate-eu-test-657878534449` | `munaxa-docs-tfstate-eu-prod-800728620253` |

TEST lives in its own account, so the separation is enforced by the account boundary as well as
by IAM. No TEST principal appears in any Production trust or bucket policy.

The old non-production stack in the management account (VPC `munaxa-docs-nonprod`, an RDS
instance, an empty ECS cluster, a validation bucket and unmanaged IAM roles) is **not** TEST. It
is not managed by Terraform. The Production deployer is denied it, and this design doesn't use
it. Retiring it is a separate owner decision (ADR-0024 puts its idle cost at about $100 a month).

## 3. Identity chains

```
testing job    ── OIDC (sub repo:munaxa/munaxa-docs:environment:testing, ref refs/heads/main)
               → munaxa-docs-eu-test-ci        (657878534449; may only assume the TEST deployer)
               → munaxa-docs-eu-test-deployer  (source identity github-actions, session gha-run-*)
               → TEST Terraform state and resources

production job ── OIDC (sub repo:munaxa/munaxa-docs:environment:production, ref refs/heads/main)
               → munaxa-docs-eu-prod-ci        (800728620253; may only assume the PROD deployer)
               → munaxa-docs-eu-prod-deployer  (source identity github-actions, session gha-run-*)
               → PRODUCTION Terraform state and resources
```

- **What a CI role can do.** Each CI role (`infra/terraform/modules/github-oidc-ci`) has exactly
  one permission, which is also its permissions boundary: `sts:AssumeRole` and
  `sts:SetSourceIdentity` on its own environment's deployer. It has no access to state, KMS,
  services, secrets, IAM or Organizations.
- **What a CI role trusts.** Its trust requires all three of these, exactly:
  - `aud = sts.amazonaws.com`;
  - `sub = repo:munaxa/munaxa-docs:environment:<env>`;
  - `ref = refs/heads/main`.
- **TEST can't reach PRODUCTION:**
  - the testing token's `sub` doesn't match the Production CI role's trust;
  - the Testing CI role is in another account, and its only permission names the TEST deployer;
  - the Production deployer's trust doesn't name it;
  - the Production state bucket refuses every principal except the Production deployer and its
    administrators.
- **PRODUCTION can't reach TEST:** the reverse holds for the same reasons. No production
  identity is trusted in 657878534449.
- **Pull requests and branches can't get credentials:**
  - the workflows that request OIDC tokens never run on `pull_request`;
  - they refuse any ref but `main` before requesting one;
  - the environments admit only `main`;
  - the AWS trust requires `refs/heads/main` anyway.
- **The deployers are unchanged in shape.** Their permissions are the same templates for both
  environments (`infra/terraform/modules/deployer-policies`), rendered with
  `Environment=Production`/`eu-prod` or `Environment=Testing`/`eu-test`. For Production the
  rendered documents are byte-identical to what was applied before this change.
- **Two bridges, not one.** `configure-aws-credentials` can't set a source identity. So the job's
  credentials are the CI role, and Terraform's own `assume_role` (provider and
  `ci.s3.tfbackend`) opens the deployer session with source identity `github-actions`.
  CloudTrail therefore attributes every change to `github-actions` and the run ID.

## 4. Immutable artifacts and promotion

1. **Built once.** `publish-images.yml` runs for every merge (called by `release.yml`). It builds
   `api` and `web` from the merge commit, and builds the scanner and accepts it only after its
   ICAP probes pass. Each image is pushed under two immutable tags and recorded by **digest**,
   then pulled back with the production pull identity. It never uses `latest`.
2. **Promoted by digest.** TEST and PRODUCTION receive the same three
   `ghcr.io/munaxa/munaxa-docs-*@sha256:…` references from that build job's outputs. Before
   deploying, `deploy-release.yml` checks that each digest exists in GHCR and that its
   `org.opencontainers.image.revision` label is the release commit. Nothing is rebuilt.
3. **Applied as a release, not as infrastructure.** The service root takes the digests as
   `-var` values, which override the committed `release.auto.tfvars`.
   `scripts/ci/plan-guard.sh release` refuses any plan that does more than replace the
   task definitions (`web`, `api`, `scanner`, `ops_provision`) and update the three services.
   The deployment order follows the runbook: scanner, then API (with the provisioning task, which
   runs the API image), then web. Each step waits for its service to stabilise. A final
   untargeted plan must be empty.
4. **Verified.** The job checks that the environment's `BASE_URL` answers 200 on
   `/api/health/ready` and `/login`.

**Database migrations stay an operator step** (`docs/operations/deployment.md`). The release job
compares `prisma/migrations` between the release the environment runs now and the new one. If
they differ, the job stops before touching anything. An operator then migrates every tenant
database and re-runs **Deploy release** from `main` with `schema_migrated: true`. The production
environment's reviewers approve that run too.

## 5. Infrastructure

`terraform-infra.yml` is dispatched by hand. Its inputs are:
- environment: `testing` or `production`;
- root: `core`, `data` or `service`;
- action: `plan` or `apply`.

How it works:
- Each input comes from a fixed list and maps to a fixed directory.
- It runs from `main` only.
- `apply` applies the saved plan from the same job.
- `production` runs wait for reviewers.
- For `service`, it plans with the image references the environment runs now. An infrastructure
  change can therefore never deploy or roll back the application.
- `plan-guard.sh infra` refuses to delete or replace a database, bucket, key, network, load
  balancer, cluster, service, secret, backup vault or IAM role from CI.

**Bootstrap is never run by CI.** `bootstrap/` (Production) and `bootstrap-eu-test/` (TEST) are
applied by an administrator in that account, for example in AWS CloudShell. Their plans show
every trust policy in full: every ARN a trust names is built from fixed parts, creation order is
explicit, and postconditions check the created ARNs.

## 6. Who runs what

| Identity | Used for |
| --- | --- |
| GitHub Actions, `testing` | Releases to TEST; TEST infrastructure plans and applies |
| GitHub Actions, `production` | Approved releases to PRODUCTION; approved PRODUCTION infrastructure plans and applies |
| Claude engineering role (`MunaxaAWSEngineeringAdmin`) | Interactive reading, inspection and operator checks; may assume the Production deployer (`munaxa-org-operator`, `claude-*`) |
| `admin.tamer` (CloudShell) | Production bootstrap; break-glass |
| An administrator in `munaxa-nonprod` | TEST bootstrap |
| `claude-munaxa-docs` | **Still active, migration pending.** Its trust statements and state access are unchanged; removing them is the next stage, after the CI path is proven |

## 7. GitHub settings (by hand, before the AWS bootstrap)

Settings → Environments:

| Environment | Deployment branches | Required reviewers | Variables |
| --- | --- | --- | --- |
| `testing` | Selected branches: `main` only | none | `BASE_URL` = TEST's public URL |
| `production` | Selected branches: `main` only | at least one named person; "prevent self-review" recommended | `BASE_URL` = `https://docs.munaxa.com` |

Repository variable `RELEASE_PIPELINE_ENABLED` = `true`: set it **only** when §8 is complete.

**Create both environments before the AWS bootstrap.** If a workflow references an environment
that doesn't exist, GitHub creates it with no protection. Its tokens would still carry that
environment's subject.

No AWS secret is stored in GitHub. The role ARNs are written in the workflows. The existing
`DOCS_PRODUCTION_PULL_USER` and `DOCS_PRODUCTION_PULL_TOKEN` (GHCR pull) stay as they are.

## 8. What must exist before the pipeline is turned on

1. **GitHub:** both environments as in §7.
2. **Production bootstrap:** `admin.tamer` plans and then applies `infra/terraform/bootstrap`.
   Expected changes:
   - add the OIDC provider, the CI role, the CI role's inline policy and its boundary;
   - update the deployer trust in place, adding `GitHubActionsSessions` and
     `GitHubActionsSourceIdentity`.

   No other change is expected. Then dispatch `terraform-infra.yml` with `production`/`core` and
   `production`/`data`, `plan` only. Both should report no changes.
3. **TEST bootstrap:** an administrator in 657878534449 applies
   `infra/terraform/bootstrap-eu-test`: state bucket and key, TEST deployer and boundaries, OIDC
   provider and Testing CI role. The procedure is the same two-step first apply as Production.
4. **TEST workload roots:** `infra/terraform/eu-test/{core,data,service}` don't exist yet. They
   are made by turning the Production roots into shared modules after #131 merges (§9).
5. **First TEST release:** an operator task (databases created and migrated), then
   **Deploy release** with `schema_migrated: true`.
6. Then set `RELEASE_PIPELINE_ENABLED=true`.

## 9. Follow-ups this design depends on

- **#131 (Production service root):** after it merges, its `release.auto.tfvars` becomes the
  initial and fallback release only, because pipeline releases pass the digests as `-var`. Its
  task definition and service addresses are what the release guard expects:
  - `aws_ecs_task_definition.{web,api,scanner,ops_provision}`;
  - `aws_ecs_service.{web,api,scanner}`.
- **TEST workload roots:** move `eu-prod/{core,data,service}` into
  `infra/terraform/modules/{core,data,service}`, with `moved` blocks. The acceptance test is a
  Production plan with **no changes**. Then add thin `eu-test/{core,data,service}` roots with
  TEST sizes: single-AZ `db.t4g.micro`, no NAT, smallest tasks.
- **`claude-munaxa-docs` retirement (Stage 2):** remove the `ClaudeAgent*` trust and its state
  access, deactivate the key, then delete it after an observation period.
- **CloudTrail in 657878534449:** the Production trail is single-account. TEST needs its own
  trail, or an organisation trail.
