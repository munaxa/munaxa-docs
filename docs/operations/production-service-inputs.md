# Production service inputs — what the operator supplies before `eu-prod/service` runs

**Account** `229251310592`, **region** `eu-central-1`. Companion to `infra/terraform/eu-prod/service/`
(ADR-0024 and its 2026-10-22 amendment: images in ECR, pulled with IAM). Every value below is produced and written **by an administrator from their own
machine or the AWS console**. No value is ever committed, pasted into a chat, put in a task override
or placed in Terraform. Run the commands with your administrator identity (the deployer cannot read
or write secret values, by design).

Write secret values from a file you then delete (`--secret-string file://…`), never inline, so they
do not land in shell history. Run `umask 077` before creating such a file.

## Current state (2026-10-26, read-only checks)

| Item | State |
| --- | --- |
| Default stage | **Applied 2026-10-26** ([run 40289111146](https://github.com/munaxa/munaxa-docs/actions/runs/40289111146), `main` at `de4ce3f`): 22 added, 0 changed, 0 destroyed |
| ACM `docs.munaxa.com` | `arn:aws:acm:eu-central-1:229251310592:certificate/4f56303c-b416-4c30-83a7-0b8cf9ab4de7`, **ISSUED** (validation CNAME in Cloudflare, §1). Not yet attached to a listener |
| `enable_https` | Set to `true` in `launch.auto.tfvars`; **pending deployment** through a reviewed plan. Until then the ALB has no listener |
| `munaxa-docs-eu-prod/app`, `munaxa-docs-eu-prod/operator` | Created, **empty** (no version) |
| Registry | Amazon ECR `munaxa-docs/{api,web,antivirus}`, pulled by the execution roles with IAM. **No registry secret**. No ECS pull tested yet (go-live runbook §10.1) |
| Email | Resend (owner decision). Nothing is configured yet, and no API key exists |
| ECS | Cluster and the six task definitions exist; **no service, task or schedule** (`enable_services = false`) |
| `docs.munaxa.com` | **No record** in Cloudflare (a leftover CNAME to a load balancer outside this account was deleted 2026-10-26). Created at cutover only (§1) |

All secrets are encrypted with the Production data key `alias/munaxa-docs-eu-prod`.

## 1. DNS records in Cloudflare (`munaxa.com` zone)

Every record here is **DNS only (grey cloud), never proxied**: ACM must see its own validation record,
and the ALB must see the browser's address (`TRUST_PROXY` names the public subnets, not Cloudflare).

| When | Type | Name | Target |
| --- | --- | --- | --- |
| **After the default-stage apply** (certificate validation; keep it permanently for renewals) | CNAME | from `aws acm describe-certificate --query 'Certificate.DomainValidationOptions[0].ResourceRecord'` | the same |
| **Cutover only**, after the services are healthy and smoke-tested | CNAME | `docs.munaxa.com` | the ALB's DNS name (`terraform output alb_dns_name` after the default-stage apply; `munaxa-docs-eu-prod-<id>.eu-central-1.elb.amazonaws.com`) |

`docs.munaxa.com` does not exist today, and `munaxa.com` has no CAA record, so Amazon may issue.
Check validation with `aws acm describe-certificate --region eu-central-1 --certificate-arn <arn>
--query Certificate.Status` → `ISSUED`. Only then is `enable_https` applied.

## 2. Images — no credential

Images come from ECR by digest (`release.auto.tfvars`, from the release package). The web, API,
scanner and provisioning execution roles pull them with IAM; image layers come through the S3
gateway endpoint. There is no registry secret. The GitHub secrets `DOCS_PRODUCTION_PULL_USER` /
`DOCS_PRODUCTION_PULL_TOKEN` belong to the retired GHCR path: they stay until an ECS pull has been
verified (go-live runbook §10.1) and their removal is explicitly authorised.

## 3. Application bundle — `munaxa-docs-eu-prod/app`

One JSON object with exactly these 10 keys. ECS injects each as an environment variable; **a missing
key stops the task**. Read only by the API and provisioning execution roles (never web or scanner).

| Key | Value | Produce with |
| --- | --- | --- |
| `JWT_ACCESS_SECRET` | ≥ 32 characters | `openssl rand -base64 48` |
| `SIGNATURE_WITNESS_SECRET` | ≥ 32 characters; **keep every prior value** for the retention period | `openssl rand -base64 48` |
| `AUDIT_CHECKPOINT_SECRET` | ≥ 32 characters | `openssl rand -base64 48` |
| `MFA_TOTP_SEALING_KEY` | ≥ 32 characters | `openssl rand -base64 48` |
| `METRICS_SCRAPE_TOKEN` | ≥ 32 characters | `openssl rand -hex 32` |
| `REDIS_PASSWORD` | URL-safe | `openssl rand -hex 32` |
| `REDIS_URL` | `redis://:<REDIS_PASSWORD>@127.0.0.1:6379` | the same password |
| `MAIL_RESEND_API_KEY` | a Resend API key with **sending access only**, restricted to the verified domain | §4 |
| `DATABASE_URL` | `munaxa-internal`'s `edms_app` URL (required even with a catalogue, STG-5) | §6 |
| `TENANT_CATALOGUE` | the runtime catalogue (no owner credential) | §6 |

Not secret, already in the task definition: `MAIL_DRIVER=RESEND`,
`MAIL_FROM_ADDRESS=docs@notify.munaxa.com` (the API calls `https://api.resend.com/emails` over the
`api` group's HTTPS egress).

Write the whole object once every value exists (after §6 step 1). Then set `app_secret_version_id` in
`launch.auto.tfvars` to the returned version id, so every API task is pinned to it (ADR-0022
consequence 8).

## 4. Resend — administrator actions

Sender: **`docs@notify.munaxa.com`**. Nothing in AWS is needed: no SES identity and no IAM user.

1. In Resend, add the domain `notify.munaxa.com` and create its DNS records in Cloudflare exactly as
   Resend lists them (DKIM, SPF and the return-path MX on a `send.` subdomain), DNS only. Wait until
   Resend shows the domain **Verified**. `munaxa.com`'s DMARC policy applies.
2. Create an API key with **Sending access** only, limited to `notify.munaxa.com`. Copy it straight
   into the app bundle file (§3), never into a chat, git, a task override or Terraform.
3. **Not before launch preparation is authorised:** no real key is created, and no production customer
   data is sent, until then. Check the Resend plan's daily sending limit against expected volume, and
   record Resend as a processor (data protection review).

## 5. Operator bundle — `munaxa-docs-eu-prod/operator`

Read only by the db-admin execution role (never the API). The db-admin task reads the three passwords;
the other keys are the operator's record.

| Key | Value |
| --- | --- |
| `EDMS_OWNER_PASSWORD` | `openssl rand -hex 32` |
| `EDMS_APP_PASSWORD` | `openssl rand -hex 32` (the same value goes into `DATABASE_URL`) |
| `EDMS_BACKUP_PASSWORD` | `openssl rand -hex 32` |
| `EDMS_OWNER_URL` | `postgresql://edms_owner:<pw>@<rds host>:5432/edms_munaxa_internal?sslmode=require` |
| `EDMS_BACKUP_URL` | `postgresql://edms_backup:<pw>@<rds host>:5432/edms_munaxa_internal?sslmode=require` |
| `OPERATOR_TENANT_CATALOGUE` | the §6 catalogue with each tenant's `migrationUrl` (`edms_owner`) |

`<rds host>` is `munaxa-docs-eu-prod-pg.cjw44yig4u0v.eu-central-1.rds.amazonaws.com`.

## 6. Tenant `munaxa-internal` — bootstrap sequence

The API runs `DEPLOYMENT_PROFILE=CLOUD`, which refuses to start without a catalogue of at least one
tenant, and `DATABASE_URL` must be that tenant's `edms_app` URL.

| Item | Value |
| --- | --- |
| Slug / name | `munaxa-internal` / `Munaxa Internal` (internal launch tenant, not a customer) |
| Tenant id | a UUID generated once by the operator in step 1 (`uuidgen`), never reused or configured in git |
| Database | `edms_munaxa_internal` on `munaxa-docs-eu-prod-pg`, owner `edms_owner` |
| Storage | bucket `munaxa-docs-eu-prod-docs-229251310592`, prefix **`munaxa-internal`** |
| Search index | **`munaxa-internal`** |

The prefix and index are the bare slug because that is what the single-tenant form derives (the
provisioning run, finding D-1); the catalogue must agree with it.

Runtime catalogue (`TENANT_CATALOGUE` in the app bundle):

```json
{"defaults":{"storage":{"driver":"S3","container":"munaxa-docs-eu-prod-docs-229251310592","region":"eu-central-1","prefixTemplate":"{slug}"},
 "search":{"indexTemplate":"{slug}"}},
 "tenants":[{"id":"<uuid>","slug":"munaxa-internal","name":"Munaxa Internal",
   "database":{"url":"postgresql://edms_app:<pw>@<rds host>:5432/edms_munaxa_internal?sslmode=require"}}]}
```

Common `run-task` network settings (public subnets, the `ops` group: 5432 to RDS and 443 out, nothing
in; a public IP for image pulls and AWS endpoints, no NAT):

```bash
NET='awsvpcConfiguration={subnets=[subnet-0bbe4ecc835eaa146,subnet-0cb1769089ee5b9e2],securityGroups=[sg-0835cfc8b50e8e396],assignPublicIp=ENABLED}'
```

1. **Secrets for the cluster roles.** Generate the tenant UUID and the three database passwords; write
   the operator bundle (§5).
2. **Cluster roles and the tenant database** (as the RDS master user, from its RDS-managed secret):
   ```bash
   aws ecs run-task --region eu-central-1 --cluster munaxa-docs-eu-prod --launch-type FARGATE \
     --task-definition munaxa-docs-eu-prod-ops-dbadmin --network-configuration "$NET"
   ```
   It applies `infra/sql/cluster/01-roles.sql`, sets the three passwords, creates `edms_backup`
   (`BYPASSRLS`, `pg_read_all_data`), grants the master `SET` on `edms_owner`, creates
   `edms_munaxa_internal` owned by `edms_owner`, and prints the server version,
   **`max_connections`** (record it: ADR-0024 §2.5 only estimates it), `rds.force_ssl`, the roles and
   the database owner to `/munaxa-docs/eu-prod/ops`. Re-running it is safe. If `CREATE ROLE … BYPASSRLS`
   is refused on RDS, stop: the backup role is then created by the documented alternative (runbook §6
   1b) and recorded.
3. **Migrations** from a checkout of the release commit (`release_commit` in `release.auto.tfvars`)
   (`pnpm install --frozen-lockfile`), through the tunnel task:
   ```bash
   aws ecs run-task --region eu-central-1 --cluster munaxa-docs-eu-prod --launch-type FARGATE \
     --enable-execute-command --task-definition munaxa-docs-eu-prod-ops-tunnel --network-configuration "$NET"
   # task id from the output; runtime id: aws ecs describe-tasks … --query 'tasks[0].containers[0].runtimeId'
   aws ssm start-session --region eu-central-1 \
     --target "ecs:munaxa-docs-eu-prod_<task id>_<runtime id>" \
     --document-name AWS-StartPortForwardingSessionToRemoteHost \
     --parameters '{"host":["munaxa-docs-eu-prod-pg.cjw44yig4u0v.eu-central-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["15432"]}'
   # in a second terminal, with an operator catalogue file whose URLs use 127.0.0.1:15432:
   TENANT_CATALOGUE_PATH=/secure/operator-catalogue.local.json node scripts/migrate-tenants.mjs
   ```
   It applies `infra/sql/database/*.sql`, `prisma migrate deploy` and `infra/sql/post-migrate/*.sql`.
   Run it twice: the second run must report nothing pending. Stop the tunnel task afterwards
   (it stops itself after one hour). Needs the Session Manager plugin locally.
4. **Complete the app bundle** (§3) with `DATABASE_URL`, `TENANT_CATALOGUE` and `MAIL_RESEND_API_KEY`, and pin
   its version.
5. **First administrator** (after migrations; finding D-1, single-tenant form): create the temporary
   secret `munaxa-docs-eu-prod/provision/munaxa-internal` with keys `TENANT_ID` (the same UUID),
   `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD`, then
   ```bash
   aws ecs run-task --region eu-central-1 --cluster munaxa-docs-eu-prod --launch-type FARGATE \
     --task-definition munaxa-docs-eu-prod-ops-provision --network-configuration "$NET"
   aws secretsmanager delete-secret --region eu-central-1 \
     --secret-id munaxa-docs-eu-prod/provision/munaxa-internal --force-delete-without-recovery
   ```
   The `ops` group covers what provisioning needs (5432 to RDS, 443 for the image, secrets and S3);
   the product sends no invitation email. The task prints the tenant, role and administrator
   identifiers, never the password.

## 7. Order of operations

1. **Default-stage service apply** (secrets, cluster, Cloud Map, log groups, certificate request, ALB
   and target groups without listeners, the six task definitions). No task runs.
2. ACM validation CNAME (§1) → certificate `ISSUED`.
3. Resend domain verified and a send-only key (§4), once launch preparation is authorised.
4. Image pull verified (go-live runbook §10.1).
5. Tenant bootstrap §6 steps 1–3 (operator bundle, db-admin, migrations).
6. App bundle complete and pinned (§3, §6 step 4).
7. `enable_https` apply.
8. `enable_services` apply; scanner probe, health checks, smoke tests (runbook §14–§16).
9. First administrator (§6 step 5).
10. Cutover: the `docs.munaxa.com` CNAME (§1).
