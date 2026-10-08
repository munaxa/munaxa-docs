# Production service inputs — what the operator supplies before `eu-prod/service` runs

**Account** `800728620253`, **region** `eu-central-1`. Companion to `infra/terraform/eu-prod/service/`
(ADR-0024, ADR-0025). Every value below is produced and written **by an administrator from their own
machine or the AWS console**. No value is ever committed, pasted into a chat, put in a task override
or placed in Terraform. Run the commands with your administrator identity (the deployer cannot read
or write secret values, by design).

Write secret values from a file you then delete (`--secret-string file://…`), never inline, so they
do not land in shell history. Run `umask 077` before creating such a file.

## Current state (2026-10-05)

| Item | State |
| --- | --- |
| ACM `docs.munaxa.com` | `arn:aws:acm:eu-central-1:800728620253:certificate/c0f177fc-3022-4dbf-8b26-8d5a6e3ffc97`, **PENDING_VALIDATION** |
| `munaxa-docs-eu-prod/ghcr-pull` | Created, **empty** (no version) |
| `munaxa-docs-eu-prod/app` | Created, **empty** (no version) |
| `munaxa-docs-eu-prod/operator` | In the service plan; created by the default-stage apply |
| SES | Sandbox (200/day, 1/s), **no identities**, account suppression on for bounces and complaints |
| Everything else in the service root | Planned, not applied. No cluster, listener, task definition, task or service exists |

All secrets are encrypted with the Production data key `alias/munaxa-docs-eu-prod`.

## 1. DNS records in Cloudflare (`munaxa.com` zone)

Every record here is **DNS only (grey cloud), never proxied**: ACM must see its own validation record,
and the ALB must see the browser's address (`TRUST_PROXY` names the public subnets, not Cloudflare).

| When | Type | Name | Target |
| --- | --- | --- | --- |
| **Now** (certificate validation; keep it permanently for renewals) | CNAME | `_07182f68c52808ed8f90603ccdd70f4c.docs.munaxa.com` | `_e99522e8a18a209737e0e5cb562ea01b.wzccmgtwzk.acm-validations.aws` |
| **Cutover only**, after the services are healthy and smoke-tested | CNAME | `docs.munaxa.com` | the ALB's DNS name (`terraform output alb_dns_name` after the default-stage apply; `munaxa-docs-eu-prod-<id>.eu-central-1.elb.amazonaws.com`) |

`docs.munaxa.com` does not exist today, and `munaxa.com` has no CAA record, so Amazon may issue.
Check validation with `aws acm describe-certificate --region eu-central-1 --certificate-arn <arn>
--query Certificate.Status` → `ISSUED`. Only then is `enable_https` applied.

## 2. GHCR pull credential — `munaxa-docs-eu-prod/ghcr-pull`

The **production pull identity** used by the publishing workflow (`DOCS_PRODUCTION_PULL_USER` /
`DOCS_PRODUCTION_PULL_TOKEN`): read-only on `ghcr.io/munaxa/munaxa-docs-{api,web,antivirus}`. Never a
personal token and never a CI or assistant session token.

Exactly this JSON (the ECS private-registry format; nothing else):

```json
{"username":"<GitHub account of the pull identity>","password":"<its read:packages token>"}
```

```bash
umask 077 && $EDITOR /tmp/ghcr.json
aws secretsmanager put-secret-value --region eu-central-1 \
  --secret-id munaxa-docs-eu-prod/ghcr-pull --secret-string file:///tmp/ghcr.json \
  --query VersionId --output text
shred -u /tmp/ghcr.json 2>/dev/null || rm -P /tmp/ghcr.json
```

Read only by the web, API, scanner and provisioning execution roles. Record the token's expiry.

## 3. Application bundle — `munaxa-docs-eu-prod/app`

One JSON object with exactly these 11 keys. ECS injects each as an environment variable; **a missing
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
| `MAIL_SMTP_USERNAME` | the SES SMTP user's access key ID | §4 step 4 |
| `MAIL_SMTP_PASSWORD` | the derived SES SMTP password for `eu-central-1` | §4 step 4 |
| `DATABASE_URL` | `munaxa-internal`'s `edms_app` URL (required even with a catalogue, STG-5) | §6 |
| `TENANT_CATALOGUE` | the runtime catalogue (no owner credential) | §6 |

Not secret, already in the task definition: `MAIL_DRIVER=SMTP`,
`MAIL_SMTP_HOST=email-smtp.eu-central-1.amazonaws.com`, `MAIL_SMTP_PORT=587`,
`MAIL_SMTP_SECURITY=STARTTLS`, certificate validation on, `MAIL_FROM_ADDRESS=docs@notify.munaxa.com`.

Write the whole object once every value exists (after §6 step 1). Then set `app_secret_version_id` in
`launch.auto.tfvars` to the returned version id, so every API task is pinned to it (ADR-0022
consequence 8).

## 4. SES SMTP (ADR-0025) — administrator actions

Sender: **`docs@notify.munaxa.com`**. The deployer has no SES or IAM-user permission, by design, so
these are an administrator's steps.

**The existing DMARC policy is kept.** `munaxa.com` publishes
`v=DMARC1; p=quarantine; adkim=s; aspf=s; rua=mailto:admin@munaxa.com` and no `sp=`, so it already
applies, unchanged, to `notify.munaxa.com`. **Strict** DKIM alignment means the DKIM signing domain
must equal the From domain exactly, which is why the SES identity is `notify.munaxa.com` itself (Easy
DKIM signs as `d=notify.munaxa.com`). An identity on `munaxa.com` would fail alignment. SPF is not
aligned (the bounce domain is `bounce.notify.munaxa.com`), which DMARC does not need when DKIM passes.
**Do not publish `_dmarc.notify.munaxa.com`**, and never a weaker policy anywhere. **Do not change
the root SPF record.**

1. **Domain identity** (Easy DKIM, RSA 2048, signing on) and custom MAIL FROM:
   ```bash
   aws sesv2 create-email-identity --region eu-central-1 --email-identity notify.munaxa.com \
     --dkim-signing-attributes NextSigningKeyLength=RSA_2048_BIT \
     --tags Key=Project,Value=MunaxaDocs Key=Environment,Value=Production
   aws sesv2 put-email-identity-mail-from-attributes --region eu-central-1 \
     --email-identity notify.munaxa.com --mail-from-domain bounce.notify.munaxa.com \
     --behavior-on-mx-failure USE_DEFAULT_VALUE
   aws sesv2 get-email-identity --region eu-central-1 --email-identity notify.munaxa.com \
     --query 'DkimAttributes.Tokens' --output text
   ```
2. **DNS in Cloudflare** (DNS only):

   | Type | Name | Value |
   | --- | --- | --- |
   | CNAME ×3 | `<token>._domainkey.notify.munaxa.com` | `<token>.dkim.amazonses.com` (one per token from step 1) |
   | MX | `bounce.notify.munaxa.com` | `10 feedback-smtp.eu-central-1.amazonses.com` |
   | TXT | `bounce.notify.munaxa.com` | `v=spf1 include:amazonses.com ~all` (ADR-0025 §2) |

   That is all: no record at `notify.munaxa.com`, no DMARC record, no root SPF change. Wait until
   `get-email-identity` reports `VerifiedForSendingStatus: true` and `MailFromAttributes.MailFromDomainStatus: SUCCESS`.
3. **Bounce and complaint feedback** (ADR-0025 §2): an SNS topic `munaxa-docs-eu-prod-ses-feedback` with
   an operator email subscription, set as the identity's bounce and complaint notification topic, then
   email feedback forwarding disabled. (The deployer can create `munaxa-docs-eu-prod-*` topics; the
   identity settings are an administrator's.)
4. **The send-only IAM user** (ADR-0025 §3, the one long-lived-credential exception): no console
   access, no group, exactly this inline policy.
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Sid": "SendOnlyAsMunaxaDocsNotifications",
       "Effect": "Allow",
       "Action": "ses:SendRawEmail",
       "Resource": "arn:aws:ses:eu-central-1:800728620253:identity/notify.munaxa.com",
       "Condition": { "StringEquals": { "ses:FromAddress": "docs@notify.munaxa.com" } }
     }]
   }
   ```
   ```bash
   umask 077
   aws iam create-user --user-name munaxa-docs-ses-smtp \
     --tags Key=Project,Value=MunaxaDocs Key=Environment,Value=Production
   aws iam put-user-policy --user-name munaxa-docs-ses-smtp --policy-name ses-send-only \
     --policy-document file://ses-send-only.json
   aws iam create-access-key --user-name munaxa-docs-ses-smtp > /tmp/ses-key.json
   ```
   Derive the SMTP password for `eu-central-1` (AWS's documented algorithm) straight into the app
   bundle file, then destroy the key file: only the access key ID and the derived password are kept.
   ```python
   import base64, hashlib, hmac, json
   key = json.load(open('/tmp/ses-key.json'))['AccessKey']
   def sign(k, m): return hmac.new(k, m.encode(), hashlib.sha256).digest()
   s = sign(('AWS4' + key['SecretAccessKey']).encode(), '11111111')
   for part in ('eu-central-1', 'ses', 'aws4_request', 'SendRawEmail'): s = sign(s, part)
   app = json.load(open('/tmp/app.json'))          # the §3 file being assembled
   app['MAIL_SMTP_USERNAME'] = key['AccessKeyId']
   app['MAIL_SMTP_PASSWORD'] = base64.b64encode(bytes([0x04]) + s).decode()
   json.dump(app, open('/tmp/app.json', 'w'))
   ```
5. **Sandbox.** Until SES production access is granted (a separate, later request), mail reaches only
   verified addresses. The API starts and records deliveries either way; nothing else depends on it.

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

`<rds host>` is `munaxa-docs-eu-prod-pg.cx6gsegwu0rz.eu-central-1.rds.amazonaws.com`.

## 6. Tenant `munaxa-internal` — bootstrap sequence

The API runs `DEPLOYMENT_PROFILE=CLOUD`, which refuses to start without a catalogue of at least one
tenant, and `DATABASE_URL` must be that tenant's `edms_app` URL.

| Item | Value |
| --- | --- |
| Slug / name | `munaxa-internal` / `Munaxa Internal` (internal launch tenant, not a customer) |
| Tenant id | a UUID generated once by the operator in step 1 (`uuidgen`), never reused or configured in git |
| Database | `edms_munaxa_internal` on `munaxa-docs-eu-prod-pg`, owner `edms_owner` |
| Storage | bucket `munaxa-docs-eu-prod-docs-800728620253`, prefix **`munaxa-internal`** |
| Search index | **`munaxa-internal`** |

The prefix and index are the bare slug because that is what the single-tenant form derives (the
provisioning run, finding D-1); the catalogue must agree with it.

Runtime catalogue (`TENANT_CATALOGUE` in the app bundle):

```json
{"defaults":{"storage":{"driver":"S3","container":"munaxa-docs-eu-prod-docs-800728620253","region":"eu-central-1","prefixTemplate":"{slug}"},
 "search":{"indexTemplate":"{slug}"}},
 "tenants":[{"id":"<uuid>","slug":"munaxa-internal","name":"Munaxa Internal",
   "database":{"url":"postgresql://edms_app:<pw>@<rds host>:5432/edms_munaxa_internal?sslmode=require"}}]}
```

Common `run-task` network settings (public subnets, the `ops` group: 5432 to RDS and 443 out, nothing
in; a public IP for image pulls and AWS endpoints, no NAT):

```bash
NET='awsvpcConfiguration={subnets=[subnet-01cfdd28b811dc45a,subnet-06a6112661ef3a157],securityGroups=[sg-0a946c040abf7deb2],assignPublicIp=ENABLED}'
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
3. **Migrations** from a checkout of `041e8278d2808926d5aaad4c890f41ec2a648424`
   (`pnpm install --frozen-lockfile`), through the tunnel task:
   ```bash
   aws ecs run-task --region eu-central-1 --cluster munaxa-docs-eu-prod --launch-type FARGATE \
     --enable-execute-command --task-definition munaxa-docs-eu-prod-ops-tunnel --network-configuration "$NET"
   # task id from the output; runtime id: aws ecs describe-tasks … --query 'tasks[0].containers[0].runtimeId'
   aws ssm start-session --region eu-central-1 \
     --target "ecs:munaxa-docs-eu-prod_<task id>_<runtime id>" \
     --document-name AWS-StartPortForwardingSessionToRemoteHost \
     --parameters '{"host":["munaxa-docs-eu-prod-pg.cx6gsegwu0rz.eu-central-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["15432"]}'
   # in a second terminal, with an operator catalogue file whose URLs use 127.0.0.1:15432:
   TENANT_CATALOGUE_PATH=/secure/operator-catalogue.local.json node scripts/migrate-tenants.mjs
   ```
   It applies `infra/sql/database/*.sql`, `prisma migrate deploy` and `infra/sql/post-migrate/*.sql`.
   Run it twice: the second run must report nothing pending. Stop the tunnel task afterwards
   (it stops itself after one hour). Needs the Session Manager plugin locally.
4. **Complete the app bundle** (§3) with `DATABASE_URL`, `TENANT_CATALOGUE` and the SES values, and pin
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

1. ACM validation CNAME → certificate `ISSUED`.
2. GHCR credential (§2).
3. SES identity, DNS, feedback topic, send-only user, SMTP password (§4).
4. **Default-stage service apply** (cluster, Cloud Map, log groups, `operator` secret, ALB and target
   groups without listeners, the six task definitions). No task runs.
5. Tenant bootstrap §6 steps 1–3 (operator bundle, db-admin, migrations).
6. App bundle complete and pinned (§3, §6 step 4).
7. `enable_https` apply.
8. `enable_services` apply; scanner probe, health checks, smoke tests (runbook §14–§16).
9. First administrator (§6 step 5).
10. Cutover: the `docs.munaxa.com` CNAME (§1).
