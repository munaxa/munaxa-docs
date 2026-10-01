# Production Release Package — release candidate `27a8daa`

> **Published as release `4e8e1ca`.** This application code was published, unchanged, from
> `4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b` (which adds only the non-root antivirus image and
> documentation) by run `36819091004`. The deployable release, its three image digests and their
> verification are in [production-release-package-4e8e1ca.md](./production-release-package-4e8e1ca.md).
> No image was ever published from `27a8daa` itself. The approval, fixes and validation below still
> apply to the application code.

**Date:** 2026-09-30. This package names the application release candidate that supersedes
`c87519e`, records the two fixes it adds (WEB-1, NUM-1), the two findings accepted as launch
limitations (WF-1, KEY-1), and every validation it passed. **It is not a production-readiness
declaration.** Nothing has been deployed to production and no image has been published; the
production infrastructure prerequisites are unchanged and still open.

## 1. Application

| Item | Value |
| --- | --- |
| **Application release candidate** | **`27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5`** (`27a8daa`) |
| Branch | `claude/docs-release-rc2` |
| Superseded release candidate (historical) | `c87519eeade4392ab656d9bfef5ff694b9c4c594` (`c87519e`) — [production-release-package-c87519e.md](./production-release-package-c87519e.md). **Not deployable** (WEB-1, NUM-1) |
| Previous production baseline (historical) | `f5d5bb2` — [production-release-package-f5d5bb2.md](./production-release-package-f5d5bb2.md). **Not deployable** |
| Functional staging baseline | `416ca94`, full staging gate |
| Application fixes since `f5d5bb2` | `6f135e5` (TOTP enrolment), `14311c2` (tenant never read from the host) — both in `c87519e` — then **`efcb955` (WEB-1)** and **`27a8daa` (NUM-1)** |
| Change `c87519e..27a8daa` | `efcb955` and `27a8daa` (application code under `apps/`, their tests, one CI shard file list, the numbering architecture doc) plus documentation-only commits |
| Not changed | `prisma/` (**no migration**), `infra/sql/`, `infra/antivirus/`, `Dockerfile`, `.dockerignore` — verified with `git diff --name-only c87519e 27a8daa`. Schema, migration procedure, RLS and scanner sources are those of `f5d5bb2` |
| Commits after `27a8daa` on the branch | documentation only (this package). **Never** use a documentation commit's SHA as the application SHA |

## 2. The fixes

### 2.1 WEB-1 — web sign-out revokes the session at the API (`efcb955`)

**Defect in `c87519e`.** The web's sign-out posted only the refresh token to `POST /auth/logout`. The
API reads no tenant from the host (`14311c2`), so it refused the request; the web swallowed the
refusal and cleared the browser's cookies. Every screen looked signed out, but a copy of the refresh
token taken before sign-out went on exchanging for new pairs for up to 30 days.

**Fix.**

- At sign-in the web stores the organisation slug in a new cookie `edms_tenant`. Its attributes are
  those of the refresh cookie: `httpOnly`, `Secure` in production, `SameSite=Lax`, `path=/`, and the
  **same expiry** as the refresh cookie.
- At sign-out the web posts `{refreshToken, tenant}` to the existing `POST /auth/logout`.
- It clears `edms_at`, `edms_rt` and `edms_tenant` on sign-out and on the session-ended route.
- The API's logout is unchanged. There is no token-format or auth-architecture change, and no
  absolute session lifetime.

**Tests.**

| Required | Test | On `c87519e` |
| --- | --- | --- |
| Sign-in stores the tenant cookie (same attributes and expiry as the refresh cookie) | `apps/web/src/lib/auth.spec.ts` | fails |
| Sign-out sends the tenant | `auth.spec.ts` | fails |
| Sign-out clears the tenant cookie (also when the API is unreachable) | `auth.spec.ts`, `session-ended/route.spec.ts` | fails |
| Browser sign-in → sign-out → replay the copied refresh token **with its tenant** → 401 | `apps/web/src/test/e2e/sign-out-revocation.e2e.spec.ts` (real Chromium, real API; CI shard "session states") | fails |
| Existing API logout tests | integration and unit suites unchanged | pass |

### 2.2 NUM-1 — colliding numbering series are refused, and answer 409 rather than 500 (`27a8daa`)

**Defect in `c87519e`.** Two rules that render the same value, such as two rules both `SMK-` + a
sequence, collided on `uq_number_reservation_formatted` (unique per tenant on the formatted number).
The violation was not translated, so submission or approval answered **500**.

**Fix.**

1. **Validation on save.** A reset scope must appear in the number. `PER_COMPANY`, `PER_ENTITY`,
   `PER_BRANCH`, `PER_DOCUMENT_TYPE` and `PER_CATEGORY` now require their code segment
   (`COMPANY_CODE`, `ENTITY_CODE`, `BRANCH_CODE`, `DOCUMENT_TYPE_CODE`, `CATEGORY_CODE`), just as the
   yearly and monthly resets already required their date segments. Without the segment, two scopes
   would restart one sequence and render the same numbers.
   - **Per-department exception kept, unchanged.** A department has no code segment, so
     `PER_DEPARTMENT` continues to save without one. It is documented in
     `docs/architecture/09-numbering-architecture.md`, and it is covered at draw time by item 2.
2. **Draw-time guard.** Before a drawn number is written, `NumberingIssueService.draw()` checks
   whether the formatted value is already issued in the tenant. If it is, the draw throws
   `NumberSeriesCollisionError`, which answers **409 `DUPLICATE`** with:
   - details `{reason: 'NUMBER_SERIES_COLLISION', formatted, numberingRuleId, numberingRuleKey, issuedByRuleId}`;
   - the field error `documentNumber: NUMBER_SERIES_COLLISION: numbering rule "<key>" drew <value>, which is already issued`.

   This covers both reserve-at-submission and draw-at-approval.
3. **Full rollback.** The error is thrown inside the request's unit of work, so the whole
   transaction rolls back. Nothing is written: no document state change, workflow instance, task
   decision, reservation, sequence advance or audit entry. The unique constraint is **not**
   weakened; it remains the final guarantee.
4. Rules already stored are not re-validated. They keep drawing, and a collision among them now
   answers 409. An administrator who next saves such a rule is told what is missing.

**Tests.**

| Required | Test | On `c87519e` |
| --- | --- | --- |
| Colliding rules rejected (every scope without its segment) | `apps/api/src/modules/administration/domain/numbering.spec.ts` | fails |
| Valid yearly, monthly and per-entity + yearly rules still accepted; per-department exception | `numbering.spec.ts` | pass |
| Two colliding series at **submission** → 409, not 500; a retry → 409 again | `apps/api/src/__tests__/numbering-collision.e2e.integration.spec.ts` | 500 |
| Two colliding series at **approval** (strict-gapless draw) → 409, retry 409 | same file | 500 |
| No partial writes: document state, workflow instances, task decisions, reservations, audit rows unchanged; the colliding value issued exactly once | same file | — |
| Existing numbering tests | unit and integration suites | pass |

## 3. Accepted launch limitations (not changed)

Both are documented for operators in [go-live-runbook.md §1a](../operations/go-live-runbook.md) and
appear as a Go/No-Go row (§25).

| # | Limitation | Workaround / rule |
| --- | --- | --- |
| **WF-1** | Built-in upper-case role keys (`APPROVER`, …) cannot be used directly as workflow `ROLE` participants. The participant takes a lower-case configuration key, and the definition is refused as a validation error | Route by a **custom role** (lower-case key), an **approval group**, a **department**, or the **manager route** |
| **KEY-1** | **Multi-tenant API-key access is not supported at launch.** An API key names no tenant; it resolves only where the deployment has exactly one tenant, and otherwise it is refused with 401. This **fails closed by design** | API keys are supported on **single-tenant deployments only**. Administrators must **not create or offer API-key integrations on a multi-tenant production deployment** (such as `docs.munaxa.com`). No tenant header or other mechanism is added |

## 4. Validation of `27a8daa`

### 4.1 CI

| Run | Commit | Result |
| --- | --- | --- |
| **554** (push) | `27a8daa` exactly | **success, 9/9 jobs**: lint, typecheck, test, build, platform stylesheet, accessibility contrast and visual regression; integration with a real object store and a real ClamAV/c-icap scanner over two tenant databases — **1202/1202, 56 files**, including `numbering-collision.e2e` (2), `tenant-resolution.e2e` (9), `antivirus.e2e` (28), `icap-antivirus` (10), `s3-upload-integrity` (5), `storage-integrity-and-reclamation` (13); five end-to-end shards — "session states" ran `sign-out-revocation.e2e` (22/22 in the shard); container images (API query engine; web branding); product isolation — https://github.com/munaxa/munaxa-docs/actions/runs/36701105091 |

### 4.2 Local gate on `27a8daa` (fresh tenant databases)

| Gate | Result |
| --- | --- |
| Formatting (`pnpm format:check`) | PASS |
| Lint (all packages, uncached) | PASS (warnings only, none new in changed files) |
| Typecheck (all packages, uncached) | PASS |
| Unit | PASS — api 892 passed / 1 skipped (the same pre-existing skip as `c87519e`); web 508; contracts 63; domain 164; i18n 80; utils 38; worker 2 |
| Build | PASS |
| **Integration** (real PostgreSQL, two tenants, **real object store and real ClamAV 1.5.4 / c-icap 0.5.10**) | **PASS — 1202/1202, 56 files, 0 skipped**, including `numbering-collision.e2e` (2), `tenant-resolution.e2e` (9), `antivirus.e2e` (28), `icap-antivirus` (10), `s3-upload-integrity` (5), `storage-integrity-and-reclamation` (13) |
| **Web sign-out replay** (`sign-out-revocation.e2e`, real Chromium, real API) | **PASS — 1/1** |

### 4.3 Staging smoke on `27a8daa`'s own images

A staging-shaped deployment of API and web images built from a clean export of `27a8daa`, labelled
`org.opencontainers.image.revision=27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5`. Local image IDs:
API `sha256:ec46937671da…`, web `sha256:11767ea5c33a…`. These are **local** IDs, not registry
digests. The procedure is the same as in the `c87519e` package §4:

1. fresh tenant databases, then `scripts/migrate-tenants.mjs` (no new migration);
2. each tenant's administrator by the image's `dist/provision.js`;
3. API, then web, then the scanner probe, then readiness, then smoke.

The environment: `NODE_ENV=production`, `DEPLOYMENT_PROFILE=CLOUD`, and two tenants (`acme` and a
decoy slugged `docs`). Storage used the S3 driver on MinIO, and antivirus was `AV_DRIVER=ICAP` on
the scanner built from `infra/antivirus` (unchanged). Readiness: both tenant databases, cache and
antivirus `UP`.

| Suite | Result |
| --- | --- |
| **Runbook §16, steps 1–21** | **21/21** |
| Release-candidate checks RC-1 … RC-6 (tenant never from the host; TOTP) | **6/6** |
| **NUM-1a** — a per-company reset without `COMPANY_CODE` is refused on save; per-entity + yearly with its segments is accepted | **PASS** |
| **NUM-1b** — a second rule rendering `SMK-0001` (already issued in step 16): submission answers **409 `DUPLICATE`**, field error `NUMBER_SERIES_COLLISION: numbering rule "…" drew SMK-0001, which is already issued`, **twice**; the document stays `DRAFT`, unnumbered and unchanged; no review task; no submission in its audit timeline | **PASS** |
| **Smoke total** | **29/29** |
| Real Chromium on the web image: organisation field required; blank organisation refused; named-tenant sign-in; branding assets 5/5; session cookies httpOnly and host-only | **5/5** |
| **WEB-1 in Chromium**: `edms_tenant` = `acme`, httpOnly, `SameSite=Lax`, `Secure`, expiry equal to `edms_rt`; sign-out via the account menu returns to `/login` and clears `edms_at`, `edms_rt` and `edms_tenant`; the refresh token copied before sign-out, replayed **with its tenant**, is **refused 401** | **3/3** |
| **Browser total** | **8/8** |
| Scanner | ClamAV **1.5.4**, c-icap **0.5.10**; `probe.mjs`: clean → 204, EICAR blocked (`Eicar-Test-Signature`) |

**Notes on the harness.** The smoke and browser scripts are those of the `c87519e` run, extended
with NUM-1a/b and the three WEB-1 browser checks. The first run failed only at NUM-1b, and the
fault was the harness. It expected the collision at approval, but the rule reserves its number at
submission (the default), and the product refused there with the correct 409. The check was
corrected to assert at submission, the environment was redeployed fresh, and the table above is
**one clean run**. The sandbox's proxy CA was given to the **build stage only**. It is absent from
both runtime images (verified: no `/proxy-ca.crt`, no proxy environment, apt sources restored).

The first build of the web image was refused by Docker Hub's rate limit (429) while resolving
`node:22-bookworm-slim`. It was retried unchanged and succeeded.

## 5. Production images

| Item | Value |
| --- | --- |
| Registry | `ghcr.io/munaxa` — `munaxa-docs-api`, `munaxa-docs-web`, `munaxa-docs-antivirus` |
| Process | `.github/workflows/publish-images.yml`, started by a tag `image/<full SHA>` |
| Tags | `<short>` and `sha-<full SHA>` — **no `latest`, ever** |
| Deployment references | **`image@sha256:<digest>` only** |
| **Status** | **PUBLISHED as release `4e8e1ca`** — tag `image/4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b`, run `36819091004`. No tag was pushed for `27a8daa` itself. The release record is [production-release-package-4e8e1ca.md](./production-release-package-4e8e1ca.md) |

### 5a. Published registry digests (release `4e8e1ca`)

| Image | Digest | Revision label | Pulled with the production pull identity | Extra check |
| --- | --- | --- | --- | --- |
| API | `ghcr.io/munaxa/munaxa-docs-api@sha256:6c1a6b31fa3502ddfe6df2fdc9d6c723edc7def711bd90f5d8525f2247872f10` | ☑ `4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b` | ☑ | ☑ query engine (`debian-openssl-3.0.x`) |
| Web | `ghcr.io/munaxa/munaxa-docs-web@sha256:815a4aa28cf75c58bd4cd4cb4031db26ef60acaa9ba7649f7b6c0a710341d4eb` | ☑ `4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b` | ☑ | ☑ `/branding/docs/favicon/favicon-32.png` → `200 image/png` |
| Antivirus | `ghcr.io/munaxa/munaxa-docs-antivirus@sha256:9920e03462439db55b40f6929e8fb60f11f72ddcc104d0320d171b28b8d194dc` | ☑ `4e8e1ca825b4bc376dc15566c9ba9e5938a6ae7b` | ☑ | ☑ non-root 101:102; ClamAV 1.5.4 / c-icap 0.5.10; `probe.mjs` exit 0 |

The images of the superseded line `8cb4c14` (run `36722457128`) are **not deployable**; its
antivirus image `sha256:02298beca666…` is the old root-starting scanner.

## 6. Infrastructure and migration impact

- **No new migration and no SQL change**, so the migration procedure (runbook §12) is unchanged.
- **No new environment variable, secret or infrastructure component.** `edms_tenant` is a
  browser cookie set by the web with the same attributes as the existing session cookies. No proxy,
  CDN or cookie allow-list change is needed, unless such a list enumerates cookie names, in which
  case it must include `edms_tenant`.
- Operators upgrading an existing tenant may review its numbering rules. A stored rule with a
  company, entity, branch, document-type or category reset but no matching code segment still
  issues numbers; a collision now answers 409 and is refused atomically.

The production infrastructure prerequisites, the go-live sequence (runbook §21) and the rollback
rules (runbook §20) apply to `27a8daa` exactly as they did to `c87519e`. Status and evidence:
[production-prerequisites-checklist.md](../operations/production-prerequisites-checklist.md).

## 7. Status of the candidate

`27a8daa` passed every check this release required: unit tests, the complete local gate,
real-Postgres two-tenant integration with object storage and antivirus, tenant resolution, the new
WEB-1 and NUM-1 regressions, full CI (run 554, 9/9), and the staging smoke on its own images
including Chromium. It is therefore **eligible to become the production release**, subject to three
steps outside this package:

1. the change approver's acceptance, including the accepted limitations WF-1 and KEY-1 (§3);
2. publishing its images by tag, and recording their digests (§5a) — **done**, as release `4e8e1ca`;
3. the open production infrastructure prerequisites — **still NOT READY**.

Production remains **NO-GO** until the first and third are done.
