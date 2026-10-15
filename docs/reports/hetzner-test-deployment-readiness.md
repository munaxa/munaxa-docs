# Readiness for a controlled Hetzner test deployment

- **Status:** Assessment only. **Nothing has been deployed to Hetzner**, and no cloud resource, DNS
  record or cost was created for it. ADR-0026 stays **Proposed**. This is **not** a statement of
  production readiness.
- **Date:** 2026-10-15
- **Branch:** `claude/amazing-turing-09vlks` at `2c07ee7` (export verified-delivery work), plus the
  documentation commit that adds this report.
- **Sources:** the code and `infra/hetzner/` at that commit; ADR-0026 §3–§10; the operations runbooks
  under `docs/operations/`; the staging gate record `staging-acceptance-gate-e94c295.md` (a
  single-host Docker staging, **not** Hetzner).
- **Rule used below:** an item is "verified" only where a run is recorded. Where only a document or
  a script exists, it says so.

## 1. Checklist

### 1.1 Verified locally (Docker on a development host, MinIO as the store)

| Area | Evidence |
| --- | --- |
| The template's stack starts and answers (proxy → web/API, private networks, only the proxy published on loopback) | ADR-0026 §10, Phase A and Phase B runs |
| Tenant databases created and migrated, idempotently | Phase A; integration run on fresh databases (58 files / 1,287 tests, `2c07ee7`) |
| Production refuses unsafe settings (`AV_DRIVER=NONE`, unencrypted SMTP, …) | ADR-0026 §10, 8/8 |
| Malware scanning fails closed; EICAR blocked | Every stack run; CI |
| Verified downloads: documents, revisions, **report exports, audit artefacts, bulk documents, bulk manifest** — digest checked before any byte is sent; tampered, missing and quarantined refused; 503 on store outage, staging exhaustion and a filling disk | Phase B run 7: 92/92; integration suites |
| Re-authorization at redemption for every link kind; tenant, ownership, kind and state binding | Integration suites; negative controls (7/7 caught); independent review |
| Bounded memory for downloads (8 and 40 × 128 MiB) and for audit export generation | Phase B run 7; integration streaming test |
| Staging files removed after success, failure, cancellation and restart | Phase B (staging empty after each case); start-up cleanup |
| No credential in logs; download/preview tokens redacted from the proxy log | Phase B (2,635 lines); Caddy filter checked against caddy 2.10.2 |
| Health endpoints that name tenants are not reachable through the proxy | ADR-0026 §10 |
| Arabic / right-to-left on the changed screens; 1280×720 layout | Phase B run 7; web tests |

### 1.2 Verified in a hosted test environment

| Area | Evidence |
| --- | --- |
| Cloudflare R2 **upload contract only** (signed checksum, HEAD digest, tampered bytes refused, CORS, scanner read-back) | CI run 38535100979 (ADR-0026 §10, gate P-1). The bucket was in the **eastern US (ENAM)** jurisdiction |

**Nothing else has run in a hosted environment.** The staging results in
`staging-acceptance-gate-e94c295.md` (PITR, store replication, outage drills, alerting) came from a
different, non-Hetzner single-host staging; that run's monitoring and WAL configuration is not in this
repository.

### 1.3 Not yet verified

| Area | State | Gate / gap |
| --- | --- | --- |
| **PostgreSQL backup** on Hetzner: nightly per-tenant dump, WAL archiving / PITR, encrypted off-site copy | **Absent from the template** (no service, no schedule, no `archive_command`); documented in ADR-0026 §9 and `backup-and-restore.md` | P-4, G-4 |
| **Restore** on Hetzner, including the audit chain check | Script exists (`scripts/dr-rehearsal.mjs`; CI restores into a second Postgres); never run on Hetzner | P-4 |
| **Object storage version history** | Required by the docs. R2 does not offer S3 versioning, and no alternative is designed. Hetzner Object Storage is untested | P-1, G-1, D-3 |
| Object store second-provider copy | `scripts/storage-backup.mjs` exists (backup/verify/restore with a manifest); not scheduled, not run against R2 or Hetzner | P-4 |
| R2 multipart writes, browser downloads, checksum preservation on copy (Phase C) | Not run | P-1 |
| **EU data residency** | Hetzner location proposed (Germany) but not verified; the only R2 bucket tested was in ENAM; no compliance review recorded | G-1 |
| TLS termination (Cloudflare Tunnel or proxy + Origin CA) and the real client address | Decided in neither direction; Caddy terminates no TLS by design | P-2, G-2, G-5 |
| Firewall, SSH, OS updates | Documented only; no configuration in the repository | G-6 |
| Email delivery (SPF/DKIM/DMARC) | Configuration only; never delivered | P-3, G-3 |
| Monitoring, alerting, log retention, disk alerts | **Absent** on Hetzner (logs rotate per container only) | ADR-0026 §9 |
| ClamAV signature refresh | Updated at container start only; no scheduled refresh in the template | — |
| Release and rollback by image digest | Publishing by digest is implemented; the deployment workflow is not written; rollback never executed; third-party images (Caddy, PostgreSQL, Redis) pinned by tag, not digest | G-8 |
| Load and memory on the chosen server size | Measured only on the development host; the API's container reaches its 1.5 GiB limit through page cache under load (no OOM kill) | G-7 |
| Redis loss on the Hetzner stack | Behaviour documented (queue jobs in flight are lost; schedules rebuilt); drilled on staging only | — |
| Host failure and rebuild | Documented ("rebuild from the template and restore"); never done | — |

## 2. Findings that affect a test deployment

| # | Finding | Severity | Evidence | Needed before |
| --- | --- | --- | --- | --- |
| R-1 | No database backup or WAL archiving exists in the Hetzner template | **Critical** for any data worth keeping | `infra/hetzner/compose.yaml` has no backup service; ADR-0026 §9 | Any data that matters |
| R-2 | Object version history: required, unavailable on R2, untested on Hetzner Object Storage | **High** | ADR-0026 §6, §10 | Choosing the store (D-3) |
| R-3 | **`SIGNATURE_WITNESS_SECRET` has a single slot.** After rotation, every earlier e-signature verifies as "key not held by this deployment" (`signature.service.ts` compares only the current key). The docs say to keep old keys, but the code cannot load them | **High** for compliance | `apps/api/src/modules/document/application/signature.service.ts` (verification) | Rotating the key, or holding signatures that must stay verifiable |
| R-4 | **`MFA_TOTP_SEALING_KEY` has no slot for a previous value.** Changing it makes every enrolment sealed under the old value unreadable | **High** (people locked out of MFA) | `apps/api/src/modules/identity/infrastructure/prisma-mfa.repository.ts` | Rotating the key |
| R-5 | Losing any of the secrets above, or `AUDIT_CHECKPOINT_SECRET`, is irreversible; their backup is documented only | **High** | ADR-0026 §9 item 3, failure table | First real data |
| R-6 | No monitoring or alerting on Hetzner | **High** for a service anybody relies on | ADR-0026 §9 | Users |
| R-7 | TLS and the client-address chain are undecided, so the sign-in rate limit is not yet keyed on the real browser address | **High** | ADR-0026 §3, P-2 | Exposure to the internet |
| R-8 | E-10: a quarantined deduplicated export cannot be recovered by running it again (fails closed; needs an administrator) | Medium | export design §1 | — |
| R-9 | The preview pipeline's internal source reads do not verify the source digest before rendering or OCR (nothing they read is handed to a person as a download) | Medium | `createInternalReadUrl` callers | — |
| R-10 | ClamAV signatures are refreshed only when the container restarts | Medium | `infra/antivirus/entrypoint.sh` | Running longer than a day |
| R-11 | `/api/health` and `/api/health/ready` name every tenant; blocked at the proxy, so reachable from inside the host only | Low (mitigated) | `Caddyfile`; health controller | — |
| R-12 | A verified download link is a bearer link for 60 s (re-checked against its person on each use) | Low (accepted) | ADR-0026 §10 | — |

## 3. What can and cannot be shown without a hosted environment

- **Can be shown locally, and was:** the application's own behaviour, as listed in §1.1: the
  security of downloads and exports, scanning, limits, staging, logs and migrations.
- **Needs a real environment:**
  - backups and restores on the chosen host and provider;
  - object versioning and replication on the chosen provider;
  - TLS, the client-address chain, the firewall and SSH;
  - mail delivery;
  - EU residency of each provider and region;
  - monitoring and alerting;
  - load on the chosen server size;
  - a rollback by digest.

  None of these has been run, and none is claimed.

## 4. Recommended next action

Prepare a **TEST** environment whose data is disposable, and run gates P-1 to P-4 there **before**
any data that matters enters it. Each step needs the owner's explicit authorization, because it
creates resources and costs (ADR-0026 D-1 to D-10):

1. **Decide the object store (D-3) and its region.**
   - Either test Hetzner Object Storage (versioning, multipart, a browser download, checksum on
     copy), or design and test R2's versioning alternative in an EU jurisdiction.
   - Run Phase C against whichever is chosen.
2. **Add backups to the template before the first restore drill:**
   - a nightly per-tenant dump as `edms_backup`;
   - WAL archiving (pgBackRest or WAL-G);
   - an encrypted off-site copy;
   - a scheduled `storage-backup.mjs`.

   Then restore on TEST and verify the audit chain (P-4).
3. **Fix R-3 and R-4 before any key is ever rotated** (a prior-key slot for the witness and MFA
   sealing keys), and record the key backup procedure.
4. **Decide TLS (D-2)** and wire the client-address chain (P-2). Configure the firewall and SSH
   (G-6). Add an external uptime check and disk and memory alerts.
5. **Publish a release** carrying the F-1 fix and this branch's work, by digest (D-10). Deploy it to
   TEST from digests, then exercise one rollback.

ADR-0026 should stay Proposed until those gates pass and their evidence has been reviewed.
