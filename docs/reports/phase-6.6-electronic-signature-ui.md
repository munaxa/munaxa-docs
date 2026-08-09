# Phase 6.6 — Electronic Signature & Witnessed Attestation UI

**Status: COMPLETE.** The ceremony exists, it is driven end to end in a real browser against a real
API, and the one claim the phase rests on is proven against the database: **what the person read is
what was signed.**

Building it also uncovered two pre-existing defects that made the product unusable in a production
build, and neither was visible to any existing test. They are set out in §12, because they are the
more consequential half of what this phase produced.

---

## 1. Objective, and what was reused

The whole backend already existed. Nothing was added to it:

| Capability | Endpoint | Reused from |
| --- | --- | --- |
| The statement, before signing | `GET /documents/:id/signatures/statement` | Phase 6.6A |
| Signing | `POST /documents/:id/signatures` | Phase 16 |
| The signed state | `GET /documents/:id/signatures` | Phase 16 |
| Verification | `GET /documents/:id/signatures/:signatureId/verification` | Phase 16 |
| Withdrawal | `POST /documents/:id/signatures/:signatureId/withdrawal` | Phase 16 |
| Whether *this* person owes a code | `GET /auth/mfa` | Phase 14 |

No endpoint was created, no contract changed, no ADR touched, no Platform change, and no new
signature state invented.

The UI reuses the repository's own primitives throughout: `Dialog`, `Field`, `Input`, `Select`,
`Textarea`, `Alert`, `Badge`, `Button`, `Card` from `@munaxa/ui`; `FormDialog`, `TextAreaField` and
`text` from `admin-shared`; `adminRead`/`adminWrite` behind server actions; `useTranslate`,
`useSession` and `router.refresh()`. Nothing was hand-built that already existed.

## 2. Where it lives

**IMPLEMENTED.** `SignaturePanel` is a slot on `DocumentScreen`, beside approvals, revisions and the
audit timeline, passed in by the document page exactly as those four are — so the document screen
still knows nothing about what a §11.50 attestation is. That is the existing composition rule, not
a new one.

The `Sign` action appears on the panel when the server says the caller holds `document:sign`. Hiding
it is a courtesy; the route re-checks the permission and the ACL scope, and the preview endpoint is
behind the same pair. `document:sign` remains seeded to no production role.

## 3. The ceremony

**IMPLEMENTED**, as a local state machine — no global state, because a half-finished attestation is
the last thing that should survive a navigation.

```
loadingStatement → statementReady → confirming → signing → success
        ↕                                ↓
      error ←──────────────────────────┘
```

**The first click does not sign.** It opens the dialogue and asks the server what the statement
says. The statement stage carries the meaning, the optional comment and the server's bytes — and no
credential field at all, which makes "read before you attest" a property of the markup rather than
of the copy.

The statement is re-read whenever the meaning or the comment changes, because both are *inside* the
attested bytes. A preview taken before either was chosen would be a preview of a different
statement.

### The statement itself

**VERIFIED.** `statementBody` is rendered verbatim into a `<pre>` with `whitespace-pre-wrap`,
`max-h-64 overflow-auto` and `tabIndex={0}` — scrollable rather than truncated, and focusable so a
keyboard user can actually scroll it. The rendered suite asserts the text **is** the exact string
the server returned, not that it contains it.

The browser does not build, parse, translate, normalise, digest or verify it. `statementBody` never
appears in the message catalogue and never will: ADR-0017 §3 stores those bytes verbatim so nothing
ever has to reproduce them, and a translated statement would mean displaying one artefact and
signing another.

### `preparedAt`

**IMPLEMENTED.** Shown as *"Prepared {date}. Your signature carries the moment you confirm it, not
this one."* It is never called the signature time, and the preview is never described as reserving,
locking or creating anything — because it does not.

## 4. Re-authentication, and an honest note about the sequence

**KNOWN LIMITATION, and a deliberate one.**

The brief's sequence puts re-authentication *before* a final confirmation. **There is no
re-authentication endpoint.** `AuthController` has four routes — login, refresh, logout, me — and
`SignerAuthenticator` is an internal port; credentials are proved only by the act that consumes
them. That is a property of the design rather than a gap: a standalone "check my password" call
would be exactly the credential oracle ADR-0017 §6's single undifferentiated refusal exists to
prevent, and building one would be inventing backend capability this phase is told not to invent.

So the confirmation stage carries the credentials **and** the explicit acknowledgement, and one
deliberate submit performs both. Everything the requirement is actually protecting is preserved:

- the statement is read on a stage of its own, before any credential field exists;
- nothing signs automatically after a credential succeeds, because there is no credential-success
  event to follow — the checkbox must be ticked and the button pressed;
- the confirmation names the document, the revision and the meaning in words, and says out loud that
  an electronic signature is being created;
- Cancel is present at every stage and signs nothing.

**MFA:** the code field appears only when `GET /auth/mfa` says *this* caller is enrolled. There is
no request in this product by which one person could ask about another's factor, so the ceremony
cannot become an enrolment oracle. No second MFA system, no OTP component, no TOTP handling in the
browser.

## 5. Where the credentials live

**Nowhere.** The password and the code are uncontrolled inputs inside a `<form>`, read out of
`FormData` at submit, handed to a server action, and unmounted. They are never in React state, never
in a ref, never in a URL, never in storage, never in a log line. The sign-in form does exactly this,
and this follows it rather than inventing a second way to hold a secret.

**VERIFIED** by two tests: one asserts that neither `localStorage`, `sessionStorage` nor the URL
contains the typed password after signing; the other asserts the field is *gone* after success —
which is stronger than cleared, because there is no input holding the value and no state that ever
did.

The query schema for the preview declares no credential field, and a password sent anyway is
stripped by the pipe before anything downstream can read it.

## 6. The signed state, verification and withdrawal

**IMPLEMENTED.** The list is exactly what the API returns, withdrawn rows included — they are
history, and hiding them would quietly rewrite the record. Two states, `LIVE` and `WITHDRAWN`, and
no others: no pending, requested, expired, awaiting, delegated, sequential or quorum, because the
domain has none.

After signing, the panel refetches and calls `router.refresh()`. **VERIFIED** in the browser that a
full reload still shows the signature — the state comes from the API, never from an optimistic
guess.

**Verification** renders the three booleans on three separate lines. Collapsing them is the mistake
the contract's own comment warns about: a signature whose bytes were altered and one its signer
withdrew are completely different findings, and `contentMatches: false` is a §11.70 record-linking
finding about a signature that is perfectly intact. `witnessedBy` names a key, never a certificate
subject. It runs on request rather than per row, because it re-reads a blob digest and recomputes an
HMAC per signature.

**Withdrawal** is offered only on your own live signature, through the existing endpoint and the
existing `FormDialog`. The dialogue says the signature stays on the record marked withdrawn, with
the reason, and that nothing is deleted.

## 7. Errors, concurrency and rate limiting

**IMPLEMENTED.** Codes are mapped, not collapsed into "something went wrong":

| Code | What the person sees |
| --- | --- |
| `VALIDATION_FAILED` | The server's own sentence — the one code where it knows something the client's schema did not |
| `RATE_LIMITED` | "Too many signing attempts. Wait a few minutes and try again." |
| `FORBIDDEN` | The catalogue's refusal — deliberately the same one sign-in gives |
| anything else | The catalogue's sentence for that code |

**Double submission** is prevented by the existing disabled/loading pattern: the button is disabled
while signing, and the dialogue refuses to close mid-request because the API is the only party that
knows whether it committed. This is UI protection only — `uq_document_signature_live` remains the
authority, and no client-side lock stands in for it.

**A duplicate** is refused by the *preview*, before a statement is produced, so the ceremony never
displays a statement for an act about to be rejected. **VERIFIED** in the browser: the alert appears,
no statement renders, and the signature count and `DOCUMENT_SIGNED` count are both unchanged.

**Rate limiting** is Phase 6.7's rule, untouched — no new rule, no second limiter, no client-side
throttle. `429` is rendered as a sentence naming no Redis, cache, counter, bucket or status code,
asserted by a regular expression.

**KNOWN LIMITATION — `Retry-After`.** `15 §7` says every limited response carries it and
`bootstrap.ts` exposes it through CORS, but the API sets no such header and
`AllExceptionsFilter.fromDomainError` drops `DomainError.details`, so `retryAfterSeconds` reaches
the client neither as a header nor in the body. The UI therefore says "wait a few minutes" rather
than counting down: inventing a number the server did not send would be worse than the vagueness.
Recorded as an unrelated backend gap in §12.

## 8. Audit

**VERIFIED against the database, in the browser.** The UI writes no audit event of any kind.

| Act | Signature row | `DOCUMENT_SIGNED` |
| --- | --- | --- |
| Opening the ceremony / previewing | none | none |
| Cancelling | none | none |
| Wrong credentials | none | none |
| Rate-limited request | none | none |
| Successful signing | one | exactly one, written by the backend |

## 9. Accessibility

**VERIFIED**, executed rather than reviewed — 28 rendered assertions in
`signing-ceremony.spec.tsx`, including three full axe passes (statement stage, confirmation stage
with a factor, and the signed list with verification expanded).

Asserted by key presses rather than by inspection: focus enters the dialogue; ten tabs never escape
it; Escape closes it and signs nothing; and the **whole ceremony runs from the keyboard alone** —
tab to Continue, type the password, Shift+Tab to the acknowledgement, Space, tab to the submit
control, Enter, and a signature request is made.

The statement region is focusable and scrollable, which is what makes a long statement readable
without a mouse. Labels come from the real translator, so a test cannot pass on a name the shipped
screen does not have.

**KNOWN LIMITATION.** jsdom has no layout, so visible focus rings and colour contrast cannot be
judged there. Contrast is checked in real Chromium by the visual suite; the platform sets
`focus-visible:ring-*` and this product defines no focus styles of its own, which is an argument
rather than a test and is recorded as one, exactly as Phase 5.2 recorded it.

**Enter-to-submit from a field** is not asserted in jsdom: the submit button reaches the form by
`form=` from the dialogue footer, which every browser honours for implicit submission and jsdom does
not implement. Tabbing to the control is what is asserted, and the browser suite drives the real
thing.

## 10. Visual regression

**VERIFIED.** Two new surfaces — `signatures-empty` and `signatures-signed` — in both themes, four
baselines, contrast checked in real Chromium against the built stylesheet. 36 assertions pass.

**KNOWN LIMITATION.** The ceremony itself is not screenshotted, and the harness's own docstring says
why: it renders **static markup**, so no dialogue opens, no portal mounts and no effect runs. A
screenshot of `SigningCeremony` there would be a screenshot of nothing. Its stages are covered where
they can be — by axe in the hydrating suite, and by real Chromium end to end.

**Platform finding.** `Badge tone="danger"` renders `text-destructive` on its own
`bg-destructive/15` tint at **3.41:1**, below the 4.5:1 WCAG 2.1 AA requires for text under
18.66px — measured by this suite, not estimated. The withdrawn marker uses `tone="muted"` instead,
and that is the right call on its own terms rather than a dodge: a withdrawn signature is *history*,
the same reading the revision timeline gives `SUPERSEDED`, and colouring it as an alarm would tell a
reader something went wrong when somebody exercised an ordinary right. The palette defect is
reported here for the Platform, beside the `text-primary-strong` one Phase 5.2 recorded.

## 11. The real-browser end-to-end proof

**IMPLEMENTED — new infrastructure this repository did not have.** `apps/web/src/test/e2e/`, a
fourth vitest project, its own turbo task, and `scripts/e2e-signature-fixture.mjs`.

It boots the artefact that ships — `apps/api/dist/main.js` — against real PostgreSQL and real Redis,
runs `next start` over the production build, and drives real Chromium. **Nothing is mocked, and the
signature endpoints least of all.**

The existing `browser` project renders static markup and says plainly why: *"Screenshotting the
running application would need the API, a database, a session and a tenant — four things that make a
UI test fail for reasons that are not about the UI."* That trade is right for contrast and
screenshots and wrong for a signing ceremony, so this harness pays the cost the other declined and
the two coexist.

**VERIFIED — 10 assertions, all executed:**

1. the Sign action is offered, the statement comes from the server, and every field in it matches
   the fixture's tenant, document, number, revision, digest and signer name
2. **the stored `statement_body` differs from what was displayed in `signed-at` and in nothing
   else** — read straight from `document_signature`, because the API deliberately does not return
   the signed bytes on the list or the `POST`
3. the signed state survives a full reload
4. verification answers all three findings, and names a witness key
5. a duplicate is refused by the preview, with no statement rendered and nothing written
6. cancelling writes nothing
7. wrong credentials write nothing, and the refusal does not say which half was wrong
8. a reader is offered no Sign action
9. **the preview route refuses that same reader with `403`** — the control, not the courtesy
10. signing is bounded at five attempts, and the `429` names no infrastructure

On (10) the claim is split deliberately, and the split is stated rather than hidden: the *bound* is
asserted against the real route with a real token, because driving six trips through a dialogue
turns "did the request happen" into a timing question and that is how a rate-limit test becomes
flaky; the *rendering* is asserted in the hydrating suite. Both halves are executed.

Two properties the harness enforces because getting them wrong cost hours: it refuses to run if
something is already listening on either port (a leftover server answers health checks perfectly
well and serves a different tenant, so every assertion fails as authorization), and it kills process
*groups*, because `next start` forks a server that outlives its launcher.

## 12. Unrelated defects found — the important part

Three, all pre-existing, none introduced by this phase, and **none visible to any existing test**.
The first two made the product unusable in a production build.

### 12.1 Sign-in was broken in every built deployment — P0

`app/(auth)/login/actions.ts` is a `'use server'` module and exported `EMPTY_FORM_STATE`, a plain
object. Next turns every export of such a module into a callable server reference, and a plain
object cannot be one:

```
⨯ Error: A "use server" file can only export async functions, found object.
```

`/login` answered **500**. Present since Phase 14 and unchanged since. Every suite stayed green,
because nothing below the login page boots the application.

Fixed by moving the constant into the client component — one line, no behaviour change.

### 12.2 The document screen and the document library were broken — P0

Both pages request `pageSize: 200` from `/admin/folders`. `MAX_PAGE_SIZE` is **100** and the
pagination schema *rejects* anything above it, so every request answered `422` and the page threw
before rendering. Neither screen could be opened, in any environment, since it was written.

Fixed to `100`. That is the API's maximum rather than a considered product answer: a tenant with more
than a hundred folders still needs a *searching* picker, which is a proper follow-up and is not this
phase's to build.

### 12.3 `Retry-After` is documented and never sent — P2

Described in §7. `RateLimitedError` carries `retryAfterSeconds`, the filter drops `details`, and no
header is set — so a client has no retry timing at all. Three artefacts claim otherwise.

### 12.4 Field errors do not reach the browser — P2

`toDomainError` in the web's API client parses the problem body and keeps `code`, `detail` and
`correlationId`, dropping `errors`. So a screen cannot tell a duplicate signature
(`{ field: 'purpose', message: 'duplicate' }`) from a discarded revision — both arrive as the same
generic sentence. The ceremony shows the server's sentence and the browser test asserts the refusal
and that nothing was written; the field-level distinction is asserted where it is visible, in the
API's own HTTP suite.

### 12.5 A trap in `useTranslate`, found by this phase's own tests

`useTranslate()` calls `translatorFor`, which returns a **new closure on every render**. Putting
`translate` in a `useEffect` dependency array therefore re-runs the effect on every render. The
ceremony did that in its first draft: the statement re-fetched in a loop and `stage` reset the
instant anything advanced it, so Continue never continued. Fixed by holding the refusal as a result
and translating during render. No other component in `apps/web` does this today — worth knowing
before one does.

## 13. Deliberately not built

No signature requests, recipients, pending states, expiry, invitations, reminders, delegated,
sequential or quorum signatures, and no notification system. No new workflow state, no new
permission, no new scope mechanism, no new audit action, no new rate-limit rule, no second limiter,
no client-side throttle, no cryptography in the browser, no second MFA dialog, no duplicate
design-system component, no second HTTP client, no `any`, no casts, no suppressions.

## 14. Validation

Every gate, executed against PostgreSQL 16 (two tenant databases) and Redis.

| Gate | Result |
| --- | --- |
| `pnpm format` | clean |
| `pnpm lint` | **0 errors**, 5 warnings (all pre-existing) |
| `pnpm typecheck` | 13/13 |
| `pnpm test` | web **125** (+28) · API 644 / 1 skipped · domain 164 · contracts 26 · utils 11 · i18n 4 · worker 2 |
| `pnpm test:integration` | 36 files, **651 passed**, 0 skipped |
| `pnpm test:visual` | **36 passed** — contrast and screenshots in both themes, 4 new baselines |
| `pnpm test:e2e` | **10 passed** — real API, real web server, real Chromium, unmocked |
| `pnpm build` | 9/9 |
| `pnpm verify:styles` | 10/10 |

PostgreSQL and Redis were reclaimed twice during the phase and restored with the documented
procedure. No assertion was weakened to reach green; where something could not be asserted honestly
at one level it was asserted at the level where it could be, and the split is stated in place.

## 15. Acceptance criteria

Every box in the brief's §31 is met, with these three qualifications stated rather than glossed:

- **Re-authentication is a stage of the confirmation rather than a stage before it** (§4), because
  the API has one door and building a second would create a credential oracle.
- **The rate-limit assertion is split** between the API level and the rendering level (§11), with
  both halves executed.
- **The ceremony has no visual baseline** (§10), because the visual harness renders static markup by
  design.

## Evidence vocabulary

- **IMPLEMENTED** — the panel, the ceremony, verification, withdrawal, the server actions, the
  strings in both catalogues, the end-to-end harness, and the two P0 fixes.
- **VERIFIED** — statement rendered verbatim; preview equals the signed statement but for the
  instant; preview and cancellation write neither a signature nor an audit row; signed state
  survives reload; `document:sign` enforced at the route; axe clean at every stage; keyboard-only
  completion; contrast in both themes.
- **KNOWN LIMITATION** — no separate re-authentication step; no `Retry-After`; no field errors in the
  browser; no visual baseline for the dialogue; no focus-ring or contrast verdict from jsdom.
- **FUTURE ENHANCEMENT** — a searching folder picker (§12.2); `Retry-After` end to end; `errors[]`
  carried through the API client; a `Badge` palette fix in the Platform.
