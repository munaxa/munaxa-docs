# Readiness for a controlled Hetzner test deployment

- **Status:** assessment and local remediation only.
  - **Nothing has been deployed to Hetzner.** No cloud resource, DNS record, bucket or cost was
    created; no secret was rotated; no image was published.
  - ADR-0026 stays **Proposed**.
  - This is **not** a statement of production readiness.
- **Date:** 2026-10-15 (fourth revision: §11, the pre-provisioning implementation and its local
  verification, on top of the decision pack in §5–§10).
- **Branch:** `claude/amazing-turing-09vlks`. The remediation is in the commits listed in §3.4,
  on top of `0401c21`.
- **Rule used below:** an item is "verified" only where a run is recorded. A document or a script
  that exists but has not run is called that.

## 1. Risks resolved, and the evidence

| # | Risk (first revision) | What was done | Evidence |
| --- | --- | --- | --- |
| **R-1** | No database backup or WAL archiving in the template (**critical**) | <ul><li>Continuous WAL archiving, encrypted (`age`, public-key) onto a separate filesystem.</li><li>A `db-backup` service: nightly base backup (with its own SHA-256 manifest) and one dump per tenant database, retention 35 days, a status file and a health check.</li><li>Both writers refuse the database's own filesystem.</li><li>The server holds no private key, and every backup command refuses to run beside one.</li><li>Procedures: `backup-and-restore.md` §5.</li></ul> | <ul><li>`test-backup-scripts.sh`: 38/38.</li><li>The drill (§3.2): **PITR demonstrated**. Recovery stopped "before commit of transaction 1056", at the target time, in a new container. The change made after the base backup was present (replayed from the WAL); the change after the target was absent.</li><li>Every tenant database was identical at the target. RLS was forced on every tenant table; `edms_app` does not bypass it; tenant isolation held as `edms_app`.</li><li>The audit hash chain verified from genesis with the product's own verifier.</li><li>Recovery to the end of the archive worked; one tenant's encrypted dump was restored beside the others.</li><li>Run twice, all expectations held.</li></ul> **Still open:** the off-server copy (§2) |
| **R-3** | Witness key single slot: a rotation made every earlier signature "key not held" | `SIGNATURE_WITNESS_PREVIOUS_SECRETS`. A signature is verified with the key its `key_id` names, never by trying each | Integration tests on real PostgreSQL: <ul><li>old key read;</li><li>failed rotation and its recovery;</li><li>mixed old and new;</li><li>altered row refused;</li><li>cross-key row refused;</li><li>new signatures use the current key.</li></ul> Negative control: 7 tests fail without the slots |
| **R-4** | MFA sealing key: no slot for a previous value | `MFA_TOTP_SEALING_PREVIOUS_KEYS`. The GCM tag identifies the key; the format is unchanged, so a rollback still reads every row; rows re-seal under the new key on the next proof | Integration tests: <ul><li>old-key read;</li><li>new-key write (the new key alone opens it, the old one does not);</li><li>mixed rows;</li><li>failed rotation leaves the row unchanged, and restoring the key recovers it.</li></ul> |
| R-4b (**new**) | **A lost or dropped MFA key locked people out completely**: the read that decides at sign-in whether a factor is owed threw, so recovery codes could not be used | An unopenable row now means "only a recovery code proves this factor": <ul><li>authenticator codes fail closed;</li><li>refusals are audited as `MFA_FAILED` with reason `SEALING_KEY_NOT_HELD`;</li><li>authenticator-shaped codes do not count toward the lock;</li><li>wrong recovery codes do.</li></ul> | Integration test: lost key → refused codes, no lock-out → recovery code accepted → factor removed → re-enrolled under the new key |
| **R-5** (code half) | Losing a key is irreversible; only documented | Previous-key slots for all three keys, including `AUDIT_CHECKPOINT_PREVIOUS_SECRETS`. `key-rotation.md` covers the procedure, a failed rotation, rollback, a lost key (what breaks, what still holds, what to do) and escrow | Tests above; checkpoint authenticity under a previous key, with a forgery still refused. Escrow itself is a procedure (§2) |
| **R-9** | Preview pipeline read sources through a signed URL and checked nothing | `readVerifiedSource`: <ul><li>refusals first;</li><li>a read bounded by the caller's ceiling and the scan byte budget;</li><li>bytes handed over only when size and SHA-256 match;</li><li>a mismatch or absent object quarantines;</li><li>a store error is retryable and changes nothing.</li></ul> The preview stream and text reads use the port with a digest check. **No store URL is signed for reading anywhere in the API** (a guard spec enforces it) | Tests: <ul><li>tampering before the verifier;</li><li>missing object;</li><li>503, timeout and unreachable store (unchanged, then succeeds);</li><li>a read miss while HEAD still sees the object;</li><li>the ceiling refused without reading;</li><li>an altered source's render fails and the source is quarantined.</li></ul> Negative control: 5 tests fail without the check |
| **R-10** | ClamAV signatures refreshed only at container start | `munaxa-scanner-watch`: <ul><li>hourly freshclam; failures logged, scanning continues;</li><li>unhealthy at 72 h stale;</li><li>scans refused (engine stopped) at 168 h, recovering by itself after a successful refresh;</li><li>a dead engine is restarted.</li></ul> | `test-scanner-watch.sh` (real image, real signatures, no network): 22/22 |
| R-10b (**new, fail-open**) | **c-icap answers "204, clean" for every file, EICAR included, when clamd was not answering as c-icap started.** The old entrypoint avoided it only by start order | <ul><li>c-icap starts only after clamd answers PING;</li><li>a start past the refusal limit waits with nothing listening;</li><li>every watch tick scans EICAR through c-icap and stops the ICAP server if it is answered 204;</li><li>the health check does the same.</li></ul> | The hazard reproduced in the test, then the guard stopping it; the start order is held by `scanner-image.spec.ts` |
| **R-11** | Health endpoints named every tenant (blocked only by the proxy) | Probes named by catalogue position (`database:1`); a failing database's slug is logged privately | Unit tests: no slug or tenant id in the report; a DOWN database is named by position and logged. Smoke: the proxy still returns 404 for every health route |
| R-6 (design and template half) | No monitoring | `monitoring.md`: 16 signals with thresholds, sources and severities; delivery design (dead-man's switch, uptime check). `ops/host-check.sh` turns the signals into findings and an exit status | The stack test runs the host check healthy (all well), then with a forced finding (non-zero, naming the disk). **Delivery is not built** (§2) |
| R-2 (evaluation) | Object version history unavailable or untested | `hetzner-object-storage-options.md`: requirements derived from the code, three candidates, every property labelled verified, documented, third-party or unknown | No provider chosen. Nothing is evidence of EU residency |

## 2. Risks still open

| # | Risk | Severity | Why it is open | Needed before |
| --- | --- | --- | --- | --- |
| R-1a | **No off-server backup copy at a provider.** The job is built and tested against a stand-in (§11); no provider account, bucket or key exists | **High** | Needs the second provider (D-5) and its console checks (region, Object Lock, key rights) | Any data that matters |
| R-2 | Object store not chosen. Versioning, checksum contract and EU residency are unverified for every candidate (R2 was tested in ENAM only) | High | Gate P-1 needs a real bucket | Choosing the store (D-3) |
| R-5a | Key escrow (two offline holders, current and previous values, backup identities) is a procedure, not evidence | High | Organisational | First real data |
| R-6a | Alert delivery: the timer and delivery script are built and tested locally (§11); the heartbeat service, uptime check and the person paged do not exist | High | Needs outside accounts and the owner's choice of recipient | Users |
| R-7 | TLS undecided (D-2); direct TLS is prepared and tested with a local CA (§11), not issued | High | The owner's decision; then DNS, firewall and a real issuance on TEST. With Cloudflare, Cloudflare decrypts all traffic, possibly outside the EU (`hetzner-tls-decision.md` §2) | Exposure to the internet |
| R-12a | **No in-product reset of another person's MFA factor.** A person with a lost key and no recovery codes needs an operator to delete their enrolment row | Medium | A feature, not a configuration | Production |
| R-12b | No inventory of which MFA rows are under which key; previous sealing keys must be kept | Low | Counting needs every key in one process (ADR-0020 refuses that) | — |
| R-13 | `munaxa-docs-postgres` is now a leg of `publish-images.yml`, accepted by `verify-image.sh` (§11), but **nothing is published**: no image has a digest yet | Medium | Publishing is the owner's step (an `image/<sha>` tag) | TEST |
| R-8 | E-10: a quarantined deduplicated export needs an administrator | Medium | Unchanged | — |
| R-14 | Firewall, SSH, OS updates, rollback by digest, host rebuild: written (`hetzner-host-operations.md`), never performed | High | Needs a server | TEST, then production |
| R-15 | RTO unmeasured at real size; the drill's 4–5 s are for small databases on a laptop | Medium | Needs real data | Production |
| R-16 | Signature refresh and refusal tested offline only; a real mirror, its rate limits and clamd reload memory on the chosen server are unmeasured | Medium | Needs the server | Running longer than a day |

## 3. Local tests performed, and exact results

### 3.1 Automated suites (this revision)

| Suite | Result |
| --- | --- |
| API unit (vitest) | **87 files, 1077 tests passed** (isolated runs, three times). One `turbo run test` run made while the stack test loaded the machine reported **2 failed / 1075 passed**. Its truncated output did not name them, and three later isolated runs passed 1077/1077. Recorded as **unexplained under load**, not as passed |
| Web, domain, contracts, i18n, utils, worker unit | 555, 172, 63, 80, 48, 2 — all passed |
| Lint and typecheck (`turbo run lint typecheck`) | all tasks successful |
| Format (`prettier --check`) | clean |
| API integration (real PostgreSQL, MinIO, a real ICAP scanner) | The affected suites passed after each change: <ul><li>keys: 4 files, 149 tests;</li><li>storage, preview and document: 9 files, 220 tests;</li><li>storage and preview after the final change: 5 files, 103 tests.</li></ul> The full run is in §3.3 |
| `infra/hetzner/testing/backup/test-backup-scripts.sh` | **38/38**. Negative control (mutant image without the same-device and no-overwrite guards): 3 failures, as expected |
| `infra/antivirus/test-scanner-watch.sh` | **22/22** on the final image. Earlier runs failed 3, then 2, checks: <ul><li>fixed sleeps shorter than an offline freshclam's retries — the test was corrected to wait for the logged event;</li><li>the **fail-open** above, which was a real defect — the code was fixed.</li></ul> |
| ShellCheck (every new or changed script) and actionlint (the workflow) | clean |

### 3.2 The stack test with the backup drill

`run-stack-test.sh` with `EXTRA_CHECKS=testing/backup/backup-drill.sh`:

- **Images:** api and web built locally from this branch; the antivirus and PostgreSQL images
  built locally.
- **Backup volume:** its own tmpfs, so the same-device refusal was **on**.

| Run | Result |
| --- | --- |
| 1 | Did not reach the backups: the test MinIO image rebuild could not clone its source through this sandbox's proxy (environment). The script now reuses an existing image |
| 2 | Failed at drill step 1: a quoting defect in the drill's own SQL. Fixed |
| 3 | **All stack checks passed, every drill expectation held**: smoke 14/14, host check, unsafe settings refused 8/8, no credential (backup identity included) in 551 log lines. PITR 5 s, recovery to the end of the archive 4 s |
| 4 | After moving two test passwords out of `docker run` arguments: **all passed again**, 48 PASS lines, no failure |

### 3.3 Full integration run

The full API integration suite (real PostgreSQL, Redis, MinIO and the ICAP scanner) ran after the
last code change (`60dd4cc`): **58 files, 1310 tests, all passed**. The previous release's figure
was 1287; the difference is this remediation's new tests.

### 3.4 Commits

| Commit | Purpose |
| --- | --- |
| `22c78a2` | R-3, R-4, R-5: previous-key slots; MFA lost-key recovery; key-rotation runbook; ADR-0020 amendment |
| `d1104b8` | R-9: verified preview source reads; no store URL signed for reading; R-2 storage options |
| `364a59c` | R-11: health probes by position |
| `4785889` | R-10: signature refresh, staleness and refusal; the c-icap fail-open closed |
| `60dd4cc` | R-1 and R-6 template half: encrypted WAL archiving, `db-backup`, the drill, the host check, CI |
| (this report) | TLS decision note, host operations, this report |

## 4. What can only be validated in a hosted environment

1. Gate P-1 against the chosen store:
   - the checksum contract;
   - multipart;
   - versioning and restore of a prior version;
   - Object Lock;
   - lifecycle;
   - browser upload and verified download (Phase C).
2. EU residency of each provider and region, with a contract or DPA review (the owner's).
3. The off-server backup copy: write-only credentials, schedule, a restore **from** it.
4. TLS and the real client-address chain (sign-in rate limit, audit addresses).
5. The firewall seen from outside; SSH hardening; unattended upgrades.
6. The dead-man's switch, uptime check and notification delivery.
7. Mail delivery (SPF, DKIM, DMARC).
8. A rollback by digest and a host rebuild from backups (the first real RTO).
9. Load and memory on the chosen server size, with clamd's reload peak.
10. Signature refresh against real mirrors over days.

## 5. Decision pack for a disposable TEST environment

Prepared on 2026-10-15 from commit `4725053`, branch `claude/amazing-turing-09vlks`. At that point:

- the working tree was clean;
- CI and the Hetzner template workflow were green on that commit.

**Nothing in this section has been bought, created or called.**

**How facts are labelled:**

| Label | Meaning |
| --- | --- |
| **[official]** | Read on the provider's own pricing or documentation page on that date |
| **[third-party]** | Press, comparison sites or forum posts only |
| **[unverified]** | Not confirmed anywhere; must be checked in the console before ordering |

Prices exclude VAT.

The **legal question** (whether a given provider, its parent company's jurisdiction or a
sub-processor is acceptable) is the owner's, with a DPA review. The tables below give the technical
facts only.

### 5.1 Off-server backup destination (D-5, R-1a)

**What must be copied.** `DOCS_BACKUP_DIR` (base backups, `wal/`, dumps, each `.age` with its
`.sha256`) is already encrypted on the server with the `age` public keys. The private identities are
never on the server (R-1).

So the destination stores ciphertext only, and **client-side encryption and key management are
already solved and independent of the provider**. The copy is a one-way host sync (for example
`rclone copy`, never `sync`, so a deletion on the server is not propagated) on a timer.

**Requirements:**

- a different provider, account and failure domain from the server;
- an EU region;
- a credential that can add objects but cannot delete or overwrite history;
- versioning or Object Lock;
- a lifecycle rule that matches the 35-day retention;
- ordinary S3 or native reads, so a restore can be tested end to end.

| | **Backblaze B2, EU Central** | **Scaleway Object Storage** (`nl-ams` / `fr-par`) | Hetzner Storage Box BX11 | Hetzner Object Storage |
| --- | --- | --- | --- | --- |
| Failure domain | **Separate provider and account** | **Separate provider and account** | Same provider and billing account as the server | Same provider; can be a separate project, but the same account |
| EU region | EU Central (Amsterdam) [third-party]. Chosen at account creation, and the endpoint names it (`s3.eu-central-003…`) [unverified]. **Verify** in the console and the endpoint | Region chosen per bucket; `nl-ams`, `fr-par`, `pl-waw` [official] | FSN1 / HEL1 [third-party] | FSN1, NBG1, HEL1 [official] |
| Encryption in transit | HTTPS | HTTPS | SFTP / SSH | HTTPS |
| Encryption at rest | Server-side encryption available [unverified for the EU region]; irrelevant to confidentiality here because the objects are `age` ciphertext | As B2 | Provider-side [unverified] | As B2 |
| Credential scoping | Application key restricted to one bucket, with capabilities chosen one by one [official]. **Without `deleteFiles` and `bypassGovernance`** a key can add files and hide them, but cannot remove a version [official] | IAM policies per bucket [documented, not tested] | One account per box; sub-accounts per directory [third-party]. No append-only mode | Per-project S3 keys; per-bucket policy support [unverified] |
| Versioning / lock | Versioning always on; Object Lock offered [official]. **Availability of Object Lock in EU Central: [unverified]** | Versioning and Object Lock; Object Lock cannot be disabled once enabled [documented] | Snapshots (10 on BX11) [third-party]; a holder of the box credential can delete them | Versioning; Object Lock only at bucket creation [official] |
| Retention | Lifecycle rules per bucket [official] | Lifecycle rules [documented] | Manual | Lifecycle (expiry) [documented] |
| Fits the existing format | Yes: opaque files, unchanged names | Yes | Yes | Yes |
| Full restore and PITR testable | Yes: download a base backup plus `wal/` onto a fresh volume and run backup-and-restore.md §5.2 | Yes | Yes | Yes |
| Cost at TEST size (< 50 GB) | $6.95/TB/month, first 10 GB free; egress free up to 3× stored, then $0.01/GB; no minimum duration [official] → **under $0.50/month** | about €0.0146/GB/month Multi-AZ; requests included; 75 GB egress free [third-party] → **under €1/month** | about €3.20/month [third-party] | Covered by the object-storage base fee if that is bought anyway (§5.3) |

**Recommendation: Backblaze B2, EU Central, with Scaleway as the alternative.**

**Why B2:**

1. It is the only candidate whose append-only credential model is documented in its own words (a
   key without `deleteFiles` cannot destroy history).
2. It is a different company and account from Hetzner.
3. It is the cheapest at this size.

**Why not the Storage Box or Hetzner Object Storage:**

- A Hetzner account suspension, billing failure or compromise would take the server and its "off-server" copy together.
- The Storage Box has no write-only mode either.

**Verify before relying on B2:**

1. The account's region is EU Central.
2. Object Lock can be enabled on a bucket there.
3. The DPA and the sub-processors are acceptable (owner).
4. The free-tier and egress terms at the time of ordering.

If the EU region or Object Lock cannot be confirmed, use Scaleway `nl-ams` with versioning plus
Object Lock and a policy that denies `DeleteObject` / `DeleteObjectVersion` to the sync key.

**Not built yet (needs approval):**

- the sync unit and its timer (host-side, written after the account exists);
- a host-check signal for the age of the newest object off the server.

The design is in README.md §7 and does not change the template.

### 5.2 TLS and privacy (D-2, R-7)

`hetzner-tls-decision.md` holds the full option analysis. The task's three options map onto it as
follows:

- **A** here is that note's option C;
- **B** is its option B;
- **C** is its option A.

| | **A. Direct TLS on the host** (Caddy, ACME) | **B. Cloudflare proxied** | **C. Cloudflare Tunnel** |
| --- | --- | --- | --- |
| Where TLS ends | On the Hetzner server, inside Caddy | At a Cloudflare edge data centre; re-encrypted to the origin | At a Cloudflare edge data centre; carried to `cloudflared` on the server over the tunnel |
| Who can read documents and metadata in clear | Only the server | **Cloudflare**, at whichever edge location serves the visitor: contents, file names, URLs, cookies, IP addresses | **Cloudflare**, as in B |
| Residency to verify | Only the server's location (DE/FI, chosen at ordering) | Where Cloudflare decrypts. Regional Services limits decryption to a region [official], but **the plan it requires is unverified** (believed Enterprise). Without it, a visitor's request may be decrypted outside the EU | As B |
| Certificates | Caddy obtains and renews (Let's Encrypt), and must keep its state on a volume | Cloudflare edge certificate plus an origin certificate (15-year validity) | Cloudflare edge only |
| DDoS protection | Hetzner's network-level DDoS protection only [official, scope unverified]; no WAF or CDN | Cloudflare's | Cloudflare's |
| Origin exposure | Public IP, ports 80 and 443 open | Public IP; 443 open to Cloudflare's ranges only | **No inbound port** except SSH |
| Firewall | 80 and 443 from anywhere; 22 from named addresses | 443 from Cloudflare's published list, which must be kept current | Inbound 22 only |
| Client IP | The TCP peer; nothing to trust | `CF-Connecting-IP` from trusted ranges (G-5, untested) | `CF-Connecting-IP` from `cloudflared` (G-5, untested) |
| Template changes | Caddyfile site address, `auto_https` on, publish 80/443, **a persistent volume for `/data`** (today `/data` is tmpfs, so certificates would be re-issued on every restart and could hit Let's Encrypt limits) | `trusted_proxies` and an origin certificate; publish 443 | A `cloudflared` service on the edge network; `trusted_proxies` |
| Failure modes | ACME failure leaves the old certificate valid for weeks; renewal checked by the host check (certificate expiry within 14 days) | Cloudflare outage or misconfiguration; range-list drift | Tunnel or `cloudflared` outage; token compromise |
| Cost | €0 | €0 (Free plan) [official]; Regional Services extra [unverified] | €0 [official] |

**Recommendation: A, direct TLS on the host**, because it is the simplest option that meets
the requirement.

- **It meets the requirement.** Documents are decrypted only on the EU server. There is no
  intermediary, so no residency claim depends on a third party's routing, and no G-5
  header-trust chain needs testing.
- **The trade-off: no CDN-level WAF or DDoS absorption.** For a disposable TEST with
  synthetic data that is acceptable.
- **For production**, the choice can be revisited once the Regional Services plan question
  is answered. Without it, B and C have no EU-only decryption guarantee.

**Changes needed after approval** (deployment configuration only; no application code):

1. A Caddyfile variant with the TEST host name and `auto_https` on.
2. A named volume for Caddy's `/data`.
3. Ports 80 and 443 published on the server's address instead of `127.0.0.1:8080`.

None is made in this revision because D-2 is not yet accepted. They belong to the same change as
the TEST `deploy.env`.

### 5.3 Object storage for documents (D-3, R-2)

| | **Hetzner Object Storage** | **Scaleway** | **Cloudflare R2** |
| --- | --- | --- | --- |
| Region evidence | FSN1, NBG1, HEL1 [official]; no other placement | `fr-par`, `nl-ams`, `pl-waw` [official] | EU jurisdiction bucket on a separate endpoint [official]. **The only bucket tested was in ENAM, which is not EU evidence** |
| Versioning | Yes [official] | Yes [documented] | **S3 versioning not implemented** [official compatibility table]; bucket locks only |
| Object Lock | At bucket creation only [official] | Can be enabled later, never disabled [documented] | Bucket locks (retention rules) [official] |
| Checksums (upload and download) | **Unknown**: gate P-1 | **Unknown**: P-1 | Partially tested in ENAM |
| Multipart / large objects | S3 multipart [documented]; limits unverified | S3 multipart [documented] | Tested in ENAM |
| Private access and keys | Private by default; keys per project [official] | IAM [documented] | Scoped API tokens [official] |
| Fits verified delivery, quarantine and integrity | Expected to: the API never signs a read URL, reads through `readVerifiedSource` and checks size plus SHA-256 itself (R-9), so the store is trusted for durability only. P-1 confirms it | Same | Same |
| Cost at TEST size | Base fee about **€4.99/month**, including 1 TB stored and 1 TB egress [third-party; the official page shows the inclusions but the figure did not render]. Billed while any bucket exists | Under €1/month [third-party] | $0.015/GB/month; Class A and B per request [official, check the current page] |

**Recommendation: Hetzner Object Storage first, in a separate project, with versioning and
Object Lock enabled at bucket creation. Scaleway is the fallback.**

Why Hetzner:

- an official EU location list;
- documented versioning;
- no third-party decryption question.

The verified-read design limits what depends on the store: integrity is the API's own check.

**R2 is not recommended.** Its EU evidence is untested, and it lacks versioning, so the recovery
of an overwritten or deleted object would rest on bucket locks alone.

**The store is accepted only when gate P-1 passes on it** (§6, G-7).

### 5.4 TEST resource plan

| Area | Plan |
| --- | --- |
| Server | **CX33** (shared x86, 4 vCPU, 8 GB, 80 GB disk) at FSN1 or NBG1, Ubuntu 24.04 LTS. **x86 is required**: every image is `linux/amd64` only, so the ARM CAX line does not fit. **If CX is not orderable** (hetzner.com showed "Currently not available" for a shared-resources line on 2026-10-15), use **CPX32**. Do not size down to 4 GB: the template's ceilings total about 7.2 GB, and clamd needs about 2.4 GB during a reload |
| Headroom | CPU: 4 vCPU for a single-user TEST. Memory: about 3–4 GB used at rest (clamd about 1.2 GB), so 8 GB leaves room for the reload. Disk: the root disk holds images (about 5 GB) and `postgres-data`; the backup directory is on its own volume |
| Volumes | **One 50 GB Hetzner Volume** mounted at `DOCS_BACKUP_DIR`. The writers refuse the database's filesystem (R-1), so it must be a separate device |
| Placement | All services on the one host as in `compose.yaml`. PostgreSQL, Redis and the scanner stay on the `internal: true` networks with no published port |
| Network and firewall | Hetzner Cloud Firewall: inbound TCP 22 from the administrators' named addresses only; TCP 80 and 443 from anywhere (option A); everything else denied. Outbound open (images, ACME, ClamAV mirrors, object store, B2, heartbeat) |
| SSH and admin | Ed25519 keys, one named sudo account per administrator, no root or password log-in (host-operations §2). Rescue console as break-glass |
| TLS and public endpoints | One host name (D-8) with an A/AAAA record to the server; `/api/health*` and `/api/metrics` stay 404 from outside (already enforced by the Caddyfile) |
| Object storage | One Hetzner Object Storage bucket, private, versioning and Object Lock on, in a **separate** Hetzner project with its own keys |
| Off-server backup | One B2 bucket in EU Central, Object Lock if available, lifecycle 35 days plus a margin. One application key scoped to that bucket, without `deleteFiles` or `bypassGovernance`, in `/etc/munaxa-docs/offsite.env` (0600) |
| Monitoring and alerts | `host-check.sh` on a 5-minute systemd timer. A free-tier dead-man's switch pinged only on success (e.g. Healthchecks.io [plan terms unverified]) and an external uptime check on `/`, both alerting a named person by e-mail or push |
| Images, deploy, rollback | A `deploy.env` naming api, web and antivirus by `@sha256:` digest from `publish-images.yml`, and Caddy and Redis by digest. `munaxa-docs-postgres` built from the release checkout with its image ID recorded (R-13). Release and rollback per host-operations §5 |
| Secrets | Generated on the server with `openssl rand -hex 32` into `/etc/munaxa-docs` (0700/0600), copied to the password manager. The `age` identities are generated off the server and held by two people. **TEST secrets are new and never reused for production** |
| Data | Synthetic tenants and documents only. **No production data, no real personal data** |
| Retention and cleanup | Backups 35 days (R-1); the B2 lifecycle matches. At the end of TEST, delete in this order: server, volume, snapshots, primary IP, firewall, buckets (after the lock expires), B2 key and bucket, heartbeat and uptime checks, DNS record. Record each deletion |

### 5.5 Monthly cost estimate

Running continuously; EUR per month before VAT.

| Item | CX33 path | CPX32 fallback | Basis |
| --- | --- | --- | --- |
| Server | €8.49 | €35.49 | [official], Hetzner price-adjustment page, effective 15 June 2026, DE/FI. CX availability [unverified]; a third-party report gives CX33 as €8.99 after a later change [third-party] |
| Primary IPv4 | €0.50 | €0.50 | [third-party] |
| Volume, 50 GB | about €2.50–3 | same | about $0.12/GB after April 2026 [third-party] |
| Snapshot before teardown or rebuild (optional) | about €1 | about €1 | per-GB snapshot price [unverified] |
| Object Storage base fee | €4.99 | €4.99 | [third-party] (the official page lists what is included, not the amount) |
| B2 off-server copy, under 50 GB | under €0.50 | same | [official] B2 price list |
| Traffic | €0 | €0 | Included server traffic and 1 TB object egress far exceed TEST use [included volumes unverified] |
| Monitoring, uptime, ACME certificates | €0 | €0 | free tiers [plan terms unverified]; Let's Encrypt is free |
| Hetzner server backups | not used | not used | +20 % of the server price; our backups do not depend on them |
| **Total** | **about €17–19** | **about €44–46** | |

**Effort: 2–4 working days, unchanged.** Hetzner Cloud bills hourly, so a TEST torn down
after a week costs a fraction of the monthly figure. But the object-storage base fee and the volume
bill while they exist.

**Suggested ceiling: €60 per month for TEST**, with alerts at €30 (Hetzner and B2 both
support usage alerts [unverified]).

**What could exceed it:**

- **CX unavailable, forcing CPX32.** Still under the ceiling.
- **Upgrading to a dedicated-vCPU server.** CCX23 at €85.99 [official] would exceed it.
  Approve separately.
- **Hetzner's server backups**, if enabled. They are not needed.
- **Snapshots left behind** after TEST.
- **A second Object Storage location or project.** The base fee is per account and the
  details are [unverified].
- **Large synthetic uploads or load tests** pushing egress past the included volumes.
- **Forgetting to delete** the bucket or the volume.

## 6. Readiness and recovery gates (before and on TEST)

**What each column means:**

- **"Local"** says what has already been shown on a workstation or in CI, with no hosted
  resource.
- **"Hosted evidence required"** must be produced on TEST and attached to this report before
  any data that matters (and, for G-1 to G-3, before PRE-PROD).
- **Evidence** means command output or a console screenshot with a timestamp. A statement is
  not evidence.

| Gate | Local (already shown) | Hosted evidence required |
| --- | --- | --- |
| G-1 Off-server backup configured | Encrypted WAL, base backups and dumps; same-device refusal; 38/38 script tests. The copy job against a MinIO stand-in: 57/57, including a credential refused a delete (§11) | The B2 bucket: region shown in the console; lock and versioning settings; key capabilities listed (no `deleteFiles`, no `bypassGovernance`); one sync run; an attempted delete with the key **refused** |
| G-2 Restore from the off-server copy | Restore from the local volume (drill); `offsite fetch` from the stand-in remote alone, every byte checked, then PITR from it (drill step 6, §11) | On a scratch volume on the TEST server or a second throwaway server: download from B2 only, check `.sha256`, decrypt with an escrowed identity, restore the base and replay the WAL |
| G-3 PITR | Shown in the drill (stopped before transaction 1056 at the target time), from the local volume and from the fetched off-server copy | The same, from the B2 copy, to a recorded target time, with a change before and after the target |
| G-4 Tenant isolation and audit chain after restore | Shown in the drill (RLS forced, `edms_app` isolated, chain verified from genesis) | The drill's checks run against the cluster restored in G-2 and G-3 |
| G-5 TLS and privacy decision accepted | Direct TLS with a local CA: routing, redirect, HSTS, the certificate's name, persistence (19/19, §11) | D-2 signed off by the owner; certificate issued and renewed (`caddy` logs); SSL Labs-style check; HTTP→HTTPS redirect; `/api/health` 404 from outside; the sign-in rate limit sees distinct client addresses |
| G-6 EU region verified | — | Console screenshots of the server location, the object-store location and the B2 region; the owner's DPA review recorded |
| G-7 Object recovery and integrity (P-1) | Verified reads, quarantine on mismatch, missing object, store errors (R-9 tests against MinIO); the storage readiness check against MinIO, 30/30, and its control (§11) | P-1 against the chosen store: checksum on upload and download; multipart; overwrite then restore the prior version; delete then restore; Object Lock refusal; a browser upload and a verified download end to end |
| G-8 Monitoring and alert delivery | `host-check.sh` healthy, with a forced finding, and with a stopped store, a failed copy and stale signatures (stack test); delivery against a local receiver, 20/20 (§11) | A forced finding pages a named person; stopping the heartbeat pages within its grace period; the uptime check fires when the proxy is stopped |
| G-9 Scanner health and refresh | 22/22 offline (refresh failure, staleness, refusal, restart, fail-open guard) | `freshclam` succeeding against real mirrors over at least 3 days; peak memory during a reload on the chosen server; EICAR refused through the product |
| G-10 Deploy and rollback by digest | `migrate` and `up` (stack test); `check-deploy-env.sh` refuses tags, placeholders and secrets (20/20, §11); the PostgreSQL image accepted by `verify-image.sh` | One release by digest with `RepoDigests` checked; one code-only rollback to the previous `deploy.env`; timings recorded |
| G-11 Firewall and SSH | — | A port scan from outside shows only 22 (from the allowed address), 80 and 443; password and root log-in refused; `unattended-upgrades` active |
| G-12 Cost and ceiling accepted | — | The owner's approval of §5.5 and the ceiling; billing alerts configured |

ADR-0026 stays **Proposed** until these gates pass and their evidence has been reviewed.

## 7. Test-deployment checklist

### 7.1 Decisions only the owner can take (needed before anything is created)

- [ ] **D-6:** spending approved, ceiling €60 per month (§5.5).
- [ ] **D-7:** CX33, or CPX32 if CX is unavailable; FSN1 or NBG1; Ubuntu 24.04 LTS.
- [ ] **D-2:** direct TLS on the host (§5.2's option A; option C in `hetzner-tls-decision.md`, the
      ADR and the template files), or another option with its residency question answered.
- [ ] **D-3 (provisional):** Hetzner Object Storage in a separate project (§5.3).
- [ ] **D-5:** Backblaze B2 EU Central, or Scaleway (§5.1).
- [ ] **D-8:** the TEST host name.
- [ ] The two holders of the backup `age` identities and of the escrow.
- [ ] The person who receives the alerts.

### 7.2 Ready in the repository (verified locally)

- [x] Encrypted WAL archiving, base backups and per-tenant dumps; PITR and a tenant restore drilled.
- [x] Previous-key slots for all three long-lived keys; MFA recoverable with recovery codes after a
      key loss.
- [x] Verified reads everywhere; no store URL signed for reading.
- [x] Scanner refresh, staleness and refusal; the fail-open closed.
- [x] Health endpoints without tenant names; the host check.
- [x] Procedures: backup and restore §5, key rotation, monitoring, host operations, TLS options.

### 7.3 Repository changes before provisioning (done in the fourth revision, §11)

- [x] Direct TLS: `compose.tls.yaml`, `Caddyfile.tls`, persistent `/data`, ports 80 and 443 only.
- [x] The off-server copy, its timer, and host-check signals for it.
- [x] The host-check and alert-delivery units (`ops/monitor.sh`, `ops/systemd/`).
- [x] `deploy.test.env.example` with digest placeholders; `munaxa-docs-postgres` added to
      `publish-images.yml` (not published).
- [ ] Publishing the four images for the commit chosen for TEST (an `image/<sha>` tag) — the
      owner's step; then the digests go into the TEST `deploy.env`.

### 7.4 On TEST (gates in §6)

- [ ] G-6, G-11, G-12 (location, firewall, SSH, billing alerts) — first.
- [ ] G-10 deploy by digest; then G-5 TLS.
- [ ] G-7 P-1 on the store.
- [ ] G-1, then G-2, G-3, G-4 from the off-server copy.
- [ ] G-8 alert delivery; G-9 scanner over days.
- [ ] One host rebuild from the off-server copy, timed (the first RTO, R-15).

## 8. Actions that would create billable resources

None of these has been taken. Each needs the owner's explicit authorization.

1. Creating the Hetzner Cloud server: hourly billing starts.
2. Creating a primary IPv4: it bills while allocated, even when detached.
3. Creating the 50 GB Volume.
4. Enabling Hetzner server backups, or taking snapshots.
5. Creating any bucket in Hetzner Object Storage: the monthly base fee starts.
6. Creating the B2 (or Scaleway) bucket and storing data in it.
7. Paid tiers of monitoring, uptime or mail services. The plan uses free tiers only.
8. Registering a new domain. The plan uses a sub-domain of the existing one: a DNS record only,
   with no charge [unverified for the registrar].

**Not billable, but outward-facing (also need authorization):**

- the DNS record;
- the firewall;
- SSH keys on the server;
- B2 and object-store API keys;
- the heartbeat and uptime accounts.

## 9. Steps after approval (not performed)

In this order, each recorded in this report with its evidence:

1. **Accounts and limits.** In the Hetzner Console:
   - create a dedicated TEST project;
   - set a billing alert.

   In Backblaze, create (or confirm) an EU Central account and set a usage cap.
2. **Repository changes** in §7.3, reviewed and merged by the owner's normal process. Then pull the
   images and record their digests.
3. **Provision:**
   - the firewall (§5.4);
   - the server with the administrators' SSH keys;
   - the volume, formatted and mounted at `DOCS_BACKUP_DIR`;
   - the DNS A/AAAA record.
4. **Host set-up** (host-operations §2–§3):
   - the named accounts, sshd hardening and `unattended-upgrades`;
   - Docker Engine from Docker's repository.
5. **Secrets:**
   - generate into `/etc/munaxa-docs`;
   - put the `age` public keys in `backup.env`, with the identities generated off the server;
   - write the B2 key to `offsite.env`;
   - copy everything to the password manager.
6. **Object store:**
   - create the bucket with versioning and Object Lock;
   - create its keys and put them in `api.env`;
   - run gate P-1.
7. **Deploy** (host-operations §5, `C="docker compose --env-file deploy.env -f infra/hetzner/compose.yaml"`):

   ```
   $C pull
   $C --profile ops run --rm migrate
   $C up -d
   infra/hetzner/ops/host-check.sh
   ```

   Then create each synthetic tenant's first administrator with the `provision` service, by
   infra/hetzner/README.md §4 (one tenant per run, `provision.env` deleted afterwards).

8. **Backups:**
   - `$C exec db-backup munaxa-backup once`;
   - start the off-server sync timer;
   - then gates G-1 to G-4.
9. **Monitoring:** the timers and the heartbeat, then gate G-8.
10. **Rollback and rebuild:** G-10 and the rebuild rehearsal.

## 10. Sources (read 2026-10-15)

- Hetzner Cloud price adjustment (official, server prices from 15 June 2026):
  https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- Hetzner Object Storage product page (official, inclusions, locations, versioning, Object Lock):
  https://www.hetzner.com/storage/object-storage/
- Hetzner Cloud page ("Currently not available" for a shared-resources line):
  https://www.hetzner.com/cloud/
- Backblaze B2 pricing (official): https://www.backblaze.com/cloud-storage/pricing
- Backblaze application key capabilities (official):
  https://www.backblaze.com/docs/cloud-storage-application-key-capabilities
- Third-party price reports (Object Storage base fee, IPv4, volume):
  - https://heise.de/-10189226
  - https://findstack.com/resources/hetzner-price-increase-2026
  - https://docs.elest.io/books/announcement/page/hetzner-price-change-notice-effective-april-1st
  - https://privatedevops.com/news/hetzner-june-2026-cloud-price-increase-what-to-do
- Earlier sources on Scaleway, R2 and Cloudflare Regional Services:
  - `hetzner-object-storage-options.md`;
  - `hetzner-tls-decision.md`.

## 11. Pre-provisioning implementation and verification (fourth revision)

What the repository needed before a TEST server is created, built and verified **locally only**.
Nothing was provisioned, bought, published, issued or called: no Hetzner, Backblaze, Scaleway,
Cloudflare, DNS or AWS request was made, no bucket or key exists, no certificate was issued, no
image was pushed. ADR-0026 stays **Proposed**.

Starting point: `59b0e26` (Markdown only, so neither workflow ran on it; both were green on the last
code commit `4725053`). Working tree clean.

### 11.1 Changes and commits

| Commit | What |
| --- | --- |
| `15941ff` | **Direct TLS and the deploy.env pre-flight.** The routing rules move to `caddy/routes.caddy`, imported by the plain `Caddyfile` and by the new `Caddyfile.tls` (automatic HTTPS for `DOCS_PUBLIC_HOSTNAME`, HTTP→HTTPS, HSTS, h1/h2, admin off). `compose.tls.yaml` publishes only 80 and 443, puts Caddy's `/data` on a volume, and refuses to start without a host name or ACME contact. `ops/check-deploy-env.sh` refuses tags instead of digests, placeholders, secrets in `deploy.env`, fewer than two backup recipients, a public plain-HTTP listener, and an address, `localhost` or example host name. `deploy.test.env.example` is the TEST file, every value a required placeholder |
| `a00ed5a` | **The off-server copy** (R-1a). `offsite/offsite.sh` in the new `offsite` service (profile `ops`, pinned rclone image, uid 70, read-only root and backup volume, own egress network): copies ciphertext only, never deletes or overwrites, reads every new file back (size, the provider's MD5 when it has one, SHA-256 by download), records verified files in run manifests, marks a backup `COMPLETE` only when all its files verified, checks every run that the remote answers and holds the newest complete backup, one run at a time, and `fetch` recovers from the remote alone with every byte checked. The drill gains step 6: PITR from the fetched copy. Procedure, retention and failure handling in backup-and-restore.md §5.5 |
| `ce160b2` | **Monitoring and alert delivery** (R-6a). `host-check.sh` adds Docker and expected services, `pg_isready`, the off-server copy, a read-only object-store listing through the API's adapter, log-derived counts (quarantine, audit chain, scanner refusal, fail-open guard), signature age, and the TLS certificate. `ops/monitor.sh` runs it and pings the heartbeat or sends the filtered finding lines; `ops/systemd/` holds the two timers. The stack test now stops the store, fails a copy and ages the signatures, and requires each to be named and then to clear |
| `2cfef42` | **Images, storage readiness, CI** (R-13, R-2). `munaxa-docs-postgres` becomes the fourth leg of `publish-images.yml`, accepted by `postgres/verify-image.sh` before the push and again on the pulled digest (the workflow runs only for an `image/<sha>` tag: nothing was published). `testing/storage/` asks a store, through the product's adapter, everything the verified reads and recovery depend on. `hetzner-template.yml` runs every new test. README, host operations, TLS and storage notes updated |
| (this report) | §2, §6, §7 and this section |

**Defects found and fixed during this work** (none in the application):

1. The copy job's first version reported success with the remote stopped when it had nothing new
   to send — found by the stack test's new outage step. Every run now checks the remote; a test
   case covers it.
2. `grep -q` at the end of a pipeline under `pipefail` could make a complete backup look
   incomplete when grep exited before rclone finished writing (seen once as a missing dump set
   in a fetch). Fixed by letting grep read to the end; three repeat runs passed.
3. The host check's default `deploy.env` path pointed into `infra/hetzner/` while the
   documentation puts the file at the checkout's root. Fixed.

### 11.2 Tests run, and exact results

All on this workstation; Docker 29.8.2, Compose v5.6.0. "Runs" counts complete runs after the
last change to the file under test.

| Test | Result |
| --- | --- |
| `testing/offsite/test-offsite.sh` (MinIO stand-in, versioned bucket, a no-delete key) | **57/57.** Earlier versions: 56/56 three times in a row after the pipefail fix; before it, one run with 3 failures (the race, then two test-script bugs: `grep -q` under pipefail and `mc ls` prefix matching) |
| `testing/monitoring/test-monitor.sh` (local receiver) | **20/20**, first run. Negative control (the character filter removed): the hostile-text check fails, as it must |
| `testing/deploy/test-check-deploy-env.sh` | **20/20**: a complete TEST file passes; 16 kinds of mistake refused by name; values never printed; both shipped examples refused |
| `testing/tls/test-tls.sh` (Caddy's local CA; nothing published on the host) | **19/19**, three runs. The first run failed one check of the test's own (how curl prints certificate names) |
| `testing/storage/run-storage-readiness.sh` (MinIO, versioning + Object Lock, a scoped key, a second bucket) | **30/30**, two runs (after: the part size set to the 5 MiB minimum so multipart is really exercised; the Object Lock refusal judged by the version surviving, since MinIO answers 400 where S3 answers 403). Control without versioning or lock: 21 PASS, 2 UNSUPPORTED, exit 0; the same expecting them: 2 FAIL, exit 1 |
| `postgres/verify-image.sh munaxa-docs-postgres:local` | **8/8** (after correcting the expected `age --version` string) |
| `systemd-analyze verify` (the four units, in a scratch root holding the checkout's paths) | no errors |
| ShellCheck (warning level, the repository's bar), every new or changed script | clean |
| actionlint | `hetzner-template.yml` clean; `publish-images.yml`: the same four style/info notes as at `59b0e26`, none new |
| `pnpm format:check` | clean |
| Stack test with the backup drill (`run-stack-test.sh`, backup volume on its own tmpfs so the same-device refusal is ON) | Run 1 **failed**, at the new outage step: it found defect 1 above. After the fix, run 2: **all stack checks passed, 66 PASS lines, no FAIL** — smoke 14/14; the off-server copy (17 files verified, base backup and dump set `COMPLETE`); the host check healthy, with a crossed limit, and with the store stopped, a copy failed and signatures 100 h old (three findings named, then cleared); unsafe settings refused 8/8; no credential (the off-server key included) in 571 log lines. The drill: PITR stopped "before commit of transaction 1062" at the target in 4 s; end of archive 3 s; the dump restore; and **step 6: base backup, 8 WAL files and the dump set fetched from the stand-in remote alone in 4 s, every byte matched, then PITR from that copy in 4 s with all 15 checks held** (changes A/B, each database identical at the target, RLS forced, `edms_app` isolated, audit chain from genesis). Laptop timings, not an RTO |

**Not re-run, because no application, migration or package code changed in this revision**
(every change is under `infra/hetzner/`, `.github/workflows/` and `docs/`): the API, web, domain,
contracts, i18n, utils and worker unit suites, lint and typecheck, the integration suite and the
migration tests. Their last results are in §3 (`4725053`'s CI and the full integration run of
58 files and 1310 tests).

### 11.3 What is now verified locally

- The off-server copy's behaviour: no deletion, no overwrite, verification by read-back, partial
  and interrupted uploads never treated as recovery points, duplicate runs, outages with and
  without new files, a damaged local file refused, recovery by `fetch`, and a **point-in-time
  recovery of the stack's cluster from the fetched copy alone**, with RLS, isolation and the audit
  chain checked (drill step 6).
- Monitoring: every check of `host-check.sh` on a healthy stack and on three real failures, and
  alert delivery with its refusals, filtering and failure reporting.
- Direct TLS: the configuration, the rendered ports and private networks, routing, the redirect,
  HSTS, the certificate's name, the token kept out of the access log, and certificate persistence.
- Storage readiness: every check against MinIO, and that it tells a capable bucket from one without
  versioning or Object Lock.
- The deploy.env pre-flight and the PostgreSQL image acceptance.

**None of this is evidence about any provider.** MinIO stood in for Backblaze B2 and Hetzner Object
Storage; Caddy's local CA stood in for Let's Encrypt; a local receiver stood in for the heartbeat
service.

### 11.4 What still requires the provider console or the TEST environment

| Item | Where |
| --- | --- |
| B2 (or Scaleway): account region EU Central confirmed; Object Lock available there; the key's capabilities (no `deleteFiles`, no `bypassGovernance`); lifecycle rule; then G-1, G-2, G-3 from it | Provider console, then TEST |
| Hetzner Object Storage: location, versioning and Object Lock set at bucket creation; `run-storage-readiness.sh` with `STORAGE_TEST_EXPECT_VERSIONING=1`, `STORAGE_TEST_EXPECT_OBJECT_LOCK=1` and a second bucket; the stack test against it (P-1); the checksum contract | Console, then TEST |
| A real Let's Encrypt issuance (staging first) and renewal; DNS; the firewall seen from outside; client addresses reaching the rate limit (G-5, G-11) | TEST |
| The heartbeat service, the uptime check, the person paged; a forced finding reaching them (G-8) | Monitoring service, TEST |
| The timers running under systemd; log rotation | TEST |
| Publishing the four images and deploying by digest; a rollback; a host rebuild with timings (G-10, R-14, R-15) | GitHub (owner), TEST |
| Scanner refresh against real mirrors over days, clamd reload memory (G-9, R-16) | TEST |
| EU residency and the DPA review (G-6) | Owner |

### 11.5 Decisions and values the owner must supply

**Decisions:** D-2 (direct TLS), D-3 (Hetzner Object Storage), D-5 (B2 EU Central or Scaleway),
D-6 (spending, ceiling €60/month), D-7 (CX33 or CPX32; FSN1 or NBG1; Ubuntu 24.04), D-8 (the TEST
host name), the commit to publish for TEST, and how TEST sends mail (a sink or a restricted relay).

**Values** (every one is a placeholder in the repository today; none was invented):

| Value | Goes into |
| --- | --- |
| `DOCS_PUBLIC_HOSTNAME`, `DOCS_ACME_EMAIL` | `deploy.env` |
| The four release digests, and the Caddy and Redis digests | `deploy.env` (after the `image/<sha>` tag runs) |
| Two `age` public keys, from two named holders; the identities offline in escrow | `deploy.env` (public keys only) |
| B2/Scaleway endpoint, region, bucket, restricted key id and secret | `offsite.env` |
| Hetzner Object Storage endpoint, region, bucket, key id and secret | `api.env`; the readiness file |
| `HEARTBEAT_URL`, `ALERT_CONTACT` (and optionally `HEARTBEAT_FAIL_URL`, `ALERT_WEBHOOK_URL`); the uptime check of `/login` | `monitoring.env`; the monitoring service |
| Administrators' SSH public keys and source addresses | the server and the Hetzner Cloud Firewall |
| A read-only GHCR pull identity (`DOCS_PRODUCTION_PULL_USER`/`_TOKEN`) if the images stay private | repository secrets; the server's Docker login |
| Mail settings for TEST | `api.env` |

### 11.6 Resources and cost for the later, separately authorized provisioning step

Unchanged from §5.4–§5.5; nothing in this revision adds a billable resource (rclone, Caddy and the
timers run on the same server).

| Resource | Monthly (excl. VAT) | Basis |
| --- | --- | --- |
| Hetzner CX33 (4 vCPU, 8 GB, 80 GB), FSN1 or NBG1 — or CPX32 if CX cannot be ordered | €8.49 — or €35.49 | official price page, June 2026; availability unverified |
| Primary IPv4 | about €0.50 | third-party |
| Hetzner Volume, 50 GB (the backup volume) | about €2.50–3 | third-party |
| Hetzner Object Storage, one bucket (base fee, 1 TB and 1 TB egress included) | about €4.99 | third-party |
| Backblaze B2 EU Central, under 50 GB, plus the read-back verification (egress free up to 3× stored) | under €0.50 | official price list; EU region unverified |
| Monitoring and uptime (free tiers), Let's Encrypt | €0 | plan terms unverified |
| **Total** | **about €17–19 (CX33) or €44–46 (CPX32)**; suggested ceiling **€60**, alerts at €30 | |

Effort to provision and pass the gates: 2–4 working days, as before. **Nothing is created until the
owner authorizes it.**
