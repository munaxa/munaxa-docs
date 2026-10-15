# Readiness for a controlled Hetzner test deployment

- **Status:** assessment and local remediation only.
  - **Nothing has been deployed to Hetzner.** No cloud resource, DNS record, bucket or cost was
    created; no secret was rotated; no image was published.
  - ADR-0026 stays **Proposed**.
  - This is **not** a statement of production readiness.
- **Date:** 2026-10-15 (second revision, after the pre-deployment remediation).
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
| R-1a | **No off-server backup copy.** The backup volume is on the same server and provider as the database | **High** | Needs a second provider and credentials: a hosted step. The design is a host sync of the already-encrypted volume (README.md §7) | Any data that matters |
| R-2 | Object store not chosen. Versioning, checksum contract and EU residency are unverified for every candidate (R2 was tested in ENAM only) | High | Gate P-1 needs a real bucket | Choosing the store (D-3) |
| R-5a | Key escrow (two offline holders, current and previous values, backup identities) is a procedure, not evidence | High | Organisational | First real data |
| R-6a | Alert delivery (timer, dead-man's switch, uptime check, notifications) not built | High | Needs outside accounts | Users |
| R-7 | TLS undecided, and with it the client-address chain (G-5) | High | **New consideration:** with Cloudflare (A, B), Cloudflare decrypts all traffic, documents included, possibly outside the EU (`hetzner-tls-decision.md` §2) | Exposure to the internet |
| R-12a | **No in-product reset of another person's MFA factor.** A person with a lost key and no recovery codes needs an operator to delete their enrolment row | Medium | A feature, not a configuration | Production |
| R-12b | No inventory of which MFA rows are under which key; previous sealing keys must be kept | Low | Counting needs every key in one process (ADR-0020 refuses that) | — |
| R-13 | `munaxa-docs-postgres` is not in `publish-images.yml`, so a TEST deployment cannot be reproduced from a published digest | Medium | Changing the publishing workflow is a release decision | TEST |
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

The full API integration suite on the local services, after the last code change, was still running
when this revision was committed. Its result is recorded in the commit that follows.

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

## 5. Proposed TEST architecture, and cost estimate

**One server, the template unchanged:**

| Component | Proposal |
| --- | --- |
| Server | Shared x86, 4 vCPU / 8 GB / 80 GB, Germany (Falkenstein or Nuremberg). The template's memory limits add up to about 7.2 GB but are ceilings: measured use is far lower apart from clamd (about 1.2 GB, twice that while reloading) |
| Backup volume | A Hetzner Volume, 50 GB, mounted for `DOCS_BACKUP_DIR` |
| Object storage | Per `hetzner-object-storage-options.md` §5: Hetzner Object Storage first, in a separate project, with versioning and Object Lock |
| Off-server copy | A bucket at a different provider, written by a host timer |
| TLS | Per `hetzner-tls-decision.md`, after the owner's answer on §2 there |
| Monitoring | A heartbeat and uptime service on a free tier; `host-check.sh` on a 5-minute timer |
| Mail | A sink or restricted sender for TEST |

**Recurring cost [estimate; every figure to be confirmed in the providers' consoles before
authorization].**

- Hetzner repriced its cloud servers in April and again in June 2026. Third-party reports of the
  new prices disagree, so the ranges are wide.
- EUR per month, before VAT.

| Item | Estimate | Basis |
| --- | --- | --- |
| Server, 4 vCPU / 8 GB shared x86 | €10–16 | ADR-0026's €7–10, plus the 2026 increases reported for that class (about +30 % and +37 %) |
| Primary IPv4 | €0.5–1 | — |
| Volume, 50 GB | €2–4 | per-GB volume pricing [verify] |
| Object storage (Hetzner base fee, 1 TB and 1 TB egress included) | €5–6.5 | product page (amount not shown there) and press or third-party figures, which conflict |
| Off-server copy at a second provider | €0–5 | free tiers or a small bucket |
| Monitoring, uptime, TLS (option A or C), mail sink | €0 | free tiers |
| Hetzner server backups (optional; not a backup in our sense) | +20 % of the server | — |
| **TEST total, running continuously** | **about €18–33 per month** | Servers bill hourly, but the volume and the object-storage base fee bill while they exist |

**One-time:**

- No provider set-up fee is known [verify].
- The domain already exists.
- The one-time cost is effort, **estimated at 2–4 working days**: provisioning, the firewall,
  P-1, the off-server copy, monitoring delivery, a rollback and a restore rehearsal.

## 6. Checklist for authorizing a disposable Hetzner TEST environment

**Decisions only the owner can take:**

- [ ] D-6: spending approved for the items in §5, with a monthly ceiling.
- [ ] D-7: server size and location.
- [ ] D-3 (provisional): the object store to test first, in a **separate** Hetzner project.
- [ ] D-2: TLS option, after answering `hetzner-tls-decision.md` §2 (termination by a third party
      outside the EU, acceptable or not).
- [ ] D-5: the provider for the off-server backup copy.
- [ ] D-8: the TEST host name.
- [ ] Who holds the two backup `age` identities and the key escrow (key-rotation.md §5).

**Ready in the repository (verified locally):**

- [x] Encrypted WAL archiving, base backups and per-tenant dumps; PITR and a tenant restore drilled.
- [x] Previous-key slots for all three long-lived keys; MFA recoverable with recovery codes after a
      key loss.
- [x] Verified reads everywhere; no store URL signed for reading.
- [x] Scanner refresh, staleness and refusal; the fail-open closed.
- [x] Health endpoints without tenant names; the host check.
- [x] Procedures: backup and restore §5, key rotation, monitoring, host operations, TLS options.

**Before the first data that matters (on TEST):**

- [ ] `munaxa-docs-postgres` published by digest (R-13), or its image ID recorded per deployment.
- [ ] Gate P-1 passed on the chosen store; versioning restore shown.
- [ ] The off-server copy running, and a restore **from it** performed.
- [ ] The dead-man's switch and uptime check paging a person.
- [ ] Firewall verified from outside; SSH keys only.
- [ ] One rollback by digest and one host rebuild rehearsed, with timings recorded.

ADR-0026 stays **Proposed** until those gates pass and their evidence has been reviewed.
