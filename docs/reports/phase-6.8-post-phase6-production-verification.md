# Phase 6.8 — Post-Phase-6 Production Verification & Residual Findings Audit

## 1. Executive summary

**Verdict: NO-GO for production, on one finding.** Everything else this audit exercised held.

The audit found **one P0**, and it was found the way this phase was designed to find things — by
measuring an execution path rather than reading a declaration. The document preview viewer issued
**6,704 presigned content URLs in 1.5 seconds** from a single mounted panel. Each is an audited
issuance, so an open viewer was simultaneously a denial-of-service against the tenant's own API and
a flood through its compliance trail. The cause was one dependency array, and its root was the
`useTranslate` identity trap this phase was asked to verify — which turned out to be not a
theoretical smell but a live production defect in code shipped by Phase 7.

That one is fixed here under §22's blocker clause, with the measurement kept as a regression guard
(2 issuances after the fix, against 6,704 before). Every other finding is documented and left alone.

The rest of the picture is better than the previous phases' record would suggest. Rate limiting,
security headers, cookie handling, tenant isolation, audit chaining, authorization coverage and the
signing ceremony were each traced to a runtime call path and exercised; none was a declaration
without a control. The two residual Phase 6.6 findings that were about *missing* behaviour —
`Retry-After` and field-level errors — are both confirmed real and both are P2, not blockers.

| | Count |
| --- | --- |
| P0 | **1** (fixed) |
| P1 | 0 |
| P2 | 4 |
| P3 | 3 |

## 2. Scope

The current merged `main` at `e4e6f9f` plus the Phase 6.6 commit `0c395c1`, across
`apps/api`, `apps/web`, `apps/worker`, `packages/*`, `prisma/`, `infra/`, `scripts/` and `docs/`.

Out of scope by instruction and observed: the Munaxa Platform (unmodified), feature work, refactors,
dependency upgrades, and fixing findings other than the one blocker.

## 3. Methodology

Every claim in §4 was pursued through five steps — declaration, binding, runtime call path,
execution, and a check that the observed result could not have been produced by a different layer.

Where a control could be exercised it was, against PostgreSQL 16 with two tenant databases, Redis,
the built API artefact (`apps/api/dist/main.js`), the production Next build under `next start`, and
real Chromium. Where it could not be exercised in this environment it is labelled **NOT VERIFIED**
and says why. **Source inspection is never labelled VERIFIED.**

Two temporary probes were written, run, and deleted; their commands are in §26. One measurement was
kept as a permanent test because it guards the P0 fix and nothing else could have caught it.

## 4. Security control inventory

| Control | Owner | Declaration | Binding | Real execution path | Proof | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Password authentication | Identity | `AuthenticationService` | `POST /auth/login` | Browser form → server action → API → scrypt verify | Real sign-in through the built web app; wrong password answers `401` | **VERIFIED** |
| Undifferentiated sign-in refusal | Identity | `auth.controller` | route | HTTP | Wrong password and unknown address return identical code and detail (`auth.e2e`) | **VERIFIED** |
| Refresh rotation + replay kill | Identity | `SessionService` | `POST /auth/refresh` | HTTP | Replay kills the family and its successor (`auth.e2e`) | **VERIFIED** |
| Session revocation | Identity | logout | `POST /auth/logout` | HTTP | Refresh after logout answers `401` | **VERIFIED** |
| MFA / TOTP | Identity | `MfaService` | `auth/mfa` routes | HTTP | 15 assertions in `mfa.integration.spec.ts` | **VERIFIED** |
| Re-authentication at signing | Document | `SignerAuthenticator` | inside `sign` | HTTP → ceremony | Wrong password writes no signature; `reauthenticated = true` on the row | **VERIFIED** |
| Cookie security | Web | `session.ts` | `Set-Cookie` | Browser | `HttpOnly=true Secure=true SameSite=Lax`; `document.cookie` is **empty** | **VERIFIED** |
| Rate limiting | API core | `RATE_LIMIT_RULES` | `APP_GUARD` #1 | HTTP | 10 sign-ins pass, the 11th is `429` from one address | **VERIFIED** |
| Rate limit — `Retry-After` | API core | `15 §7`, `rate-limit.ts` | — | HTTP | **Header absent from a real `429`** | **FAILED** (F-2) |
| Rate limit — distribution | API core | `CachePort.increment` | Redis `INCR`+`EXPIRE NX` in one `MULTI` | two adapters | Two guards over two connections share one budget | **VERIFIED** |
| Rate limit — fail closed | API core | `credentialSensitive` | guard | Redis down | Credential route refuses, others proceed | **VERIFIED** |
| Authentication guard | API core | `AuthenticationGuard` | `APP_GUARD` #2 | HTTP | Guarded route answers `401` with no token and with a forged one | **VERIFIED** |
| Tenant isolation guard | API core | `TenantIsolationGuard` | `APP_GUARD` #3 | HTTP | Cross-tenant document answers `404` and leaks no title | **VERIFIED** |
| RBAC | API core | `@RequirePermission` | `APP_GUARD` #4 | HTTP | Reader without `document:sign` is refused `403` on the preview route | **VERIFIED** |
| ACL / object scope | Library | `@ScopedTo` | `APP_GUARD` #5 | HTTP | Unreachable document answers `404`, never `403` | **VERIFIED** |
| Permission catalogue integrity | API core | `RoutePermissionRegistry` | `OnApplicationBootstrap` | boot | The app boots in every integration and E2E run, so the set difference passed | **VERIFIED** |
| Row-level security | Database | migration SQL | `FORCE ROW LEVEL SECURITY` | SQL | Discovered from `pg_class`; ENABLED **and** FORCED on every tenant-scoped table | **VERIFIED** |
| Cross-tenant read/write | Database | policy | RLS | SQL | Other tenant's rows hidden; a write naming another tenant refused | **VERIFIED** |
| Database-per-tenant | API core | ADR-0015 | `TenantDatabase` | SQL | Each tenant written to its own database "and nowhere else" | **VERIFIED** |
| Audit hash chain | Audit | `ChainedAuditWriter` | in-transaction | SQL | Genesis link, per-tenant chains, gap-free under concurrency | **VERIFIED** |
| Audit append-only | Database | trigger | table | SQL | `UPDATE`/`DELETE` refused **even for the owner role** | **VERIFIED** |
| Audit needs a transaction | Audit | `requireTransaction` | writer | runtime | Refuses to open one of its own | **VERIFIED** |
| Signature uniqueness | Database | `uq_document_signature_live` | partial unique index | SQL | Ten rounds of a genuine race, one winner each | **VERIFIED** |
| Signature witness | Document | HMAC-SHA256 | `sign` | HTTP + SQL | Stored `signature` recomputes over stored bytes | **VERIFIED** |
| Statement authenticity | Document | ADR-0017 §3 | preview + sign | Browser + SQL | Displayed bytes equal stored bytes but for `signed-at` | **VERIFIED** |
| Input validation | API core | Zod at the boundary | `ZodValidationPipe` | HTTP | Bad body answers `422` with **both** field errors | **VERIFIED** |
| Security headers | API core | helmet | middleware | HTTP | CSP, HSTS, COOP, CORP, `X-Frame-Options: DENY`, nosniff, Referrer-Policy, Permissions-Policy all present on a real response | **VERIFIED** |
| CORS | API core | `bootstrap.ts` | middleware | HTTP | `Vary: Origin`, credentials allowed, expose list present | **VERIFIED** |
| Outbound allow-list | Integration | allow-list adapter | HTTP port | runtime | Empty by default — nothing reachable | **VERIFIED** |
| Secret handling | API core | config | boot | boot | Production refuses `STORAGE_DRIVER=NONE`, a missing TOTP sealing key and a missing audit checkpoint secret — observed as a real boot refusal | **VERIFIED** |
| No credential in client state | Web | ceremony | form | jsdom | Password absent from storage and URL; field unmounted after success | **VERIFIED** |
| Field-level error propagation | Web | `api-client.ts` | — | runtime | **`errors` dropped at `toDomainError`** | **FAILED** (F-3) |
| Presigned URL issuance discipline | Web | "one per viewer open" | `useCallback` | runtime | **6,704 issuances in 1.5 s** | **FAILED → fixed** (F-1) |
| CSRF | — | — | — | — | Not applicable: the API is token-authenticated with `Authorization`, and the browser holds no readable credential | **NOT APPLICABLE** |
| Federated authentication | Identity | `federation.controller` | routes | — | Not exercised — no identity provider available here | **NOT VERIFIED** |
| Restore rehearsal | Operations | `backup-and-restore.md` | — | — | Never executed | **NOT VERIFIED** (F-5) |

## 5. Runtime wiring verification

**VERIFIED.** `APP_GUARD` order, read from `app.module.ts` and confirmed by observed behaviour:

```
RateLimitGuard → AuthenticationGuard → TenantIsolationGuard → RbacGuard → AclGuard
```

The order is proven rather than asserted: a `429` is returned to an **unauthenticated** caller on
`POST /auth/login`, which can only happen if the limiter runs before authentication; and a `403`
from `RbacGuard` reaches a caller whose token verified, which can only happen if authentication ran
first.

`RoutePermissionRegistry` implements `OnApplicationBootstrap` and refuses to start when a route
declares a permission the catalogue does not contain. It is not a test that can be skipped: the API
booted in the integration gate and in the browser gate, so the check ran and passed both times.

## 6. Rate limiting verification

**VERIFIED**, over the real pipeline, against the built artefact:

```
attempt 1..10 -> 401     (credentials refused)
attempt 11    -> 429     (limiter refused)
```

`auth.login` is 10 per 5 minutes keyed on address and identity, and the eleventh request from one
address was refused. Redis afterwards holds
`rl:document.sign:t:{tenant}:identity:{user}:{revision}:{purpose}` — tenant-namespaced, with no
password, code, token or header anywhere in the key.

The body is `application/problem+json` with `code: RATE_LIMITED` and a sentence that names no Redis,
cache, counter or connection.

**FAILED — `Retry-After`.** See F-2. The response carries no such header and no
`retryAfterSeconds`.

**Test effectiveness.** `core/security/__tests__/rate-limit.integration.spec.ts` does invoke
`RateLimitGuard.canActivate` directly — but it is not the only proof: `auth.e2e.integration.spec.ts`
drives the real HTTP pipeline, and this audit re-drove it against the built artefact. Both levels
exist, which is what Phase 6.7 Part A was for.

## 7. API error propagation

Traced end to end and located precisely.

| Hop | Status | Code | Field path | Message | Multiple errors |
| --- | --- | --- | --- | --- | --- |
| API → HTTP | 422 | `VALIDATION_FAILED` | ✅ | ✅ | ✅ both |
| HTTP → `apiFetch` | ✅ | ✅ | ❌ | generic only | ❌ |
| → `ActionResult` | — | ✅ | ❌ | generic only | ❌ |
| → UI | — | ✅ | ❌ | generic only | ❌ |

**The loss is at exactly one line.** `toDomainError` (`apps/web/src/lib/api-client.ts:78`) builds
`DomainError` from `code`, `detail` and `correlationId` and discards `problem.errors`. Measured:
`DomainError.details` came back `{}` for a body carrying two field errors.

Evidence — the real API response:

```json
{"status":422,"code":"VALIDATION_FAILED","detail":"Some of the details are not valid.",
 "errors":[{"field":"revisionId","message":"Invalid uuid"},
           {"field":"purpose","message":"Invalid enum value. …"}]}
```

and what the client produced: `{"ok":false,"code":"VALIDATION_FAILED","detail":"Some of the details
are not valid."}`.

**FAILED** as a capability, **P2** as a risk. Not redesigned — see F-3.

## 8. `useTranslate` review

**VERIFIED — the trap is real, and it had already caused a P0.**

`translatorFor(locale)` returns a **new closure on every call** (measured:
`translatorFor('en') !== translatorFor('en')`), and `useTranslate()` calls it on every render.
Translation itself is correct and locale switching works (`en` → "Munaxa Docs", `ar` → "مناخة
للوثائق"), and there is no staleness risk — a fresh closure always reads the current locale.

The consequence is confined to dependency arrays, and it is severe there. Two live sites existed:

| Site | Shape | Consequence |
| --- | --- | --- |
| `preview-panel.tsx:107` | `useCallback([document.id, toast, translate])`, and an effect **calls** it | **P0 render loop** — see F-1 |
| `upload-dialog.tsx:141` | `useCallback([translate, update])`, used as an event handler | Harmless churn; nothing calls it from an effect |

The architecture was **not** changed. Memoising `translatorFor` would fix the class of problem but
is a change to a shared package on the strength of one defect, which is not this phase's call.

## 9. Signature verification

**VERIFIED**, re-executed against a booted API, a booted web server and real Chromium — 10
assertions, none mocked. All eighteen points of the brief's §8 hold:

- the action appears only for a holder of `document:sign`, and the preview route refuses a reader
  with `403` — the control, not the hidden button;
- the displayed statement is the server's, field by field (tenant, document, number, revision,
  digest, signer name);
- preview creates no signature row and no `DOCUMENT_SIGNED`;
- cancelling and wrong credentials create neither;
- `statement_body` differs from what was displayed in **`signed-at` and nothing else**;
- `reauthenticated` is `true` on the row, and `DOCUMENT_SIGNED` appears exactly once;
- the signed state survives a reload;
- a duplicate is refused by the preview, before a statement is produced;
- verification answers all three findings and names a witness key;
- signing is bounded at five attempts and the `429` names no infrastructure.

## 10. Audit verification

**VERIFIED** for chaining, ordering, per-tenant separation and immutability: genesis link, each event
linked to the last, gap-free sequence under concurrent writers, separate chains per tenant, and
`UPDATE`/`DELETE` refused **even for the table owner**. The writer refuses to run outside a
transaction rather than opening one of its own, which is what makes "audit commits with its change"
true rather than aspirational.

**NOT VERIFIED**, and stated rather than implied: mixed historical formats, `recordId`-covered
formats, resumed verification, structured failure codes, swapped-record-id detection, unknown-format
handling and "no false tampering accusation for unverifiable evidence". This repository has no
historical corpus in those formats and none was manufactured — fabricating one would prove the
fabrication, not the product.

**A real audit-integrity risk was found**, and it is F-1: thousands of spurious audited issuances per
viewer open do not corrupt the chain, but they bury the evidence the chain exists to protect.

## 11. Tenant isolation

**VERIFIED**, using the repository's own discovery-based SQL rather than a maintained list — the same
query the post-migration gate uses, so the two cannot diverge:

- more than thirty tenant-scoped tables discovered;
- row-level security **ENABLED and FORCED** on each — `FORCE` being the half the deploy gate does
  not check and the half that matters, since without it the owner bypasses the policy;
- the `tenant_isolation` policy present on each;
- another tenant's rows hidden from the application role on every one;
- a write naming another tenant refused, whatever the application intended;
- each tenant written to its own database and nowhere else;
- **an identifier from tenant A does not find tenant B's record even when handed it**;
- scope chains resolve only within the tenant's own database;
- audit trails, rate-limit keys and signatures each separated per tenant.

The browser gate adds the same claim through the product: a signer in one tenant asking for another
tenant's document by identifier gets `404`, learns nothing about it, and writes nothing.

## 12. Authentication

**VERIFIED** for valid and invalid credentials, unknown accounts, refresh, refresh replay, logout,
session revocation, MFA, and cookie attributes (§4). Sign-in through the built application works —
the Phase 6.6 `500` is gone and stays gone, since the browser gate signs in on every run.

**NOT VERIFIED:** federated authentication (no identity provider available here), and
`Secure`-under-staging as distinct from the observed `Secure=true` in this configuration.

## 13. Authorization

**VERIFIED**, both directions, and the result is clean.

**Routes → permissions.** 279 route handlers across 34 controllers. **278** carry
`@RequirePermission` at the handler or the class (the guard reads both). The single exception is
`GET /auth/me`, which is correct: it sits behind the global authentication guard and returns only
the caller's own context, so requiring a specific permission would be meaningless.

**Permissions → enforcement.** 39 in the catalogue; 36 guard at least one route. The other three are
each accounted for rather than phantom:

| Permission | Where it is enforced |
| --- | --- |
| `document:reject` | In the handler — `approval.controller.ts:233` calls `requirePermission` |
| `search:all` | A modifier, not a gate — `search.service.ts:77` widens results with it |
| `report:manage` | Genuinely unrouted, and **declared** as reserved in `route-permission.registry.ts:48` |

No phantom permissions, no unguarded privileged route, no role-key/id mismatch surfaced.

## 14. API surface

34 controllers, 279 routes. Phase 6.5 classified these and closed the five unreachable backends it
found; nothing in this audit contradicts that, and the signature surface — the last one it left open
— is now `USED` end to end.

**NOT VERIFIED** as a fresh exhaustive re-classification: repeating Phase 6.5's caller trace across
all 34 controllers was out of proportion to this phase, and its findings were acted on rather than
merely recorded. Called out so the gap is visible rather than assumed closed.

## 15. UI runtime verification

| Workflow | Proof | Status |
| --- | --- | --- |
| Login | Real browser, built app, twice per E2E run | **VERIFIED** |
| Document screen | Opened in the browser gate | **VERIFIED** |
| Signature ceremony | 10 browser assertions | **VERIFIED** |
| Preview viewer | Measured — and found broken (F-1) | **VERIFIED** (defect) |
| Document library | Fixed in Phase 6.6 (`pageSize`), not opened in a browser here | **NOT VERIFIED** |
| Bulk operations, notifications, search rebuild, templates, audit timeline, permissions screens | jsdom and axe only | **NOT VERIFIED** at runtime |

**This is the largest remaining gap, and F-1 is why it matters.** Two of the three screens that have
now been opened in a real browser turned out to be broken in ways no other check could see. The rest
have never been opened.

## 16. Design system verification

**VERIFIED that the gates run and that they fail when they should.** The strongest evidence is
unforced: during Phase 6.6 the contrast gate rejected a new surface at **3.41:1** on the platform's
`Badge tone="danger"`, and this phase's own P0 regression test failed at 6,704 and passed at 2. Both
are demonstrations that the harnesses discriminate, produced without leaving deliberate breakage in
the repository.

`verify:styles` is declared `cache: false` and runs against the built stylesheet; `test:visual` and
`test:e2e` likewise. 36 contrast and screenshot assertions across both themes, and axe runs in every
rendered suite with `duplicate-id` and `duplicate-id-active` explicitly re-enabled.

**KNOWN LIMITATION** (recorded by Phase 5.2 and unchanged): jsdom cannot judge focus rings; contrast
is judged only where a surface has a browser baseline.

## 17. Configuration verification

**VERIFIED** by observed boot refusals rather than by reading the schema. Starting the built API with
`NODE_ENV=production` and this environment's variables produced:

```
STORAGE_DRIVER / MAIL_DRIVER / AV_DRIVER must name a real provider in production.
OPENAPI_ENABLED: The OpenAPI explorer is not served in production.
MFA_TOTP_SEALING_KEY: Authenticator secrets need their own sealing key in production.
AUDIT_CHECKPOINT_SECRET: Audit checkpoints must be signed in production.
```

That is the production hardening working: the process refuses to start rather than running weakened.
Tenancy validation likewise refuses `TENANT_ID` combined with a catalogue.

**NOT VERIFIED:** legacy alias shadowing, staging-specific behaviour, and session idle/absolute
deadlines under real elapsed time. No defaults were changed.

## 18. Dependency and supply chain

**VERIFIED:**

- **`@nestjs/throttler` is absent** — from every manifest and from `pnpm-lock.yaml` (0 matches).
- **The lockfile is consistent** — `--frozen-lockfile --lockfile-only` left it unmodified.
- **No `workspace:` range leaks** — only `@edms/*` use them, in every manifest.
- The API's runtime dependencies are 21 packages; the worker's are 8. No duplicate security library
  (one JWT path, one hasher, one Redis client).

**Advisories: 4 high, 2 moderate, 0 critical** — and none is in a server runtime path:

| Package | Severity | Where |
| --- | --- | --- |
| `postcss` (×4) | high/moderate | `@tailwindcss/postcss`, a web **devDependency** — build-time |
| `sharp` | high | build-time image tooling (`onlyBuiltDependencies`) |
| `js-yaml` | high | transitive, tooling |

None appears in `apps/api` or `apps/worker` dependencies. Recorded as **F-6 (P3)**; nothing upgraded,
per instruction.

## 19. Production build

**VERIFIED.** All nine packages build. More importantly the artefacts were *run*: the browser gate
boots `apps/api/dist/main.js` and `next start` over the production build and drives them with
Chromium on every run, so the class of failure Phase 6.6 found — source correct, runtime broken — is
now covered by a gate rather than by luck.

**NOT VERIFIED:** container images. No Docker daemon is available in this environment; CI builds all
three targets and is the standing evidence.

## 20. Test effectiveness

Asked of each control: *could this test pass while the control was unreachable?*

| Control | Strongest available proof | Could it pass while unreachable? |
| --- | --- | --- |
| Rate limiting | Real HTTP `429` against the built artefact | No |
| Authentication | Real sign-in through the built web app | No |
| RBAC | Reader refused `403` on a real route | No |
| ACL | Unreachable document answers `404` over HTTP | No |
| RLS | SQL against two real databases as the application role | No |
| Audit chain | SQL against real rows, concurrent writers | No |
| Signature authenticity | Browser bytes compared to the stored column | No |
| Signature uniqueness | Ten real races | No |
| Preview issuance discipline | **Counted server-action calls** | No — and nothing else could see it |
| Cookie attributes | Read from a real browser context | No |
| Field-level errors | — | **There is no test at all** (F-3) |
| Withdrawal semantics | jsdom only | Yes — no runtime proof |
| Notifications, bulk, search, templates | jsdom / integration only | Partly |

Two structural observations. The repository has genuinely moved from declaration-testing to
effect-testing over the last several phases — every P0-class control above has a runtime proof. But
**the web application is the weak side**: `apps/web` has 126 assertions against `apps/api`'s 644 plus
651 integration, and until Phase 6.6 nothing had ever loaded the application at all.

## 21. Known flakes

**`outbox-dispatch` — did not reproduce.** Eight consecutive runs, 8 passed, 0 failed.

The mechanism is nonetheless confirmed by reading the test after failing to reproduce it: the
assertion *"skips rows another dispatcher is holding"* opens a second connection that takes
`SELECT … FOR UPDATE` inside a transaction, then waits a **fixed 100 ms** before dispatching. On a
loaded runner the lock may not be held yet, the pass picks up both rows, and the assertion fails with
`expected 2 to be 1`.

**KNOWN LIMITATION.** Test infrastructure, not product behaviour — `SKIP LOCKED` is what is under
test and it works. Recommended correction: poll `pg_locks` until the lock is observable instead of
sleeping. Not changed here; changing it is not this phase's remit and the assertion must not be
weakened.

## 22. Operational readiness

| Area | Status |
| --- | --- |
| Security | **VERIFIED** — see §4 |
| Multi-tenant isolation | **VERIFIED** |
| Architecture | **VERIFIED** by composition and boot checks |
| Deployment | **VERIFIED** for build and run; **NOT VERIFIED** for containers here |
| Testing | **VERIFIED** for the API; **KNOWN LIMITATION** for the web (§15) |
| Observability | **IMPLEMENTED** — correlation id and `traceparent` on real responses |
| Backup / restore | **NOT VERIFIED** — see F-5 |
| Disaster recovery | **NOT VERIFIED** |
| Dependency security | **VERIFIED** — no runtime advisory |
| Accessibility | **VERIFIED** for covered surfaces |
| Performance | **NOT VERIFIED** — no load testing exists |

## 23. Findings

### F-1 — P0: the preview viewer issues thousands of audited presigned URLs per open **(FIXED)**

**Finding.** `PreviewPanel` issued **6,704** preview content URLs in 1.5 seconds from a single mount.

**Evidence.** Measured by counting real `requestPreviewContent` calls with the URL held constant, so
the count reflects the panel's own render loop and not a child reloading on a changed prop. Unfixed:
6,704. Fixed: 2. Both figures produced by the same probe against the same fixture.

**Failure scenario.** A person opens any document whose preview is `READY`. The browser enters a
render loop: the effect calls `openContent`, which sets `content`, which re-renders, which produces a
new `openContent` (because `translate` is a new closure every render), which re-runs the effect.
Every iteration mints a presigned URL and writes an audited issuance. Roughly 4,500 requests per
second per open viewer — a self-inflicted denial of service against the tenant's own API, and a flood
through the compliance trail that buries the evidence it exists to hold.

**Affected surface.** `apps/web/src/features/preview/preview-panel.tsx`, on every document with a
renderable preview. Pre-existing since Phase 7. Not a Phase 6.6 regression.

**Current mitigation.** None before this audit. Nothing detected it: the panel rendered correctly,
axe was clean, screenshots matched, types were sound.

**Recommendation, applied.** Remove `translate` and `toast` from the `useCallback` dependency list.
Both are read only to phrase a failure and neither changes what is requested, so capturing the
render's copies is correct and makes the callback stable. Four lines, no behaviour change, no
contract change, no Platform change — §22's blocker clause. A regression test
(`preview-issuance.spec.tsx`) keeps the count bounded, because a count is the only observable.

**Blocks production:** it did. Fixed.

### F-2 — P2: `Retry-After` is documented, advertised, and never sent

**Finding.** A real `429` carries no `Retry-After` header and no `retryAfterSeconds` in the body.

**Evidence.** The full response to the eleventh sign-in from one address contains
`Access-Control-Expose-Headers: X-Correlation-Id,Retry-After` — advertising a header that is not
there — and a problem body with no retry field. `RateLimitedError` does carry `retryAfterSeconds`,
and `AllExceptionsFilter.fromDomainError` drops `DomainError.details` on the way out.

**Failure scenario.** A client cannot tell when to retry, so it either retries immediately — adding
load to a service already refusing it — or, as the Phase 6.6 UI does, tells the person "wait a few
minutes" without knowing. Three artefacts state the opposite: `15 §7`, `rate-limit.ts`'s docstring,
and the CORS expose list.

**Current mitigation.** The UI does not fabricate a number.

**Recommendation.** Set the header in the exception filter for `RATE_LIMITED` and carry
`retryAfterSeconds` in the body; or correct the three documents. Not fixed here — the brief is
explicit, and this changes an API response shape.

**Blocks production:** no.

### F-3 — P2: field-level validation errors never reach the browser

**Finding.** `errors[]` is dropped at `apps/web/src/lib/api-client.ts:78`.

**Evidence.** §7. A 422 carrying two field errors became `DomainError` with `details: {}`.

**Failure scenario.** Every form in the product shows one generic sentence instead of naming the
field. Concretely: the signing ceremony cannot distinguish "you already signed this" from "that
revision is discarded", because both arrive identically.

**Current mitigation.** Screens show the server's generic sentence, which is accurate but unhelpful.
No test asserts the loss in either direction.

**Recommendation.** Carry `errors` into `DomainError.details` and surface it on `ActionResult`.
Small, but it touches shared plumbing used by every screen — out of scope for an audit.

**Blocks production:** no.

### F-4 — P2: most of the web application has never been run

**Finding.** Of eleven major workflows, three have been opened in a real browser.

**Evidence.** §15. Two of those three were broken (Phase 6.6's `/login` 500 and `pageSize: 200`), and
the third was broken in a different way (F-1). The base rate is not reassuring.

**Recommendation.** Extend the Phase 6.6 browser harness across the remaining workflows. The
infrastructure now exists; this is the highest-value testing work available.

**Blocks production:** no, but it is the reason confidence in the web tier should stay low.

### F-5 — P2: no restore rehearsal has ever been performed

**Finding.** `docs/operations/backup-and-restore.md` documents a procedure and an
`audit.verify-chain` step. It has never been executed.

**Evidence.** None — that is the finding. **NOT VERIFIED**, and no evidence was fabricated. It cannot
be performed safely here: there is no backup artefact and no separate cluster to restore into.

**Recommendation.** Rehearse in a staging environment and record the wall-clock time to a verified
chain. Until then RPO/RTO are aspirations.

**Blocks production:** it should be treated as blocking by anybody operating this in a regulated
setting, though it is not a code defect.

### F-6 — P3: build-time dependency advisories

Four high and two moderate advisories, all in build-time tooling (`postcss`, `sharp`, `js-yaml`), none
in `apps/api` or `apps/worker` runtime dependencies. Recorded, not upgraded.

### F-7 — P3: `useTranslate` returns an unstable identity

The root cause of F-1, and it will cause another. `translatorFor` allocates a new closure per call.
One further live site (`upload-dialog.tsx:141`) is currently harmless because nothing calls it from
an effect. Memoising per locale in `@edms/i18n` would remove the class of defect; that is a shared
package change and not this phase's call.

### F-8 — P3: `outbox-dispatch` timing

§21. Did not reproduce in 8 runs; the fixed 100 ms sleep remains the mechanism.

## 24. Risk matrix

| Finding | Severity | Likelihood | Impact | Blocks production |
| --- | --- | --- | --- | --- |
| F-1 preview loop | P0 | Certain on any previewable document | API load + audit flooding | **Was yes — fixed** |
| F-5 no restore rehearsal | P2 | — | Unknown recovery time | Operationally, yes |
| F-4 unrun web workflows | P2 | High | Unknown runtime defects | No |
| F-2 `Retry-After` | P2 | Certain when limited | Retry storms; docs untrue | No |
| F-3 field errors | P2 | Certain on any validation failure | Poor errors everywhere | No |
| F-6 advisories | P3 | Low | Build-time only | No |
| F-7 translator identity | P3 | Latent | Another F-1 | No |
| F-8 outbox timing | P3 | Low | CI noise | No |

## 25. Recommended next work

1. **Extend the browser harness** to the remaining workflows (F-4). Highest value by a distance —
   every screen opened so far has found a defect.
2. **Carry `retryAfterSeconds` and `errors` through** (F-2, F-3). One small backend change and one
   small client change, together closing both API-truthfulness gaps.
3. **Rehearse a restore** (F-5). The one readiness gap that cannot be closed by writing code.
4. **Memoise the translator** (F-7), with a lint rule for hook dependency arrays, so F-1 cannot recur.
5. Fix the `outbox-dispatch` wait (F-8) by polling `pg_locks`.

## 26. Evidence / commands

```bash
# Rate limiting and Retry-After — against the built artefact
node apps/api/dist/main.js                       # TENANT_ID/TENANT_SLUG from the fixture
for i in $(seq 1 11); do curl -sD - -o /dev/null --noproxy '*' \
  -X POST http://127.0.0.1:3001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"probe@nobody.test","password":"wrong","tenant":"<slug>"}'; done

# Field-level errors, at the API
curl -s --noproxy '*' -X POST .../documents/<id>/signatures -H "Authorization: Bearer <t>" \
  -d '{"revisionId":"not-a-uuid","purpose":"RUBBER_STAMP"}'

# Preview issuance count (kept as apps/web/src/features/preview/preview-issuance.spec.tsx)
pnpm --filter @edms/web exec vitest run --project=a11y src/features/preview/preview-issuance.spec.tsx

# Cookie attributes, from a real browser context
#   Playwright storageState after a real sign-in through the built web app

# Authorization coverage
#   279 handlers scanned for @RequirePermission at handler and class level
#   39-permission catalogue differenced against the decorators actually used

# Flake
for i in $(seq 1 8); do pnpm --filter @edms/api exec vitest run \
  --config vitest.integration.config.ts src/core/outbox/__tests__/outbox-dispatch.integration.spec.ts; done

# Supply chain
pnpm audit --prod --json
pnpm install --frozen-lockfile --lockfile-only   # lockfile unchanged
grep -c throttler pnpm-lock.yaml                 # 0
```

### Gate results

| Gate | Result |
| --- | --- |
| `pnpm format` | clean |
| `pnpm lint` | **0 errors**, 5 warnings (pre-existing) |
| `pnpm typecheck` | 13/13 |
| `pnpm test` | web **126** · API 644 / 1 skipped · domain 164 · contracts 26 · utils 11 · i18n 4 · worker 2 |
| `pnpm test:integration` | 36 files, **651 passed**, 0 skipped |
| `pnpm test:visual` | **36 passed** |
| `pnpm test:e2e` | **10 passed** — real API, real web server, real Chromium |
| `pnpm build` | 9/9 |
| `pnpm verify:styles` | 10/10 |
| PostgreSQL 16, two tenant databases, Redis | used throughout; restored once after reclamation |

## 27. Final go / no-go

**NO-GO as found. GO for further feature development, with conditions.**

The P0 was real, was in shipped code, and was invisible to every check the repository had. It is
fixed and guarded. With that fix in place there is no known blocker in the code.

What still stands between this and "production ready" is not code:

- **no restore rehearsal has ever been performed** (F-5) — a regulated deployment should not go live
  on an unrehearsed recovery procedure;
- **most of the web application has never been executed** (F-4), and the three screens that have been
  were all broken.

The security controls, by contrast, are in good order: every one in §4 that could be exercised was
exercised, and none turned out to be a declaration without a control. That is a different result from
Phase 6.3, 6.4, 6.7 and 6.6, each of which found one — and it is the first phase in this sequence
where the answer to *"is the control actually reachable?"* was yes, every time.

**Feature development may continue.** Production go-live should wait for F-5 and a meaningful dent in
F-4.

## Evidence vocabulary

- **VERIFIED** — executed against the running system: §4's marked rows, §5–§13, §16–§19.
- **IMPLEMENTED** — present and bound, not independently exercised here: observability.
- **KNOWN LIMITATION** — §21's flake mechanism; jsdom's blind spots; the web tier's coverage.
- **NOT VERIFIED** — federation, container images, restore rehearsal, historical audit formats,
  staging configuration, eight of eleven web workflows, performance.
- **FAILED** — F-1 (fixed), F-2, F-3.
- **FUTURE ENHANCEMENT** — §25.
