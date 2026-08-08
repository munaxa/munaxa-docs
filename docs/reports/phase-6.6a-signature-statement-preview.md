# Phase 6.6A — Electronic Signature Statement Preview API

**Status: COMPLETE.** Phase 6.6 is unblocked. One additive `GET`, one statement construction shared
with signing, and one proof that the bytes a ceremony displays are the bytes a signature stores.

It also found something the phase was not looking for, and that finding is the more important half
of this report: **signing has never worked over HTTP in its default configuration.** §11.200
re-authentication — on by default, and the whole reason the endpoint accepts a password — read
`user_credential` outside any unit of work, so every real signature answered `500`. It is fixed, in
four lines, and the reason nothing caught it for six phases is set out below.

---

## 1. Why Phase 6.6 stopped

The ceremony's central screen has to show the exact attestation statement *before* the user
confirms. ADR-0017 makes that a requirement rather than a nicety: a §11.50 signature manifestation
*is* the evidence, and somebody who attests text they were not shown has not manifested anything.

`DocumentSignaturesController` had four routes. `statementBody` appeared on exactly one of them —
verification — which takes a `signatureId` and therefore requires the signature to already exist.
`serialiseSignatureStatement` was called from exactly one place, inside
`DocumentSignatureService.sign`, at the instant of signing.

So there was no way to obtain the statement before the act that creates it, and all three
workarounds were refused with reasons:

| Workaround | Why not |
| --- | --- |
| Render the text in the browser | Forbidden by the brief, and wrong on its own terms: ADR-0017 §3 stores the bytes verbatim *precisely* so verification never regenerates them. A browser-composed statement is a second artefact. |
| Sign first, then display | Inverts the ceremony. The user would attest before reading. |
| Paraphrase | Discards the §11.50 manifestation, which is the evidence. |

## 2. The statement construction, traced

**VERIFIED** — the path, read from the code rather than assumed:

```
DocumentSignaturesController.sign            presentation
  → DocumentSignatureService.sign            application  — feature flag, witness key, actor, §11.200
    → signWithin → AdministeredWriter.write  one transaction, one audit row
      → signableRevision()                   document, revision, DISCARDED refusal
      → refuseWhenAlreadySigned()            the live-signature rule
      → statementFacts()                     content digest from the blob row, signer's name/email
      → statementFrom()                      serialiseSignatureStatement  ← the only call site
      → witness(body, secret)                HMAC-SHA256, keyId derived from the secret
```

`serialiseSignatureStatement` (in `@edms/domain`) is a hand-ordered, newline-delimited
serialisation, versioned by its first line, deliberately not `JSON.stringify` — a signature over a
re-serialisation depends on two `stringify` calls agreeing about key order, which is a property of a
runtime rather than of a format.

## 3. What was extracted, and what was not

**IMPLEMENTED** — `signWithin`'s body became four private methods, called in the same order by
`sign` and by `previewStatement`:

| Method | What it owns |
| --- | --- |
| `signableRevision(documentId, revisionId)` | Document exists; revision exists **and belongs to this document**; revision is not `DISCARDED` |
| `refuseWhenAlreadySigned(revisionId, signer, purpose)` | The live-signature rule |
| `statementFacts(document, revision, signer)` | Everything the statement is *about*, resolved from the record |
| `statementFrom(facts, act)` | **The single call to `serialiseSignatureStatement`** |

Two details are load-bearing.

`SignatureStatementFacts` is declared as `Omit<SignatureStatement, 'purpose' | 'statement' |
'signedAt'>` rather than as a fresh interface, so the compiler keeps it in step with the domain: a
field added to what a signature attests becomes a field the preview must resolve, rather than one it
could silently omit.

They are four methods rather than one because the *order* is behaviour. Folding them together would
have moved the duplicate check to the other side of the digest read, which changes which refusal a
caller sees when two things are wrong at once. Splitting them keeps the order visible at each call
site and identical to what it was before this phase.

**Not changed:** the canonical bytes, the field ordering, `SIGNATURE_STATEMENT_VERSION`, the HMAC,
the derived `keyId`, the algorithm string, `signRevisionSchema`, `documentSignatureSchema`,
`signatureVerificationSchema`, the audit action and payload, withdrawal, the concurrency index, or
the rate-limit rules. ADR-0017 is untouched. No Platform change; no new `@munaxa/*` package.

## 4. The endpoint

```
GET /api/v1/documents/:id/signatures/statement?revisionId=…&purpose=…[&statement=…]

200 → { statementBody, revisionId, purpose, preparedAt }
```

**IMPLEMENTED.** Declared above the `:signatureId` routes; there is no ambiguity to resolve, since
those match two path segments and this matches one.

`statementBody` reuses the field name the verification response already gives the same artefact —
they are the same bytes from the same construction, and two names in one contract would invite a
client to treat them as two things.

`preparedAt` is the instant embedded in those bytes. It is on the response because of §7's known
limitation, so a screen can *say* what it is instead of implying a promise the server did not make.

`statement` is accepted because the signer's own words are part of the attested bytes; a preview
that omitted them would show a statement the signature will not match.

Nothing else was added. No canonical byte dump beyond the statement, no digest as a separate field,
no `keyId`, no witness. This is a statement preview, not cryptographic debugging.

## 5. Authorization

**VERIFIED** — `document:sign` plus `@ScopedTo('id', ScopeType.DOCUMENT)`, asserted by reflection on
every push and exercised over HTTP.

Why `document:sign` and not `document:view`, given that the statement discloses nothing new — the
document's number, the revision's label, the content digest and the caller's *own* name and address
are all already visible to a reader:

> The permission is not protecting a secret. It says what the surface is **for**. This is the first
> step of a §11.50 ceremony, and it belongs to the people who may complete one. A caller who may
> read a controlled document has no business assembling an attestation over it, and a route that let
> them would be a capability nobody granted.

No permission was created, none was changed, no new scope mechanism exists. `document:sign` is still
ADR-0017 §5's `S`, seeded to no role including the tenant administrator.

**Re-authentication was deliberately not added.** Previewing is not signing. §11.200 belongs to the
act, and a query string is the last place a password should be — the query schema declares no
credential field, and one offered anyway is dropped at the pipe before anything downstream can read
it, log it or key on it. The ceremony's order is unchanged:

```
VIEW → PREVIEW → RE-AUTHENTICATE → CONFIRM → SIGN
```

## 6. Validation, tenancy and error behaviour

**VERIFIED**, each over the real route:

| Case | Answer | Why that one |
| --- | --- | --- |
| Revision belongs to another document | `404` | `describe` answers null for a foreign revision as well as a missing one; both refusals are the same, because saying "it exists, but not here" is telling somebody about a document they were not reaching for |
| Document does not exist | `404` | `AclGuard`'s refusal — an unreachable object is not told it exists |
| Revision is `DISCARDED` | `422`, `{ field: 'revisionId', message: 'DISCARDED' }` | The existing rule, not a new one |
| Signer already holds a live signature for that purpose | `422`, `{ field: 'purpose', message: 'duplicate' }` | Same check, same field, same message as signing |
| Purpose outside the catalogue | refused, no statement | The existing enum, through the existing pipe — see §9 |
| Unauthenticated | `401` | |
| Holds `document:view` only | `403` — and the same caller reads `GET …/signatures` with `200` | The sharpest form of "never rely on UI hiding as authorization" |
| Another tenant's signer, by identifier | `404`, nothing of the other tenant in the body, nothing written in her database | ADR-0015: two tenants, two databases, one process's catalogue |

No error semantics were invented, and the existence/authorization collapse the other document routes
perform is preserved exactly.

## 7. Preview versus signing — and the one thing a preview cannot promise

**VERIFIED** by `apps/api/src/__tests__/signature-statement.e2e.integration.spec.ts`: a preview is
taken over HTTP, the same revision and purpose are then signed over HTTP, the stored
`statement_body` is read straight from `document_signature`, and

```
differingFields(preview, stored) === ['signed-at']
```

Every other line is byte-identical. The same test recomputes `HMAC-SHA256(stored, secret)` and
matches it against the stored `signature` column, because a preview that agreed with a body nothing
was signed over would prove nothing.

**KNOWN LIMITATION — the instant.** `signed-at` is resolved when the signature is taken, so a
preview's is necessarily earlier. This is a property of time rather than a defect, and it is not
hidden: `preparedAt` names the previewed instant on the response, and the assertion above pins
`signed-at` as *the only* permitted difference rather than tolerating a set of them.

**VERIFIED — the preview writes nothing.** Three previews leave `document_signature` and
`audit_event` at exactly their prior counts for the tenant. `previewStatement` runs in
`AdministeredWriter.read` — the transaction without the audit event, which is the distinction that
class exists to make unmissable. No `DOCUMENT_SIGNED`, and no new audit vocabulary.

**VERIFIED — the preview does not spend the signing budget.** Eight consecutive previews all
answer `200`, and a signature immediately afterwards succeeds. `document.sign` is five per fifteen
minutes; had previews counted, the sixth would have been refused and the signature would have been a
`429`. No rule was added, none was widened, and no second limiter exists: a `GET` matches no entry in
Phase 6.7's route table and falls to `default` (300 a minute, per identity), which is the existing
architecture applying rather than a preview-specific rule appearing.

## 8. The defect this phase found: signing was broken

**IMPLEMENTED (fix).** `DocumentSignatureService.sign` called
`SignerAuthenticator.reauthenticate` before opening its transaction.
`IdentitySignerAuthenticator` reads `user_credential` through `PrismaCredentialRepository`, which —
like every repository in this product — calls `requireTransaction()`. There was no ambient unit of
work, so the read threw `NoActiveTransactionError` and the endpoint answered `500`.

`SIGNATURE_REQUIRE_REAUTHENTICATION` defaults to **on**, because §11.200 requires two identification
components. So in its default configuration, **every electronic signature this product has ever been
asked to take has failed.** The endpoint that Phase 6.7 spent a phase rate-limiting could not
succeed.

Why nothing caught it: `signature-uniqueness.integration.spec.ts` asserts the partial unique index
against the database directly and deliberately bypasses the service; the Phase 6.7 HTTP test drives
`POST …/signatures` with a caller who lacks `document:sign`, so authorization refuses every request
before the service is reached; and there is no service-level spec, for the reason in §10. Six phases
of green suites, and no request ever reached line 108.

The fix is to wrap the credential read in `this.writer.read(...)` — a `read` rather than folding it
into the write below, because the ordering is the security property: credentials are proved *before*
the transaction that writes the attestation opens, so a refusal leaves nothing behind. Nothing else
changed: same call, same inputs, same single undifferentiated refusal, same position in the sequence.

This is the fourth phase running to find a control that was declared, configured and unreachable —
after Phase 6.3's phantom permissions, Phase 6.4's unread `DeliveryState.FAILED`, and Phase 6.7's
route table that matched no real path. Every one was found by a request rather than by a reading.

## 9. One thing observed and deliberately not fixed

**KNOWN LIMITATION.** `zod` publishes separate CommonJS and ESM entry points exposing two distinct
`ZodError` classes. The API compiles to CommonJS in production, so `ZodValidationPipe`'s
`instanceof ZodError` holds and a malformed query is a `422`. Under vitest the API's own modules are
transformed to ESM while `@edms/contracts/dist` stays CommonJS, the `instanceof` misses, and the pipe
re-throws — which the filter reports as `500`.

This affects every schema-validated route in the repository, predates this phase, and is a property
of the test harness rather than of the product. It is recorded rather than papered over:

- The HTTP test asserts what is actually guaranteed — the request does not succeed and no statement
  comes back — and says in place why the status code is not pinned there.
- The exact refusal is pinned on the schema itself, in
  `presentation/__tests__/signatures.controller.spec.ts`, where no transform sits in between.

Also noted: `ZodValidationPipe`'s comment claims unknown keys are "rejected rather than stripped".
Plain `z.object` strips them, so the comment overstates. Harmless here — a stripped password is a
password nothing downstream can see — but it is not what the comment says.

## 10. Tests

**VERIFIED.** 8 unit assertions and 15 HTTP assertions, all executed.

`presentation/__tests__/signatures.controller.spec.ts` — runs on every push, no infrastructure:

1. the preview declares `document:sign`, not `document:view`
2. the preview is `@ScopedTo` the document in the path
3. the four existing routes' permissions and scopes are unchanged
4. every purpose in the existing catalogue is accepted and `RUBBER_STAMP` is not
5. a revision identifier that is not one is refused
6. no credential field is declared, and one offered is discarded
7. the preview route does not fall under `document.sign`
8. the signing route is still `document.sign`, still credential-sensitive

`__tests__/signature-statement.e2e.integration.spec.ts` — real Nest application, real PostgreSQL ×2,
real Redis, real scrypt, real HMAC:

1. a signable revision returns the canonical statement, every field asserted by name
2. the signer's own words appear in the previewed bytes
3. no credential, key, witness or hash material is disclosed; the response has exactly four keys
4. **preview versus a real signature: `['signed-at']` is the only differing field**, the instants
   are ordered correctly, and the stored witness verifies over the stored bytes
5. the preview refuses once that signature exists, with signing's own field and message
6. the same revision still previews for a different purpose
7. three previews create no signature row and no audit row
8. eight previews do not spend the signing budget, and a signature after them succeeds
9. an unknown purpose is refused and produces no statement
10. a revision belonging to another document is refused
11. a `DISCARDED` revision is refused with `revisionId: DISCARDED`
12. a missing document answers `404`
13. an unauthenticated caller answers `401`
14. a reader who may not sign answers `403` — and reads the signature list with `200`
15. a signer in another tenant answers `404`, learns nothing, and writes nothing

**Why there is no mocked service-level spec.** `sign` runs inside `AdministeredWriter.write`, which
calls `requireTransaction()` — the ambient Prisma transaction, held in `AsyncLocalStorage` that only
`PrismaUnitOfWork` can populate. A hand-built fake unit of work cannot put a transaction there, so a
unit test of signing is not merely undesirable, it is unconstructible. Inventing a mock statement
builder to get one would have meant asserting the exact thing this phase must not assert: that two
constructions agree.

**Why no ACL `DENY` fixture.** `testing/acl-seed.ts` records the convention that an `acl_entry`
written as the owner is not the row a request would have written, and that a suite seeding one is
not testing what a request would see. Scope enforcement is therefore proven the two honest ways: by
reflection that the binding is declared, and over HTTP that a caller without the permission is
refused while the same caller reads the list.

## 11. Validation

All gates run locally against PostgreSQL 16 (two tenant databases) and Redis.

| Gate | Result |
| --- | --- |
| `pnpm format` | clean |
| `pnpm lint` | **0 errors**, 5 warnings (all pre-existing) |
| `pnpm typecheck` | 13/13 |
| `pnpm test` | API 644 passed / 1 skipped · domain 164 · web 97 · contracts 26 · utils 11 · i18n 4 · worker 2 |
| `pnpm test:integration` | **36 files, 651 passed, 0 skipped** |
| `pnpm build` | 9/9 |
| `pnpm verify:styles` | 10/10 |
| Visual | not affected — no web change in this phase |

Integration was 35 files / 636 before; the new suite is the +1 file and +15 tests. The HTTP suite was
run twice consecutively, green both times, after a first run that failed on its own `auth.login`
budget — the fixture now signs in once per person, which is the same self-inflicted flakiness Phase
6.7 fixed the same way.

## 12. Deliberately not done

No signature UI — that is Phase 6.6, and this phase stops here as instructed. No signature-request
state machine, no pending/expired/cancelled states, no recipient model. No second MFA dialog. No
change to ADR-0017, to the cryptographic semantics, or to the Munaxa Platform. No new permission, no
new scope mechanism, no new audit action, no new rate-limit rule, no second limiter. No `any`, no
casts, no lint or typecheck suppressions.

## 13. Handoff to Phase 6.6

The UI can now implement `VIEW → PREVIEW → RE-AUTHENTICATE → CONFIRM → SIGN` without reconstructing
any statement in the browser. Two things it must carry:

- **Label the instant.** `preparedAt` is the previewed timestamp, not the signing one. The screen
  should say the statement will carry the instant of confirmation.
- **The refusals are structured.** `errors: [{ field, message }]` is what to branch on; `detail` is a
  translated generic sentence.

## Evidence vocabulary

- **IMPLEMENTED** — the shared statement construction; the `GET` route and its contract; the
  §11.200 transaction fix.
- **VERIFIED** — preview equals the signed statement in every field but `signed-at`; the preview
  writes no signature and no audit row; it does not spend the signing budget; `document:sign` and
  `@ScopedTo` are declared and enforced; tenant isolation over the route; every refusal in §6.
- **KNOWN LIMITATION** — the `signed-at` instant cannot be known before signing; the harness-only
  `zod` dual-package effect on validation status codes; no ACL `DENY` fixture, by convention.
- **FUTURE ENHANCEMENT** — the Phase 6.6 ceremony UI; a service-level spec for signing, if the
  transaction seam is ever made injectable; pinning validation status codes in-process once the
  build and the harness agree on one module system.
