# Production Infrastructure Implementation Checklist — release candidate `27a8daa`

**What this is.** The operator's work plan for the nine production prerequisites, to be executed
**before** the first production deployment of Munaxa Docs. When §D's gate passes, the operator
proceeds to the [go-live runbook](./go-live-runbook.md) §21.

**Sources of truth:**

- [go-live runbook](./go-live-runbook.md) (procedures);
- [production prerequisites checklist](./production-prerequisites-checklist.md) (status);
- [release package](../reports/production-release-package-27a8daa.md) (artifact identity);
- [staging acceptance report](../reports/staging-acceptance-gate-e94c295.md) (what staging proved).

**Release.** Application release candidate `27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5` (`27a8daa`) = `f5d5bb2` plus the tenant-resolution
and TOTP-enrolment fixes (as `c87519e`), the web sign-out revocation (WEB-1, `efcb955`) and the
numbering-collision fix (NUM-1, `27a8daa`). `f5d5bb2` and `c87519e` are historical and not
deployable. Accepted launch limitations WF-1 and KEY-1: runbook §1a — **no API-key integration on a
multi-tenant deployment**. Functional staging baseline
`416ca94`.

**Scanner.** The validated architecture is c-icap **0.5.10** → ClamAV **1.5.4** over plain ICAP on a
private network, built from `infra/antivirus/`.

**Conventions.**

- `<ANGLE_BRACKETS>` are **operator-supplied values**. Nothing here invents a hostname, origin,
  registry, credential, digest or threshold.
- Secrets are named, never written down. They live in the secret store (prerequisite 9) and never in
  Git, this file or the change record.
- "Record" means the **change record** for the go-live. Digests also go into the release package
  (prerequisite 9).
- Nothing here is READY until its evidence exists **from the production environment**. Staging
  evidence proves the application and the procedure, not production infrastructure.

---

## A. Dependency order

```text
            ┌──────────────────────────────────────────────────────────┐
  Phase 0   │ 9a Registry + push/pull identities   9b Secret store     │  (no dependencies)
            │ 9c Configuration versioning          named owners        │
            └───────────────┬──────────────────────────────┬───────────┘
                            │                              │
  Phase 1   1 DNS + public TLS + load balancer    7a PostgreSQL cluster, roles, edms_backup
            (needs: hostnames, certs)             (needs: secret store)
                            │                              │
  Phase 2   6 Object storage (needs: web origin from 1 for CORS and STORAGE_PUBLIC_URL)
            4 SMTP relay + sender domain (needs: DNS control from 1)
            5 Private scanner network + scanner (needs: 9a to pull the image)
            Redis (runbook §8; needs: network, secret store)
                            │
  Phase 3   9d Publish images and verify by digest (needs: 9a; scanner image checked against 5)
            3 Alert routing + named on-call + escalation + silences
            2 Monitoring stack + 14 alerts + capacity/CPU/memory/5xx/cert (needs: 1, 5, 6, 7, 3)
                            │
  Phase 4   7b Backup + verification + PITR verification + restore into a separate destination
               + application connectivity on the restored DB (needs: 7a, 9d, 6, isolated mail sink)
            8 Production-sized load baseline against approved thresholds
               (needs: everything above deployed as it will run; not yet in rotation)
                            │
  Phase 5   D. Final deployment readiness gate  →  go-live runbook §21 (21 steps)
```

**The same order as a list:**

1. **Registry, identities, secret store, configuration versioning (9a–9c).** Everything else pulls
   from these or stores into them.
2. **In parallel:**
   - DNS, public TLS and the load balancer (1);
   - the PostgreSQL cluster, roles and `edms_backup` (7a).
3. **After step 2:**
   - object storage (6), which needs the production web origin from step 2;
   - SMTP (4), which needs DNS control;
   - the scanner network (5) and Redis.
4. **Publish the images and verify them by digest (9d).** Needs 9a. Confirm the scanner image's
   versions under 5.
5. **Alert routing and the on-call rota (3), then the monitoring stack (2).** Every alert must be
   routed to a person before it is proven.
6. **Recovery rehearsal (7b), then the load baseline (8).** Both need the full stack deployed
   exactly as it will run, **not in rotation** and holding no user data.
7. **Readiness gate (D)**, then runbook §21.

---

## Prerequisite details

### 1. Public DNS, CA/TLS and load balancer

| Field | Detail |
| --- | --- |
| **Purpose** | Browsers reach the web and API over HTTPS with a publicly trusted certificate. The API and web see the browser's real address through the trusted proxy (D-2) |
| **Operator action** | 1. Create DNS records for `<WEB_HOSTNAME>` (and the API path or host, if split) pointing at the load balancer.<br>2. Obtain a publicly trusted certificate and full chain for `<WEB_HOSTNAME>` (and `<STORAGE_PUBLIC_HOSTNAME>` if browsers reach the store under your own name).<br>3. Configure the load balancer: TLS 1.2+ only; HTTP → HTTPS redirect; HSTS; routes `/api/*` → API and everything else → web; health checks as below.<br>4. Set `TRUST_PROXY` (API) and `WEB_TRUST_PROXY` (web) to the load balancer's address ranges |
| **Load-balancer health checks** | API rotation: `GET /api/health/ready` (200 = may receive traffic; 503 names the DOWN dependency). Container liveness: `GET /api/health/live` (the image's `HEALTHCHECK`). Web rotation: `GET /login` 200 |
| **Required inputs** | `<WEB_HOSTNAME>`, `<STORAGE_PUBLIC_HOSTNAME>` (if any), the certificate and key (secret store), `<LB_ADDRESS_RANGES>`, the DNS provider and its access |
| **Where configured** | DNS provider; load balancer / proxy; the certificate in the LB or secret store; `TRUST_PROXY` and `WEB_TRUST_PROXY` in the configuration (§C) |
| **Validation** | `dig +short <WEB_HOSTNAME>` · `openssl s_client -connect <WEB_HOSTNAME>:443 -servername <WEB_HOSTNAME> -verify_return_error </dev/null` · `curl -sI http://<WEB_HOSTNAME>/login` · `curl -sI https://<WEB_HOSTNAME>/login` (HSTS, `X-Frame-Options: DENY`, nosniff) · `openssl s_client -tls1_1 …` (must fail) · after deploy, runbook §17 D-2 check: `session_family.ip_address` is the client, not the LB |
| **Expected result** | The name resolves to the LB. `Verify return code: 0 (ok)` with a public CA chain. HTTP → 301 to HTTPS. HTTPS 200 with the security headers. TLS 1.0 and 1.1 refused. The client address is recorded correctly |
| **Evidence to record** | DNS answers; certificate subject, issuer, SAN and expiry; the `s_client` output; the headers; the LB listener and health-check configuration (screenshot or export) |
| **Owner** | `<NETWORK_PKI_OWNER>` |
| **Blocking** | **Yes.** NO-GO without public DNS and TLS (runbook §25) |

### 2. Production monitoring

| Field | Detail |
| --- | --- |
| **Purpose** | Detect every failure staging exercised, and those staging did not cover (capacity, resources, 5xx, certificates), independently of the API's own view |
| **Operator action** | 1. Deploy or choose the monitoring stack (Prometheus-compatible or equivalent).<br>2. Scrape `GET /api/metrics` with `Authorization: Bearer <METRICS_SCRAPE_TOKEN>` from every API instance.<br>3. Configure external probes: `/api/health/ready`, `/api/health/live`, the `antivirus` / `database:*` / `cache` entries of `/api/health`, web `/login`, **the object store's own health endpoint**, and PostgreSQL and Redis TCP.<br>4. Run a scanner exporter that runs `probe.mjs` periodically from the scanner network and publishes success and the age of `daily.cvd`. Publish metrics from the backup and signature-update jobs.<br>5. Load the 14 alerts below, plus the additional signals |
| **The 14 staging-validated alerts** | AntivirusDegraded · ScannerProbeFailing · ApiNotReady · ApiDown · WebDown · DatabaseDown · RedisDown · ObjectStoreDown · QueueFailuresGrowing · OutboxBacklog · BackupFailed · BackupStale · SignaturesStale · SignatureUpdateNotRunning (signals and staging thresholds: [prerequisites checklist §4](./production-prerequisites-checklist.md)) |
| **Additional production signals** | Object-storage capacity and quota · database disk, connections and replication lag · CPU and memory per API, web, scanner, PostgreSQL and Redis instance (clamd about 1 GB, about double during a reload, runbook §9.7) · HTTP 5xx rate at the LB · certificate expiry for the web and store hostnames. **Thresholds: `<OPERATOR-APPROVED>`** |
| **Required inputs** | The monitoring platform, `<METRICS_SCRAPE_TOKEN>` (secret), the probe locations (one must reach the scanner network), thresholds for the additional signals |
| **Where configured** | Monitoring platform (scrape configs, probes, rules); the API's `METRICS_DRIVER=PROMETHEUS` and `METRICS_SCRAPE_TOKEN` |
| **Validation** | Every target `up`. Every rule loaded and evaluating. Scrape without the token → 401, with it → 200. **Provocations before traffic** (the stack deployed, not in rotation): stop the scanner → AntivirusDegraded and ScannerProbeFailing; stop Redis → RedisDown and ApiNotReady; block the store probe → ObjectStoreDown; a failing backup run → BackupFailed. Restore each, then RESOLVED. Rules needing hours or days (SignaturesStale, BackupStale, SignatureUpdateNotRunning, OutboxBacklog) are verified by rule review and a test alert, and recorded as such |
| **Expected result** | All targets up. Each provoked alert fires and resolves. The additional signals are visible with thresholds set |
| **Evidence to record** | The target list; the loaded rules (export); for each provocation: time, alert name, FIRING and RESOLVED timestamps |
| **Owner** | `<SRE_OWNER>` |
| **Blocking** | **Yes.** NO-GO if monitoring is missing, or object storage is not monitored independently |

### 3. Production alert routing, on-call, escalation, silences

| Field | Detail |
| --- | --- |
| **Purpose** | An alert reaches a **named, responsible person**, not a mailbox. The staging mailbox does not count |
| **Operator action** | 1. Name the on-call rota and escalation chain for Munaxa Docs.<br>2. Route every `page` severity alert to the production on-call mechanism (pager or rota tool). Route `ticket` severities to the team queue.<br>3. Configure escalation (unacknowledged within `<ESCALATION_TIMEOUT>` → next level).<br>4. Write the maintenance-silence procedure: a planned drain pages ApiDown, WebDown and ApiNotReady (observed in staging), so the go-live window needs a silence that is created, scoped and expired by named people |
| **Required inputs** | `<ONCALL_PRIMARY>`, `<ONCALL_ESCALATION>`, `<PAGING_SYSTEM>` and its integration, `<ESCALATION_TIMEOUT>`, `<SILENCE_PROCEDURE_OWNER>` |
| **Where configured** | Alert router (e.g. Alertmanager receivers and routes) and the paging system |
| **Validation** | 1. A synthetic alert per route.<br>2. **The real scanner test:** with production deployed and not in rotation, stop the scanner. `AntivirusDegraded` must page `<ONCALL_PRIMARY>`, who acknowledges it. Leave one alert unacknowledged to prove escalation. Restart the scanner, pass `probe.mjs`, receive RESOLVED.<br>3. Create a silence for a test window and confirm alerts inside it are suppressed and those outside are not |
| **Expected result** | The page is received and acknowledged by the named person. Escalation reaches the second level. RESOLVED is received. The silence behaves as scoped |
| **Evidence to record** | The route configuration; page and acknowledgement timestamps and names; the escalation timestamp; the silence ID, scope and expiry |
| **Owner** | `<ONCALL_OWNER>` |
| **Blocking** | **Yes.** NO-GO if the scanner DEGRADED alert does not reach the real on-call |

### 4. SMTP relay, sender domain, SPF/DKIM/DMARC

| Field | Detail |
| --- | --- |
| **Purpose** | Workflow notifications (approval needed, approved, published) and any e-mailed alerts are delivered and authenticated |
| **Operator action** | 1. Choose the relay and sender address `<MAIL_FROM_ADDRESS>` on `<SENDER_DOMAIN>`.<br>2. Publish SPF (authorising the relay), a DKIM key (relay signs) and a DMARC policy for `<SENDER_DOMAIN>`.<br>3. Store the relay credentials in the secret store.<br>4. Set the `MAIL_*` configuration (§C) with `MAIL_SMTP_SECURITY` = `TLS` or `STARTTLS` |
| **Required inputs** | `<SMTP_HOST>`, `<SMTP_PORT>`, `<TLS_OR_STARTTLS>`, `<SMTP_USERNAME>`/`<SMTP_PASSWORD>` (secret), `<MAIL_FROM_ADDRESS>`, `<SENDER_DOMAIN>`, `<AUTHORISED_TEST_RECIPIENT>` |
| **Where configured** | Relay provider; DNS (SPF/DKIM/DMARC TXT records); secret store; API configuration |
| **Validation** | `dig +short TXT <SENDER_DOMAIN>` (SPF) · `dig +short TXT <DKIM_SELECTOR>._domainkey.<SENDER_DOMAIN>` · `dig +short TXT _dmarc.<SENDER_DOMAIN>` · `openssl s_client -starttls smtp -connect <SMTP_HOST>:<SMTP_PORT> -verify_return_error` (or `-connect` for implicit TLS) · **one** authorised test message to `<AUTHORISED_TEST_RECIPIENT>` through the relay, whose received headers show `spf=pass`, `dkim=pass`, `dmarc=pass`. **No real production notifications** during validation without explicit authorisation |
| **Expected result** | The records resolve. The TLS handshake verifies. The test message is delivered with all three passes |
| **Evidence to record** | The DNS answers, the TLS handshake summary, the test message's `Authentication-Results` header, and who authorised the test |
| **Owner** | `<MAIL_DNS_OWNER>` |
| **Blocking** | **Yes**, where notifications are required (NO-GO if SMTP is missing where required) |

### 5. Private antivirus network and scanner (validated architecture preserved)

| Field | Detail |
| --- | --- |
| **Purpose** | Every upload is scanned by a real ClamAV behind c-icap, and fails closed when the scanner is unavailable. The scanner is reachable only by the API |
| **Operator action** | 1. Create a private network or segment for the scanner. Only the API instances may reach TCP `1344`; nothing is published publicly (clamd's `3310` is internal to the container).<br>2. Deploy the scanner image **by digest** (prerequisite 9) with a persistent signature volume and at least about 1 GB RAM for clamd, plus reload headroom (runbook §9.7).<br>3. Provide a signature-update path: egress to the ClamAV mirror, or a private mirror, and a **schedule** (runbook §9.3). The image only runs freshclam at start.<br>4. Set `AV_DRIVER=ICAP`, `AV_ICAP_URL=icap://<SCANNER_PRIVATE_ADDRESS>:1344/avscan` (plain ICAP; `icaps://` is refused), and keep `AV_ICAP_MAX_BYTES` / `AV_SCAN_TIMEOUT_MS` at their validated defaults unless you deliberately change them |
| **Required inputs** | `<SCANNER_PRIVATE_ADDRESS>`, `<SCANNER_NETWORK>`, `<SIGNATURE_MIRROR_OR_EGRESS>`, `<SIGNATURE_UPDATE_SCHEDULE>`, `<SCANNER_MEMORY_LIMIT>` |
| **Where configured** | Network or security groups; container orchestration; scheduler; API configuration |
| **Validation** | **Versions:** `docker exec <scanner> sh -c 'clamd --version; c-icap -V'` → ClamAV **1.5.4** and c-icap **0.5.10**. If they differ (packages are unpinned, runbook §1), record the versions and treat them as a new artifact that must pass everything in this row.<br>**Probe (clean and EICAR):** from the API's network namespace, `node infra/antivirus/probe.mjs icap://<SCANNER_PRIVATE_ADDRESS>:1344/avscan` → exit 0, "clean passed (204), EICAR blocked (Eicar-Test-Signature)". Use `--wait 300` on a first start.<br>**Reachability:** from the API → `1344` open. From the web tier, and from outside the private network, → closed or filtered (`nc -vz -w 3 <SCANNER_PRIVATE_ADDRESS> 1344`). An external port scan of the public addresses shows no `1344`/`3310`.<br>**Scanner unavailable** (before traffic): stop the scanner → `/api/health` shows `antivirus: DEGRADED`, readiness still 200, `probe.mjs` exits 1 (`ECONNREFUSED`/timeout), the AntivirusDegraded page fires (prerequisite 3). Start it again → probe exit 0, `antivirus: UP`.<br>**Scanner error:** with c-icap up, stop the engine (`docker exec <scanner> sh -c 'kill $(cat /var/run/clamav/clamd.pid)'`) → the probe fails, and `/api/health` shows DEGRADED. `docker restart <scanner>` → it recovers (STG-9 fix) and the probe passes.<br>**Signatures:** the scheduled update log shows success, and the `daily` version and date are current. SignaturesStale and SignatureUpdateNotRunning are loaded (prerequisite 2).<br>Upload-level behaviour (FAILED/UNREACHABLE, TIMEOUT and SCANNER_ERROR, never CLEAN) was validated in staging. In production, test it only with probes and health checks before traffic, so no user data is created |
| **Expected result** | The versions match (or are recorded and re-validated). The probe passes. Only the API reaches the scanner. Unavailable and error states are detected and alerted, and they recover. Signatures are current and updating on schedule |
| **Evidence to record** | The image digest; the version output; the probe output (the timestamp and both checks); the reachability matrix; the timeline of the unavailable and error tests with alert timestamps; the signature versions and the last update time; the memory limit |
| **Owner** | `<NETWORK_OWNER>` + `<RELEASE_ENGINEER>` |
| **Blocking** | **Yes.** NO-GO if the scanner is not UP or `probe.mjs` fails |

### 6. Production object storage

| Field | Detail |
| --- | --- |
| **Purpose** | Durable, versioned, replicated document storage that browsers upload to and download from directly (presigned URLs), monitored independently |
| **Operator action** | 1. Create `<STORAGE_BUCKET>` in `<STORAGE_REGION>` / `<STORAGE_ENDPOINT>`.<br>2. Enable **versioning**.<br>3. Configure **replication** to `<REPLICATION_TARGET>`.<br>4. Create credentials scoped to this bucket only (or an instance role).<br>5. Configure **CORS** for `<WEB_ORIGIN>` only: methods `PUT`, `GET`; allowed headers at least `content-type` and `x-amz-checksum-sha256` (every upload is one signed PUT carrying its SHA-256, STG-10). The repository defines no CORS document: write it for your provider.<br>6. Set `STORAGE_PUBLIC_URL=<WEB_ORIGIN>` (required with every driver: preview links are built from it).<br>7. Add independent monitoring of the store's health and capacity (prerequisite 2) |
| **Required inputs** | `<STORAGE_DRIVER>` (`S3`/`R2`), `<STORAGE_BUCKET>`, `<STORAGE_REGION>`, `<STORAGE_ENDPOINT>` (if not AWS), credentials (secret) or a role, `<WEB_ORIGIN>` (from prerequisite 1), `<REPLICATION_TARGET>`, `<CAPACITY_QUOTA>` |
| **Where configured** | Storage provider (bucket policy, versioning, replication, CORS); secret store; API configuration and catalogue storage settings |
| **Validation** | Versioning via the provider CLI (e.g. `aws s3api get-bucket-versioning --bucket <STORAGE_BUCKET>` → `Enabled`). Replication rule status → enabled and healthy. **CORS preflight** `curl -si -X OPTIONS "<STORE_URL>/<STORAGE_BUCKET>/cors-probe" -H "Origin: <WEB_ORIGIN>" -H "Access-Control-Request-Method: PUT" -H "Access-Control-Request-Headers: content-type,x-amz-checksum-sha256"` → `Access-Control-Allow-Origin: <WEB_ORIGIN>`. The same with `-H "Origin: https://not-the-origin.invalid"` → no allow header. After deploy (before traffic), §16 smoke steps 5–8 upload, download and preview from a **real browser** at `<WEB_ORIGIN>`. The store probe is up in monitoring |
| **Expected result** | Versioning Enabled. Replication healthy. CORS allows only the production origin. The browser upload succeeds, and preview URLs start with `<WEB_ORIGIN>` |
| **Evidence to record** | Bucket settings exports (versioning, replication, CORS); the preflight outputs; the smoke results; the monitoring target |
| **Owner** | `<STORAGE_OWNER>` |
| **Blocking** | **Yes.** NO-GO if storage protection or its independent monitoring is missing |

### 7. PostgreSQL, backup, PITR, failover, restore

**7a. Cluster preparation (before everything that needs the database)**

| Field | Detail |
| --- | --- |
| **Purpose** | Tenant databases with forced RLS; a backup role that reads through RLS without weakening it |
| **Operator action** | Runbook §6: `01-roles.sql` (`edms_owner`, `edms_app`). **Create `edms_backup`** (`LOGIN BYPASSRLS`, `GRANT pg_read_all_data`) with its password from the secret store; never grant `BYPASSRLS` to `edms_owner`/`edms_app`. One database per tenant owned by `edms_owner`. The tenant catalogue. WAL archiving / PITR on (provider feature or `archive_mode`). Replication (a standby or the provider's HA) |
| **Required inputs** | `<DB_PROVIDER>`, `<DB_HOST>`, tenant list (`<TENANT_ID>`, `<TENANT_SLUG>`, database names), role passwords (secret), `<PITR_RETENTION>`, `<BACKUP_STORAGE_LOCATION>` (outside the production cluster), `<REPLICA_OR_HA_CONFIG>` |
| **Where configured** | Database provider/cluster; secret store; catalogue (mounted secret) |
| **Validation** | `\du edms_backup` shows `Bypass RLS` and membership of `pg_read_all_data`; `edms_owner`/`edms_app` are not superuser or BYPASSRLS. WAL archiving: `select archived_count, failed_count, last_archived_time from pg_stat_archiver` (failed 0, recent) or the provider's PITR status. Replication status healthy |
| **Owner / Blocking** | `<DBA_OWNER>` · **Yes** |

**7b. Recovery rehearsal (after images are published; before go-live)**

Run everything here in an **isolated rehearsal environment**. The restored API must not reach users
or send anything:

- a mail sink or no-delivery relay instead of the production relay;
- `OUTBOUND_HTTP_ALLOWLIST` empty (no webhooks or audit push);
- its own empty Redis;
- a copy of the store, not the production bucket.

A restored database contains pending outbox work, and with consumers enabled it **would re-deliver
notifications and webhooks**. Nothing here restores over, or writes to, the production database
except the backup itself.

| Required step | Procedure | Expected result | Evidence |
| --- | --- | --- | --- |
| **Backup creation** | Runbook §19.2: `pg_dump --format=custom --file <dir>/<db>.dump "postgresql://edms_backup@<DB_HOST>:5432/<db>"` per tenant, plus the provider's base backup | One dump per tenant, stored at `<BACKUP_STORAGE_LOCATION>` | File names, sizes, SHA-256, time |
| **Backup verification** | `pg_restore --list <dump>` per tenant (table data present); if a storage copy is taken, `node scripts/storage-backup.mjs verify --dir <path>` → `intact` | Every tenant lists its tables. Storage verify `intact` | The command outputs |
| **Restore into a separate destination** | `DATABASE_MIGRATION_URL=<edms_backup URL, tenant 1> DATABASE_URL=<app URL, tenant 1> SECOND_…=<tenant 2> DR_DEST_ADMIN_URL=<superuser URL on the EMPTY rehearsal cluster> DR_BACKUP_DIR=<path> node scripts/dr-rehearsal.mjs --prepare-destination > dr.json` (runbook §23; the destination accepts password-less `edms_owner`/`edms_app` from the rehearsal host only). With more than two tenants, run it per pair, or restore with `pg_restore --create` into the empty cluster and compare row counts | `differences: []`; `posture`: RLS forced on every table, roles not BYPASSRLS, audit not updatable; the audit tail equals the source's (STG-11 fixed) | `dr.json` summary (no URLs or passwords), timings |
| **PITR verification** | Restore the provider's base backup plus WAL to `<TARGET_TIMESTAMP>` into a **new** instance (provider PITR or `restore_command` + `recovery_target_time`). Choose a target between two known, timestamped writes (for example two audit events, or a marker in a DBA-approved probe database) | Recovery stops at the target: the event before it is present, the one after it absent | The recovery log line ("recovery stopping before …"), the query outputs |
| **Failover** | Execute the provider's documented failover (or a switchover to the standby) **in the rehearsal environment or during an approved window, never destructively against live data**. Measure the time to a writable primary | The application reconnects (readiness 200) after the failover | Procedure document, timeline |
| **Application connectivity on the restored DB** | In the isolated rehearsal environment, start `munaxa-docs-api@sha256:<API_DIGEST>` against the restored databases (catalogue pointing at them), with an empty Redis, a store copy, a mail sink, an empty outbound allowlist and the real scanner. Then: readiness 200, `/api/health` all UP; sign in with an existing account; open and download a document (bytes equal); the log shows "Queue state rebuilt from durable state after the broker lost it"; `REDIS_URL=… node scripts/dr-verify-chain.mjs` → "The audit chain verified" per tenant | All pass. The audit chain verifies (a DR test fails without it) | Outputs and log lines |
| **Named confirmation** | `<BACKUP_CONFIRMER>` reviews the evidence above and signs off in the change record. Repeated for the pre-deployment backup at go-live (runbook §21 step 9) | A signed confirmation with name and time | Change record entry |

**7b owner / blocking:** `<DBA_OWNER>` · **Yes.** NO-GO if the backup cannot be verified or PITR and
recovery are not satisfied. If the provider's PITR or failover cannot be rehearsed before go-live,
this stays **NOT READY**. The change approver may accept the risk only in writing, and it is not
recorded as READY.

### 8. Production-sized infrastructure and load baseline

| Field | Detail |
| --- | --- |
| **Purpose** | Establish that production-sized infrastructure meets **approved** capacity requirements. The staging result (29,551 requests, 0 failures, 0 rate-limited, **latency targets missed** on one 4-CPU host) establishes no production capacity |
| **Operator action** | 1. Provision production-sized API, web, PostgreSQL, Redis, store and scanner capacity.<br>2. Obtain approved thresholds from the capacity owner (inputs below).<br>3. Before traffic, with test identities in a **test tenant**, run `node infra/loadtest/run.mjs --base-url https://<WEB_HOSTNAME> --tokens-file <tokens> --folder-id … --document-id … --search-term …`. Sign the identities in from several client addresses within the per-address limit (10 per 5 min). Use enough identities for the largest scenario (100).<br>4. Collect the measurements below throughout the run |
| **Measurements to collect** | Per scenario: concurrency; identities; duration; requests; throughput (req/s); p50, p95, p99 latency; failures; 429s (more than 1% failures or 429s is not a baseline). API: CPU, memory, event-loop lag and instance count. PostgreSQL: CPU, connections, lock waits, slow queries, replication lag. Redis: ops/s, memory, rejected connections. Object store: request latency and errors. Scanner: CPU, memory, scan latency (if an upload scenario is approved). LB: 5xx rate |
| **Approval thresholds** | **Operator- or owner-supplied; not defined here:** `<P95_TARGETS_PER_SCENARIO>`, `<P99_TARGETS_PER_SCENARIO>`, `<THROUGHPUT_TARGET>`, `<MAX_ERROR_RATE>`, `<MAX_CPU_UTILISATION>`, `<MAX_MEMORY_UTILISATION>`, `<DB_CONNECTION_CEILING>` |
| **Where configured** | The load generator host(s); the monitoring stack for resource data; the capacity-requirements record |
| **Validation** | The measurement table compared against the approved thresholds, row by row |
| **Expected result** | Every measured value within its approved threshold, or a written capacity decision by the owner |
| **Evidence to record** | The harness output table; resource graphs and exports; the threshold table with approvals; the test tenant ID (clean it up afterwards) |
| **Owner** | `<CAPACITY_OWNER>` + `<RELEASE_ENGINEER>` |
| **Blocking** | **Yes, where capacity requirements exist** (runbook §25) |

### 9. Container registry, immutable images, pull identity, secret store, configuration versioning

**9a–9c. Platform foundations**

| Field | Detail |
| --- | --- |
| **Purpose** | Deploy exactly the validated artifacts, by immutable digest, with credentials never in Git and configuration traceable |
| **Operator action** | 1. Registry `<REGISTRY_HOST>` with three repositories: **API** `<REGISTRY_HOST>/<API_REPOSITORY>`, **web** `<REGISTRY_HOST>/<WEB_REPOSITORY>`, **antivirus** `<REGISTRY_HOST>/<AV_REPOSITORY>`. Tags immutable (if supported). Pull access restricted.<br>2. A **push identity** for the release engineer or build system only.<br>3. A **separate production pull identity**, read-only, used by the runtime.<br>4. Signing, if `<SIGNING_POLICY>` requires it.<br>5. A secret store holding every secret in §C.<br>6. Configuration versioning: the non-secret configuration for API, web and catalogue in a versioned store, with the version recorded per deployment |
| **Required inputs** | `<REGISTRY_HOST>`, the three repository names, `<PUSH_IDENTITY>`, `<PULL_IDENTITY>`, `<SIGNING_POLICY>`, `<SECRET_STORE>`, `<CONFIG_REPOSITORY>` |
| **Owner / Blocking** | `<PLATFORM_OWNER>` · **Yes.** Registry chosen: GHCR `munaxa` (`ghcr.io/munaxa/munaxa-docs-{api,web,antivirus}`). Currently **OPERATOR ACTION REQUIRED**: publish (9d) and provision the pull identity |

**9d. Publishing the images — `.github/workflows/publish-images.yml`**

Publishing is a tag push; the workflow builds exactly the commit the tag names, in GitHub Actions
(where the `@munaxa/*` build secret is available), and never tags `latest`.

```bash
# From any clone with push rights to munaxa/munaxa-docs.
git fetch origin claude/docs-release-rc2
git tag image/27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5 27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5
git push origin image/27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5
```

The run publishes `ghcr.io/munaxa/munaxa-docs-api`, `-web` and `-antivirus`, each tagged `27a8daa`
and `sha-27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5`, and prints the three `image@sha256:<digest>` references in its summary (and as the
`digest-*` artifacts). It fails — publishing nothing it has not verified — unless each **pulled
digest** carries the revision label, runs as non-root, holds no credential, and (API) carries its query
engine, (web) serves its branding, (scanner) reports its recorded versions and passes `probe.mjs` on the
candidate, after an unclean restart and on the pulled digest. Its last job pulls all three with the
production pull identity (`DOCS_PRODUCTION_PULL_USER` / `DOCS_PRODUCTION_PULL_TOKEN`).

**The validated scanner image is not transferable from staging.** `munaxa-antivirus:7442853`
(`sha256:805574b9…`, ClamAV 1.5.4 / c-icap 0.5.10) existed only in the ephemeral staging
environment. The published scanner is therefore a rebuild from the same sources, with unpinned
Ubuntu packages. It must pass prerequisite 5's version check and every scanner test before it is
accepted. Record the versions it actually carries.

**Verification after push**, using the **production pull identity**, never the push identity:

| Check | Command | Expected |
| --- | --- | --- |
| Pull by digest works with the pull identity | `docker pull <REGISTRY_HOST>/<API_REPOSITORY>@sha256:<API_DIGEST>` (and web, antivirus) | Pull succeeds; the pull identity cannot push |
| Digest is immutable | Re-resolve the tag later and confirm the digest is unchanged. Registry immutability setting: on | Same digest |
| Revision label | `docker image inspect <ref>@sha256:… -f '{{index .Config.Labels "org.opencontainers.image.revision"}}'` | `27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5` for API, web and scanner |
| Web serves its brand artwork (STG-12) | Run the web digest with `PORT=3000 NEXT_PUBLIC_API_URL=http://127.0.0.1:9`, then `curl -so /dev/null -w '%{http_code} %{content_type}' http://127.0.0.1:3000/branding/docs/favicon/favicon-32.png` (the same check as CI's "The web image serves the brand artwork its pages reference") | `200 image/png` |
| Scanner versions and probe | Prerequisite 5 | ClamAV 1.5.4, c-icap 0.5.10 (or recorded) and the probe passes |
| Signature, if required | `<SIGNING_TOOL> verify <ref>@sha256:…` | Valid signature |

**Where the digests are recorded:**

1. The release package, [production-release-package-27a8daa.md](../reports/production-release-package-27a8daa.md),
   in its **"Published registry digests"** table (§1a). Commit it as a documentation change. The
   application SHA stays `27a8daa`.
2. The go-live **change record** (runbook §21 steps 1 and 21).
3. The deployment manifests, as `image@sha256:<digest>`, never a tag.

**Rollback target (runbook §20).** For this first production deployment there is **none**. Record
"no rollback target — first deployment". From the next release on, the rollback target is these
digests, once they have run here.

---

## B. Operator checklist (execute in order; tick only with evidence recorded)

**Phase 0 — foundations**

- [ ] Owners named for every prerequisite (`<…_OWNER>` values filled in the change record)
- [ ] 9a Registry `<REGISTRY_HOST>` exists, with API, web and antivirus repositories; tag immutability on
- [ ] 9a Push identity (release engineer or build system) created
- [ ] 9a **Separate** read-only production pull identity created; confirmed unable to push
- [ ] 9b Secret store `<SECRET_STORE>` provisioned; access restricted
- [ ] 9c Configuration repository `<CONFIG_REPOSITORY>` versioned; the initial production config committed (no secrets)
- [ ] 9a Signing policy decided (`<SIGNING_POLICY>`: required / not required)

**Phase 1 — edge and database**

- [ ] 1 DNS for `<WEB_HOSTNAME>` resolves to the load balancer
- [ ] 1 Public certificate and chain installed; `openssl s_client -verify_return_error` → `0 (ok)`
- [ ] 1 LB: TLS 1.2+ only, 80 → 443, HSTS, routes `/api/*` → API; health checks (API `/api/health/ready`, web `/login`)
- [ ] 1 `<LB_ADDRESS_RANGES>` recorded for `TRUST_PROXY` / `WEB_TRUST_PROXY`
- [ ] 7a Cluster roles created (`01-roles.sql`); role passwords in the secret store
- [ ] 7a `edms_backup` created (`BYPASSRLS`, `pg_read_all_data`); owner and app roles verified non-BYPASSRLS
- [ ] 7a Tenant databases and catalogue created
- [ ] 7a WAL archiving / PITR enabled; `failed_count` 0 and archiving recent
- [ ] 7a Replication or HA configured and healthy

**Phase 2 — services**

- [ ] 6 Bucket created; versioning **Enabled**; replication to `<REPLICATION_TARGET>` healthy
- [ ] 6 Bucket-scoped credentials (or a role) in the secret store
- [ ] 6 CORS for `<WEB_ORIGIN>` only (PUT, GET; headers `content-type`, `x-amz-checksum-sha256`); allowed and foreign-origin preflights recorded
- [ ] 6 `STORAGE_PUBLIC_URL=<WEB_ORIGIN>` in the configuration
- [ ] 4 SPF, DKIM and DMARC published for `<SENDER_DOMAIN>`; `dig` outputs recorded
- [ ] 4 Relay TLS/STARTTLS handshake verified; credentials in the secret store
- [ ] 4 One **authorised** test message delivered with spf/dkim/dmarc = pass
- [ ] 5 Scanner network created; only API instances may reach `1344`; nothing public
- [ ] 5 Signature-update egress or mirror available; update schedule configured
- [ ] 5 Scanner memory limit at least about 1 GB plus reload headroom
- [ ] Redis 7 with persistence (`appendonly`) and a password; reachable only from the API (runbook §8)

**Phase 3 — artifacts, routing, monitoring**

- [ ] 9d Tag `image/<27a8daa full SHA>` pushed; the publish workflow built API and web from `27a8daa` and pushed them
- [ ] 9d Scanner image built by the same run from `infra/antivirus` at `27a8daa`, probed and pushed; versions recorded
- [ ] 9d Digests resolved; pulled **with the pull identity**; revision labels = `27a8daa…`
- [ ] 9d Web digest serves `/branding/docs/favicon/favicon-32.png` → `200 image/png`
- [ ] 9d Signatures verified (if required)
- [ ] 9d Digests entered in the release package §1a and the change record
- [ ] 5 Scanner deployed **by digest**; `clamd --version` / `c-icap -V` = ClamAV 1.5.4 / c-icap 0.5.10 (or recorded and re-validated)
- [ ] 5 `probe.mjs` from the API network → exit 0 (clean 204 **and** EICAR blocked)
- [ ] 5 Reachability matrix: API → `1344` open; web, outside and public → closed
- [ ] 5 Signature update ran on schedule; `daily` current
- [ ] 3 On-call rota and escalation named; page routes configured
- [ ] 3 Maintenance-silence procedure written; test silence behaves as scoped
- [ ] 2 Monitoring targets up: API metrics (token), readiness and liveness, `/api/health` entries, web, **object store (independent)**, PostgreSQL, Redis, scanner probe, backup and signature jobs
- [ ] 2 The 14 alerts loaded, plus capacity, CPU/memory, 5xx and certificate-expiry alerts with **approved** thresholds

**Phase 4 — prove it (production stack deployed, NOT in rotation, no user data)**

- [ ] 5 + 3 **Scanner stopped → `AntivirusDegraded` paged `<ONCALL_PRIMARY>`, acknowledged**; escalation proven; restart → probe exit 0 → RESOLVED
- [ ] 5 Scanner engine killed → probe fails, DEGRADED; `docker restart` → recovered, probe exit 0
- [ ] 2 Provocations: RedisDown, ObjectStoreDown, BackupFailed fired and resolved; long-window rules reviewed and recorded
- [ ] 7b Backup created (`edms_backup`) and verified (`pg_restore --list`, storage verify)
- [ ] 7b Restore into a **separate** destination: `dr-rehearsal.mjs` → `differences: []`, posture intact, audit tail equal
- [ ] 7b PITR to a timestamp verified (before-target present, after-target absent)
- [ ] 7b Failover procedure executed in rehearsal or an approved window; timeline recorded
- [ ] 7b Restored API (isolated: mail sink, empty outbound allowlist, own Redis, store copy): readiness 200, sign-in, download bytes equal, queue rebuild logged, "The audit chain verified"
- [ ] 7b `<BACKUP_CONFIRMER>` signed the recovery evidence
- [ ] 8 Approved thresholds received from `<CAPACITY_OWNER>`
- [ ] 8 Load run on production-sized infrastructure (test tenant): the measurement table collected; within thresholds or a written capacity decision
- [ ] 8 Test tenant or test data cleaned up

**Phase 5 — gate**

- [ ] §D readiness gate complete and signed → proceed to runbook §21

---

## C. Production configuration inventory

Every value is **operator-supplied**. **(S)** = secret: in the secret store only, never in Git, this
file or the change record. Everything else goes in the versioned configuration repository.

| # | Setting | Service | Value source / requirement |
| --- | --- | --- | --- |
| 1 | `NODE_ENV` | API, web | `production` |
| 2 | `PORT` | API, web | default 3001 / 3000 unless changed |
| 3 | `DATABASE_URL` (S) | API | `edms_app` URL; required even with a catalogue |
| 4 | `TENANT_CATALOGUE_PATH` or `TENANT_CATALOGUE` (S: contains URLs) | API | every production tenant: `id`, `slug`, database URLs, storage prefix |
| 5 | `TENANT_ID` + `TENANT_SLUG` | API | only for a single-tenant install instead of 4 |
| 6 | `DATABASE_MIGRATION_URL` (S) | release workstation only | `edms_owner` URL; **never** in the running API |
| 7 | Backup role URL / password (S) | backup job | `edms_backup` |
| 8 | `REDIS_URL` (S) | API | Redis 7 with a password |
| 9 | `JWT_ACCESS_SECRET` (S) | API | required |
| 10 | `SIGNATURE_WITNESS_SECRET` (S) | API | required in production |
| 11 | `AUDIT_CHECKPOINT_SECRET` (S) | API | required in production |
| 12 | `MFA_TOTP_SEALING_KEY` (S) | API | required in production |
| 13 | `CORS_ORIGINS` | API | `<WEB_ORIGIN>` |
| 14 | `WEB_BASE_URL` | API | `<WEB_ORIGIN>` |
| 15 | `TRUST_PROXY` | API | `<LB_ADDRESS_RANGES>` |
| 16 | `WEB_TRUST_PROXY` | web | `<LB_ADDRESS_RANGES>` |
| 17 | `NEXT_PUBLIC_API_URL` | web | the API as the web tier reaches it |
| 18 | `STORAGE_DRIVER` | API | `S3` or `R2` |
| 19 | `STORAGE_BUCKET` | API (and catalogue storage settings) | `<STORAGE_BUCKET>` |
| 20 | `STORAGE_REGION` / `STORAGE_ENDPOINT` | API | as the provider needs |
| 21 | `STORAGE_ACCESS_KEY_ID` + `STORAGE_SECRET_ACCESS_KEY` (S) (+ `STORAGE_SESSION_TOKEN`) | API | bucket-scoped; or both unset for an instance role |
| 22 | `STORAGE_FORCE_PATH_STYLE` | API | per provider (`true` for most S3-compatibles) |
| 23 | `STORAGE_PUBLIC_URL` | API | `<WEB_ORIGIN>`; required with every driver |
| 24 | `STORAGE_MAX_UPLOAD_BYTES` | API | default 2 GiB; under ICAP the effective limit is `min(this, AV_ICAP_MAX_BYTES)` |
| 25 | `MAIL_DRIVER` | API | `SMTP` (or `RESEND`) |
| 26 | `MAIL_FROM_ADDRESS` | API | `<MAIL_FROM_ADDRESS>` on `<SENDER_DOMAIN>` |
| 27 | `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT`, `MAIL_SMTP_SECURITY` | API | relay; `TLS` or `STARTTLS` |
| 28 | `MAIL_SMTP_USERNAME` + `MAIL_SMTP_PASSWORD` (S) | API | both or neither |
| 29 | `AV_DRIVER` | API | `ICAP` |
| 30 | `AV_ICAP_URL` | API | `icap://<SCANNER_PRIVATE_ADDRESS>:1344/avscan` (plain ICAP on the private network) |
| 31 | `AV_ICAP_MAX_BYTES` | API | validated default 134217728 (128 MiB); drives API memory (§9.7) |
| 32 | `AV_SCAN_TIMEOUT_MS` | API | validated default 120000 |
| 33 | `AV_ICAP_TEST_URL` | API | **must be unset** |
| 34 | `OPENAPI_ENABLED` | API | `false` |
| 35 | `OUTBOUND_HTTP_ALLOWLIST` | API | only intended webhook/push hosts (https); empty = none |
| 36 | `METRICS_DRIVER` + `METRICS_SCRAPE_TOKEN` (S) | API | `PROMETHEUS` + token |
| 37 | `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT` | API | **must be unset** |
| 38 | `QUEUE_CONSUMERS_ENABLED` | API | `true` |
| 39 | `NODE_OPTIONS` | API | image default `--max-old-space-size=768`; raise with `AV_ICAP_MAX_BYTES` × concurrent completions |
| 40 | TLS certificate + key (S) | LB | for `<WEB_HOSTNAME>` (and the store hostname if applicable) |
| 41 | Registry pull credential (S) | runtime | `<PULL_IDENTITY>` |
| 42 | Registry push credential (S) | release engineer | `<PUSH_IDENTITY>` |
| 43 | Image references | runtime | `<REGISTRY_HOST>/<API_REPOSITORY>@sha256:…`, `…/<WEB_REPOSITORY>@sha256:…`, `…/<AV_REPOSITORY>@sha256:…` |
| 44 | Monitoring and alert-routing secrets (S) | monitoring | paging integration keys, metrics token |
| 45 | First tenant administrator (`ADMIN_PASSWORD` (S), `ADMIN_EMAIL`, `ADMIN_NAME`, `TENANT_NAME`) | provisioning (runbook §6 step 5) | per tenant, at provisioning only |

The API refuses to start under `NODE_ENV=production` when a required value is missing or invalid,
and names it. That start log is evidence for runbook §25 "All required secrets present".

---

## D. Final deployment readiness gate

The operator may proceed to **runbook §21 step 1** only when **every** row below has its evidence
attached to the change record and is signed by its owner. Any missing row is **NO-GO**. An
unresolved prerequisite is never converted to PASS; an accepted risk is recorded as such, by the
change approver, and does not count as READY.

| # | Requirement | Evidence that must exist | Owner |
| --- | --- | --- | --- |
| D1 | Release identity | `27a8daa`; CI run 554 9/9; API, web and scanner **digests** in the release package §1a; revision labels verified with the pull identity | Release engineer |
| D2 | Images | Pulled by digest with the production pull identity; web serves its brand artwork; signatures (if required) | Platform |
| D3 | Rollback target | "No rollback target — first deployment" recorded (runbook §20) | Release engineer |
| D4 | DNS / TLS / LB | Prerequisite 1 evidence: public chain verified, HTTPS headers, 80 → 443, health checks, `TRUST_PROXY` ranges | Network/PKI |
| D5 | Scanner | Prerequisite 5 evidence: versions; `probe.mjs` exit 0 from the API network; reachability matrix; unavailable and error tests recovered; signatures current and on schedule | Network + release engineer |
| D6 | Alerting reaches people | Prerequisite 3 evidence: **AntivirusDegraded page acknowledged by `<ONCALL_PRIMARY>`**; escalation proven; silence procedure ready for the window | On-call owner |
| D7 | Monitoring | Prerequisite 2 evidence: targets up, 14 alerts plus additional signals loaded, provocations fired and resolved, **independent store monitoring** | SRE |
| D8 | SMTP | Prerequisite 4 evidence: SPF/DKIM/DMARC pass on the authorised test message (where notifications are required) | Mail/DNS |
| D9 | Object storage | Prerequisite 6 evidence: versioning, replication, CORS (allowed and foreign preflights), `STORAGE_PUBLIC_URL`, scoped credentials | Storage |
| D10 | Database and recovery | Prerequisite 7 evidence: `edms_backup`; backup created and verified; **PITR verified**; **restore into a separate destination** with `differences: []`; **restored API connected, audit chain verified**; failover procedure; **named confirmation by `<BACKUP_CONFIRMER>`** | DBA + named confirmer |
| D11 | Capacity | Prerequisite 8 evidence: approved thresholds and the measurement table within them (where capacity requirements exist) | Capacity owner |
| D12 | Configuration and secrets | §C complete in the secret store and the versioned configuration; a dry start of the API under `NODE_ENV=production` against production dependencies (not in rotation) starts without refusal | Platform |
| D13 | Migration readiness | A clean checkout of `27a8daa` on the release workstation with Node 22 / pnpm 10.33; `DATABASE_MIGRATION_URL` available from the secret store; runbook §12 reviewed | Release engineer |
| D14 | Change control | Change window and approver recorded; users notified if the installation has served traffic (runbook §13) | Change approver |

---

## Status summary (2026-09-29)

**READY** (application side; evidence in the staging report, release package and CI run 550):

- Application release candidate `27a8daa`, CI run 554 9/9 (the historical `f5d5bb2` was CI run 550).
- The staging gate on `416ca94`, plus the STG-12 targeted regression on `f5d5bb2`, plus the §16 smoke (pending) on `27a8daa`'s own images.
- The deployment, rollback and recovery **procedures** (runbook, this checklist).
- The scanner architecture, `probe.mjs`, and the alert rule definitions, all proven in staging.

**OPERATOR ACTION REQUIRED** (no production evidence exists yet):

1. Public DNS, CA/TLS and the load balancer.
2. The production monitoring stack, the 14 alerts and the additional signals.
3. Alert routing, the named on-call, escalation and maintenance silences.
4. The SMTP relay, sender domain, SPF/DKIM/DMARC.
5. The private scanner network, the scanner deployment and the signature-update path.
6. Production object storage, CORS, versioning, replication, `STORAGE_PUBLIC_URL` and monitoring.
7. PostgreSQL, backup, PITR, failover, restore rehearsal and the named confirmation.
8. Production-sized infrastructure, approved thresholds and the load baseline.
9. The secret store and configuration versioning (9b, 9c); the owners in every "Owner" field.

**BLOCKED — ENVIRONMENT:**

- **9a/9d: production image registry not configured.** Registry host, repositories, push and pull
  identities, and signing policy not supplied. So no image can be published or verified by digest,
  and D1, D2, D5 (the scanner by digest) and D10 (the restored API by digest) cannot complete.

**Production is NOT ready.** It must not be declared ready until §D's evidence exists.
