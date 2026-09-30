# Production Release Package — `f5d5bb2`

> **Superseded on 2026-09-30 — historical record, not a deployable release.** The application release
> candidate is **`c87519e`** ([production-release-package-c87519e.md](./production-release-package-c87519e.md)),
> which adds the tenant-resolution fix (`14311c2`) and the TOTP-enrolment fix (`6f135e5`). Do not
> build, publish or deploy `f5d5bb2`. Everything below is kept unchanged as the record of 2026-09-29.

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
| Never deploy as the release | `a560bb0` (historical RC baseline, staging NO-GO), `e94c295` (STG-10), or `416ca94` (its web image lacks the brand artwork). Deploy `f5d5bb2` only. `a560bb0` is the historical RC and D-3 floor, never a rollback target |
| Scanner version pinning | The scanner Dockerfile installs unpinned Ubuntu packages. A rebuild must record `clamd --version` and `c-icap -V` and pass `probe.mjs` (runbook §1, §9.2) |

## 1a. Published registry digests (to be completed by the operator)

Filled in after publishing and verifying the images
([production-infrastructure-implementation.md](../operations/production-infrastructure-implementation.md)
prerequisite 9d). **Until every row holds a verified digest, production is NO-GO.** Record the digests
here as a documentation commit, and in the go-live change record. The application SHA stays
`f5d5bb2`.

| Image | Repository (operator-supplied) | Digest (after push) | Revision label verified | Pulled with the production pull identity | Extra check |
| --- | --- | --- | --- | --- | --- |
| API | `<REGISTRY_HOST>/<API_REPOSITORY>` | `sha256:<API_DIGEST>` | ☐ `f5d5bb2…` | ☐ | — |
| Web | `<REGISTRY_HOST>/<WEB_REPOSITORY>` | `sha256:<WEB_DIGEST>` | ☐ `f5d5bb2…` | ☐ | ☐ `/branding/docs/favicon/favicon-32.png` → `200 image/png` |
| Antivirus | `<REGISTRY_HOST>/<AV_REPOSITORY>` | `sha256:<AV_DIGEST>` | ☐ `f5d5bb2…` | ☐ | ☐ ClamAV `1.5.4` / c-icap `0.5.10` (or the versions recorded here), `probe.mjs` exit 0 |

Status: **BLOCKED — ENVIRONMENT: production image registry not configured.**

## 2. Documentation

- **Final RC report:** [release-candidate-final-validation.md](./release-candidate-final-validation.md).
- **Final staging acceptance report:**
  [staging-acceptance-gate-e94c295.md](./staging-acceptance-gate-e94c295.md).
  - The full gate on `416ca94`: STAGING GO.
  - §14 there covers STG-12 on `f5d5bb2`.
  - The historical NO-GO for `a560bb0` stays in
    [staging-acceptance-gate-a560bb0.md](./staging-acceptance-gate-a560bb0.md).
- **Production infrastructure implementation checklist (what the operator does, in order, with
  validation and evidence; the final readiness gate before §21):**
  [../operations/production-infrastructure-implementation.md](../operations/production-infrastructure-implementation.md).
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

- **Application:** a rollback target is the immutable digest of a validated release that has already
  run in this production environment. For this **first** production deployment there is none: fix
  forward or keep traffic drained, and record "no rollback target — first deployment" before
  go-live. `a560bb0` is only the historical RC and the D-3 floor, never a target. Rolling back below
  D-3 is **prohibited**: it removes real malware scanning.
- **Database:** migrations are forward-only. Never reverse them, and **never restore over the live
  database**. If the migrated database must be abandoned, restore the pre-deployment backup (or PITR)
  into a new database, verify it, then repoint the catalogue. This discards writes since the backup
  and is the change approver's decision.
- **Object storage:** nothing is deleted. **Scanner:** keeps running.

## 6. Addendum — 2026-09-30: tenant login fix, image publishing, ecosystem decision

Appended; §1–§5 above are unchanged and remain the record of 2026-09-29.

### 6.1 Ecosystem architecture

Docs production follows the accepted ecosystem decision
([munaxa ADR-0002](https://github.com/munaxa/munaxa/blob/main/docs/adr/0002-independent-products-one-shared-foundation.md)):
Docs is independently deployable, owns its databases, tenants, users and authentication, and has
no runtime dependency on Work, School, Munaxa Identity or any control plane. The Identity ADR
([munaxa ADR-0001](https://github.com/munaxa/munaxa/blob/main/docs/adr/0001-munaxa-identity-is-a-sixth-peer-product.md))
was merged in `e173217` (munaxa PR #263); it does not oblige Docs to use Identity. Nothing in this
release package introduces Identity, a shared tenant table, a shared database or the Work/Identity
Render blueprint into Docs.

### 6.2 Tenant login fix — NOT in `f5d5bb2`

| Item | Value |
| --- | --- |
| Defect | With the organisation field blank, sign-in/refresh/sign-out, OIDC discovery/callback and API-key resolution took the leftmost host label as the tenant: `docs.munaxa.com` → `docs`, `api.docs.munaxa.com` → `api`. Measured: a blank-tenant sign-in at `docs.munaxa.com` **authenticated into a tenant whose slug is `docs`**. |
| Fix commit | **`14311c2`** `fix(auth): never read the tenant from the host; require it at sign-in` (branch `claude/docs-tenant-login-and-images`) |
| Related fix | **`6f135e5`** `fix(mfa): read the enrolling account inside a unit of work` — `POST /auth/mfa/enrolment` answered 500 on every call (NoActiveTransactionError), so the web's `/mfa` screen could not enrol an authenticator. Found by the new suite's TOTP test. Present in `f5d5bb2`. |
| Regression suite | `apps/api/src/__tests__/tenant-resolution.e2e.integration.spec.ts`, 9 tests over HTTP with tenants named `docs` and `api`: blank tenant at `docs.munaxa.com` and at `api.docs.munaxa.com` refused (401, same as a wrong password); named tenant signs in at both hosts into the named tenant; named-tenant sign-in and refresh on a plain host; refresh without a tenant refused; TOTP enrol → `MFA_REQUIRED` → recovery code accepted; OIDC discovery accepts `tenant`. 9/9 pass; with the old host rule restored 4 fail. |
| Other gates (local, this session) | API unit 880 passed / 1 skipped; web unit 503; contracts 63; typecheck and lint clean (warnings only, in untouched files); format clean. API integration: 1145 passed, 17 failed, 38 skipped — all 17 failures `ECONNREFUSED 127.0.0.1:9000` (no object store in this container), the 38 skips are the scanner suites (no scanner). CI run **551** on `c87519e` (contains both fixes; `c87519e` adds only the workflow): **success, 9/9 jobs** — lint, typecheck, unit, build, integration with a real object store and scanner, the five end-to-end shards, product isolation, images — https://github.com/munaxa/munaxa-docs/actions/runs/36673368975 |
| Known limit | API keys resolve an unnamed tenant only where the deployment has exactly one. A multi-tenant cloud deployment has no way for a machine caller to name its tenant (it could not on `f5d5bb2` either at `docs.munaxa.com`). |

**Consequence for the release SHA.** Both fixes post-date `f5d5bb2`. Images built from `f5d5bb2`
carry the defect: a blank organisation field on `docs.munaxa.com` fails sign-in (or, if a tenant is
ever given the slug `docs` or `api`, signs into it), and TOTP enrolment fails. Deploying `f5d5bb2`
therefore requires, operationally, that no tenant is provisioned with the slug `docs`, `api` or any
other label of a Docs hostname, and that MFA enrolment is not offered. Shipping the fixes requires a
new application SHA and the targeted staging re-validation this project applies to any source change
— **a release decision, not taken here.**

### 6.3 Production images

| Item | Value |
| --- | --- |
| Registry | `ghcr.io/munaxa` — repositories `munaxa-docs-api`, `munaxa-docs-web`, `munaxa-docs-antivirus` (the convention munaxa-work and munaxa-identity already use) |
| Publishing workflow | `.github/workflows/publish-images.yml`, commit **`c87519e`**. Trigger: tag `image/<40-hex SHA>`; builds exactly that commit, two immutable tags per image, never `latest`. Verifies on the pulled digest: revision label, non-root, no credential in history or filesystem, API query engine, web branding (every `/branding/` URL of the login page plus `/branding/docs/favicon/favicon-32.png` → `200 image/*`). Scanner: records `clamd --version`, `c-icap -V` and package versions; `probe.mjs` exit 0 on the candidate, after an unclean restart, and on the pulled digest; pushes the probed image itself. Final job pulls all three with the production pull identity. |
| Source for API and Web | `f5d5bb28146c57ab7937eff90cebd7621a28c9f2`, as instructed |
| Source for antivirus | `infra/antivirus` at the same commit (unchanged since the validated `7442853`), rebuilt — the staging image `munaxa-antivirus:7442853` is not the production artifact |
| API digest | **not published** |
| Web digest | **not published** |
| Antivirus digest | **not published** |
| Scanner versions | **not recorded for a production build** — they are recorded by the workflow run. Staging's `7442853` image had ClamAV `1.5.4`, c-icap `0.5.10`; an unpinned rebuild may differ. |
| Production pull identity | **not configured** — repository secrets `DOCS_PRODUCTION_PULL_USER` / `DOCS_PRODUCTION_PULL_TOKEN` (a read-only `read:packages` identity for the production host) are operator-provisioned |

**Why nothing is published.** The release session's git transport accepted the branch push and
refused the tag push (`fatal: the remote end hung up unexpectedly`, three attempts; the branch push
over the same transport succeeded). No image was built or pushed, so no digest exists. To publish,
from any clone with push rights:

```bash
git fetch origin claude/docs-tenant-login-and-images
git tag image/f5d5bb28146c57ab7937eff90cebd7621a28c9f2 c87519e
git push origin image/f5d5bb28146c57ab7937eff90cebd7621a28c9f2
```

Then copy the three `image@sha256:` references and the scanner versions from the run summary into
§1a above, as a documentation commit. Until every §1a row holds a verified digest, production stays
NO-GO — unchanged from §1a.
