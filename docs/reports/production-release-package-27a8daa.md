# Production Release Package — release candidate `27a8daa`

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

Pending: CI run 554 on `27a8daa` in progress.

### 4.2 Local gate on `27a8daa` (fresh tenant databases)

Pending: the local gate is in progress.

### 4.3 Staging smoke on `27a8daa`'s own images

Pending: the staging smoke runs on images built from `27a8daa`.

## 5. Production images

| Item | Value |
| --- | --- |
| Registry | `ghcr.io/munaxa` — `munaxa-docs-api`, `munaxa-docs-web`, `munaxa-docs-antivirus` |
| Process | `.github/workflows/publish-images.yml`, started by the tag `image/27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5` |
| Tags | `27a8daa` and `sha-27a8daa69f878df56ddc8e8e6360ecec6c5ef1a5` — **no `latest`, ever** |
| Deployment references | **`image@sha256:<digest>` only** |
| **Status** | **NOT PUBLISHED**, and no image tag was pushed. Publishing is the operator's step, after the change approver accepts this candidate ([production-infrastructure-implementation.md](../operations/production-infrastructure-implementation.md) 9d) |

### 5a. Published registry digests (to be completed after publishing)

| Image | Repository | Digest | Revision label | Pulled with the production pull identity | Extra check |
| --- | --- | --- | --- | --- | --- |
| API | `ghcr.io/munaxa/munaxa-docs-api` | `sha256:<API_DIGEST>` | ☐ `27a8daa…` | ☐ | ☐ query engine |
| Web | `ghcr.io/munaxa/munaxa-docs-web` | `sha256:<WEB_DIGEST>` | ☐ `27a8daa…` | ☐ | ☐ `/branding/docs/favicon/favicon-32.png` → `200 image/png` |
| Antivirus | `ghcr.io/munaxa/munaxa-docs-antivirus` | `sha256:<AV_DIGEST>` | ☐ `27a8daa…` | ☐ | ☐ ClamAV/c-icap versions from the run; `probe.mjs` exit 0 |

**Until every row holds a verified digest, production is NO-GO.**

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
