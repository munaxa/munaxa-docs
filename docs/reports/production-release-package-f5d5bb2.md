# Production Release Package — `f5d5bb2`

**Date:** 2026-09-29. This package names the candidate production artifact and what must happen
before and during go-live. **It is not a production-readiness declaration.** Nothing has been
deployed to production. The next step is to satisfy the production infrastructure prerequisites
below, then execute the go-live runbook.

## 1. Application

| Item | Value |
| --- | --- |
| Final application SHA | **`f5d5bb28146c57ab7937eff90cebd7621a28c9f2`** (`f5d5bb2`) |
| CI | Run 550 on `f5d5bb2`, 9/9 jobs green |
| Staging-approved functional baseline | **`416ca946f6afaee8bcea7fcf94c9705af800c5a8`** (`416ca94`), which passed the full staging acceptance gate (CI run 548, 9/9) |
| Difference from the baseline | STG-12 only: the web stage of the `Dockerfile` now ships the generated brand artwork (`apps/web/public`), plus a CI guard. No application source changed (`apps/`, `packages/`, `prisma/` and `infra/sql` are identical), and `apps/api/dist` is byte-identical between the two API images. Also between them: the STG-11 fix to the operator tool `scripts/dr-rehearsal.mjs` (`ab4fa7b`) |
| STG-12 validation | Staging with real Chromium, light and dark: favicons and logos `200 image/png`, byte-identical to `@munaxa/platform`, no branding 404, login and the authenticated shell render; before the fix 3/10, after 10/10. On the final images: scanner probe passes, §16 smoke 22/22 |
| Images (built from a clean checkout of `f5d5bb2`, labelled `org.opencontainers.image.revision=f5d5bb2…`) | `munaxa-docs-api:f5d5bb2` `sha256:53bf43be9ade46f494ec20258f9f9703f9ce2a688fd3ddc8677a47849872a0eb` · `munaxa-docs-web:f5d5bb2` `sha256:ada7ddb0acb709cf89a1ddcad6ed7ae369cabe6c9b5f2681b9685c26f8ee3727` · the scanner `munaxa-antivirus:7442853` `sha256:805574b9640df49959b82d4f42ad56280db07cc9dcb2efccc63f91b56b2cf8e4` (`infra/antivirus` is unchanged since `7442853`) |
| Registry digests | **BLOCKED — ENVIRONMENT: production image registry not configured.** CI builds and does not push, and no registry was supplied. The IDs above are local image IDs from the ephemeral release-engineering environment. They are evidence, not a deliverable artifact. The operator must publish images built from `f5d5bb2` (and the scanner) to an immutable registry and record them by digest. [production-prerequisites-checklist.md](../operations/production-prerequisites-checklist.md) §2 lists exactly what to provide and verify |
| Working tree | Clean at `f5d5bb2` (`git status --porcelain` empty in the build checkout) |
| Never deploy as the release | `a560bb0` (historical RC baseline, staging NO-GO), `e94c295` (STG-10), or `416ca94` (its web image lacks the brand artwork). Deploy `f5d5bb2` only. `a560bb0`–`416ca94` appear in the rollback section only as last-resort rollback targets above the D-3 floor |
| Scanner version pinning | The scanner Dockerfile installs unpinned Ubuntu packages. A rebuild must record `clamd --version` and `c-icap -V` and pass `probe.mjs` (runbook §1, §9.2) |

## 2. Documentation

- **Final RC report:** [release-candidate-final-validation.md](./release-candidate-final-validation.md).
- **Final staging acceptance report:**
  [staging-acceptance-gate-e94c295.md](./staging-acceptance-gate-e94c295.md).
  - The full gate on `416ca94`: STAGING GO.
  - §14 there covers STG-12 on `f5d5bb2`.
  - The historical NO-GO for `a560bb0` stays in
    [staging-acceptance-gate-a560bb0.md](./staging-acceptance-gate-a560bb0.md).
- **Production prerequisites checklist (status, missing inputs, configuration, Go/No-Go):**
  [../operations/production-prerequisites-checklist.md](../operations/production-prerequisites-checklist.md).
- **Production go-live runbook:**
  [../operations/go-live-runbook.md](../operations/go-live-runbook.md), with release identity pinned
  to `f5d5bb2`.

## 3. Production prerequisites

**Application-validated:** these were shown working in staging and need no application change.

- The deployment order and drain.
- Migrations and forced RLS.
- D-20 idempotency.
- The real ICAP antivirus: CLEAN, INFECTED and FAILED, and large files up to the ceiling.
- Outage behaviour and recovery for the scanner, Redis, the object store and a tenant database.
- The health signals each alert rule uses.
- DR restore with the tooling.
- A load baseline without errors.
- Previews through `STORAGE_PUBLIC_URL`.
- SMTP delivery.
- Brand artwork (STG-12).

**Production infrastructure still required.** None of these is application-code work:

1. Public CA certificates and DNS.
2. Real production alert routing and escalation.
3. Production monitoring stack.
4. Production SMTP relay with SPF/DKIM/DMARC.
5. Private scanner network and signature-update path.
6. Production bucket CORS/versioning/replication and `STORAGE_PUBLIC_URL`.
7. PITR, replication failover rehearsal, `edms_backup` role and backup alerting.
8. Production-sized load baseline.
9. Immutable image registry/digests/signing and secret/configuration management.

Two notes from staging bear on these:

- **Prerequisite 2:** configure Alertmanager silences for the planned maintenance window. A drain
  pages ApiDown, WebDown and ApiNotReady.
- **Prerequisite 8:** the harness's latency targets were not met on single-host staging (0 failures,
  0 rate-limited). The production baseline decides capacity.

## 4. Deployment sequence (go-live runbook §21)

The repository defines no downtime duration. The approved change window sets it.

1. Confirm the final release SHA `f5d5bb2` and the images by registry digest.
2. Confirm the production change window.
3. Confirm the staging gate.
4. Confirm the production prerequisites (every item in the checklist READY with evidence).
5. Confirm the scanner: private network, signatures current, `probe.mjs` exit 0.
6. Drain traffic.
7. Take the backup (as `edms_backup`).
8. Verify the backup.
9. A named person confirms the backup.
10. Deploy the release (images by digest, configuration and secrets).
11. Run the tenant migrations from a checkout of `f5d5bb2`.
12. Start the API.
13. Start the web.
14. Probe the scanner from the API's network.
15. Run the health checks.
16. Run the smoke tests.
17. Confirm monitoring, with alerts reaching the production on-call.
18. Make the Go/No-Go decision (runbook §25).
19. Restore traffic.
20. Monitor (§22).
21. Record the result.

## 5. Rollback (go-live runbook §20)

- **Application:** redeploy earlier images by digest. They must be at or above the **D-3 floor**
  (`a560bb0` or later on this line; prefer `416ca94` or later). Rolling back below D-3 is
  **prohibited**, because it removes real malware scanning. On a first production deployment, or
  when the previous production images are below the floor, there is no application rollback: fix
  forward or keep traffic drained.
- **Database:** migrations are forward-only. Never reverse them, and **never restore over the live
  database**. If the migrated database must be abandoned, restore the pre-deployment backup (or PITR)
  into a new database, verify it, then repoint the catalogue. This discards writes since the backup
  and is the change approver's decision.
- **Object storage:** nothing is deleted. **Scanner:** keeps running.
