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
| Registry digests | NOT APPLICABLE yet. There is no registry: CI builds and does not push. These are local image IDs. The production build must be pushed to an immutable registry and recorded by digest (prerequisite 9) |
| Working tree | Clean at `f5d5bb2` (`git status --porcelain` empty in the build checkout) |

## 2. Documentation

- **Final RC report:** [release-candidate-final-validation.md](./release-candidate-final-validation.md).
- **Final staging acceptance report:**
  [staging-acceptance-gate-e94c295.md](./staging-acceptance-gate-e94c295.md).
  - The full gate on `416ca94`: STAGING GO.
  - §14 there covers STG-12 on `f5d5bb2`.
  - The historical NO-GO for `a560bb0` stays in
    [staging-acceptance-gate-a560bb0.md](./staging-acceptance-gate-a560bb0.md).
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

1. Confirm the release SHA: `f5d5bb2`, and images built from it (by digest).
2. Confirm the approved change window and approver.
3. Confirm the staging gate: the report above, `416ca94` GO plus the STG-12 targeted regression on
   `f5d5bb2`.
4. Confirm the scanner and signatures: deployed on the private network (§9.2), `probe.mjs` passes,
   signatures current (§9.3).
5. Drain traffic (§13).
6. Back up as `edms_backup` and verify (§19.2), confirmed by a named person.
7. Deploy: images available to the runtime; configuration and secrets set for API and web (§5).
8. Run migrations from a checkout of `f5d5bb2` (§12).
9. Start the API.
10. Start the web.
11. Probe the scanner from the API's network (§15).
12. Health checks (§14, §15).
13. Smoke tests (§16).
14. Monitoring confirmation: active and alerting to the on-call rota (§18).
15. Go / No-Go (§25). On NO-GO: roll back (§20) or fix within the window.
16. Restore traffic.
17. Monitor (§22).
18. Record the result: SHA, times, backup identifiers, probe output, smoke results, the go/no-go
    table, operators.
