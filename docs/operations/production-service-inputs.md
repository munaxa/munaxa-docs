# Production service inputs — what the operator supplies before `eu-prod/service` runs

**Account** `800728620253`, **region** `eu-central-1`. Companion to `infra/terraform/eu-prod/service/`
(ADR-0024, ADR-0025). Every value below is written **by an administrator from their own machine or
the AWS console**. No value is ever committed, pasted into a chat, put in a task override or placed
in Terraform. Run every command with your administrator identity (not the deployer, which cannot
read or write secret values by design).

Write secret values from a file you then delete (`--secret-string file://…`), never inline, so they
do not land in shell history. Use `umask 077` before creating the file.

## Current state (2026-10-04)

| Item | State |
| --- | --- |
| ACM `docs.munaxa.com` | `arn:aws:acm:eu-central-1:800728620253:certificate/c0f177fc-3022-4dbf-8b26-8d5a6e3ffc97`, **PENDING_VALIDATION** |
| `munaxa-docs-eu-prod/ghcr-pull` | Created, **empty** (no version). `…:secret:munaxa-docs-eu-prod/ghcr-pull-rHpjV9` |
| `munaxa-docs-eu-prod/app` | Created, **empty** (no version). `…:secret:munaxa-docs-eu-prod/app-Vaf3zn` |
| `munaxa-docs-eu-prod/operator` | Not yet created (next service apply) |
| SES | Sandbox (200/day, 1/s), **no identities**, account suppression on for bounces and complaints |
| Everything else in the service root | Planned, not applied. No cluster, listener, task or service exists |

All three secrets are encrypted with the Production data key `alias/munaxa-docs-eu-prod`.

## 1. ACM: the validation record (Cloudflare)

Create in the `munaxa.com` zone, **DNS only (grey cloud), not proxied**:

| Type | Name | Target |
| --- | --- | --- |
| CNAME | `_07182f68c52808ed8f90603ccdd70f4c.docs.munaxa.com` | `_e99522e8a18a209737e0e5cb562ea01b.wzccmgtwzk.acm-validations.aws` |

Keep it permanently: ACM uses it for automatic renewal. Check with
`aws acm describe-certificate --certificate-arn <arn above> --query Certificate.Status` → `ISSUED`.
Do **not** point `docs.munaxa.com` itself at anything yet; that is the cutover, after the services
are healthy.

## 2. GHCR pull credential — `munaxa-docs-eu-prod/ghcr-pull`

The **production pull identity** used by the publishing workflow (`DOCS_PRODUCTION_PULL_USER` /
`DOCS_PRODUCTION_PULL_TOKEN`), read-only on `ghcr.io/munaxa/munaxa-docs-{api,web,antivirus}`. Not a
personal or session token.

Exact JSON (ECS private-registry format; both keys required, nothing else):

```json
{"username": "<GitHub account of the pull identity>", "password": "<its read:packages token>"}
```

```bash
umask 077; $EDITOR /tmp/ghcr.json        # the JSON above
aws secretsmanager put-secret-value --region eu-central-1 \
  --secret-id munaxa-docs-eu-prod/ghcr-pull --secret-string file:///tmp/ghcr.json
shred -u /tmp/ghcr.json 2>/dev/null || rm -P /tmp/ghcr.json
```

Read by the web, API, scanner and provisioning execution roles only. Record the token's expiry.

## 3. Application bundle — `munaxa-docs-eu-prod/app`

One JSON object. ECS injects each key as an environment variable; **a missing key stops the task**.
Read by the API execution role and the provisioning execution role only (never web or scanner).

| Key | Value | How to produce it |
| --- | --- | --- |
| `JWT_ACCESS_SECRET` | ≥ 32 characters | `openssl rand -base64 48` |
| `SIGNATURE_WITNESS_SECRET` | ≥ 32 characters; **keep every prior value** for the retention period | `openssl rand -base64 48` |
| `AUDIT_CHECKPOINT_SECRET` | ≥ 32 characters | `openssl rand -base64 48` |
| `MFA_TOTP_SEALING_KEY` | ≥ 32 characters | `openssl rand -base64 48` |
| `METRICS_SCRAPE_TOKEN` | ≥ 32 characters | `openssl rand -hex 32` |
| `REDIS_PASSWORD` | URL-safe | `openssl rand -hex 32` |
| `REDIS_URL` | `redis://:<REDIS_PASSWORD>@127.0.0.1:6379` | the same password |
| `MAIL_SMTP_USERNAME` | the SES SMTP user's **access key ID** | §4 |
| `MAIL_SMTP_PASSWORD` | the derived **SES SMTP password for eu-central-1** | §4 |
| `DATABASE_URL` | `munaxa-internal`'s `edms_app` URL (required even with a catalogue, STG-5) | §5 |
| `TENANT_CATALOGUE` | the runtime catalogue (no owner credentials) | §5 |

Fixed, not secret (already in the task definition): `MAIL_SMTP_HOST=email-smtp.eu-central-1.amazonaws.com`,
`MAIL_SMTP_PORT=587`, `MAIL_SMTP_SECURITY=STARTTLS`, certificate validation on,
`MAIL_FROM_ADDRESS` from `launch.auto.tfvars`.

After writing it, set `app_secret_version_id` in `launch.auto.tfvars` to the new version id, so
every API task is pinned to it (ADR-0022 consequence 8).

## 4. SES SMTP (ADR-0025) — administrator actions

**Sending domain: to be confirmed.** `launch.auto.tfvars` proposes `docs@notify.munaxa.com` on a
dedicated subdomain `notify.munaxa.com`; ADR-0025 leaves `<MAIL_DOMAIN>` open. Replace it before the
first service apply if you choose otherwise. The deployer has no SES or IAM-user permission, by
design, so these steps are an administrator's.

1. **Domain identity** (Easy DKIM, RSA 2048, signing on):
   ```bash
   aws sesv2 create-email-identity --region eu-central-1 --email-identity notify.munaxa.com \
     --dkim-signing-attributes NextSigningKeyLength=RSA_2048_BIT \
     --tags Key=Project,Value=MunaxaDocs Key=Environment,Value=Production
   aws sesv2 put-email-identity-mail-from-attributes --region eu-central-1 \
     --email-identity notify.munaxa.com --mail-from-domain bounce.notify.munaxa.com \
     --behavior-on-mx-failure USE_DEFAULT_VALUE
   aws sesv2 get-email-identity --region eu-central-1 --email-identity notify.munaxa.com \
     --query 'DkimAttributes.Tokens'
   ```
2. **DNS in Cloudflare** (DNS only):

   | Type | Name | Value |
   | --- | --- | --- |
   | CNAME ×3 | `<token>._domainkey.notify.munaxa.com` | `<token>.dkim.amazonses.com` (one per token from step 1) |
   | MX | `bounce.notify.munaxa.com` | `10 feedback-smtp.eu-central-1.amazonses.com` |
   | TXT | `bounce.notify.munaxa.com` | `v=spf1 include:amazonses.com ~all` |
   | TXT | `_dmarc.notify.munaxa.com` | `v=DMARC1; p=none; rua=mailto:<reporting address>` |

   Do not change the root domain's SPF record.
3. **The send-only IAM user** (ADR-0025 §3; the one long-lived-credential exception). No console
   access, no group, exactly this inline policy:
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
   aws iam create-user --user-name munaxa-docs-ses-smtp --tags Key=Project,Value=MunaxaDocs Key=Environment,Value=Production
   aws iam put-user-policy --user-name munaxa-docs-ses-smtp --policy-name ses-send-only \
     --policy-document file://ses-send-only.json
   aws iam create-access-key --user-name munaxa-docs-ses-smtp > /tmp/ses-key.json   # umask 077 first
   ```
4. **Derive the SMTP password** for `eu-central-1` from the secret access key (AWS's documented
   algorithm), then **destroy the secret access key**; only the access key ID (username) and the
   derived password are stored (§3):
   ```python
   import base64, hashlib, hmac, json
   key = json.load(open('/tmp/ses-key.json'))['AccessKey']
   def sign(k, m): return hmac.new(k, m.encode(), hashlib.sha256).digest()
   s = sign(('AWS4' + key['SecretAccessKey']).encode(), '11111111')
   for part in ('eu-central-1', 'ses', 'aws4_request', 'SendRawEmail'): s = sign(s, part)
   print(key['AccessKeyId'], base64.b64encode(bytes([0x04]) + s).decode())   # write straight into the app JSON, not the terminal
   ```
5. **Sandbox.** Until SES production access is granted (a separate, later request), mail is
   delivered only to verified addresses. The API starts and queues notifications either way.

## 5. Tenant `munaxa-internal` — what must exist before the API starts

The API runs with `DEPLOYMENT_PROFILE=CLOUD`, which refuses to start without a catalogue of at least
one tenant, and `DATABASE_URL` must be that tenant's `edms_app` URL. Nothing below exists yet.

| Item | Value |
| --- | --- |
| Slug / name | `munaxa-internal` / `Munaxa Internal` |
| Tenant id | a new UUID generated by the operator at bootstrap (`uuidgen`); never reused |
| Database | `edms_munaxa_internal` on `munaxa-docs-eu-prod-pg`, owned by `edms_owner` |
| Runtime URL (`edms_app`, NOBYPASSRLS) | `postgresql://edms_app:<pw>@munaxa-docs-eu-prod-pg.cx6gsegwu0rz.eu-central-1.rds.amazonaws.com:5432/edms_munaxa_internal?sslmode=require` |
| Storage | bucket `munaxa-docs-eu-prod-docs-800728620253`, prefix `tenants/munaxa-internal` |
| Search index | `docs-munaxa-internal` |

Runtime catalogue (`TENANT_CATALOGUE` in the app bundle; no owner credential):

```json
{"defaults":{"storage":{"driver":"S3","container":"munaxa-docs-eu-prod-docs-800728620253","region":"eu-central-1","prefixTemplate":"tenants/{slug}"},
 "search":{"indexTemplate":"docs-{slug}"}},
 "tenants":[{"id":"<uuid>","slug":"munaxa-internal","name":"Munaxa Internal",
   "database":{"url":"<the edms_app URL above>"}}]}
```

The **operator catalogue** (operator bundle, for `scripts/migrate-tenants.mjs`) is the same with a
`migrationUrl` (`edms_owner`) per tenant; the operator bundle also holds the `edms_owner` and
`edms_backup` URLs. The API never reads it.

**Bootstrap sequence** (runbook §6, §12; ADR-0024 §2.10), after the cluster exists:

1. A short-lived **db-admin task** (pinned `postgres:16` client, `ops-dbadmin` roles, `ops` security
   group, RDS-managed master secret) runs as `munaxa_master`:
   `infra/sql/cluster/01-roles.sql`; passwords for `edms_owner` and `edms_app`;
   `CREATE ROLE edms_backup LOGIN BYPASSRLS` + `GRANT pg_read_all_data`;
   `GRANT edms_owner TO munaxa_master WITH SET TRUE`;
   `CREATE DATABASE edms_munaxa_internal OWNER edms_owner`; and `SHOW max_connections`.
2. Write the operator bundle and the app bundle's `DATABASE_URL` and `TENANT_CATALOGUE`.
3. **Migrations** from a checkout of `041e827`: `scripts/migrate-tenants.mjs` with the operator
   catalogue, over an SSM port-forward through the short-lived **tunnel task** (runbook §12). A re-run
   reports nothing pending.
4. **First administrator**: `node apps/api/dist/provision.js` as a one-off task on the API image
   (`ops-provision` roles), single-tenant form `TENANT_ID`/`TENANT_SLUG` (finding D-1),
   `QUEUE_CONSUMERS_ENABLED=false`, the password in a temporary secret
   `munaxa-docs-eu-prod/provision/munaxa-internal`, deleted afterwards.

The db-admin, tunnel and provisioning **task definitions** (and the `operator` secret) are the next
service-root change; they are not in this one.

## 6. Order of operations

DNS validation →
GHCR secret → SES identity, DNS, user, password → service apply (cluster, task definitions,
operator secret) → database bootstrap and migrations → app bundle complete and pinned →
`enable_https` → `enable_services` → smoke tests → cutover.
