# CI/CD: TEST and PRODUCTION

**Purpose:** how a change reaches Munaxa Docs TEST and PRODUCTION, which identity does what, what
TEST costs, and what must exist before each step can run. The code is in `.github/workflows/`,
`scripts/ci/` and `infra/terraform/` (see its [README](../../infra/terraform/README.md)).

**Status:** the design is complete in the repository. **Nothing on the AWS side exists yet:** no
GitHub OIDC provider, no CI role, no TEST bootstrap, no TEST foundation. The release pipeline is
**off** until TEST exists (§10).

## 1. The flow

```
feature branch → pull request → CI (ci.yml, infrastructure-checks.yml) → merge to main
  → release.yml
      build once     publish-images.yml: three images from the merge commit, probed, pushed,
                     pinned by digest, pulled back with the production pull identity
      → TEST         test-session.yml `up` (environment `testing`), automatic:
                     create TEST (or roll the running one), migrate its database, verify health;
                     the run page shows https://test.docs.munaxa.com
      → QA           people test on TEST
      → approval     environment `production`: its required reviewers approve this run
      → PRODUCTION   deploy-release.yml (environment `production`): the SAME digests, no rebuild
      → TEST off     test-session.yml `down`: TEST is destroyed once PRODUCTION has the release
```

A merge never deploys PRODUCTION on its own. The production job needs both of these:
- TEST succeeded;
- a reviewer approved.

The production job only gets AWS credentials after the approval.

If nobody approves, TEST still stops by itself (§6). The approval can be given later all the same:
PRODUCTION needs TEST to have **passed**, not to be running.

## 2. TEST: a cheap foundation, and sessions that exist only while needed

TEST is split by what things cost when nobody is testing.

**Persistent foundation** (`infra/terraform/eu-test/foundation`, plus `bootstrap-eu-test`). Free
or nearly free, created once:

| Resource | Idle cost / month |
| --- | --- |
| VPC, two public and two database subnets, route tables, internet gateway, S3 gateway endpoint, security groups | $0 |
| **No NAT gateway.** Tasks get a public IP and an egress-only security group, so nothing needs one | $0 |
| ECS cluster (Fargate and Fargate Spot capacity providers) | $0 |
| CloudWatch log groups, 7-day retention | ≈ $0 (no traffic) |
| Workload IAM roles and boundary, TEST deployer, Testing CI role, GitHub OIDC provider | $0 |
| ACM certificate for `test.docs.munaxa.com` | $0 |
| Route 53 public hosted zone `test.docs.munaxa.com` | $0.50 |
| KMS keys: Terraform state, TEST data | $2.00 |
| S3: Terraform state bucket; TEST document bucket (objects expire after 7 days) | ≈ $0.01 |
| DB subnet group, parameter group (`rds.force_ssl=1`) | $0 |
| AWS Budget for the account (first two budgets are free) | $0 |
| **Idle total** | **≈ $2.50–3** |

**Ephemeral session** (`infra/terraform/eu-test/session`), created by a release and destroyed
after it. Every resource is tagged `Lifecycle=ephemeral` and `ExpiresAt=<UTC time>`:

| Resource | While running |
| --- | --- |
| PostgreSQL 16, `db.t4g.micro`, single AZ, 20 GB gp3, **no backups, no final snapshot** | ≈ $0.024/h |
| Application Load Balancer, HTTPS (TLS 1.3 policy), HTTP → HTTPS redirect | ≈ $0.03/h |
| Fargate: web 0.25 vCPU/1 GB, API 0.5 vCPU/2 GB (with Redis), scanner 0.25 vCPU/2 GB on **Spot** | ≈ $0.06/h |
| Public IPv4 addresses (load balancer, tasks) | ≈ $0.025/h |
| Secrets Manager (application, operator, GHCR pull, RDS master), deleted without a recovery window | ≈ $0.002/h |
| Cloud Map namespace, DNS record `test.docs.munaxa.com` → load balancer | ≈ $0 |
| **Session total** | **≈ $0.14/h, ≈ $3.40 for a 24-hour session** |

Prices are eu-central-1 on-demand list prices; the AWS bill is the authority.

**Compared:**

| Option | Idle / month | Notes |
| --- | --- | --- |
| A. Permanent TEST (everything always on, with NAT) | ≈ $140 | Simplest; pays for nothing most of the month |
| B. Fully ephemeral (everything, including network, DNS zone, certificate, keys) | ≈ $0 | Every session waits for certificate validation and a new DNS delegation, which needs a manual Cloudflare change each time. Not workable without DNS automation |
| **C. Hybrid (chosen)** | **≈ $2.50–3** | Stable URL and certificate; a session starts in about 15–20 minutes |

Not used by TEST: ECR (images come from GHCR), NAT gateways, Multi-AZ, Performance Insights,
enhanced monitoring, AWS Backup, a CloudTrail trail of its own (§11).

TEST never sends email: `MAIL_DRIVER=NONE`, and the session has no SMTP credential at all.

## 3. Environments

| | TEST | PRODUCTION |
| --- | --- | --- |
| GitHub environment | `testing` | `production` |
| Who may deploy | `main` only | `main` only |
| Approval | none: automatic after merge | required reviewers |
| AWS account | `munaxa-nonprod` 657878534449 (NonProduction OU) | 800728620253 (management account) |
| Names | `munaxa-docs-eu-test-*`, `Environment=Testing` | `munaxa-docs-eu-prod-*`, `Environment=Production` |
| Terraform | `bootstrap-eu-test`, `eu-test/foundation`, `eu-test/session` | `bootstrap`, `eu-prod/{core,data,service}` |
| State bucket | `munaxa-docs-tfstate-eu-test-657878534449` | `munaxa-docs-tfstate-eu-prod-800728620253` |
| Database | disposable, recreated per session, migrated automatically | persistent; migrations are an operator step |
| URL | `https://test.docs.munaxa.com` (while a session runs) | `https://docs.munaxa.com` |

TEST lives in its own account, so the separation is enforced by the account boundary as well as
by IAM. No TEST principal appears in any Production trust or bucket policy.

The old non-production stack in the management account (VPC `munaxa-docs-nonprod`, an RDS
instance, an empty ECS cluster, a validation bucket and unmanaged IAM roles) is **not** TEST. It
is not managed by Terraform. The Production deployer is denied it, and this design doesn't use
it. Retiring it is a separate owner decision (ADR-0024 puts its idle cost at about $100 a month).

## 4. Using TEST (no AWS console, no Terraform, no command line)

Everything is in the repository's **Actions** tab.

- **After a merge:** open the **Release** run. The **TEST** job links to
  `https://test.docs.munaxa.com` once it is healthy. Sign in with the TEST administrator account
  (the `TEST_ADMIN_EMAIL` secret; ask the repository owner for the password).
- **Approve PRODUCTION:** on the same run, **Review deployments** → `production` → Approve. When
  PRODUCTION is done, TEST switches itself off.
- **Buttons:** **TEST environment** → Run workflow → choose:

  | Action | What it does |
  | --- | --- |
  | `status` | Shows whether TEST runs, which release, until when, and its address (run summary) |
  | `start` | Starts TEST with the newest release on `main`, or the commit you enter |
  | `extend` | Keeps TEST running for 4, 8, 24, 48 or 72 hours from now |
  | `stop` | Destroys TEST now |

- **Where state is visible:** the run summary of each TEST run, and Settings → Environments →
  `testing` (the latest deployment and its URL).

Each TEST session starts with an **empty** database: one tenant (`munaxa-internal`) and one
administrator. Data entered during QA disappears when TEST stops. A new release on a TEST that is
already running keeps its data.

## 5. What a TEST session does

`test-session.yml up`, in the `testing` environment:

1. **Checks** that the release commit is on `main` and that each image digest's revision label is
   that commit (the same check PRODUCTION makes).
2. **Looks at AWS** (`scripts/ci/test-session.sh describe`): the load balancer's and database's
   `ExpiresAt` and `ReleaseCommit` tags.
3. **No session:** applies the session with `enable_services=false` (database, load balancer, DNS
   record, secret containers, task definitions). Then bootstraps the database, as the #131
   operator procedure does, but unattended:
   - writes freshly generated values into the secret containers. The deployer may write secret
     values but never read them;
   - runs the database administration task: roles `edms_owner`, `edms_app`, `edms_backup`, and
     the tenant database;
   - opens a tunnel task and an SSM port forward from the runner, and runs
     `node scripts/migrate-tenants.mjs` twice (the second run must find nothing pending);
   - creates a temporary provisioning secret, runs the provisioning task (tenant and first
     administrator), and deletes the secret;
   - applies again with `enable_services=true`.
4. **Session already running:** plans the new images, migrates the database through the tunnel
   (only the migration owner's password is rotated; every other secret keeps its value), then
   applies the saved plan.
5. **A session whose services never started** (an earlier failure) is destroyed and rebuilt.
6. **Waits** for the three services and checks `/api/health/ready` and `/login` over HTTPS.

Every plan is saved and checked by `scripts/ci/plan-guard.sh session`. It refuses anything
outside the session's own resources (`aws_db_instance.main`, `aws_route53_record.web`,
`module.app.*`), and it refuses to delete or replace the database or a secret container during an
apply. Teardowns are checked by `plan-guard.sh session-destroy`: deletes only, and only the
session's own resources.

Generated passwords exist only in the runner process and in Secrets Manager. They are masked in
the log, never echoed, and written only to a private temporary directory that is removed on exit.

## 6. Expiry and cleanup

- Each `up` sets `ExpiresAt` to **24 hours** after the deployment. `extend` moves it up to 72 hours
  ahead.
- `release.yml` stops TEST once PRODUCTION has the release, unless a newer release is already
  under test there (the `ReleaseCommit` tag differs).
- **Hourly** (`TEST environment`, schedule): if a session exists and its `ExpiresAt` has passed,
  or it has none, it is destroyed. A session is found by its load balancer, its database **or**
  its application secret. So a half-built or half-destroyed session is cleaned up too.
- `extend` accepts 4–72 hours from now; it can be repeated, but `ExpiresAt` is never more than 72
  hours ahead.
- Teardown is idempotent: a destroy with nothing left does nothing. A leftover provisioning
  secret is deleted, and the run fails if any session resource remains.
- Teardown cannot reach PRODUCTION. It runs as the Testing CI role and the TEST deployer in
  657878534449, and its plan may only delete the session's own resources.
- **One queue.** Everything that changes TEST (deploy, extend, stop, expiry teardown) runs one at
  a time, so a teardown can never run in the middle of a deployment. Each run decides only when it
  reaches the head of the queue, from what AWS shows at that moment.
  - The hourly check looks first, outside the queue, and joins the queue only if something has
    expired.
  - GitHub keeps one waiting run per queue, so a newer waiting run replaces an older waiting one.
    A release replaced this way is not tested and not promoted. Use **TEST environment → start**
    with its commit to test it again.
  - `status` only reads and never queues.

**Budget:** `bootstrap-eu-test` creates an AWS Budget for the whole 657878534449 account,
`$15`/month by default. It emails at 50 % and 100 % of actual spend, and at 100 % of forecast.

What $15 covers:
- the foundation (about $3) plus about 85 session-hours;
- for example 20 releases a month, each tested for about 4 hours.

If TEST routinely stays up until its 24-hour expiry, raise it to $30. The first two budgets of an
account are free.

The account was created with IAM access to billing denied. Its roles may therefore be refused the
Budgets API. The TEST bootstrap runbook checks this first. If they are refused, the same budget is
created from the management account, filtered to the linked account (`create_budget = false`).

## 7. Identity chains

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
- **No free inputs.** No workflow takes a role ARN, account, directory or path as input. Account,
  roles and directories are fixed in the workflow or chosen from closed lists.
- **The deployers.** Their permissions are the same templates for both environments
  (`infra/terraform/modules/deployer-policies`), rendered with `Environment=Production`/`eu-prod`
  or `Environment=Testing`/`eu-test`. For Production the rendered documents are byte-identical to
  what was applied before this change. TEST adds, **in TEST only**:
  - a boundary statement and one document (`deployer-testing-session`) for the session:
    - DNS records for `test.docs.munaxa.com` and below only;
    - the SSM port-forwarding session into the TEST cluster's tasks only;
    - ECS Exec on the TEST cluster;
    - ending its own `gha-run-*` sessions.
  - deletes of its own TEST resources, which the shared templates already allow per environment.
    Task definitions are kept (`skip_destroy`); `ecs:DeregisterTaskDefinition` is effectively
    not granted.
- **Two bridges, not one.** `configure-aws-credentials` can't set a source identity. So the job's
  credentials are the CI role, and Terraform's own `assume_role` (provider and
  `ci.s3.tfbackend`) opens the deployer session with source identity `github-actions`. The TEST
  scripts do the same with `aws sts assume-role --source-identity github-actions`, keeping the
  credentials in their own process. CloudTrail therefore attributes every change to
  `github-actions` and the run ID.

## 8. Immutable artifacts and promotion

1. **Built once.** `publish-images.yml` runs for every merge (called by `release.yml`). It builds
   `api` and `web` from the merge commit, and builds the scanner and accepts it only after its
   ICAP probes pass. Each image is pushed under two immutable tags (`<short>`, `sha-<full>`) and
   recorded by **digest**, then pulled back with the production pull identity. It never uses
   `latest`.
2. **Promoted by digest.** TEST and PRODUCTION receive the same three
   `ghcr.io/munaxa/munaxa-docs-*@sha256:…` references from that build job's outputs. Before
   deploying, both `test-session.yml` and `deploy-release.yml` check that each digest exists in
   GHCR and that its `org.opencontainers.image.revision` label is the release commit. Nothing is
   rebuilt. `TEST environment → start` finds a release's digests through its `sha-<commit>` tags
   and checks the same label.
3. **PRODUCTION is applied as a release, not as infrastructure.** The service root takes the
   digests as `-var` values, which override the committed `release.auto.tfvars`.
   `scripts/ci/plan-guard.sh release` refuses any plan that does more than replace the task
   definitions (`web`, `api`, `scanner`, `ops_provision`) and update the three services. The
   deployment order follows the runbook: scanner, then API (with the provisioning task, which
   runs the API image), then web. Each step waits for its service to stabilise. A final
   untargeted plan must be empty.
4. **Verified.** The PRODUCTION job checks that `BASE_URL` answers 200 on `/api/health/ready` and
   `/login`.

**PRODUCTION database migrations stay an operator step** (`docs/operations/deployment.md`). The
production job compares `prisma/migrations` between the release PRODUCTION runs now and the new
one. If they differ, it stops before touching anything. An operator then migrates every tenant
database and re-runs **Deploy release** from `main` with `schema_migrated: true`. The production
environment's reviewers approve that run too. TEST migrates automatically, because its database
is disposable.

## 9. Infrastructure

`terraform-infra.yml` is dispatched by hand. Its inputs are:
- environment and root: `testing`/`foundation`, or `production`/`core`, `data` or `service`;
- action: `plan` or `apply`.

How it works:
- Each input comes from a fixed list and maps to a fixed directory.
- It runs from `main` only.
- `apply` applies the saved plan from the same job.
- `production` runs wait for reviewers.
- For `service`, it plans with the image references PRODUCTION runs now. An infrastructure change
  can therefore never deploy or roll back the application.
- `plan-guard.sh infra` refuses to delete or replace a database, bucket, key, network, load
  balancer, cluster, service, secret, backup vault, IAM role or hosted zone from CI.

The TEST session is not here. It belongs to `test-session.yml`.

**Bootstrap is never run by CI.** `bootstrap/` (Production) and `bootstrap-eu-test/` (TEST) are
applied by an administrator in that account, for example in AWS CloudShell. Their plans show
every trust policy in full: every ARN a trust names is built from fixed parts, creation order is
explicit, and postconditions check the created ARNs.

## 10. Before the pipeline is turned on

### GitHub settings (by hand)

**Settings → Environments → New environment `testing`:**

| Setting | Value |
| --- | --- |
| Deployment branches and tags | **Selected branches and tags** → add rule `main` (only) |
| Required reviewers | none (TEST deploys automatically) |
| Wait timer | none |
| Secret `TEST_PULL_USER` | GitHub user of a **read-only** GHCR pull identity for `ghcr.io/munaxa/munaxa-docs-*` |
| Secret `TEST_PULL_TOKEN` | its token: classic PAT with `read:packages` only, or a fine-grained token with packages read; expiry noted in your calendar |
| Secret `TEST_ADMIN_EMAIL` | the e-mail you sign in to TEST with (any mailbox: TEST sends no mail) |
| Secret `TEST_ADMIN_PASSWORD` | a long random password used only for TEST |
| Variables | none required |

**Settings → Environments → New environment `production`:**

| Setting | Value |
| --- | --- |
| Deployment branches and tags | **Selected branches and tags** → add rule `main` (only) |
| Required reviewers | at least one named person (you); tick **Prevent self-review** if a second reviewer exists |
| Allow administrators to bypass | **off** |
| Wait timer | optional |
| Variable `BASE_URL` | `https://docs.munaxa.com` |
| Secrets | none: the GHCR pull identity stays the existing repository secrets `DOCS_PRODUCTION_PULL_USER` / `DOCS_PRODUCTION_PULL_TOKEN` |

**Settings → Secrets and variables → Actions → Variables (repository):**
- `TEST_ENVIRONMENT_ENABLED` = `true`, set once TEST exists (step 9 below). Until then the TEST
  buttons and the hourly expiry do nothing.
- `RELEASE_PIPELINE_ENABLED` = `true`, set **last** (step 12).

Until `RELEASE_PIPELINE_ENABLED` is set, every merge to `main` builds and deploys nothing. Set it
any earlier and the next merge would do the following:
- build and push images;
- try to create TEST before it can exist, or promote to a PRODUCTION whose service root (#131)
  is not on `main`;
- fail halfway.

Set it last, and the first automatic release finds every piece in place.

**Create both environments before any AWS bootstrap.** If a workflow references an environment
that doesn't exist, GitHub creates it with no protection, and its tokens would still carry that
environment's subject. No AWS secret is ever stored in GitHub; the role ARNs are written in the
workflows.

### Order

| # | Step | Who | AWS write? |
| --- | --- | --- | --- |
| 1 | Create the `testing` and `production` environments and the four TEST secrets (above) | you, GitHub | no |
| 2 | Production bootstrap **plan** ([runbook](bootstrap-plan-runbooks.md) §2): expect 4 add, 1 change, PASS | `admin.tamer`, CloudShell | no |
| 3 | TEST bootstrap **plans** ([runbook](bootstrap-plan-runbooks.md) §3): expect PASS twice | you, `munaxa-nonprod` CloudShell | no |
| 4 | Approve and apply the Production bootstrap (same plan, `apply bootstrap.tfplan`) | `admin.tamer` | **yes** (A) |
| 5 | Approve and apply the TEST bootstrap in two steps (key, then the rest; then `-migrate-state`) | you | **yes** (B) |
| 6 | Merge #134 | you | no |
| 7 | `terraform-infra.yml`: `production`/`core` and `production`/`data`, `plan`. Both should show no changes (proves the Production CI chain) | GitHub Actions | no |
| 8 | `terraform-infra.yml`: `testing`/`foundation`, `plan`, then `apply` | GitHub Actions | **yes** (C) |
| 9 | Cloudflare, once: four `NS` records for `test` in `munaxa.com` (from `delegation_name_servers`), proxy off; DMARC unchanged. Then set `TEST_ENVIRONMENT_ENABLED=true` | you | no (Cloudflare) |
| 10 | **TEST environment → start**, check the URL, sign in, then **stop** | GitHub Actions | **yes** (D) |
| 11 | #131 merged and PRODUCTION running a release from `eu-prod/service` (operator procedure; separate approval) | you / operator | **yes** (E) |
| 12 | Set `RELEASE_PIPELINE_ENABLED=true` | you | no |

## 11. AWS write gate

Nothing below has been run. Each group needs your explicit approval.

**A. Production bootstrap** (800728620253, `admin.tamer`): **4 creates, 1 update.**
- create: the GitHub OIDC provider `token.actions.githubusercontent.com`;
- create: the role `munaxa-docs-eu-prod-ci`, its inline policy and its boundary;
- update: the trust of `munaxa-docs-eu-prod-deployer`, adding `GitHubActionsSessions` and
  `GitHubActionsSourceIdentity`. Nothing else.

**B. TEST bootstrap** (657878534449): 37 creates (36 without the budget).
- the state key and alias;
- the state bucket and its six settings;
- the OIDC provider, the Testing CI role, its policy and its boundary;
- the TEST deployer, its boundary, the workload boundary, and ten deployer policies with their
  attachments;
- the budget (or, if refused, one budget in the management account).

**C. TEST foundation** (657878534449, GitHub Actions as the TEST deployer):
- network: VPC, 2 public and 2 database subnets, internet gateway, 2 route tables and their
  associations, the S3 gateway endpoint, 6 security groups and their rules;
- ECS cluster with capacity providers, and 5 log groups;
- Route 53 zone `test.docs.munaxa.com` and the certificate validation record;
- ACM certificate;
- data key and its alias;
- the document bucket and its six settings;
- DB subnet group and parameter group;
- 6 execution roles and 2 task roles, with their policies.

**D. TEST session**, every time TEST starts. Destroyed again by stop, promotion or expiry:
- database, load balancer, two target groups, two listeners and a listener rule;
- DNS alias record;
- Cloud Map namespace and two services;
- three secret containers and their values;
- six task definitions and three services;
- per run: operator tasks, one SSM session and one temporary provisioning secret.

**E. Production application** (800728620253):
- #131's service root, first applied by the operator procedure;
- then each approved release. A release only replaces task definitions and updates the three
  services (`plan-guard.sh release`).
- Production schema migrations stay an operator action.

## 12. Follow-ups and open decisions

- **#131 (Production service root)** must be merged before PRODUCTION can take a pipeline
  release. Until then `deploy-release.yml` stops at "The environment exists": `eu-prod/service`
  has no `ecs.tf` on `main`. After it merges, its `release.auto.tfvars` becomes the initial and
  fallback release only, because pipeline releases pass the digests as `-var`. Its task
  definition and service addresses are what the release guard expects:
  - `aws_ecs_task_definition.{web,api,scanner,ops_provision}`;
  - `aws_ecs_service.{web,api,scanner}`.
- **Moving Production onto `modules/app-service`: deferred, not needed.** The two-environment
  design works with Production on its own #131 root. The module exists so that TEST builds the same
  application stack. A later move would use `moved` blocks and is accepted only with a no-change
  Production plan.
- **CloudTrail for 657878534449: decision needed.** No organisation trail exists. The only trail is
  `munaxa-docs-account-trail` in 800728620253: single-account, multi-region. The CloudTrail
  console's 90-day event history still covers the TEST account without a trail.
  - **Recommended:** make that trail an organisation trail later. That means enabling CloudTrail
    trusted access in Organizations, setting `is_organization_trail`, and adding the
    `AWSLogs/o-qzf8irwaya/*` prefix to its bucket policy.
  - Every member account's management events then land in the management account's bucket, where
    no member-account administrator can delete them.
  - The first copy of management events is free.
  - It changes a Production audit resource, so it is a separate bootstrap change with its own
    plan and approval.
- **Production budget alerts go to `alerts@example.com`** (the example value). Nobody receives
  them. Changing the address is a one-line Production bootstrap change; keep it separate from
  step 4 so the bootstrap plan stays exactly 4 + 1.
- **The legacy `munaxa-docs-nonprod` stack in 800728620253 is still running and is not TEST.**
  It consists of:
  - VPC `vpc-0b749fc532d67e1cb` (10.120.0.0/16) with a NAT gateway and its Elastic IP;
  - RDS `munaxa-docs-eu-nonprod-pg` (db.t4g.small, Multi-AZ, deletion protection off);
  - an empty ECS cluster `munaxa-docs-eu-nonprod`;
  - bucket `munaxa-docs-eu-nonprod-val-7d2e5a19`;
  - four `*nonprod*` IAM roles.

  It costs roughly $100 a month, mostly the NAT gateway and the Multi-AZ database. The new design
  neither uses nor touches it: both deployers are denied anything named or tagged non-production.
  Retiring it is a separate owner decision.
- **`claude-munaxa-docs` retirement (Stage 2):** remove the `ClaudeAgent*` trust and its state
  access, deactivate the key, then delete it after an observation period.
- **The migration runner passes its database URL to `prisma` as a command-line argument**
  (`scripts/migrate-tenants.mjs`, unchanged here). On a TEST runner this is a single-use, per-run
  password on an ephemeral, single-tenant VM, and the password is masked in the log. Changing the
  runner to pass it through the environment is a separate application change.
