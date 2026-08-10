# Phase 7.1C — Server-Render Rate-Limit Handling & Record-Page Verification

**Outcome: COMPLETE.** The record page is now **VERIFIED in the running application** at all six
widths, and a rate-limited server render now tells the reader the truth instead of "Something went
wrong."

Nothing about the rate limiter changed. No limit was raised, no route exempted, no bypass added, no
test weakened. The suite fits inside the existing 300-per-minute budget because the record page
stopped asking for things nobody had asked to see: **fifteen API requests per page view became
eight**, measured before and after against the live counters.

| | Before | After |
| --- | --- | --- |
| Record-page server render | 15 API requests | **8** |
| Suite peak on `rl:default:…:identity:…` | **305** / limit 300 | **219** / limit 300 |
| `signing.e2e.spec.ts` | 26 passed, **1 failed** | **27 passed, 0 failed** |
| Record page at 1440/1280/1024/768/430/390 | route error boundary | **passes, 3.3 s** |
| `RATE_LIMITED` in the web server log | every run | **absent** |

---

## 1. The proven cause this phase inherited

Phase 7.1B established, from the web server's own log and from Redis counters read at two-second
resolution during a full run:

- the record page's server component made **fifteen** API requests to render once;
- all of them fell to the `default` rule — `{ windowSeconds: 60, limit: 300, by: ['identity'] }` —
  keyed by tenant **and** identity;
- the suite's signer identity reached **305** in one window;
- the request that crossed the line was refused `429 RATE_LIMITED`;
- the server component threw, and Next.js rendered the route error boundary, digest `2626124548`;
- the browser therefore never saw the record page.

That is a legitimate production control refusing a request that genuinely exceeded a budget. The
control was never the defect. Two other things were.

## 2. The existing error architecture — traced before anything was written

| Piece | Where | What it establishes |
| --- | --- | --- |
| `ErrorCode.RATE_LIMITED` | `packages/domain/src/errors.ts:19` | one code, shared by API and web |
| `RETRYABLE_ERROR_CODES` | `apps/api/src/core/errors/application-errors.ts:197` | `RATE_LIMITED` is **already classified retryable**, beside `DEPENDENCY_UNAVAILABLE` and `VERSION_CONFLICT` |
| `STATUS_BY_CODE` | `all-exceptions.filter.ts:43` | `RATE_LIMITED → 429` |
| problem detail | `all-exceptions.filter.ts:131` | `translate(locale, 'error.RATE_LIMITED')` — "Too many requests. Wait a moment and try again." |
| `toDomainError` | `apps/web/src/lib/api-client.ts:78` | the web tier reconstructs a `DomainError` **carrying the code**, so a screen branches on meaning rather than on a status number |
| `adminGet` vs `adminRead` | `apps/web/src/lib/admin/api.ts` | the product's own split: **throw** when a page has nothing to render, **return a result** when a screen is already up and needs a message |
| `AdminForbidden` | `features/admin-shared/screen.tsx:50` | the established shape for *an API refusal a page can draw honestly* — a `Page` with an `ErrorState`, rendered by the server component in place of the screen |
| signing ceremony | `features/signatures/signing-ceremony.tsx:480` | `RATE_LIMITED` already has its **own** client-side state — wait and retry, not failure |
| route error boundary | `apps/web/src/app/error.tsx` | receives **only** `error.digest`; the message and the code are stripped by Next in production |

The last row is the decisive one. **The boundary cannot distinguish a 429 from a crash** — by
design, so a server-side failure cannot leak. Any fix therefore has to happen *before* the throw
escapes the server component. And the product already knows what a retryable refusal should look
like; it simply had no way to say it from a server render.

## 3. The record page's request fan-out — the investigation Part 3 asked for first

Every request the server render made, and what it was for:

| # | Endpoint | Purpose | Consumed by | First paint? |
| --- | --- | --- | --- | --- |
| 1 | `GET /auth/me` | the caller's permissions | every affordance | **yes** |
| 2 | `GET /documents/:id` | the record — and the call that *writes* the audit-on-read event | the whole page | **yes** |
| 3 | `GET /documents/:id/workflow` | approval state | `ApprovalPanel` | **yes** |
| 4 | `GET /documents/:id/revisions` | revision history | `RevisionPanel` | **yes** |
| 5 | `GET /documents/:id/preview` | viewer manifest | `PreviewPanel` | **yes** |
| 6 | `GET /documents/:id/signatures` | attestations | `SignaturePanel` | **yes** |
| 7 | `GET /auth/mfa` | whether *this* caller owes a second factor | signing ceremony | **yes** |
| 8 | `GET /audit?…` | the trail | `AuditTimeline`, already suspended | streams |
| 9 | `GET /admin/folders?libraryId=…` | move destinations | **move dialogue only** | **no** |
| 10 | `GET /admin/categories` | category picker | **edit dialogue only** | **no** |
| 11 | `GET /admin/confidentiality-levels` | classification picker | **edit dialogue only** | **no** |
| 12 | `GET /admin/users` | user-typed metadata fields | **edit dialogue only** | **no** |
| 13 | `GET /admin/departments` | department-typed fields | **edit dialogue only** | **no** |
| 14 | `GET /admin/fields` | field definitions | **edit dialogue only** | **no** |
| 15 | `GET /admin/document-types` | which fields this type has | **edit dialogue only** | **no** |

Rows 9–15 are read straight off the screen's source: `categories`, `confidentialityLevels`, `users`,
`departments` and `fields` appear **only** inside `{editing && …}`, and `folders` **only** inside
`{moving && …}`. Both dialogues open from the overflow menu and are closed on arrival.

So a reader who opened a controlled document to read it paid for a form they never saw, on every
document, every time — and seven of those requests are *tenant catalogues*: the same answer for every
document in the tenant, fetched again per page view. Nothing is duplicated *within* the render, but
the work is unnecessary at that moment, which is what Part 3 asked about.

This is a genuine architectural issue on its own terms, independent of any test. **VERIFIED** by
source reading and by the +15 counter jump Phase 7.1B measured, which the two agree on exactly.

## 4. Options considered

| | Option | Verdict |
| --- | --- | --- |
| **A** | Render an explicit rate-limit state for a server render refused with 429 | **Chosen.** It is the only thing that satisfies the phase's stated principle, and the product already draws this exact distinction on the client. |
| **B** | Let the affected data degrade — `.catch(() => null)` around more of the fan-out | **Rejected.** The page already does this where it is honest (preview, signatures, MFA — panels that can be absent). Extending it to the *document itself* would render a record page with no record: a compliance surface silently showing less than the truth is worse than an error. |
| **C** | Reduce the record page's fan-out | **Chosen, on its own merits.** Seven of fifteen requests were for closed dialogues. Justified by the evidence in §3 rather than by the test, and implemented through an existing pattern rather than a new one. |
| **D** | A narrowly scoped route rule for the record page's endpoints | **Rejected.** It would create a bucket sized around one screen's inefficiency and make server-rendered pages *privileged* relative to every other caller — criterion 6, failed. Removing the inefficiency is the smaller and more honest change. |
| **E1** | Cache the tenant catalogues across requests (`unstable_cache`) | **Rejected on security grounds.** These reads are tenant-scoped and permission-scoped; a cache keyed anywhere short of both is a cross-tenant leak, and this is a database-per-tenant product where that boundary is the architecture (ADR-0015). |
| **E2** | Raise the `default` limit | **Rejected.** Explicitly out of bounds, and it would trade a real control for a green test. |
| **E3** | Split the E2E suite across more identities | **Rejected.** Part 8's own constraint: the tests that share the signer are *the same person doing different things*, and inventing personas to spread a bucket is changing test semantics to reduce request count. |

Against Part 2's eight questions, the chosen pair answers: **(1)** protection unchanged — same rules,
same guard, same Redis; **(2)** `Retry-After` semantics unchanged, and §9 records what they actually
are today; **(3)** the reader gets a true statement and a button; **(4)** authorization unchanged —
same endpoints, same token, same per-endpoint guards; **(5)** only `RATE_LIMITED` is handled, every
other failure still throws, and that is pinned by a test; **(6)** no page gains any exemption;
**(7)** no test-only behaviour exists — the E2E suite runs the shipped build; **(8)** both halves
reuse patterns already in the tree.

## 5. Decision

**A + C, each minimal, neither dependent on the other.**

A alone would have left the record page unverifiable in a browser — a correct "wait a moment" screen
is still not the record page. C alone would have fixed the suite and left the underlying defect: the
next expensive page to hit a 429 would have shown "Something went wrong" again. Both are required,
and both stand on evidence rather than on making a test pass.

## 6. Security analysis

Everything Part 4 requires is preserved, and each was checked by running the test that proves it, not
by reading the code:

| Property | Evidence |
| --- | --- |
| Distributed Redis-backed enforcement | `rate-limit.integration.spec.ts` — "two application instances share one budget", **9/9 passed** |
| Tenant isolation of the buckets | same suite's isolation test; keys observed in Redis are `rl:{rule}:t:{tenant}:…` throughout |
| Identity isolation | observed: four distinct `rl:default:t:…:identity:…` keys in one run, counted separately |
| Signature protection | `document.sign` still 5/900 s; E2E "bounds signing at the API, and the refusal names no infrastructure" **passed** |
| Login protection | `auth.login` still 10/300 s by ip **and** identity; observed enforcing during this phase |
| Fail-closed for credential routes | "refuses a credential-sensitive request when the limiter is unreachable" **passed**; "keeps a non-credential request working" **passed** |
| No process-local limiter | no `Map`, counter or cache added anywhere; the guard file is untouched |
| No test bypass | `git diff` touches no file under `apps/api/src/core/security/`; the E2E suite drives the shipped production build |

Two properties the change *improves*: a caller who lacks permission on `/admin/departments` used to
take the whole record page down with a 500 they could do nothing about — they now learn it when they
ask to edit. And the seven deferred reads are no longer performed for callers who never had any
intention of editing, which is a smaller attack surface per page view, not a larger one.

**What did not change and is worth stating plainly:** the record page is still rate-limited, still
under the `default` rule, still keyed by tenant and identity. A caller who opens documents fast
enough will still be refused — they will simply be *told* so.

## 7. The minimal implementation

**IMPLEMENTED — the rate-limit state.**

- `features/admin-shared/screen.tsx` — `RateLimited`, the same `Page` + `ErrorState` shape
  `AdminForbidden` uses. Title `state.rateLimited` ("Too many requests"), description the API's own
  `error.RATE_LIMITED` sentence, action a `router.refresh()` button. **Manual, never automatic:**
  retrying on the reader's behalf spends more of a budget that is already spent, and hiding a limit
  is how a limit stops working.
- `packages/i18n` — one new key, `state.rateLimited`, in **both** catalogues.
- `app/(workspace)/documents/[documentId]/page.tsx` — the page body moved into a helper, wrapped in
  a `try/catch` that returns `<RateLimited />` for `ErrorCode.RATE_LIMITED` **and rethrows
  everything else**, so the error boundary keeps its job for the failures it is right for.

**IMPLEMENTED — the fan-out reduction.**

- `features/documents/options.ts` (new) — `DocumentEditOptions` and `DocumentMoveOptions`. A separate
  module because `actions.ts` carries `'use server'`.
- `features/documents/actions.ts` — `loadEditOptions(documentTypeId, confidentialityRank)` and
  `loadMoveOptions(libraryId)`. Server actions, not browser fetches: the access token lives in an
  `httpOnly` cookie and a script cannot carry it. The confidentiality filter and the type→fields
  resolution moved with the data, so the dialogue receives exactly what it received before.
- `features/documents/document-screen.tsx` — the options **are** the open state (`null` is closed),
  so no half-populated form and no loading state to design. The shape is copied from
  `loadShippedTemplate` on the notification templates screen: await, then open; a refusal becomes a
  toast in the same words every other refused action on this screen uses.
- The page passes six fewer props; four spec files updated to match.

Nothing else. The record page's layout, the panels, the actions, the permissions and the API are
untouched — the 27 visual baselines re-rendered **byte-identical**, which is the check that the
change is data-plumbing and not a redesign.

## 8. E2E result — VERIFIED in the running application

Real API, real Redis, real PostgreSQL, two real tenant databases, the production Next build, real
Chromium. Nothing mocked.

```
✓ rate limiting > bounds signing at the API, and the refusal names no infrastructure   4657ms
✓ 9 · responsive layout > lists documents without horizontal overflow at every width   2744ms
✓ 9 · responsive layout > keeps the record page usable at every width                  3326ms
✓ 9 · responsive layout > keeps navigation reachable on a phone                        1232ms

Test Files  1 passed        Tests  27 passed | 19 skipped
```

The record-page test went from a 30-second timeout into an error boundary to **3.3 seconds**, and the
web server log for the whole run contains **no exception at all** — where every previous run carried
`code: 'RATE_LIMITED' … digest: '2626124548'`.

The test itself is stronger than the one it replaces, not weaker. Per Part 6 it now authenticates
normally, navigates to the real record page, waits on the real page, and at **1440, 1280, 1024, 768,
430 and 390** asserts:

- horizontal overflow ≤ 1px;
- the document **number** is on screen;
- the document **title** is on screen — read from the database, not assumed;
- the **status** is on screen, in the words the catalogue renders it with, read from the database;
- the **primary action** (Download) is visible;
- the **More actions** trigger is visible;

and then, at the narrowest width, **clicks** the trigger and waits for a real menu item — reachable,
not merely present. The 30-second timeout is unchanged, and the Phase 7.1A diagnostic dump is gone
with the thing it was diagnosing. No sleep, no retry, no mock, no skip.

`recovery.e2e.spec.ts` fails at `beforeAll` on a missing `DR_DEST_ADMIN_URL` — the disaster-recovery
rehearsal needs a destination cluster this container has not been given. Pre-existing, identical in
the Phase 7.1B runs, and unrelated to this phase.

## 9. Rate-limit regression evidence

Measured the same way the cause was measured — an observe-only poller reading Redis every two
seconds through the whole run, writing nothing.

```
Before (Phase 7.1B):   305  rl:default:t:…:identity:…      ← limit 300, refused
After  (this phase):   219  rl:default:t:…:identity:…      ← limit 300, 27% headroom
```

86 fewer requests from one suite, entirely from record-page renders. `document.sign`, `auth.login`
and `search` counters are unchanged in shape and still enforcing.

Rules re-proved by their own tests rather than by inspection:

| Test | Result |
| --- | --- |
| `rate-limit.integration.spec.ts` (whole file, real Redis) | **9 passed** |
| `default` refuses past its real threshold | passed (two-instance shared-budget test) |
| `document.sign` bounded at 5 / 900 s, refusal names no infrastructure | passed at unit, integration **and** E2E level |
| `auth.login` bounded per IP and per identity | passed |
| Redis unreachable → credential route refuses | passed |
| Redis unreachable → non-credential route continues | passed |
| Retry window carried in the refusal | passed |

No new route rule was introduced, so there is none to prove independently.

## 10. Responsive verification result

**VERIFIED — in the running application**, which is the sentence three phases could not write.

| Surface | 1440 | 1280 | 1024 | 768 | 430 | 390 |
| --- | --- | --- | --- | --- | --- | --- |
| Document library (real browser) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Record page (real browser)** | **✓** | **✓** | **✓** | **✓** | **✓** | **✓** |
| Phone navigation drawer (real browser) | — | — | — | — | ✓ | ✓ |

Static verification is unchanged and still runs: `responsive.spec.tsx` asserts zero horizontal
overflow for four surfaces at the same six widths against the real built stylesheet in Chromium, and
the 27 visual baselines cover the record page in both themes and at 390px.

## 11. Gates

Every gate re-run after the product change; nothing below is carried over from an earlier phase.

| Gate | Result |
| --- | --- |
| `pnpm format` | clean |
| `pnpm lint` | **0 errors**, 7 warnings — all pre-existing `import()`-type-annotation warnings in `pdf-viewer.tsx`, `pdf-text.ts` and `servers.ts` |
| `pnpm typecheck` | 13/13 |
| unit | web **137** · api **645** (1 skipped) · domain 164 · contracts 26 · utils 11 · i18n 4 · worker 2 |
| integration (real PostgreSQL + Redis) | **656 passed**, 3 failed — all three are `s3-upload-integrity`, which needs MinIO; MinIO is not running in this container (`/minio/health/live` → no route). Unrelated to this phase |
| `pnpm build` | 9/9 |
| `pnpm verify:styles` | 10/10 |
| visual + responsive (real Chromium) | **75 passed**, 27 baselines unchanged |
| **e2e — `signing.e2e.spec.ts`** | **27 passed, 0 failed** |
| e2e — `recovery.e2e.spec.ts` | env-gated failure (`DR_DEST_ADMIN_URL` unset), pre-existing |

New coverage: `features/documents/record-page.spec.tsx`, five tests — that the render asks for none
of the seven deferred endpoints, that it still asks for all six it renders from, that the pickers
load **only** when somebody opens that dialogue, that a 429 renders the rate-limit state rather than
the boundary, and that every other failure still throws.

One observation recorded rather than hidden: the web unit suite failed **once**, early in the phase,
with axe-core's "Axe is already running" in `screens.a11y.spec.tsx` while other work was running on
the machine. It has passed four consecutive times since, including twice in isolation. It is a
load-sensitive collision in the a11y harness, not a consequence of this change, and it is named here
rather than claimed as green throughout.

## 12. Limitations and open questions

**KNOWN LIMITATION — `Retry-After` is documented but not on the wire.** `rate-limit.ts:8` says
"every limited response carries `Retry-After`", `bootstrap.ts:49` exposes the header through CORS,
and `RateLimitedError` carries `retryAfterSeconds`. But `AllExceptionsFilter` sets only status, type
and body, and `fromDomainError` does not copy `details` into the problem — so **no header and no
number ever reach the caller**. Phase 6.6 recorded the absence; this phase confirms the comment
overstates what is built. The rate-limit state therefore says "wait a moment" rather than "wait 43
seconds". Not fixed here: it is an API contract change, it is not required for the reader to have an
actionable screen, and Part 5 says not to combine unrelated improvements.

**KNOWN LIMITATION — only the record page handles a server-render 429.** It is the page the evidence
covers. Every other server-rendered page still reaches the generic boundary if one of its reads is
refused. `RateLimited` is exported from `features/admin-shared` and is one `try/catch` away for any
of them.

**RAISED, NOT ANSWERED — should this be a layout-level concern rather than a page-level one?** A
wrapper that caught `RATE_LIMITED` for every workspace route would remove the repetition, at the cost
of a boundary that can swallow a refusal a specific page might want to handle differently. Worth a
decision; not one to take from a single data point.

**RAISED, NOT ANSWERED — the fan-out question generalises.** Eight requests per page view is better
than fifteen and still not small. The document library, the permissions screen and the admin screens
were not measured. Whether a 300-per-minute identity bucket is the right size for a server-rendered
application whose pages each cost several requests is a product decision about the limit *and* about
the pages, and this phase deliberately changed only the page it had evidence for.

**FUTURE ENHANCEMENT — the deferred reads could be narrower still.** `loadEditOptions` fetches all
document types to resolve the fields of one. An endpoint returning a single type's fields would make
it five requests instead of six. Not taken: Part 3 says not to refactor the API for request count
without clear evidence, and one request is not that evidence.

## Evidence vocabulary

**IMPLEMENTED** — `RateLimited`, the `state.rateLimited` key in both catalogues, the record page's
`RATE_LIMITED` branch, `options.ts`, `loadEditOptions`, `loadMoveOptions`, and the screen's
load-then-open dialogues. **VERIFIED** — the record page in real Chromium at all six widths with
identity, status, primary action and a menu that actually opens; the fan-out reduction, measured at
305→219 on the live counters; and every rate-limit property in §6, each by running its own test.
**KNOWN LIMITATION** — `Retry-After` absent from the wire; only this page handles a server-render
429; MinIO-dependent integration tests unrun. **RAISED, NOT ANSWERED** — layout-level versus
page-level handling; whether the bucket fits a server-rendered application. **FUTURE ENHANCEMENT** —
a single-type fields endpoint.
