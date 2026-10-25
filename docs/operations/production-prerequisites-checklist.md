# Production Prerequisites Checklist — selected release `c6a6d8c`

**Selected release:** `c6a6d8cefe14f26670de9e8a413bcdd87851306d` (`c6a6d8c`, Option A), published to Amazon ECR
as three immutable images by run `40133309866`
([production-release-package-c6a6d8c.md](../reports/production-release-package-c6a6d8c.md)).
**Its approval gates are open:** the residual-risk acceptance (package
§6, not accepted), Tier B, the Terraform plan, the ECS pull test and any apply. Nothing is deployed.

*Historical:* release `4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b` (`4e8e1ca`) was published to GHCR
by run `36819091004`
([production-release-package-4e8e1ca.md](../reports/production-release-package-4e8e1ca.md)) and
cannot be deployed from ECR. Its application code was the approved `27a8daa`; it superseded `c87519e`, `f5d5bb2` and the `8cb4c14`
image line, which are historical and not deployable. Launch limitations WF-1, KEY-1 and D-1, subject to formal sign-off before go-live, are in runbook §1a. See
[production-release-package-27a8daa.md](../reports/production-release-package-27a8daa.md), the
[staging acceptance report](../reports/staging-acceptance-gate-e94c295.md), the
[RC report](../reports/release-candidate-final-validation.md) and the
[go-live runbook](./go-live-runbook.md) (§21 step 4 requires this checklist). **How** to implement each item, in order, with commands and
the final readiness gate: [production-infrastructure-implementation.md](./production-infrastructure-implementation.md).

**Rules.** Nothing here is READY without evidence **from the production environment**. Staging
evidence shows the application and procedure work. It does not satisfy a production prerequisite.
Record exact production values only as the operator supplies them. No domains, origins, thresholds or
credentials are invented here, and no secret value belongs in Git or in this file.

Statuses: **READY**, **MISSING**, **BLOCKED**, **OPERATOR ACTION REQUIRED**.

**Recorded 2026-09-29; release identity updated 2026-09-30; release publication recorded 2026-10-01; selected ECR release `c6a6d8c` recorded 2026-10-25.**

| Area | Status |
| --- | --- |
| **Release artifacts** (§2) | **PUBLISHED; APPROVAL GATES OPEN.** API, web and scanner of `c6a6d8c` in ECR by digest, revision-labelled, release smoke 18/18 on the published digests. ECR re-read 2026-10-25: unchanged. Residual risk not accepted; no ECS pull tested. *Historical:* `4e8e1ca` (GHCR), published and verified, not deployable from ECR |
| **Production infrastructure** (§1) | **NOT READY.** No production environment, domain, relay, on-call destination or provider has been supplied, and none was reachable from the release engineering environment. Every item in §1 is therefore not READY |

## 1. Prerequisite matrix

| # | Prerequisite | Status | What staging proved (application side) | What production must show (evidence) | Owner |
| --- | --- | --- | --- | --- | --- |
| 1 | Public CA certificates and DNS | **MISSING** (no production domain or certificate supplied) | TLS 1.2/1.3 only, HSTS, 80 → 443, `TRUST_PROXY`/`WEB_TRUST_PROXY` resolve the browser's address (staging CA) | The production web hostname in DNS. A publicly trusted certificate and full chain for it (`openssl s_client -verify_return_error`). HTTPS 200 on `/login` and `/api/health/ready`. The object-store endpoint browsers use also has a public certificate. `TRUST_PROXY`/`WEB_TRUST_PROXY` set to the real load-balancer ranges | Operator (network/PKI) |
| 2 | Production alert routing | **MISSING** (no production on-call destination supplied; the staging mailbox is not production alerting) | Every alert type below FIRED and RESOLVED end to end to a mailbox, including **scanner stopped → `AntivirusDegraded` in about 1 min** | Test alerts **received by the production on-call mechanism** (pager or rota), with an escalation path, for each of: scanner DEGRADED, scanner probe failing, API not ready or down, web down, database, Redis, object store, backup failed or stale. Maintenance-window silencing configured, because a drain pages API/web down | Operator (on-call owner) |
| 3 | Production monitoring stack | **MISSING** (no production monitoring supplied) | Probes and rules in §4 below, all exercised | Every signal in §4 scraped in production: targets up, rules loaded. Object storage monitored **independently** (API readiness does not cover it) | Operator (SRE) |
| 4 | Production SMTP | **MISSING** (no relay or sender domain supplied) | Application e-mail (approval needed, approved, published) and alert e-mail through a STARTTLS-required relay | Relay host and port with TLS or STARTTLS verified. Sender domain chosen. SPF, DKIM and DMARC records published and passing. Credentials in the secret store. One authorised test notification delivered. **No real production notifications during validation without explicit authorisation** | Operator (mail/DNS) |
| 5 | Private scanner network | **OPERATOR ACTION REQUIRED** (design validated; production network not provided) | Scanner only on an internal network: API reachable; web, proxy and store not; no egress and no DB from the scanner. Scheduled signature updates. clamd about 1 GB RSS. `probe.mjs` from the API namespace | API → scanner `:1344` reachable, and from nowhere else. No public exposure of `1344`/`3310`. Signature-update egress (or a mirror) working, with its schedule. About 1 GB RAM for clamd plus reload headroom. `probe.mjs` exit 0 **from the production API network before traffic** | Operator (network) + release engineer |
| 6 | Object storage | **MISSING** (no production bucket or origin supplied) | Bucket CORS for the web origin (browser upload), versioning, replication failover, `STORAGE_PUBLIC_URL` previews, independent store probe | Production bucket and its scope. Credentials scoped to it. `STORAGE_PUBLIC_URL` = the production web origin. CORS allowing `PUT`/`GET` from **the actual production origin** (supplied by the operator). Versioning on. Replication configured. Capacity and quota known. Independent monitoring (item 3) | Operator (storage) |
| 7 | Backup / PITR / failover | **MISSING** (no production database provider, restore destination or credentials supplied) | `edms_backup` backups, verify, a scheduled backup with `BackupFailed` alert, zero-difference DR restore, PITR to a timestamp (cluster-level), one tenant restored to a point in time by extraction from the recovered cluster, replica failover | `edms_backup` created (runbook §6 step 1b). Scheduled backups with verification. WAL archiving/PITR on. Replication. A written failover procedure. Backup alerts reaching on-call. A restore destination and restore credentials. **If the provider's PITR/failover cannot be rehearsed before go-live, this stays NOT READY** and the risk goes to the change approver. No destructive production tests | Operator (DBA) |
| 8 | Production load baseline | **MISSING** (no production-sized infrastructure; no approved thresholds) | 100 identities, 29,551 requests, 0 failures, 0 rate-limited. **Latency targets missed** on a single 4-CPU host. This does **not** establish production capacity | The measurement in §5 on production-sized infrastructure, compared against thresholds **supplied or approved by the operator** (or existing capacity requirements) | Operator (capacity owner) + release engineer |
| 9 | Image registry / secrets / configuration | **OPERATOR ACTION REQUIRED** (registry: Amazon ECR, applied 2026-10-22; selected release `c6a6d8c` published to ECR 2026-10-24 with a release package, pending its approval gates; `db97825` superseded; no ECS pull tested yet, §2. Secret store, versioned configuration and signing policy still open) | Images build reproducibly from `27a8daa` (CI run 554) and ran the §16 smoke 29/29 and browser 8/8 in a staging-shaped deployment; release `4e8e1ca` was published to GHCR by run `36819091004` (historical); `db97825` was published to ECR by run `39929830650` (§2) | ☑ A registry with immutable digests and access control (ECR, IMMUTABLE tags, push only by the OIDC publisher role). ☑ API, web and scanner pushed and verified **by digest** (`db97825`; not a selected release). ☑ A selected release with an ECR release package (`c6a6d8c`, [package](../reports/production-release-package-c6a6d8c.md); its residual-risk acceptance and Tier B gates are still open). ☐ Pulls by the ECS execution roles proven by a real task (runbook §10.1); IAM simulation passes. The GHCR pull identity (`DOCS_PRODUCTION_PULL_USER`/`_TOKEN`) stays until then. ☐ Signing, if policy requires. ☐ A secret store holding every secret in §3. ☐ Configuration versioned. ☐ A rollback target by digest (runbook §20): none for the first deployment, which must be recorded | Operator (platform) |

## 2. Images and publication

**Registry:** Amazon ECR in `229251310592` — `munaxa-docs/api`, `munaxa-docs/web`, `munaxa-docs/antivirus` (ADR-0024 amendment, 2026-10-22). Until 2026-10-22 it was `ghcr.io/munaxa`. GHCR images are historical and are never deployed.
**Process:** `.github/workflows/publish-images.yml`, started by pushing a tag `image/<full SHA>`. It
builds exactly that commit, tags each image `<short>` and `sha-<full SHA>` — **never `latest`** — and
verifies each **pulled digest**: revision label, non-root, no credential in history or filesystem, the
API's query engine, the web image's branding, and for the scanner the recorded ClamAV/c-icap versions,
`verify-container.sh` (non-root, no UID 0 process, `freshclam` as the container user) and `probe.mjs`
(candidate, after an unclean restart, and pulled digest). The images are pushed to ECR through
GitHub OIDC by the publisher role, which may only push to the three repositories. A final job
confirms each digest in ECR. No registry credential is involved.

**Selected release: `c6a6d8c` (Option A), PUBLISHED, APPROVAL GATES OPEN.** Tag
`image/c6a6d8cefe14f26670de9e8a413bcdd87851306d`, run
[40133309866](https://github.com/munaxa/munaxa-docs/actions/runs/40133309866), 2026-10-24 (every
job succeeded, including the release smoke on the published digests, 18/18):

| Image | Digest | Tags | ECR basic scan (2026-10-24) |
| --- | --- | --- | --- |
| API | `229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/api@sha256:f8af3e0a0e78601c245c03123f032d6c859aa8e3a41f35ab2100423d664e41ae` | `c6a6d8c`, `sha-c6a6d8cefe14f26670de9e8a413bcdd87851306d` | HIGH 7, MEDIUM 2, LOW 2 (Debian 12 util-linux and zlib; no Debian 12 fix; residual risk awaiting sign-off) |
| Web | `229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/web@sha256:9e4345a11db5970fca23cd43a6045e393b96becb46a223d665ba776c20beac0e` | same | HIGH 7, MEDIUM 2, LOW 2 (same) |
| Antivirus | `229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/antivirus@sha256:e7ad4aa889abd477624e35d421150b8e95825a2e67d5eb5114b7b8d03f39f4a6` | same | none |

Details, the CVE-by-CVE assessment and the open gates are in
[production-release-package-c6a6d8c.md](../reports/production-release-package-c6a6d8c.md).

**History: `db97825`, superseded, not deployable.** Tag
`image/db97825d26195666e7415735f0769d1c10bbbf4d`, run
[39929830650](https://github.com/munaxa/munaxa-docs/actions/runs/39929830650), 2026-10-23
(every job succeeded). All pushes came from the publisher role (CloudTrail):

| Image | Digest | Tags | ECR basic scan (2026-10-23) |
| --- | --- | --- | --- |
| API | `229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/api@sha256:e8f641e608b38e9366c88e714f07a0851bd7066f64f0964f5b188bd211d78b47` | `db97825`, `sha-db97825d26195666e7415735f0769d1c10bbbf4d` | HIGH 7, MEDIUM 2, LOW 2 (Debian 12 util-linux and zlib; no Debian fix yet) |
| Web | `229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/web@sha256:0703fafa9f887d5c815d18b0752c5de6431f40f7c279988d31b0c30757e755b3` | same | HIGH 7, MEDIUM 2, LOW 2 (same) |
| Antivirus | `229251310592.dkr.ecr.eu-central-1.amazonaws.com/munaxa-docs/antivirus@sha256:1278da65948893cf62c799c19cf003296154f84489192af99f627b3dec827e22` | same | HIGH 2, UNDEFINED 2 (zlib CVE-2026-85091 and xz USN-8945-1; Ubuntu fixes available, PR #143) |

`db97825`'s application code is `041e827` plus the Docs v2 web design (#137). CI passed on each
of those commits, but no release package and no staging smoke cover them. A release is deployable
only after it has been selected and has an ECR release package with its digests.

**Not yet proven (as recorded for `db97825`; for `c6a6d8c` see its package §7):**

- that ECS can pull these images. The pull is authorised by IAM (simulated) and by the S3 endpoint
  policy, but no task has run (runbook §10.1);
- that the antivirus fix in #143 works in a published image.

**Historical (GHCR, not deployable):**

- release `4e8e1ca` (run `36819091004`) and release `041e827` (run `36948766244`), with digests in
  their release packages;
- both were pulled at the time with the GHCR pull identity (`DOCS_PRODUCTION_PULL_USER` /
  `DOCS_PRODUCTION_PULL_TOKEN`).

Those secrets are not used by ECR. They stay until the ECS pull test (runbook §10.1) has passed,
and are removed only with explicit authorisation. The antivirus image runs as **UID/GID 101:102**
(`clamav`). Its signature volume must be writable by 101:102 (runbook §9.2).

**Superseded — do not deploy:** the `8cb4c14` images (run `36722457128`). Its antivirus image
`sha256:02298beca666d7db346de82e42cab2f692faa4ed417fa7259e3b1ff3999e33d4` is the **old
root-starting scanner** and must not be used in production.

Still open for the operator: decide the signing policy, if any; confirm the pull token's expiry; record
the three `image@sha256:…` references in the change record.

Deployment manifests reference **`image@sha256:<digest>` only** — never a tag.

| Historical release candidate evidence for `27a8daa` (not deliverable artifacts, not evidence for `c6a6d8c`) | Value |
| --- | --- |
| Local API/web images of `27a8daa` used for the staging smoke | Built from a clean checkout of `27a8daa`, labelled `org.opencontainers.image.revision=27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5`; release package §4 |
| Scanner rebuilt from `infra/antivirus` at `27a8daa` | ClamAV **1.5.4**, c-icap **0.5.10**; `probe.mjs` exit 0 |

Historical — the superseded `f5d5bb2` build and the staging-gate scanner (which started as root),
kept as evidence and **not** to be published or deployed:

| Image | Built from | Local image ID (not a registry digest) | Validated by |
| --- | --- | --- | --- |
| `munaxa-docs-api:f5d5bb2` | clean checkout of `f5d5bb2` | `sha256:53bf43be9ade46f494ec20258f9f9703f9ce2a688fd3ddc8677a47849872a0eb` | CI 550; staging smoke 22/22 |
| `munaxa-docs-web:f5d5bb2` | clean checkout of `f5d5bb2` | `sha256:ada7ddb0acb709cf89a1ddcad6ed7ae369cabe6c9b5f2681b9685c26f8ee3727` | CI 550 (brand-artwork check); staging browser 10/10 |
| `munaxa-antivirus:7442853` | `infra/antivirus` at `7442853` | `sha256:805574b9640df49959b82d4f42ad56280db07cc9dcb2efccc63f91b56b2cf8e4` (ClamAV 1.5.4, c-icap 0.5.10) | Full staging gate |

At go-live, on the **published digests**, re-confirm (the publishing run verified each already):

- the API, web and scanner images carry `org.opencontainers.image.revision=c6a6d8cefe14f26670de9e8a413bcdd87851306d`;
- the web image serves `/branding/docs/favicon/favicon-32.png`;
- the scanner's recorded versions match the workflow run, and `probe.mjs` passes;
- §16 smoke passes on these digests.

## 3. Production configuration checklist (no values here)

Source of truth: runbook §5 and `apps/api/src/core/config/configuration.ts`. The API refuses to
start under `NODE_ENV=production` when a required value is missing or invalid, and names it.

| Setting | Requirement | Set | Verified by |
| --- | --- | --- | --- |
| `NODE_ENV` | `production` (API and web) | ☐ | API start log |
| `DATABASE_URL` | required, even with a catalogue (app role `edms_app`) | ☐ | readiness `database:*` UP |
| `TENANT_CATALOGUE` / `TENANT_CATALOGUE_PATH` (or `TENANT_ID`/`TENANT_SLUG`) | the production tenants | ☐ | readiness lists every tenant |
| `DATABASE_MIGRATION_URL` | **only** where migrations run (release workstation), never in the running API | ☐ | absent from the API environment |
| `REDIS_URL` | required, with a password | ☐ | `cache: UP` |
| `JWT_ACCESS_SECRET`, `SIGNATURE_WITNESS_SECRET`, `AUDIT_CHECKPOINT_SECRET`, `MFA_TOTP_SEALING_KEY` | required, from the secret store | ☐ | API starts |
| `CORS_ORIGINS`, `WEB_BASE_URL` | the production web origin | ☐ | browser sign-in |
| `TRUST_PROXY` (API), `WEB_TRUST_PROXY` (web) | the real proxy/load-balancer ranges | ☐ | `session_family.ip_address` = the client |
| `STORAGE_DRIVER`, `STORAGE_BUCKET`, `STORAGE_REGION`/`STORAGE_ENDPOINT`, credentials (a key pair; an instance role is not supported by the current adapter, runbook §7) | the production bucket | ☐ | smoke upload/download |
| `STORAGE_PUBLIC_URL` | **required with every driver**: the production web origin | ☐ | preview URLs use it |
| `MAIL_DRIVER`, `MAIL_FROM_ADDRESS`, `MAIL_SMTP_HOST`/`PORT`/`SECURITY` (TLS or STARTTLS), credentials | the production relay | ☐ | authorised test notification |
| `AV_DRIVER` | `ICAP` | ☐ | `/api/health` `antivirus: UP` |
| `AV_ICAP_URL` | the scanner on the private network | ☐ | `probe.mjs` from the API network |
| `AV_ICAP_MAX_BYTES` | default 134217728 (128 MiB) unless changed deliberately; drives API memory | ☐ | 128 MiB + 1 refused before storage |
| `AV_SCAN_TIMEOUT_MS` | default 120000 | ☐ | config review |
| `AV_ICAP_TEST_URL` | **never set** | ☐ | absent |
| `OPENAPI_ENABLED` | `false` | ☐ | `/api/docs` 404 |
| `METRICS_DRIVER`, `METRICS_SCRAPE_TOKEN` | Prometheus and a token | ☐ | scrape 200 with the token, 401 without |
| `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | ☐ | absent |
| `QUEUE_CONSUMERS_ENABLED` | `true` | ☐ | queues draining |
| `NEXT_PUBLIC_API_URL` (web) | the API as the web tier reaches it | ☐ | web sign-in |
| Backup role URL (`edms_backup`) | operator commands only, secret | ☐ | scheduled backup succeeds |

## 4. Monitoring: signals production must cover

The **staging-validated** alert set is listed below; each was fired and resolved in staging, except
where noted:

| Alert | Signal | Threshold in staging |
| --- | --- | --- |
| AntivirusDegraded | `/api/health` `antivirus` not UP | 30 s |
| ScannerProbeFailing | `probe.mjs` (clean 204 plus EICAR blocked) against ICAP → c-icap → ClamAV | 2 min |
| ApiNotReady | `/api/health/ready` not 200 | 1 min |
| ApiDown | liveness or the metrics scrape fails | 1 min |
| WebDown | web `/login` not 200 | 1 min |
| DatabaseDown | a tenant database not UP, or PostgreSQL unreachable | 1 min |
| RedisDown | cache DOWN or Redis unreachable | 1 min |
| ObjectStoreDown | the store's own health endpoint (**independent of the API**) | 1 min |
| QueueFailuresGrowing | failed jobs rising (queue consumers) | 10 min window |
| OutboxBacklog | `edms_outbox_pending` > 100 | 10 min (not provoked in staging) |
| BackupFailed | the last scheduled backup failed | immediate |
| BackupStale | no successful backup | 2 h (not provoked in staging) |
| SignaturesStale | ClamAV `daily` older than 48 h | 5 min (not provoked in staging) |
| SignatureUpdateNotRunning | scheduled freshclam not succeeding | 2 h (not provoked in staging) |

The staging thresholds are a starting point. Production values are the operator's.

**Not in the staging set, still required in production** (thresholds are the operator's):

- object-storage capacity and quota;
- database disk and connections;
- CPU and memory per API, web, scanner, PostgreSQL and Redis instance;
- the HTTP 5xx rate at the load balancer;
- certificate expiry.

## 5. Production load baseline: what to measure

Run `infra/loadtest/run.mjs` with `--tokens-file` (many identities, from several client addresses
within the per-address sign-in limit), against production-sized infrastructure before go-live, or in
the window before traffic if that is the only production-sized environment.

Record:

- **Load:** concurrency per scenario; duration; throughput (requests/s); p50/p95/p99 latency; error
  rate; 429 rate. More than 1% failures or 429s is not a baseline.
- **API:** CPU and memory per instance.
- **PostgreSQL:** CPU, connections, lock waits, slow queries.
- **Redis:** ops/s, memory, rejected connections.
- **Object store:** latency and errors.
- **Scanner:** CPU, memory, scan latency (an upload scenario, if approved).

**Pass criteria are supplied or approved by the operator** (or existing capacity requirements). The
harness's built-in targets are not approved thresholds, and the staging result sets no capacity.

## 6. Missing operator inputs

1. The production web hostname, its DNS, and its certificate and chain. The object-store endpoint
   hostname and certificate. The load-balancer address ranges.
2. The production on-call mechanism (pager or rota), the escalation path, and the maintenance-silence
   procedure.
3. The production monitoring stack (Prometheus or equivalent), or who provides it.
4. The SMTP relay, the sender domain, SPF/DKIM/DMARC ownership, and credentials.
5. The scanner's network placement, the signature-update egress or mirror, and host sizing.
6. The production bucket and region/endpoint, credentials or role, **the production web origin for
   CORS and `STORAGE_PUBLIC_URL`**, the replication target, and capacity.
7. The database provider, PITR and replication capability, the restore destination and restore
   credentials, and whether PITR/failover can be rehearsed before go-live.
8. Production-sized infrastructure for the load test, and the approved latency, throughput and error
   thresholds.
9. The image registry and pull/push identities, the signing policy, the secret store, the
   configuration versioning, and the previous production images (if any) for rollback.
10. The change window, the change approver, and the named person who confirms the backup.

## 7. Final production Go/No-Go (to be completed at go-live)

| Requirement | Evidence | Status | Owner |
| --- | --- | --- | --- |
| Release `c6a6d8c` images published by registry digest | digests, image labels (§2), [package](../reports/production-release-package-c6a6d8c.md) | NOT READY: published by run `40133309866` (release smoke 18/18) and re-read from ECR 2026-10-25 (unchanged); residual risk not accepted (package §6) | Platform |
| Release `c6a6d8c` deployed by those digests in production | deployment manifests, running image IDs | NOT READY (not deployed) | Platform |
| Staging smoke (Tier B) on the `c6a6d8c` digests | Tier B results ([release-validation-option-a.md](./release-validation-option-a.md) §2 step 7) | NOT READY (not run). Historical evidence (`416ca94` full gate; `f5d5bb2` STG-12; `27a8daa` §16 smoke 29/29 and browser 8/8) does not count for `c6a6d8c` | Release engineer |
| Production DNS and public TLS | cert chain, HTTPS | NOT READY | Network/PKI |
| Monitoring stack, signals in §4 | targets up, rules loaded | NOT READY | SRE |
| Scanner DEGRADED alert reaches the **production** on-call | test alert acknowledged by on-call | NOT READY | On-call owner |
| SMTP (TLS/STARTTLS, SPF/DKIM/DMARC) where notifications are required | relay test, DNS | NOT READY | Mail/DNS |
| Object storage: bucket, CORS for the production origin, versioning, replication, independent monitoring | bucket settings, probe | NOT READY | Storage |
| Scanner UP on the private network; `probe.mjs` passes from the API network | probe output, `/api/health` | NOT READY | Network + release engineer |
| Backup taken, verified and confirmed by a named person | backup IDs, verify output | NOT READY (at go-live) | DBA + named person |
| PITR/recovery requirements satisfied | archiver status, procedure, rehearsal or recorded risk | NOT READY | DBA |
| Migration procedure ready (checkout of `c6a6d8c`, migration URL, verified backup) | workstation, dry check | NOT READY | Release engineer |
| All required secrets present (§3) | API starts under `NODE_ENV=production` | NOT READY | Platform |
| Production load/capacity requirements established | §5 results against approved thresholds | NOT READY | Capacity owner |
| Rollback path (the previous production release's digest, or "no rollback target — first deployment" recorded) | registry, runbook §20 | NOT READY | Release engineer |

**Production is NO-GO while any row above is not READY.** The complete NO-GO list is in runbook §25.
