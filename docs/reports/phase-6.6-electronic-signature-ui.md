# Phase 6.6 — Electronic Signature & Witnessed Attestation UI

**Status: BLOCKED**

No UI was built and the signature capability was left untouched, which is what §26 instructs when
the honest answer is that the backend is not sufficiently safe to expose. Two blockers were found,
both by tracing code rather than reading comments, and both are on §22's stop list.

The signature *domain* is excellent and ADR-0017-faithful. Neither blocker is a design flaw in the
signature model. Both are missing enforcement elsewhere that the ceremony depends on — and both are
**pre-existing**: the endpoint is live today, so nothing here is made worse by not building a screen.

---

## BLOCKER 1 — There is no rate limiting anywhere in the API

§23 question 14 asks whether the signature action is appropriately rate-limited. It is not, and no
part of the deployment provides it.

| Evidence | Finding |
| --- | --- |
| `apps/api/package.json:28` | `@nestjs/throttler@^6.4.0` is a declared dependency |
| `grep -rn "throttler\|Throttler" apps/api/src` | **no match** — imported nowhere |
| `configuration.ts:464-465, 1203-1205` | `RATE_LIMIT_WINDOW_SECONDS` / `RATE_LIMIT_MAX_REQUESTS` parsed into `AppConfig` |
| `grep -rn "rateLimit" apps/api/src` (excluding config) | **no match** — read by nothing |
| `app.module.ts:132-135` | The four `APP_GUARD`s are authentication, tenant isolation, RBAC, ACL. No throttler |
| `infra/`, `deploy/`, `ops/` | No `limit_req` or equivalent edge configuration |
| `@munaxa/platform` | Provides no throttle |

Two architecture documents nonetheless specify the control in detail:

- **`15-api-architecture.md` §7** — a five-row table: strict per-IP *and* per-account limits on
  login with lockout and audit; per-user search; presign; export; "General | Per token, with
  `Retry-After`". §5's error table lists `429`.
- **`17-security-architecture.md`** — "Rate limiting | Per IP and per identity on auth, search,
  presign and export".

**Why this blocks signatures specifically.** `POST /documents/:id/signatures` takes a password and
answers one deliberately-undifferentiated `ForbiddenError` for every credential failure. That
uniform refusal is correct — it stops a session thief learning which half of the credentials they
still need — but it is only a defence if guesses are *bounded*. ADR-0017 §6 states plainly that
re-authentication exists to satisfy §11.200 against somebody holding a session they should not.
Unlimited attempts against that endpoint is an online password-guessing oracle aimed at exactly the
attacker the control was designed to stop.

§14 is explicit about the response: *"Do not silently add a second rate limiter. Do not create a
client-only throttle. If a platform enhancement is required: STOP and document it."* That is what
this is.

## BLOCKER 2 — Two concurrent requests can produce two signatures

§23 question 4. The answer is **yes**, and it is a three-part finding:

1. **The guard is application-level only.** `DocumentSignatureService.sign` calls
   `liveSignatureExists({ revisionId, signerUserId, purpose })` and throws if one is found —
   a read-then-write.
2. **The isolation level is READ COMMITTED.** `TenantDatabase.withTenant` calls
   `client.$transaction(...)` with **no `isolationLevel` option** (`tenant-database.ts:76`), so
   Prisma uses the PostgreSQL default. Two concurrent transactions can therefore both execute the
   existence check, both see nothing, and both insert.
3. **There is no unique index to catch them.** `prisma/schema.prisma:3628` carries this comment:

   > *One live signature per person, revision and purpose. Partial on `withdrawn_at`, so a withdrawn
   > signature does not block the person signing again — which is the whole reason a withdrawal is a
   > row rather than a delete.*

   The three declarations beneath it are `@@index`, not `@@unique`, and
   `20260806120000_advanced_features/migration.sql:179-185` creates three plain `CREATE INDEX`
   statements. **No unique index on `document_signature` exists anywhere** — not in the Prisma
   schema, not in the migrations, not in `infra/sql/tenant/`.

The comment describes a constraint that was never created. This is the same class of finding as
Phase 6.4's `DeliveryState.FAILED` and Phase 6.3's phantom permissions: a stated control with no
implementation behind it.

**Why it blocks.** A double-click, a retried request, or two browser tabs can produce two live
signatures by the same person, on the same revision, for the same purpose. In a Part 11 record that
is not a cosmetic duplicate — it is two attestations of the same fact with different identifiers and
different witnesses, and an inspection cannot tell which one the signer meant. §22 lists
"concurrency/replay protection is missing" as a stop condition.

---

## 1. Signature Architecture Audit

Traced UI → API → controller → service → domain → persistence → audit. The chain is complete and
sound apart from the two blockers above.

`DocumentSignatureService` (380 lines) refuses to sign without a witness key rather than writing an
unwitnessed row; reads the content digest from the revision's own blob through the content gate
rather than from the request; serialises the statement through `@edms/domain`'s
`serialiseSignatureStatement`; stores those bytes verbatim; witnesses with HMAC-SHA256 under a
`keyId` **derived from the secret** so a rotation cannot be misrecorded; and writes
`DOCUMENT_SIGNED` inside the same `AdministeredWriter.write` transaction as the row.

## 2. ADR-0017 Compliance Matrix

| # | ADR-0017 decision | Implemented | Evidence |
| --- | --- | --- | --- |
| 1 | A row per signature, not a `signed_by`/`signed_at` pair | ✅ | `model DocumentSignature`, 20+ columns |
| 2 | Canonical statement, versioned, field-ordered | ✅ | `serialiseSignatureStatement`, `SIGNATURE_STATEMENT_VERSION` |
| 3 | Statement stored verbatim; verification hashes *those* bytes | ✅ | `statementBody` column; `verify` never rebuilds |
| 4 | Server is the witness; HMAC under a named `key_id` | ✅ | `witness()`, `keyIdFor()` derived from the secret |
| 5 | `document:sign` seeded to no role, tenant admin included | ✅ | verified against the seed in Phase 6.3 |
| 6 | Re-authentication required by default; recorded per signature | ✅ | `SIGNATURE_REQUIRE_REAUTHENTICATION`; `reauthenticated` column |
| 7 | Withdrawal is columns, not a delete or a flag alone | ✅ | `withdrawnAt` / `withdrawnBy` / `withdrawnReason` |
| 8 | `DOCUMENT_SIGNED` in 13 §2, filed on the document | ✅ | `DocumentAudit.DOCUMENT_SIGNED`, subject `DOCUMENT` |
| 9 | Verification answers three booleans, not one | ✅ | `signatureValid`, `contentMatches`, `withdrawn` |

**No material disagreement between ADR-0017 and the implementation was found.** The two blockers are
not ADR violations — the ADR does not speak to rate limiting or to the index.

## 3. Signature State Machine — derived, not invented

**There is no signature *request* model.** No pending, expired, cancelled or rejected state; no
recipient, no due date, no requester. Nothing in the schema, service, controller or contracts
represents one. A signature is *taken* by a signer who holds `document:sign`, not requested of them.

The real machine has two states:

```
(no row) --sign--> LIVE --withdraw--> WITHDRAWN   [terminal]
```

| Question | Answer, from the code |
| --- | --- |
| Who may request a signature? | **Nobody — the capability does not exist** |
| Who may sign? | A holder of `document:sign` with ACL reach on the document |
| Who may witness? | `SignaturePurpose.WITNESS` is a *purpose*, not a role — a second ordinary signature |
| What is signed? | A **revision**, chosen by the caller; any status except `DISCARDED` |
| Expiration? | **None.** No timer, no TTL |
| Cancellation / rejection? | **None.** Withdrawal by the signer is the only reversal |
| Re-authentication? | Password always; TOTP when the signer has a confirmed authenticator |
| Audit | `DOCUMENT_SIGNED` on sign *and* on withdraw, with different `operation` values |

Because §4 of the brief ("Signature Request UI") has no backend behind it, building one would have
meant inventing states, a recipient model and an expiry policy — which §22 forbids.

## 4. API Contract Inventory

| Capability | Route | Permission | Existing UI | Required UI |
| --- | --- | --- | --- | --- |
| List a document's signatures | `GET /v1/documents/:id/signatures` | `document:view` + `@ScopedTo` DOCUMENT | none | signature panel |
| Sign a revision | `POST /v1/documents/:id/signatures` | `document:sign` + `@ScopedTo` | none | the ceremony |
| Verify one | `GET /v1/documents/:id/signatures/:signatureId/verification` | `document:view` + `@ScopedTo` | none | evidence view |
| Withdraw one | `POST /v1/documents/:id/signatures/:signatureId/withdrawal` | `document:sign` + signer identity | none | confirm dialog |
| Signer's MFA status | `GET /v1/auth/mfa` | (caller's own) | MFA screen | reused to decide whether to show the TOTP field |

**No endpoint is missing for the UI.** `GET /auth/mfa` already answers whether the signer holds a
confirmed authenticator, so the ceremony can show the TOTP field conditionally without a new route
and without leaking anything. No API addition would have been required.

## 5. UI/API Mapping

Nothing exists. `grep -rni "signature" apps/web/src` returns three unrelated matches (the word used
about JWTs, hook signatures and upload metadata). This was correctly classified F in Phase 6.5.

## 6. Authorization Report

Sound, and would not have needed changing. `document:sign` gates signing and withdrawal; every route
is `@ScopedTo('id', ScopeType.DOCUMENT)` so ACL reach is resolved on the document itself; listing and
verification require only `document:view`. Withdrawal carries a **second** gate in the service — only
the signer may withdraw their own signature, not an administrator — because a signature is a personal
attestation and somebody else retracting it is a different fact the product cannot record honestly.

## 7. Re-authentication Report

`IdentitySignerAuthenticator` verifies the password against `user_credential` through Identity's own
`PasswordHasher`. Document never sees a hash. It returns **one boolean**, and answers `false` rather
than throwing for every distinct failure, so the caller can produce a single refusal.

Gated by the tenant setting `SIGNATURE_REQUIRE_REAUTHENTICATION`, and whatever it demanded is
recorded on the signature row — because the setting can change afterwards and what *this* signature
required is a fact about this signature.

## 8. TOTP Compatibility Report

Compatible, with nothing to add. `mfa.isRequired(userId)` decides whether a code is owed; when it is,
verification goes through `MfaService.challenge` — the **same** path sign-in uses — so the replay
window, the recovery-code path and Phase 14's audit rows all apply to a signature exactly as they
apply to a sign-in. No second TOTP implementation would have been created, and none is needed.

## 9. Replay / Concurrency Report

**This is BLOCKER 2.** See above. Summary of the three layers a signing ceremony would need:

| Layer | Present |
| --- | --- |
| UI disables the button after submit | would be trivial — and is **not** a security control |
| Application existence check | ✅ `liveSignatureExists` inside the transaction |
| Serialisable isolation *or* a unique index | ❌ **neither** |

## 10. Document / Revision Integrity Report

Strong, and the part of the design most worth preserving. The signed digest is read from the
revision's own `file_object` through the content gate — never from the request — so §11.70's
signature/record link is decided by the record. `revisionIsSignable` refuses `DISCARDED` only;
`DRAFT` is signable on purpose, because Part 11 has no notion of "too early to sign" and the
`purpose` says which act this was. The UI would never have chosen the revision's identity.

## 11. Tenant Isolation Report

Not separately testable in this phase because nothing was built, but the mechanism is the established
one: a tenant is a whole database (ADR-0015), every signature query carries the tenant, and the ACL
scope guard resolves the document before the handler runs. A manipulated `signatureId` from another
tenant cannot be found by a query scoped to this tenant's database.

## 12. Audit Integrity Report

`DOCUMENT_SIGNED` is written by the application layer inside the same transaction as the signature
row, through `AdministeredWriter.write` — one transaction, one audit row, hash-chained like every
other. Withdrawal writes a **second** `DOCUMENT_SIGNED` with `operation: DELETED` rather than editing
the first, because the trail refuses `UPDATE`. The audit payload is minimised per 13 §3: the
signature id, revision, purpose and digest, never the statement body.

Nothing in this phase wrote an audit row from the UI, because this phase wrote no UI.

## 13. Security Hardening Report

| Concern | Finding |
| --- | --- |
| Server-side authorization | ✅ |
| Tenant isolation | ✅ |
| Credential minimisation | ✅ backend takes password/code, stores neither |
| No secret logging | ✅ the service logs nothing about credentials |
| Safe error handling | ✅ one refusal for every credential cause — deliberately no enumeration |
| Auditability | ✅ |
| Replay / concurrency | ❌ **BLOCKER 2** |
| Rate limiting | ❌ **BLOCKER 1** |

### The fourteen §23 answers

| # | Question | Answer |
| --- | --- | --- |
| 1 | Sign without password re-authentication? | No — unless the tenant setting is off, which is recorded on the row |
| 2 | Sign without required TOTP? | No — `MfaService.challenge` must return true when a factor is confirmed |
| 3 | Replay the signing request? | Partially — a *sequential* replay is refused by `liveSignatureExists` |
| 4 | **Two concurrent requests → two signatures?** | **Yes — BLOCKER 2** |
| 5 | Sign a stale revision? | Yes, by design — signing an older revision is a legitimate act; `DISCARDED` is refused |
| 6 | Cross-tenant signing? | No — separate databases plus scope guard |
| 7 | Unauthorized direct API call? | No — `document:sign` plus ACL, independent of any UI |
| 8 | Credentials in logs? | No |
| 9 | Credentials in URLs? | No — body only |
| 10 | Evidence modifiable after signing? | No — audit refuses `UPDATE`; the witness would fail verification |
| 11 | Audit captures the event? | Yes — `DOCUMENT_SIGNED` |
| 12 | Ceremony completable by keyboard? | **Unproven — no ceremony exists** |
| 13 | UI exposes only authorized information? | **Unproven — no UI exists** |
| 14 | **Appropriately rate-limited?** | **No — BLOCKER 1** |

Twelve of fourteen are answered by code. Two are answered "no", and two more cannot be answered
because building the thing that would answer them is what these blockers prevent.

## 14–15. Accessibility and Visual Regression Reports

**Not applicable.** No UI was built, so there is nothing to assert and nothing was claimed. No
existing visual baseline was altered.

## 16. Implemented Changes Report

**None to the signature capability**, deliberately. The only change in this phase is unrelated
hygiene carried over from Phase 6.5: a stray `dump.rdb` — a Redis snapshot written into the
repository root when the local integration run restarted the server — was removed and added to
`.gitignore`.

## 17. API Compatibility Report

Nothing changed. No route, response shape, permission, audit action, event name or state semantic.

## 18. Deleted Code Report

Nothing deleted.

## 19. Dependency Reduction Report

No dependency added, removed or upgraded. Worth recording that `@nestjs/throttler` is installed and
**entirely unused** — it is the dependency BLOCKER 1 would consume, so removing it would be wrong.

## 20. Validation Report

| Gate | Result |
| --- | --- |
| format:check | pass |
| lint | 0 errors, 5 pre-existing warnings |
| typecheck | 13/13 |
| test | 97 web, 636 API, 164 domain, 26 contracts, 11 utils, 4 i18n, 2 worker |
| build | 9/9 |
| verify:styles | 10/10 |
| visual | 28 |
| integration | 617 passed, 33 files, 0 skipped |

These are the Phase 6.5 results, re-verified unchanged: this phase altered no product code, so no
gate could move. **No signature-specific test was added**, because adding tests for a ceremony that
was deliberately not built would assert nothing.

## 21. Remaining Signature Backlog

| # | Item | Priority | Estimate |
| --- | --- | --- | --- |
| 1 | **Rate limiting across the API**, implementing `15 §7`'s table — per-token general limit with `Retry-After`, strict per-IP-and-account on credential-accepting routes. Consumes the installed `@nestjs/throttler`; needs a store decision (Redis is already a dependency) | **P0** | ~3 days |
| 2 | **The partial unique index the schema comment already describes**: `UNIQUE (tenant_id, revision_id, signer_user_id, purpose) WHERE withdrawn_at IS NULL`, plus a concurrency integration test asserting one of two simultaneous requests loses | **P0** | ~4 hours |
| 3 | The signing ceremony UI — unblocked by 1 and 2 | P1 | ~1 week |
| 4 | Signature panel and evidence view on the document screen | P1 | ~3 days |
| 5 | Audit the *other* rate-limiting claims in `15 §7` — login lockout, search weighting, presign quota — which are equally unimplemented | P1 | ~1 day |
| 6 | Fix the flaky `outbox-dispatch` concurrency test: it sleeps a fixed 100 ms waiting for a lock rather than waiting until the lock is held, and failed once on CI during this session | P2 | ~1 hour |

## 22. Phase 6.6 Final Status

**BLOCKED.**

Not because the signature architecture is wrong — it is the most carefully built thing I audited
across six phases, and ADR-0017 is honoured on all nine of its decisions. Blocked because a
legally meaningful signing ceremony rests on two controls that this repository documents and does not
implement: bounded credential attempts, and a guarantee that one act produces one signature.

Both are small, well-understood, and fixable in about three days between them. Neither requires
touching the signature domain, ADR-0017, the authentication architecture, or any API contract. Once
they exist, everything else the ceremony needs is already in place — including `GET /auth/mfa`, so
not even a new endpoint is required.

The brief's §26 says: *"If the correct answer is that the backend is not sufficiently safe to expose:
STOP. Document the exact blocker and leave the capability untouched."* That is what this is. Building
a Part 11 attestation ceremony on an unthrottled password oracle, where a double-click can mint two
attestations of the same fact, would have produced a signature screen rather than a signature.
