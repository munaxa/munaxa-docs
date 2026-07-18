# Munaxa — Security Hardening Audit (June 2026)

**Auditor:** Principal Security Engineer (automated review)
**Scope:** `apps/api` (NestJS), `apps/admin` (Next.js), `apps/mobile` (Flutter), `prisma/*`,
`infra/*`, CI/CD, multi-tenant data layer.
**Date:** 2026-06-16
**Method:** Full source review of authentication, authorization, tenant isolation, the data
access layer, file uploads, frontend, and infrastructure configuration.

> **Note on verification:** This container is offline and workspace dependencies are not
> installed, so `tsc`/`jest` could not be executed here. The code patches in this PR follow the
> repository's existing patterns and ship with unit/e2e tests; **run `pnpm -w typecheck` and
> `pnpm -w test` / `pnpm --filter @munaxa/api test:e2e` in CI to confirm green.**

---

## 1. Executive Security Report

Munaxa is a **multi-tenant School Operating System** holding the highest-sensitivity data a
SaaS can hold: **minors' PII, academic grades, attendance/location (presence & bus), medical
records, and financial/e-invoicing data**, across many isolated schools (tenants) on shared
infrastructure.

The **baseline security posture is strong and above industry norm** for a product at this stage:

- **Password storage:** memory-hard **scrypt** (N=2¹⁵), timing-safe compare, transparent
  bcrypt→scrypt upgrade on login.
- **Sessions:** short-lived **HS256 access JWT** + **opaque rotating refresh tokens** stored only
  as SHA-256 hashes, with **refresh-reuse detection** that revokes the whole token family.
- **Brute force:** per-IP throttle (20/min on login) **plus** per-account lockout (5 fails/15 min)
  derived from the committed audit trail.
- **Tenant isolation:** request-scoped `AsyncLocalStorage` context **+ PostgreSQL Row-Level
  Security** running as a `NOBYPASSRLS` role, with a `TenantIsolationGuard` rejecting cross-tenant
  IDs — genuine defense in depth.
- **Input safety:** global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted` (kills most
  mass-assignment), Prisma parameterized queries (no raw SQL string concatenation found),
  AES-256-GCM for integration secrets at rest.
- **Frontend:** React auto-escaping, **no** `dangerouslySetInnerHTML`/`eval`, production CSP +
  HSTS + nosniff + frame-deny, mobile uses OS secure storage (Keychain/Keystore).
- **Audit logging:** append-only `AuditLog` (RLS-enforced, no UPDATE/DELETE policy), written in
  the **same transaction** as financial state changes.

The audit nonetheless found a set of **practical, exploitable gaps** — most importantly a
**hole in the RLS "backstop" covering the entire finance/e-invoicing and presence subsystem**,
**unrestricted file-upload content types**, a **cross-tenant object-reference (BOLA) path through
storage keys**, **no MFA**, **JWTs in browser `localStorage`**, and **no bot/credential-stuffing
defense**. Several controls described in `docs/architecture/09-security-architecture.md` (AV
scanning, MFA, `tokenVersion`, Cloudflare WAF, distributed rate limiting) are **documented but not
yet implemented** — the doc reads as target state, not shipped state.

**Three of the highest-value, lowest-risk fixes are implemented in this PR** (see §6). The
remainder are specified with exact patches and migration steps for scheduled rollout.

### Headline risks

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| F1 | RLS not enabled on 13 finance/e-invoicing + presence tables (isolation backstop has holes) | **High** | ✅ Fixed in this PR |
| F2 | Unrestricted upload content-type (no MIME allow-list) → malware / stored-XSS | **High** | ✅ Fixed in this PR |
| F3 | Cross-tenant object reference via client-supplied `fileKey`/`receiptKey` (BOLA, bypasses RLS) | **High** | ✅ Fixed in this PR |
| F4 | Access **and** refresh JWT in browser `localStorage` → XSS = durable account takeover | **High** | Specified |
| F5 | No MFA anywhere (admins, finance, platform) | **High** | Specified |
| F6 | No bot / credential-stuffing / scraping defense (no CAPTCHA/Turnstile, no proxy/TOR control) | **High** | Specified |
| F7 | In-memory (non-distributed) rate limiting; per-IP only | **Medium** | Specified |
| F8 | Inconsistent intra-tenant ownership checks (timetable, structure update FKs) | **Medium** | Specified |
| F9 | Account enumeration via cross-tenant "multiple accounts" error | **Medium** | Specified |
| F10 | No AV/malware scan on uploads (documented control unimplemented) | **Medium** | Specified |
| F11 | CSP `script-src 'unsafe-inline'` weakens XSS mitigation | **Medium** | Specified |
| F12 | Access token valid ≤15 min after suspend/role-change (no `tokenVersion`) | **Medium** | Specified |
| F13 | HIBP breach check opt-in + fail-open, off by default | **Low** | Specified |
| F14 | Sentry error-replay with no explicit input masking | **Low** | Specified |
| F15 | `JWT_ACCESS_SECRET` min length only 16 chars | **Low** | Specified |
| F16 | No edge WAF / Cloudflare rules; API HSTS relies on edge | **Medium** | Specified |
| F17 | No "password changed / new device" notification email | **Low** | Specified |

### Security score

| | Score (0–100) |
|---|---|
| **Pre-audit** | **68 / 100** — strong fundamentals, material gaps in isolation backstop, uploads, MFA, bot defense |
| **With this PR's 3 fixes applied** | **~75 / 100** |
| **With full remediation plan (§2)** | **~90 / 100** (target) |

Scoring rationale: the cryptographic, session, and audit foundations are excellent (would alone
score high), but a multi-tenant system handling minors' data is judged strictly on **isolation
completeness** and **account-takeover resistance**, where MFA absence, `localStorage` tokens, the
RLS gap, and missing bot defense each cap the ceiling.

---

## 2. Prioritized Remediation Plan

**Phase A — Immediate (this PR / this week)**
1. ✅ Enable RLS on the 13 finance/presence tables (**F1**) — migration `20260616120000_finance_presence_rls`.
2. ✅ Upload content-type allow-list + size ceiling + SSE at presign (**F2**) — `StorageService`.
3. ✅ Tenant-scope check on all client-supplied storage keys (**F3**) — `assertKeyInTenant`.
4. Turn on `PASSWORD_BREACH_CHECK=1` in production env (**F13**) — config only.

**Phase B — 2 weeks (account-takeover hardening)**
5. Move refresh token to **httpOnly + Secure + SameSite=Strict cookie**; keep access token in
   memory only (not `localStorage`) (**F4**).
6. Add **TOTP MFA** (mandatory for Platform + Finance roles, optional elsewhere) (**F5**).
7. Add `tokenVersion` claim; bump on suspend/disable/role change to invalidate live access tokens (**F12**).
8. Generic account-enumeration responses; require `tenantSlug` instead of revealing multiplicity (**F9**).

**Phase C — 1 month (abuse & edge)**
9. **Cloudflare Turnstile** on login / reset / any self-service registration; **Redis-backed**
   distributed rate limiting; per-account + per-IP + per-ASN limits (**F6, F7**).
10. **Cloudflare WAF** in front of API + Admin; managed ruleset, bot fight mode, rate rules, TOR/VPN
    challenge for sensitive routes; enforce **HSTS preload** at edge (**F16**).
11. **ClamAV** (or S3 + Lambda AV) scan-before-available pipeline; quarantine + audit on hit (**F10**).
12. Tighten CSP to **nonce-based** script-src (drop `'unsafe-inline'`) (**F11**).

**Phase D — ongoing (intra-tenant authZ & monitoring)**
13. Service-layer **ownership scoping**: a teacher edits only their own sections' timetable/grades/
    attendance; validate FK reassignment on all update endpoints (**F8**).
14. Sentry input masking + PII scrubbing; "password changed / new login" notifications (**F14, F17**).
15. Raise `JWT_ACCESS_SECRET` minimum to 32 chars; document JWT signing-key rotation (`kid`) (**F15**).

---

## 3. Top 20 Critical Fixes (ranked)

1. **Close the RLS gap** on finance/e-invoicing/presence tables. *(done)*
2. **Allow-list upload MIME types**; reject `text/html`, `image/svg+xml`, executables. *(done)*
3. **Validate client storage keys belong to the tenant** before store/sign. *(done)*
4. **Move JWTs out of `localStorage`** → httpOnly cookie (refresh) + memory (access).
5. **Add MFA (TOTP)**, mandatory for Platform & Finance.
6. **Bot defense**: Turnstile/CAPTCHA on auth + reset endpoints.
7. **Distributed (Redis) rate limiting**, per-account + per-IP + per-ASN.
8. **`tokenVersion`** claim to revoke live access tokens on suspend/role change.
9. **Edge WAF (Cloudflare)** + bot fight + managed rules + HSTS preload.
10. **AV scanning** before an uploaded file is downloadable.
11. **Generic auth errors** — kill cross-tenant account enumeration.
12. **Nonce-based CSP** (remove `'unsafe-inline'`).
13. **Enforce upload size at the bucket** via presigned POST policy (content-length-range).
14. **Ownership scoping** for teacher grade/attendance/timetable mutations.
15. **Validate FK reassignment** on `PATCH` (grade→campus, classroom→campus, etc.).
16. **Enable HIBP breach check** in production.
17. **Sentry masking/scrubbing** of inputs and PII in replays/breadcrumbs.
18. **Security notifications** (password changed, new device login) to user + guardian.
19. **Raise JWT secret min length to 32**; add `aud`/`iss`; plan key rotation (`kid`).
20. **Rate-limit & audit downloads** of student records (presigned GET) to deter scraping.

---

## 4. OWASP Top 10 (2021) Mapping

| OWASP | Munaxa findings | Status |
|-------|-----------------|--------|
| **A01 Broken Access Control** | F3 (storage BOLA, fixed), F8 (intra-tenant ownership), F1 (RLS gap, fixed) | Partially fixed |
| **A02 Cryptographic Failures** | F4 (`localStorage` tokens), F15 (JWT secret length); scrypt/AES-GCM/TLS otherwise solid | Open (F4/F15) |
| **A03 Injection** | None found — Prisma parameterized, ValidationPipe whitelist, no raw SQL strings | ✅ Clean |
| **A04 Insecure Design** | F5 (no MFA), F6 (no bot defense), F10 (no AV), F12 (token revocation latency) | Open |
| **A05 Security Misconfiguration** | F11 (CSP unsafe-inline), F16 (no WAF), F2 (upload types, fixed) | Partially fixed |
| **A06 Vulnerable Components** | Pinned deps + lockfile; ensure Dependabot/`pnpm audit` in CI | Verify in CI |
| **A07 Identification & Auth Failures** | F5 (MFA), F6 (stuffing), F9 (enumeration), F13 (breach check) | Open |
| **A08 Software & Data Integrity** | Append-only audit log ✅; verify CI provenance / signed images | Mostly ✅ |
| **A09 Logging & Monitoring Failures** | F14 (Sentry masking), F17 (security notifications); good access/audit logging | Minor gaps |
| **A10 SSRF** | HIBP is the only outbound user-influenced call (fixed host, k-anonymity) — no SSRF found | ✅ Clean |

---

## 5. Detailed Findings

Each finding: **severity · attack scenario · business impact · vulnerable code · secure
replacement · migration steps · automated tests.** Findings F1–F3 are implemented in this PR; the
rest carry ready-to-apply patches.

### F1 — RLS not enforced on finance / e-invoicing / presence tables — **HIGH** ✅ Fixed

- **Scenario:** The architecture advertises PostgreSQL RLS as "layer 4 — even if an app-layer bug
  omits a tenant filter, Postgres won't return another tenant's rows." But RLS was only enabled on
  ~58 of 71 tables. **13 tenant-scoped tables had no policy**:
  `EInvoiceSettings, EInvoiceCredential, EInvoiceCounter, EInvoiceDocument, EInvoiceLog,
  FeeAdjustment, PaymentAllocation, PaymentReminder, Refund, StudentBillingProfile,
  AttendanceSourceConfig, StudentPresenceEvent, BusAttendanceEvent`. A single missing `where:
  { tenantId }` in any query touching these — or a future `$queryRaw` — leaks or cross-writes
  **financial records and student location/presence data** between schools. (`EInvoiceCredential`
  also stores encrypted tax-authority secrets.)
- **Business impact:** Cross-tenant disclosure of minors' location and another school's finances;
  GDPR/Jordan PDPL breach; loss of multi-tenant trust; potential financial fraud.
- **Vulnerable code:** `prisma/migrations/20260603120100_tenant_rls/migration.sql` and successors
  enabled RLS table-by-table and never listed the 13 above.
- **Secure replacement:** New migration applies the same `tenant_isolation` policy
  (`USING/WITH CHECK "tenantId" = app_current_tenant() OR app_is_platform()`) with `ENABLE` +
  `FORCE ROW LEVEL SECURITY`. Safe because every runtime path already runs inside `withTenant`
  (sets `app.tenant_id`) or `withPlatform` (sets `app.is_platform='on'`), verified across
  `finance/`, `einvoicing/`, `presence/`.
- **Migration steps:** ship `prisma/migrations/20260616120000_finance_presence_rls/`; CI runs
  `prisma migrate deploy` then re-applies `infra/postgres/app-role.sql` (already wired in
  `deploy.yml`). No data migration; additive. Rollback = drop the policies.
- **Tests:** `apps/api/test/tenant-isolation.e2e-spec.ts` extended — asserts `relrowsecurity` and
  `relforcerowsecurity` are `true` for all 13 tables via `pg_class`.

### F2 — Unrestricted upload content-type → malware / stored-XSS — **HIGH** ✅ Fixed

- **Scenario:** Every presign DTO declared `contentType: string` with **no allow-list**.
  `StorageService.presignUpload` signed a PUT for **any** type. A parent/teacher/student requests a
  presigned URL for `text/html` (or `image/svg+xml`), uploads an XSS/phishing page, then shares the
  presigned **GET** — the browser renders it inline from the storage origin. Executable/macro types
  enable malware distribution through a trusted school domain.
- **Business impact:** Stored XSS / session theft, malware hosting under the school brand, phishing,
  reputational and legal exposure.
- **Vulnerable code:** `apps/api/src/common/storage.service.ts` (`presignUpload` took `contentType`
  verbatim into `PutObjectCommand`); DTOs in `parent-portal/documents`, `academics/homework`,
  `finance/transactions`, `student-portal/resources`.
- **Secure replacement (shipped):** `ALLOWED_UPLOAD_MIME` allow-list (PDF, common images sans SVG,
  office docs, text/csv); `assertUploadAllowed()` rejects others with `400`; `presignUpload` calls
  it before minting a URL; adds `ServerSideEncryption: 'AES256'` and `ContentLength` cap; global
  `MAX_UPLOAD_BYTES = 50 MB`. Centralized → covers **all** upload paths.
- **Migration steps:** none (code only). Confirm clients only upload allow-listed types; extend the
  set if a legitimate type is rejected. **Follow-up:** switch to **presigned POST** with a
  `content-length-range` policy condition to hard-enforce max size on streaming uploads, and add AV
  scanning (**F10**).
- **Tests:** `apps/api/src/common/storage.service.spec.ts` — accepts allow-listed, rejects
  `text/html`/`svg`/executables/`application/zip`, rejects oversized, verifies key sanitization.

### F3 — Cross-tenant object reference via client storage keys (BOLA) — **HIGH** ✅ Fixed

- **Scenario:** Uploads are two-step: presign returns a server-built key
  `tenants/<tenantId>/…`, then the client **echoes a `fileKey` back at "confirm"** which is stored
  verbatim. Storage lives outside Postgres, so **RLS cannot stop a client from confirming another
  tenant's key.** Tenant A registers `tenants/<TenantB-id>/documents/…` as a homework attachment /
  parent document / resource / payment receipt; later `presignDownload` mints a working GET for
  **Tenant B's private file** (report cards, medical docs, receipts).
- **Business impact:** Direct cross-tenant exfiltration of minors' documents and financial receipts.
- **Vulnerable code:** `academics/homework/homework.service.ts#confirmAttachment`,
  `parent-portal/documents/document.service.ts#confirm`,
  `student-portal/resources/resource.service.ts#create`,
  `finance/transactions/transaction.service.ts#create` — each stored `dto.fileKey`/`receiptKey`
  without validating tenant ownership.
- **Secure replacement (shipped):** `StorageService.assertKeyInTenant(fileKey)` requires the key to
  start with `tenants/${requireTenantId()}/` and contain no `..`; called at all four confirm sites
  (plus re-validates declared type/size on confirm, since the presign step can be skipped).
- **Migration steps:** none (code only).
- **Tests:** `storage.service.spec.ts` — accepts own-tenant key, rejects another tenant's key and
  traversal/unscoped keys (run inside `TenantContextStore.run`).

### F4 — Access & refresh JWT in browser `localStorage` — **HIGH** (specified)

- **Scenario:** `apps/admin/src/lib/auth.ts` stores both tokens in `localStorage`, readable by any
  injected script. One XSS (compounded by F11's `'unsafe-inline'` CSP) yields the long-lived
  **refresh** token → durable account takeover surviving page reloads. Mobile is fine (Keychain).
- **Business impact:** Full admin/finance account takeover from a single XSS; grade/finance tampering.
- **Vulnerable code:** `apps/admin/src/lib/auth.ts:28-43`.
- **Secure replacement:** Server sets refresh token as **`Set-Cookie: refresh=…; HttpOnly; Secure;
  SameSite=Strict; Path=/api/v1/auth`**; `/auth/refresh` reads it from the cookie; access token
  held **in memory** (React state), never persisted. Requires API cookie support + CSRF defense for
  the cookie-based refresh route (double-submit token or `SameSite=Strict` + origin check).
- **Migration steps:** add `cookie-parser`; emit/clear cookie in `auth.controller` login/refresh/
  logout; update admin client to stop writing `localStorage` and rely on `credentials: 'include'`.
- **Tests:** e2e — login `Set-Cookie` has `HttpOnly`+`Secure`+`SameSite`; refresh works from cookie;
  access token absent from `localStorage`; logout clears cookie + revokes family.

### F5 — No MFA — **HIGH** (specified)

- **Scenario:** No TOTP/WebAuthn anywhere (`grep` for `totp|mfa|otp|webauthn` → none). Password +
  refresh is the only factor for Platform admins, Finance, and school admins. A single phished/
  stuffed credential = full access. `09-security-architecture.md` lists MFA as a control; it is not
  implemented.
- **Business impact:** Account takeover of privileged roles → mass grade/finance/PII compromise.
- **Secure replacement:** Add `User.totpSecret` (encrypted) + `mfaEnrolledAt`; `/auth/mfa/enroll`
  (QR), `/auth/mfa/verify`; require a second step in `login` when MFA enrolled; **enforce** for
  `PLATFORM_*` and finance roles. Recovery codes (hashed). WebAuthn as a later upgrade.
- **Migration steps:** Prisma migration for the new columns; staged rollout (optional → enforced
  for privileged roles); admin enrollment UI.
- **Tests:** login without 2nd factor blocked when enrolled; correct/incorrect TOTP; recovery-code
  single-use; platform role cannot complete login without MFA.

### F6 — No bot / credential-stuffing / scraping defense — **HIGH** (specified)

- **Scenario:** Login is protected only by a per-IP throttle (20/min) + per-account lockout. A
  botnet (rotating IPs/residential proxies/TOR) performs distributed credential stuffing and
  account enumeration under the per-IP ceiling. Authenticated student-record list endpoints have no
  scraping controls, enabling bulk export of minors' data by a compromised low-priv account.
- **Business impact:** Mass account takeover; bulk PII scraping; enumeration.
- **Secure replacement:** **Cloudflare Turnstile** on login/reset/registration (server-verified);
  **Cloudflare Bot Fight / managed challenge**, rate rules, and **TOR/known-proxy challenge** at the
  edge; per-account velocity limits; pagination caps + per-principal download rate limits + audit on
  student-record reads (deter scraping). Optional device-fingerprint risk scoring.
- **Migration steps:** front API/Admin with Cloudflare; add Turnstile widget + `siteverify`; tune
  WAF rate rules; add Redis-backed per-account counters.
- **Tests:** login rejected without valid Turnstile token; automated burst returns `429`/challenge;
  list endpoints enforce max page size; download endpoints rate-limited + audited.

### F7 — In-memory, per-IP rate limiting — **MEDIUM** (specified)

- **Scenario:** `ThrottlerModule.forRoot` uses the default **in-memory** store, so limits are
  **per instance** — horizontal scaling multiplies the effective limit, and a restart resets
  counters. Keyed on IP only. (`09-security-architecture.md` says "Redis-backed" — not implemented.)
- **Business impact:** Rate limits weaken/ineffective at scale; easier brute force/stuffing.
- **Secure replacement:** `@nestjs/throttler` Redis storage (`ThrottlerStorageRedisService`) using
  the existing `REDIS_URL`; add named throttlers (stricter on auth/reset/upload) keyed by
  account+IP.
- **Tests:** limit holds across two app instances sharing Redis; `429` + `Retry-After` returned.

### F8 — Inconsistent intra-tenant ownership checks — **MEDIUM** (specified)

- **Scenario:** RLS scopes by **tenant**, not by **ownership within** a tenant. Several endpoints
  rely on a coarse permission only:
  - **Timetable:** any holder of `TIMETABLE_MANAGE` (e.g. VicePrincipal) can `GET/PATCH/DELETE` any
    section's slots/exceptions and any campus config via `:id`/`:campusId`, regardless of which
    sections/campuses they actually run
    (`timetable/slots/slot.controller.ts`, `timetable/exceptions/exception.controller.ts`,
    `timetable/config/config.controller.ts`). Teachers/students/parents hold `TIMETABLE_READ`.
  - **Structure:** `PATCH` endpoints accept foreign-key changes without re-validation —
    `grade.service.ts`/`classroom.service.ts` `update()` pass `dto` straight to the repo, so a
    `campusId` can be reassigned to an unchecked value (data-integrity / orphaning).
  - **Grades/attendance:** confirm that a teacher can only mutate **their own** sections' records.
- **Business impact:** Grade/attendance/timetable tampering across a school by mid-level staff;
  data-integrity corruption. (Genuine cross-**tenant** access is still blocked by RLS — this is
  intra-tenant.)
- **Secure replacement:** Introduce a reusable ownership guard/service (mirroring
  `student-portal`/`parent-portal` `*ScopeService.assertManageAccess`) and call it in timetable,
  grade, and attendance mutations; validate FK existence/scope on every `PATCH` that accepts a
  parent id (or strip immutable FKs from `Update*Dto`).
- **Tests:** teacher A editing teacher B's section slot/grade → `403`; `PATCH grade` with a foreign
  `campusId` → `400`; VicePrincipal limited to assigned campuses.

### F9 — Account enumeration via cross-tenant error — **MEDIUM** (specified)

- **Scenario:** Login/reset are correctly generic for the common case, **but**
  `resolveUserByEmail`/`resolveUserByIdentifier` throw `BadRequestException('Multiple accounts
  found for this email; specify the school.')` when a handle exists at >1 tenant — revealing that an
  email/national-ID is registered, and at multiple schools. The mobile/web defaults send no
  `tenantSlug`, so this path is reachable.
- **Business impact:** Confirms account existence / cross-school enrollment of a child; aids
  targeted phishing and stuffing.
- **Secure replacement:** Always require the tenant context (slug/subdomain) for login/reset, or
  return the same generic `401`/`202` without disclosing multiplicity; never branch the error on
  account count.
- **Tests:** identical response/status/time for unknown vs. single vs. multi-tenant handles.

### F10 — No AV/malware scanning on uploads — **MEDIUM** (specified)

- **Scenario:** Files become downloadable immediately after confirm; no scan. Even allow-listed
  types (PDF/office) can carry exploits/macros. `09-security-architecture.md` depicts an AV step
  that doesn't exist.
- **Secure replacement:** S3 event → ClamAV/Lambda scan → mark `available`/`quarantined`;
  `presignDownload` refuses non-`available` objects; quarantine → audit + notify. Pair with F2's
  allow-list.
- **Tests:** infected fixture → quarantined + no download URL; clean → available.

### F11 — CSP allows `'unsafe-inline'` scripts — **MEDIUM** (specified)

- **Vulnerable code:** `apps/admin/next.config.mjs` `script-src 'self' 'unsafe-inline'`; CSP is
  production-only (none in dev).
- **Secure replacement:** nonce-based `script-src` (Next.js middleware nonce), drop
  `'unsafe-inline'`; this materially raises the bar for F4's XSS→takeover path.
- **Tests:** CSP header contains a per-response nonce and no `'unsafe-inline'` in `script-src`.

### F12 — Access token valid ≤15 min after suspend/role change — **MEDIUM** (specified)

- **Scenario:** Access JWT carries `roles`/`perms` and is verified statelessly with no
  `tokenVersion`/`jti` denylist. Refresh families are revoked on password change/suspend, but an
  already-issued access token keeps working until expiry — a suspended teacher/abuser retains access
  for up to 15 minutes. (Documented as an accepted trade-off, but worth closing for privileged roles.)
- **Secure replacement:** add `tokenVersion` to `User` + JWT claim; `JwtAuthGuard` rejects on
  mismatch (cache version in Redis to stay fast); bump on suspend/disable/role change/password reset.
- **Tests:** suspended user's existing access token → `401` on next request after version bump.

### F13 — HIBP breach check opt-in & fail-open — **LOW** (specified)

- Set `PASSWORD_BREACH_CHECK=1` in production (config only). Fail-open on outage is acceptable;
  consider also checking at **login** for high-priv roles. Test: known-breached password rejected
  on change when enabled.

### F14 — Sentry error-replay without input masking — **LOW** (specified)

- `apps/admin/sentry.client.config.ts` captures 100% of error sessions with no explicit
  `maskAllText`/`maskAllInputs`/`blockAllMedia`; with tokens in `localStorage` (F4) replays could
  capture sensitive data. Set explicit masking + `beforeSend` PII scrubbing. Test: config asserts
  masking flags on.

### F15 — JWT secret minimum length 16 — **LOW** (specified)

- `env.validation.ts` allows a 16-char `JWT_ACCESS_SECRET`. Raise minimum to **32**; add `aud`/`iss`
  to signed tokens and verify them; plan signing-key rotation via `kid`. (Change the validator only
  after confirming production secrets are ≥32 chars to avoid a boot failure.)

### F16 — No edge WAF; API HSTS at edge only — **MEDIUM** (specified)

- Put **Cloudflare** in front of API + Admin: managed WAF ruleset, bot fight mode, rate rules,
  DDoS, and **HSTS (with preload)** at the edge; restrict origin to Cloudflare IPs. The API's
  `helmet()` provides HSTS only when TLS-terminated at the app; behind a proxy, set it at the edge.

### F17 — No security notifications — **LOW** (specified)

- No email on password change / new-device login. Add notifications to the user (and guardian for
  minor accounts) to surface takeover early. Test: password change triggers a queued notification.

---

## 6. Secure Code Patches (implemented in this PR)

| Area | File(s) | Change |
|------|---------|--------|
| RLS gap (F1) | `prisma/migrations/20260616120000_finance_presence_rls/migration.sql` | Enable+force RLS + `tenant_isolation` policy on 13 finance/presence tables |
| Upload allow-list (F2) | `apps/api/src/common/storage.service.ts` | `ALLOWED_UPLOAD_MIME`, `assertUploadAllowed`, SSE-S3, size cap |
| Storage BOLA (F3) | `storage.service.ts` + `homework.service.ts`, `documents/document.service.ts`, `resources/resource.service.ts`, `transactions/transaction.service.ts` | `assertKeyInTenant` enforced at every confirm/create that accepts a client key |
| Size threading (F2) | `transactions/transaction.service.ts`, `academics/homework/homework.service.ts` | Pass declared `size` into presign for the bucket-level `ContentLength` cap |
| Tests | `apps/api/src/common/storage.service.spec.ts`, `apps/api/test/tenant-isolation.e2e-spec.ts` | Unit tests for allow-list + BOLA; e2e RLS coverage assertion |

The remaining findings (F4–F17) include concrete replacement designs above; they are intentionally
**not** auto-applied because they need product decisions (MFA UX, cookie/CSRF model), infra changes
(Cloudflare, Redis, ClamAV), or coordinated client work.

---

## 7. Penetration Testing Checklist

**Authentication**
- [ ] Brute force `/auth/login` past 20/min per IP; confirm `429`, then per-account lockout after 5 fails.
- [ ] Distributed stuffing from rotating IPs/TOR — measure whether lockout/throttle holds.
- [ ] Refresh-token **reuse**: replay a rotated token → whole family revoked (`auth.refresh.reuse`).
- [ ] Token theft: confirm access token in admin `localStorage` (F4) and demonstrate reuse.
- [ ] Password reset: token single-use, 1-hour expiry, no enumeration on request; reset revokes sessions.
- [ ] Enumeration: compare responses for unknown / single-tenant / multi-tenant handles (F9).
- [ ] JWT: alg-confusion (`none`/RS↔HS), tampered `perms`/`tid`, expiry handling; post-suspend window (F12).

**Authorization / tenancy**
- [ ] Cross-tenant IDs in params/query/body → `403` (TenantIsolationGuard) and RLS denial.
- [ ] **Storage BOLA (F3):** confirm/download another tenant's `fileKey` → `403` (now fixed).
- [ ] **RLS (F1):** with `app.tenant_id` unset, finance/presence tables return nothing; cross-tenant write rejected.
- [ ] Intra-tenant (F8): teacher edits another section's timetable/grade/attendance → expect `403`.
- [ ] Vertical escalation: low-priv user hits admin/finance/platform routes; custom-role permission tampering.

**API**
- [ ] Mass assignment: extra/unknown fields rejected (`forbidNonWhitelisted`); attempt to set `tenantId`, `status`, `tokenVersion`.
- [ ] Excessive exposure: responses don't leak `passwordHash`, `tokenHash`, `totpSecret`, other tenants' data.
- [ ] Rate limits per route (F7) across multiple instances.
- [ ] Replay/idempotency on financial POSTs.

**Files**
- [ ] Upload `text/html`, `image/svg+xml`, `.exe`, `.js`, zip → rejected (F2, fixed).
- [ ] Oversized upload → rejected at presign and bucket.
- [ ] Path traversal in `fileName`/`fileKey` (`../`) → sanitized/blocked.
- [ ] Presigned URL expiry (15 min) and content-type pinning enforced by S3.
- [ ] AV bypass (EICAR / macro doc) once F10 lands.

**Frontend**
- [ ] XSS sinks (none expected); CSP `'unsafe-inline'` bypass (F11); clickjacking (frame-deny present).
- [ ] Token exposure in bundles/logs/URLs; Sentry replay capture (F14).

**Infra**
- [ ] Security headers (HSTS/CSP/nosniff/frame) on API + Admin; WAF/bot rules (F16); secret scanning in CI.

---

## 8. Production Deployment Checklist

**Secrets & config**
- [ ] `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` set, **distinct**, ≥32 chars, from secrets manager (F15).
- [ ] `PASSWORD_BREACH_CHECK=1` (F13).
- [ ] `CORS_ORIGINS` pinned to real Admin/mobile origins (no wildcard with credentials).
- [ ] `EINVOICE_MASTER_KEY` (32-byte base64) in secrets manager; rotation documented.
- [ ] No secrets in code/`.env` committed (`.gitignore` covers `.env*`; CI secret scanning on).

**Database**
- [ ] API connects as `munaxa_app` (**NOSUPERUSER, NOBYPASSRLS**); migrations as separate owner (`DIRECT_DATABASE_URL`).
- [ ] `prisma migrate deploy` run **including** `20260616120000_finance_presence_rls` (F1).
- [ ] Post-migrate: re-apply `infra/postgres/app-role.sql` grants; verify RLS on **all** tenant tables
      (`SELECT relname FROM pg_class WHERE relrowsecurity AND relkind='r'`).
- [ ] Encrypted backups, restricted access, restore drill; PITR enabled.

**App runtime**
- [ ] `NODE_ENV=production` (Swagger off, env guards active).
- [ ] Helmet on; HSTS enforced at edge with preload (F16); CSP nonce-based (F11).
- [ ] Redis-backed rate limiting (F7); stricter auth/reset/upload limits.
- [ ] Containers run **non-root** with HEALTHCHECK (already in Dockerfiles).

**Edge / network (Cloudflare)**
- [ ] WAF managed ruleset + Bot Fight + rate rules + DDoS; TOR/proxy challenge on auth (F6, F16).
- [ ] Turnstile on login/reset/registration, server-verified.
- [ ] Origin locked to Cloudflare IP ranges; RDS/Redis in private subnets.

**Storage**
- [ ] S3 bucket **private**, SSE enabled (defense-in-depth `ServerSideEncryption` now also set per-object), block public access on.
- [ ] AV scan pipeline live; quarantine bucket + alerting (F10).
- [ ] Presigned URLs short-lived (15 min); downloads audited + rate-limited (anti-scraping).

**Identity**
- [ ] MFA enrolled & **enforced** for Platform + Finance before go-live (F5).
- [ ] Refresh token in httpOnly/Secure/SameSite cookie; access token not persisted (F4).
- [ ] `tokenVersion` revocation wired to suspend/role-change (F12).

**Observability**
- [ ] Sentry input masking + PII scrubbing (F14); alerts on `auth.login.locked`, `auth.refresh.reuse`,
      permission denials, cross-tenant attempts.
- [ ] Access + audit logs shipped to retention store; no PII/secrets in logs (verified — interceptor logs no bodies).

---

## 9. School-Specific Risk Notes

- **Grade manipulation:** mutations are permissioned and audited in-transaction, but **ownership
  scoping is incomplete** (F8) — close so a teacher can edit only their own sections; alert on
  out-of-window grade edits.
- **Attendance manipulation:** same ownership-scoping gap (F8); presence/bus tables now RLS-isolated (F1).
- **Student-record leakage:** F1 (RLS) + F3 (storage BOLA) were the main cross-tenant vectors — both
  fixed; add download rate-limits/audit to deter authorized-but-bulk scraping (F6).
- **Parent/teacher account takeover:** addressed by F4 (cookie tokens), F5 (MFA), F6 (stuffing
  defense), F17 (notifications).
- **Finance tampering:** RLS gap on `Refund/PaymentAllocation/FeeAdjustment/EInvoice*` closed (F1);
  enforce MFA for finance roles (F5); keep the in-transaction audit invariant.

---

*Patches in this PR: §6. Everything else is specified with code/migration/test guidance for
scheduled remediation per §2.*
