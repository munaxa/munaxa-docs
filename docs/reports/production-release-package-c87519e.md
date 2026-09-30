# Production Release Package — release candidate `c87519e`

> **Superseded by `27a8daa` — do not deploy `c87519e`.** It carries findings WEB-1 (web sign-out does
> not revoke the session at the API) and NUM-1 (colliding numbering rules answer 500), both fixed in
> `27a8daa`. See [production-release-package-27a8daa.md](./production-release-package-27a8daa.md).
> This package is kept unchanged below as the historical record.

**Date:** 2026-09-30. This package names the application release candidate that supersedes
`f5d5bb2`, records the two fixes it adds and every validation it passed. **It is not a
production-readiness declaration.** Nothing has been deployed to production and no image has been
published; the production infrastructure prerequisites are unchanged and still open.

## 1. Application

| Item | Value |
| --- | --- |
| **Application release candidate** | **`c87519eeade4392ab656d9bfef5ff694b9c4c594`** (`c87519e`) |
| Branch | `claude/docs-release-rc-c87519e` |
| Previous production baseline (historical) | `f5d5bb28146c57ab7937eff90cebd7621a28c9f2` (`f5d5bb2`) — [production-release-package-f5d5bb2.md](./production-release-package-f5d5bb2.md). **Superseded; not deployable** (§2) |
| Functional staging baseline | `416ca946f6afaee8bcea7fcf94c9705af800c5a8` (`416ca94`), full staging gate |
| Commits `f5d5bb2..c87519e` | three docs-only commits (`9d24185`, `0a65c82`, `0e97a6c`), then `6f135e5`, `14311c2`, `c87519e` |
| Application change `f5d5bb2..c87519e` | exactly the two fixes below. `c87519e` itself adds only `.github/workflows/publish-images.yml`, which is outside the image build context (`.github/` is in `.dockerignore`) |
| Not changed | `prisma/` (no migration), `infra/sql/`, `infra/antivirus/`, `Dockerfile` — so the schema, the migration procedure, RLS and the scanner sources are those of `f5d5bb2` |
| Commits after `c87519e` on the branch | documentation only (this package). **Never** use a documentation commit's SHA as the application SHA |

## 2. The two fixes

| Commit | Fix | Defect in `f5d5bb2` |
| --- | --- | --- |
| **`14311c2b3f8c057b780a54d79deb3b33f923da06`** `fix(auth): never read the tenant from the host; require it at sign-in` | Sign-in, refresh, sign-out, OIDC discovery/callback and API-key resolution resolve only the tenant the caller names; the web login form requires the organisation field | A blank organisation field was resolved from the leftmost host label: `docs.munaxa.com` → `docs`, `api.docs.munaxa.com` → `api`. Measured: a blank-tenant sign-in at `docs.munaxa.com` **authenticated into a tenant slugged `docs`** |
| **`6f135e550351595610e69377feb5f1705f352d0c`** `fix(mfa): read the enrolling account inside a unit of work` | `POST /auth/mfa/enrolment` reads the credential inside a transaction | Every TOTP enrolment answered **500** (`NoActiveTransactionError`); the web's `/mfa` screen could not enrol an authenticator |

Both are verified present in `c87519e`: `git merge-base --is-ancestor` holds for each, and the
regressions below fail on `f5d5bb2`'s behaviour and pass on `c87519e`.

## 3. Validation of `c87519e`

### 3.1 CI

| Run | Commit | Result |
| --- | --- | --- |
| **552** (workflow_dispatch) | `c87519e` exactly | **success, 9/9 jobs**: lint, typecheck, test, build, platform stylesheet, **accessibility contrast and visual regression**; integration with a real object store (MinIO from pinned source) and a real ClamAV/c-icap scanner over two tenant databases; five end-to-end shards (session states; recovery and the data grid; the screens; delegations; signing, faded text and search); container images (API query engine; web branding); product isolation — https://github.com/munaxa/munaxa-docs/actions/runs/36675762889 |
| 551 (push) | `c87519e` | success, 9/9 — https://github.com/munaxa/munaxa-docs/actions/runs/36673368975 |

### 3.2 Local gate on a clean checkout of `c87519e` (fresh databases)

| Gate | Result |
| --- | --- |
| Formatting (`pnpm format:check`) | PASS |
| Lint (all packages, uncached) | PASS (warnings only, none in changed files) |
| Typecheck (all packages, uncached) | PASS |
| Unit | PASS — api 880 passed / 1 skipped; web 503; contracts 63; domain 164; i18n 80; utils 38; worker 2 |
| Build | PASS |
| **Integration** (real PostgreSQL, two tenants, **real object store and real ClamAV 1.5.4 / c-icap 0.5.10**) | **PASS — 1200/1200, 55 files, 0 skipped**, including `s3-upload-integrity` (5), `storage-integrity-and-reclamation` (13), `antivirus.e2e` (28), `icap-antivirus` (10) and `tenant-resolution.e2e` (9) |

### 3.3 Release-candidate regressions

| Required check | Evidence | Result |
| --- | --- | --- |
| Blank tenant on `docs.munaxa.com` cannot resolve tenant `docs` | integration `tenant-resolution.e2e` (tenant slugged `docs` exists); staging RC-1 | PASS |
| Blank tenant on `api.docs.munaxa.com` cannot resolve tenant `api` | integration (tenant slugged `api` exists); staging RC-2 | PASS |
| Named tenant login still works | integration (both hosts, lands in the named tenant); staging RC-3; browser | PASS |
| TOTP enrolment works | integration (enrol → confirm with a real code); staging RC-5 | PASS |
| TOTP recovery-code login works | integration (`MFA_REQUIRED` without a code, recovery code accepted); staging RC-6 | PASS |
| Refresh does not infer the tenant from the hostname | integration; staging RC-4 (without a tenant 401, with it 200) | PASS |

## 4. Staging smoke on `c87519e`'s own images

A staging-shaped deployment of API and web images built from a clean checkout of `c87519e`
(labelled `org.opencontainers.image.revision=c87519e…`), run by the runbook's order: fresh tenant
databases → `scripts/migrate-tenants.mjs` → each tenant's administrator by the image's
`dist/provision.js` → API → web → scanner probe → readiness → smoke. `NODE_ENV=production`,
`DEPLOYMENT_PROFILE=CLOUD` with a two-tenant catalogue (`acme`, and a decoy tenant slugged `docs`),
S3 driver on MinIO, `AV_DRIVER=ICAP` on the scanner rebuilt from `infra/antivirus`, SMTP through a
STARTTLS-required relay with certificate validation, production secrets generated for the run.
Readiness: both tenant databases, cache and antivirus `UP`.

| Suite | Result |
| --- | --- |
| **Runbook §16, steps 1–21** (authentication, documents, preview, revision, antivirus/quarantine, workflow and numbering, search, audit, permissions, bulk) | **21/21** |
| Release-candidate checks RC-1 … RC-6 (§3.3) | **6/6** |
| Real Chromium on the web image: organisation field required; blank organisation refused; named-tenant sign-in lands in the application; every branding asset the login page references served as an image (5/5); session cookies httpOnly and host-only | **5/5** |
| Scanner rebuilt from `infra/antivirus` at `c87519e` | ClamAV **1.5.4**, c-icap **0.5.10**; `probe.mjs`: clean → 204, EICAR blocked (`Eicar-Test-Signature`) |

**Honest notes on the harness.** The smoke is a scripted replay of §16 through the API as an
operator would run it, written for this release; earlier attempts failed on harness errors, each
corrected in the harness and never in the product: configuration key format, re-run code collisions,
role setup (`AUTHOR` and `READER` hold nothing tenant-wide by design; reach comes from ACL entries — `role-seed.ts`), the digest the
web client announces on upload, check-out ordering after publish (known D-4), a non-EICAR bulk file,
and the per-address sign-in limit (reset between the §16 and RC sections; it rejected the twelfth
sign-in, as designed). The final run above was a **single clean run on a freshly deployed
environment**. The local images were built in a sandbox whose network needs a proxy CA; that CA was
supplied to the **build stage only** and is absent from the runtime images (verified). The production
images are built by the publishing workflow from the unmodified `Dockerfile`.

## 5. Findings from this validation (pre-existing; not regressions; not fixed here)

| # | Finding | Present in `f5d5bb2` | Effect | Proposed handling |
| --- | --- | --- | --- | --- |
| **NUM-1** | Two numbering rules that format the same value (e.g. both `SMK-` + sequence) collide on `uq_number_reservation_formatted`; the automatic reservation at submission does not translate the unique violation, so **submission answers 500** | yes | Only with overlapping rule formats in one tenant; the operator avoids it by giving every rule a distinguishing literal or type-code segment | Map the violation to a 409 (or make the rule save refuse overlapping formats) in a later release |
| **WF-1** | Workflow `ROLE` participants must be lower-case keys, and the seeded roles are upper-case (`APPROVER`), so a workflow cannot route to a seeded role | yes | Tenants route approvals through a custom (lower-case) role, a group or a department | Accept the seeded keys in the participant schema, or document the convention |
| WEB-1 | Web sign-out sends no tenant, so the server-side refresh family is not revoked (the browser's cookies are cleared) | yes (reported 2026-09-30) | A copied refresh token stays usable until it expires | Send the tenant on sign-out |
| KEY-1 | API keys name no tenant; with more than one tenant in a deployment they are refused | yes (at `docs.munaxa.com`) | Machine callers work on single-tenant deployments only | A tenant selector for keys |

None of these was introduced by `6f135e5` or `14311c2`, and none affects the release's
isolation, antivirus or audit guarantees. Whether any is release-blocking is the change approver's
decision; this package does not treat them as such.

## 6. Production images

| Item | Value |
| --- | --- |
| Registry | `ghcr.io/munaxa` — `munaxa-docs-api`, `munaxa-docs-web`, `munaxa-docs-antivirus` |
| Process | `.github/workflows/publish-images.yml` (in `c87519e`), started by the tag `image/c87519eeade4392ab656d9bfef5ff694b9c4c594` |
| Tags | `c87519e` and `sha-c87519eeade4392ab656d9bfef5ff694b9c4c594` — **no `latest`, ever** |
| Deployment references | **`image@sha256:<digest>` only** |
| **Status** | **NOT PUBLISHED.** The release candidate passed every required check (§3–§4), so publishing is permitted; it was not performed from the release session, whose git transport refuses tag pushes. The operator pushes the tag (runbook-adjacent command in [production-infrastructure-implementation.md](../operations/production-infrastructure-implementation.md) 9d) |

### 6a. Published registry digests (to be completed after publishing)

| Image | Repository | Digest | Revision label | Pulled with the production pull identity | Extra check |
| --- | --- | --- | --- | --- | --- |
| API | `ghcr.io/munaxa/munaxa-docs-api` | `sha256:<API_DIGEST>` | ☐ `c87519e…` | ☐ | ☐ query engine |
| Web | `ghcr.io/munaxa/munaxa-docs-web` | `sha256:<WEB_DIGEST>` | ☐ `c87519e…` | ☐ | ☐ `/branding/docs/favicon/favicon-32.png` → `200 image/png` |
| Antivirus | `ghcr.io/munaxa/munaxa-docs-antivirus` | `sha256:<AV_DIGEST>` | ☐ `c87519e…` | ☐ | ☐ ClamAV/c-icap versions from the run; `probe.mjs` exit 0 |

**Until every row holds a verified digest, production is NO-GO.**

## 7. What is unchanged from the `f5d5bb2` package

The production infrastructure prerequisites (DNS/TLS, alerting, monitoring, SMTP, private scanner
network, object storage, backup/PITR/failover, load baseline, registry/secrets/configuration), the
go-live sequence (runbook §21) and the rollback rules (runbook §20: no application rollback target
for the first deployment; migrations forward-only; never restore over the live database) apply to
`c87519e` exactly as they did to `f5d5bb2`. Status and required evidence:
[production-prerequisites-checklist.md](../operations/production-prerequisites-checklist.md).
