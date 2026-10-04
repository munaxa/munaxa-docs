# ADR-0025 — Production email is Amazon SES through SMTP

- **Status:** Accepted (product-owner decision)
- **Date:** 2026-10-04
- **Phase:** Production Phase 0 (go-live decisions)
- **Builds on:** [ADR-0022](./0022-hosted-platform-aws-ecs-fargate.md) and
  [ADR-0024](./0024-minimum-cost-first-customer-launch.md). It resolves the mail credential that
  ADR-0024 §2.9 left open and **changes nothing else** in ADR-0024's architecture. It supersedes
  nothing

## Context

[ADR-0022](./0022-hosted-platform-aws-ecs-fargate.md) chose SES "through the existing
`MAIL_DRIVER=SMTP`" for the hosted service.
[ADR-0024](./0024-minimum-cost-first-customer-launch.md) §2.9 kept mail on SMTP with STARTTLS or TLS
and certificate validation, but did not choose the credential: SES SMTP credentials derived from an
IAM user, or `MAIL_DRIVER=RESEND` with a Resend API key.

A read-only comparison of the two against the repository found the following.

- **Both drivers are built and accepted by production startup validation; neither needs code.**
  `MAIL_DRIVER=SMTP` wires `SmtpMailAdapter` and `MAIL_DRIVER=RESEND` wires `ResendMailAdapter`
  (`apps/api/src/infrastructure/infrastructure.module.ts`).
- **The SMTP adapter's transport is strict.**
  - It refuses to continue if the server does not offer STARTTLS, rather than falling back to plain
    text.
  - It validates the server certificate against the host name.
  - It authenticates with `AUTH PLAIN`, or `AUTH LOGIN` where only that is offered.
  - The envelope sender is `MAIL_FROM_ADDRESS`, the same address as the `From` header
    (`apps/api/src/infrastructure/providers/smtp/`).
- **Production startup validation requires:**
  - a relay host and `MAIL_FROM_ADDRESS`;
  - `MAIL_SMTP_SECURITY` set to `STARTTLS` or `TLS`;
  - `MAIL_SMTP_REJECT_UNAUTHORIZED` left on;
  - both halves of the SMTP credential, or neither
  (`apps/api/src/core/config/configuration.ts`).
- **What the product emails.** Notifications only, through `DeliveryService`. There is no
  invitation email and no self-service password-reset email. Delivery is a database row, attempted
  up to five times over roughly half an hour, so it survives the Redis restarts ADR-0024 accepts.
  Repeated permanent failures suppress an address and alert an administrator.
- **Cost at expected volume.**
  - SES costs $0.10 per 1,000 emails, with no minimum fee.
  - Resend's free plan stops at 100 emails a day, which is not safe for paying customers. Its first
    paid plan costs $20 a month, about a fifth of ADR-0024's launch target.
- **Data location.** SES keeps message processing with AWS in `eu-central-1`, the processor already
  in use. Resend would add a non-AWS processor whose account infrastructure is in the United States.
- **The non-production account today** (read-only, 2026-10-04):
  - SES in `eu-central-1` is in the sandbox: 200 messages per 24 hours, 1 per second.
  - It has no identities and no configuration sets.
  - Account-level suppression is enabled for `BOUNCE` and `COMPLAINT`.

## Decision

> **Amazon SES through SMTP in `eu-central-1` is the permanent production email provider for
> Munaxa Docs. The API connects with STARTTLS on port 587, using credentials derived from one
> dedicated, send-only IAM user, recorded below as an intentional long-lived-credential exception.
> No application code change is required. Resend is not part of the production plan.**

### 1. Scope of the email

- **Transactional notification email only.** These are one-to-one messages triggered by actions in
  the product: approvals, reviews and publications.
- **No marketing email** and **no purchased or imported mailing lists.**
- **Recipients** are users that each customer's administrators provision in their tenant.
- **The application's notification preferences remain authoritative** over what each user
  receives. SES adds no preference or subscription layer of its own.

### 2. SES identity and email authentication

| Item | Decision |
| --- | --- |
| Identity | One SES **domain identity** for the sending domain `<MAIL_DOMAIN>`, in `eu-central-1` |
| DKIM | **Easy DKIM**, RSA 2048-bit, signing enabled. Its **three CNAME records** also verify the domain |
| Custom MAIL FROM | A dedicated subdomain, for example `bounce.<MAIL_DOMAIN>`, used for nothing else. It has **one MX** record (`10 feedback-smtp.eu-central-1.amazonses.com`) and an **SPF** TXT record (`v=spf1 include:amazonses.com ~all`). Behaviour on MX failure is "use the default MAIL FROM" until the setup reports success |
| DMARC | `_dmarc.<MAIL_DOMAIN>` TXT, starting at **`p=none`** with an operator-chosen reporting address. It is tightened (`quarantine`, then `reject`) once reports show aligned mail. DKIM alignment alone passes DMARC; the custom MAIL FROM adds SPF alignment |
| Bounces and complaints | Identity notifications for bounces and complaints go to an **SNS** topic with an operator email subscription. Email feedback forwarding is then disabled, so feedback does not depend on a mailbox at the from-address |
| Suppression | **Account-level suppression stays enabled** for bounces and complaints, beside the application's own suppression after repeated permanent failures |

The SES records in the table are the minimum. Do not add SES to the root domain's SPF record unless
the from-address domain itself must pass SPF.

### 3. IAM: the one intentional exception

The SES SMTP interface accepts only credentials derived from an IAM user's access key. AWS documents
that SMTP credentials cannot be derived from temporary credentials, so an ECS task role cannot be
used. This record therefore accepts **one long-lived credential, deliberately and narrowly scoped**.

- **One dedicated IAM user** used solely for SES SMTP, for example `munaxa-docs-ses-smtp`.
- **No console access**, no other policy and no group membership that grants anything else.
- **One active access key** at a time; a second exists only during rotation (§4).
- **Only `ses:SendRawEmail`.** This is the minimum the SES SMTP interface needs.
- **Restricted to the verified sending domain** by resource ARN, and **to the from-address** by
  `ses:FromAddress`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendOnlyAsMunaxaDocsNotifications",
      "Effect": "Allow",
      "Action": "ses:SendRawEmail",
      "Resource": "arn:aws:ses:eu-central-1:<PROD_ACCOUNT_ID>:identity/<MAIL_DOMAIN>",
      "Condition": {
        "StringEquals": { "ses:FromAddress": "<FROM_ADDRESS>" }
      }
    }
  ]
}
```

- **Configuration sets.** If one is later attached to the identity, its ARN must be added to
  `Resource`.
- **Verify the policy with a real send.** How SES evaluates condition keys for SMTP sessions is
  documented in general terms only. The production end-to-end test (§9) is what proves the policy
  allows the application's mail and nothing broader.
- **The source-IP condition cannot be used.** `aws:SourceIp` is not usable because ECS task
  addresses change (ADR-0024 §3.3).

**This exception is not a change to ADR-0024's S3 rule.** S3 access stays on the ECS task role
(`STORAGE_CREDENTIALS_SOURCE=ECS_TASK_ROLE`), and startup still refuses static S3 credentials. The
SES user grants nothing in S3 or any other service.

### 4. SMTP credential handling

- **The SMTP user name is the IAM access key ID.**
- **Storage.** Only the **derived SES SMTP password**, specific to `eu-central-1`, is stored in the
  application secret. The **raw IAM secret access key is not retained** after the password is
  derived.
- **Where it is stored.** Both values go into ADR-0024's existing **application bundle** secret, as
  JSON keys `MAIL_SMTP_USERNAME` and `MAIL_SMTP_PASSWORD`. The deployment still has four Secrets
  Manager secrets.
- **Injection.** ECS injects both through `secrets` entries pinned to a secret version (ADR-0022
  consequence 8). **They are never set as ordinary environment variables.**
- **Rotation**, in this order:
  1. Create a second access key for the same IAM user.
  2. Derive its SMTP password for `eu-central-1` and discard its secret access key.
  3. Write a new version of the application bundle with the new user name and password.
  4. **Redeploy the API.** A secret change takes effect only on redeployment (ADR-0022). Under
     ADR-0024, drain the queues first.
  5. Confirm a notification is delivered.
  6. Delete the old access key.
- **Rotation is also immediate** on any suspicion of exposure. The free IAM credential report shows
  key age.

### 5. Network

- **API tasks connect outbound on TCP 587** to `email-smtp.eu-central-1.amazonaws.com`, from their
  own public address.
- **The API security group must allow outbound TCP 587** to `0.0.0.0/0`, because SES endpoint
  addresses are not fixed. The current non-production ECS group allows outbound 5432, 6379, 1344
  and 443 only.
- **No SES VPC endpoint.** It would add about $17.50 a month and is not needed.
- **ADR-0024's network is unchanged:** public-subnet tasks with public IPv4, no NAT Gateway, and no
  fixed outbound address. SES authenticates by credential, not by source address. ADR-0024's diagram
  already shows the API sending mail over STARTTLS on 587.

### 6. Application configuration (API task)

| Variable | Value | How it is set |
| --- | --- | --- |
| `MAIL_DRIVER` | `SMTP` | Environment |
| `MAIL_SMTP_HOST` | `email-smtp.eu-central-1.amazonaws.com` | Environment |
| `MAIL_SMTP_PORT` | `587` | Environment |
| `MAIL_SMTP_SECURITY` | `STARTTLS` | Environment |
| `MAIL_SMTP_USERNAME` | The IAM access key ID | **Secret**: application bundle, pinned version |
| `MAIL_SMTP_PASSWORD` | The derived SES SMTP password | **Secret**: application bundle, pinned version |
| `MAIL_FROM_ADDRESS` | `<FROM_ADDRESS>`, an address on the verified domain | Environment |
| `MAIL_FROM_NAME` | `Munaxa Docs` (default) | Environment, optional |
| `MAIL_SMTP_REJECT_UNAUTHORIZED` | `true`: **certificate validation stays on**; production startup refuses `false` | Left at default |
| `MAIL_TIMEOUT_MS` | `15000` (default) | Left at default |
| `MAIL_SMTP_CLIENT_NAME` | Defaults to the host name of `WEB_BASE_URL` | Left at default |
| `WEB_BASE_URL` | The production web origin, used in notification links | Environment |

`MAIL_RESEND_API_KEY` and `MAIL_RESEND_ENDPOINT` are not set.

### 7. Cost

- **SES:** $0.10 per 1,000 emails, with no minimum fee. At launch volume this is **cents per month**.
- **No added cost** for the identity, the IAM user, the DNS records in an existing zone, or the SNS
  email subscription at launch volume.
- **No new secret.** The credential is stored in the existing application bundle.
- **Not introduced for the first-customer launch:**
  - dedicated IP addresses;
  - SES Virtual Deliverability Manager;
  - SES Mail Manager;
  - an SES VPC endpoint;
  - the SES Pro or Enterprise plans.
- **Recommended, about $0.20 a month:** two CloudWatch alarms on the free SES reputation metrics,
  bounce rate and complaint rate (§8).

### 8. Monitoring

- **SES reputation must be monitored.** Alarms go to ADR-0024's SNS alert topic:
  - bounce rate above **2.5%**;
  - complaint rate above **0.05%**.

  AWS reviews accounts at 5% bounces and 0.1% complaints, so these thresholds leave a margin.
- **Bounce and complaint notifications** arrive through the SNS topic in §2.
- **Application signals stay as they are:** repeated hard bounces suppress an address and alert an
  administrator.

### 9. SES production access

**Production access is required before normal customer delivery.** In the sandbox SES sends only to
verified addresses, at most 200 messages a day and 1 per second. Sandbox status is per account and
per region, so the request is made in the **production account** in `eu-central-1`. AWS gives its
first answer within 24 hours, and longer if it asks for more information.

The request describes:

- **Mail type:** `TRANSACTIONAL`.
- **Use case:** notification email from a multi-tenant document-control SaaS to users that each
  customer's administrators provision. There is no marketing email and there are no purchased
  lists, and users control notifications through the product's preferences.
- **Sending pattern:** one message per recipient, triggered by an action in the product.
- **Website URL:** the production web origin.
- **Sender identity:** the domain identity with DKIM, a custom MAIL FROM domain and DMARC.
- **Bounce and complaint handling:** account-level suppression, SNS notifications to the operator,
  and application suppression with an administrator alert after repeated permanent failures.
- **Expected volume:** **supplied by the operator at the time of the request.** This record does not
  state a number.
- **Contacts:** up to four addresses for AWS correspondence.

## Consequences

### Relationship to ADR-0024

- **No change to ADR-0024's architecture.** Its services, network, secrets layout, monitoring model
  and cost target stand. The mail cost adds cents.
- **It resolves ADR-0024 §2.9.** The mail provider and credential are now decided: SES SMTP with an
  IAM-user-derived credential, not Resend. ADRs are immutable, so ADR-0024 is not edited.
- **The only architectural exception is the SES SMTP IAM user** in §3.

### Security and operational risks, accepted

1. **A long-lived SMTP credential exists.** This is the primary exception. It is mitigated by:
   - a policy that only sends, only from the verified domain and only as the from-address;
   - no console access;
   - one key;
   - the derived password only, never the raw secret key;
   - storage in Secrets Manager with version pinning.

   Anyone who obtains it can send mail as `<FROM_ADDRESS>` through SES until it is rotated.
2. **Rotation is manual** (§4) and requires an API redeployment.
3. **The raw IAM secret access key must not be retained** anywhere: not in a secret, a file, a
   ticket or a password manager.
4. **Production credentials must not be placed in ordinary environment variables** or task
   overrides.
5. **Bounces and complaints that arrive after SES accepts a message** are not fed into the
   application. The application learns only of failures SES reports during the SMTP session. SES
   suppression, the SNS notifications and the reputation alarms cover this. Ingesting late feedback
   into the application would be future work.
6. **The SMTP adapter has not been exercised against SES itself in this repository.** Staging proved
   a relay that requires STARTTLS. The production end-to-end test closes this.
7. **Sender reputation is shared by all tenants**, as ADR-0021 records for other shared
   infrastructure.

### Deferred items, required before customer email

1. The SES **production-access** approval.
2. Selection of the **sending domain, from-address, MAIL FROM subdomain and DMARC reporting
   address**, and confirmation of who controls DNS.
3. The **DNS records**: three DKIM CNAMEs, the MAIL FROM MX and SPF records, and DMARC.
4. The **production IAM user**, its access key and the derived SMTP password.
5. The **production Secrets Manager secret version** carrying `MAIL_SMTP_USERNAME` and
   `MAIL_SMTP_PASSWORD`.
6. The **production security-group rule**: API outbound TCP 587.
7. The **SNS topic and subscription** for bounces and complaints, and the two reputation alarms.
8. An **end-to-end production test**:
   - one authorised test notification;
   - SPF, DKIM and DMARC passing in the received headers;
   - the IAM policy confirmed to allow it.

### Documentation to correct separately

- **`resend-mail.adapter.ts` header comment.** It says `MAIL_DRIVER=SMTP` is refused at boot and that
  Resend is "the only one". Both have been untrue since Phase 18 built the SMTP adapter; the code is
  correct and only the comment is stale.
- **Operations documents.** The go-live runbook (§3, §5) and the production infrastructure
  implementation checklist present "SMTP or Resend". For the hosted service the choice is SES SMTP.

### Production readiness

Production remains **NOT READY**
([production-prerequisites-checklist.md](../../operations/production-prerequisites-checklist.md)).
Prerequisite 4, production SMTP, stays NOT READY until the deferred items above are complete and
evidenced.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Resend (`MAIL_DRIVER=RESEND`) | Already built and needs no code. But a usable paid plan costs about $20 a month against cents, the free plan's 100-a-day limit is unsafe for paying customers, it adds a non-AWS data processor outside the EU account, and it would contradict ADR-0022's SES choice |
| SES through its HTTP API with the ECS task role | Would avoid the long-lived credential, but the application has no SES API driver; it needs code |
| An SES VPC endpoint for SMTP | About $17.50 a month for no benefit under ADR-0024's public-IP network |
| A dedicated IP address | $24.95 a month; shared SES addresses are appropriate at launch volume |
