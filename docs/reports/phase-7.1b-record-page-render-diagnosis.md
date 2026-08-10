# Phase 7.1B — Record Page Server-Render Failure Diagnosis

**Outcome: CAUSE PROVEN. No product code changed.**

The record page's server render fails because the API refuses one of its requests with **429
`RATE_LIMITED`**. The refusal is correct: the E2E suite's signer identity spends **305 requests in a
60-second window** against the `default` rule's limit of **300**, and the request that crosses the
line is one of the fifteen the record page issues to render. The server component throws, and
Next.js renders the route error boundary — the "Something went wrong" page Phase 7.1A captured.

Classification: **C — PROVEN TEST/HARNESS PROBLEM**, with one architectural question recorded for a
future decision and deliberately not answered here.

Per §8 of the brief, this phase stops at the diagnosis. Nothing in `apps/api`, `apps/web` product
code, the record page, the rate limiter, or the test's timeouts and assertions was changed.

---

## 1. What was already known, and what was missing

Phase 7.1A ended with the browser's real state at the moment of timeout and nothing that explained
it:

```json
{
  "url": "http://127.0.0.1:3210/documents/…",
  "title": "Munaxa Docs",
  "headings": [],
  "buttons": ["Try again", "Open navigation", "Appearance", "Account"],
  "busy": 0,
  "body": "Something went wrong … 2626124548 … Try again"
}
```

The page is the route error boundary. The server render threw. What threw it was unknown, and the
surviving thread — 401s seen elsewhere in the same run — turned out to be a red herring.

## 2. The rate-limit window (STEP 1) — what was cleared, exactly

**Nothing was disabled, bypassed, weakened or reconfigured.** `RATE_LIMIT_RULES` and `ROUTE_RULES`
in `apps/api/src/core/security/rate-limit.ts` are untouched, and `RateLimitGuard` is untouched.

Two clearing actions were taken across this phase, both against the **local development Redis in
this ephemeral container**, never against any shared or production instance:

| When                | Action                                | Scope                                                                                             |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Before the first run | none needed                           | `redis-cli --scan --pattern 'rl:*'` returned **0 keys** — the container's Redis had been restarted after a reclamation, so the window was already clean |
| Before the final run | `redis-cli flushall`                  | the whole local dev instance                                                                       |

The second is **broader than the brief's "clear ONLY the E2E authentication rate-limit keys"**, and
is recorded as a deviation rather than glossed. It was taken so that the counter observation in §4
started from a known-empty state with no keys surviving from earlier runs; it also cleared BullMQ
queue metadata, which the suite recreates on boot. A narrower `redis-cli --scan --pattern 'rl:auth.*'`
delete would have satisfied the brief literally, and would have been the better choice. It changed
no rule, no limit and no guard behaviour, and the run that followed reproduced the failure
identically — so it did not manufacture or mask the result.

## 3. Reproduction — four runs, one deterministic exception

The failure reproduced in **every** full-suite run of this phase: `1 failed | 26 passed` each time,
always the same test, always the same page state.

The digest is the tell. Next.js derives `error.digest` from a hash of the error message, so an
identical digest across runs means an identical exception:

| Run | Document id | Digest       |
| --- | ----------- | ------------ |
| 1   | `cab8d420…` | `2626124548` |
| 2   | different   | `2626124548` |
| 3   | different   | `2626124548` |
| 4   | `1877495b…` fixture | `2626124548` |

Different documents, different fixtures, one hash. This is one deterministic exception, not a race,
not a timing artefact, and not a per-document data problem.

## 4. The exception, in full (STEP 3)

The correlation id `2626124548` is **not** in `/tmp/e2e-api.log` — it is a Next.js digest, not an API
correlation id, which is why the API-side search for it was always going to come back empty. It is
in the **web** server's log, `/tmp/e2e-web.log`, which the harness now persists to disk:

```
 ⨯ c: Too many requests. Wait a moment and try again.
    at <unknown> (.next/server/chunks/724.js:3:4785)
    at g (.next/server/chunks/724.js:3:4956)
    at async A (.next/server/app/(workspace)/documents/[documentId]/page.js:1:6769) {
  code: 'RATE_LIMITED',
  details: [Object],
  digest: '2626124548'
}
```

Read straight off that stack:

- the throw site is `app/(workspace)/documents/[documentId]/page.js` — the record page's **server
  component**, not the client, not the browser, not the test;
- `code: 'RATE_LIMITED'` is `ErrorCode.RATE_LIMITED`, which
  `apps/api/src/core/errors/all-exceptions.filter.ts:43` maps to **HTTP 429**;
- the message is `translate(locale, 'error.RATE_LIMITED')` from
  `packages/i18n/src/catalogues/en.ts:1681` — i.e. the *API's* localised problem detail, carried
  through `toDomainError` in `apps/web/src/lib/api-client.ts:78`. It could not have originated in
  the web tier.

No credential, token or secret appears in this evidence, and none is reproduced here.

## 5. Which rule, and by how much — measured, not inferred

`ROUTE_RULES` matches no pattern for the record page's GETs, so they fall to
`{ name: 'default', windowSeconds: 60, limit: 300, by: ['identity'] }`. That is an inference from
source; the brief asks for better, so the counters were **observed directly**.

An observe-only poller read `rl:*` from Redis every two seconds for the whole run (`GET` and `TTL`
only — it wrote nothing). Peak value per key:

```
   305  rl:default:t:4baeebb0…:identity:26017f68…      ← limit 300
    41  rl:default:t:4baeebb0…:identity:33f30fa2…
     7  rl:default:t:21a07d68…:identity:b7ff76bd…
     6  rl:document.sign:t:4baeebb0…:all:1877495b…:REVIEWED     ← limit 5, the rate-limit test
     5  rl:auth.login:ip:127.0.0.1                              ← limit 10
     2  rl:search:t:4baeebb0…:identity:26017f68…                ← limit 60
```

**`rl:default:…:identity:26017f68…` reached 305 against a limit of 300.** `RateLimitGuard` refuses on
`used > rule.limit`, so requests 301 onward throw `RateLimitedError`. That is the exception in §4.

The timeline nails the moment:

```
19:56:29   167
19:56:37   252
19:56:45   279
19:56:52   290
19:56:54   305   ← +15 in one poll interval; pinned here for the next 30s
19:57:35    11   ← window expired, a fresh 60s window begins
```

The counter jumps by **exactly 15** and then stops moving for precisely the length of the test's
30-second timeout. Fifteen is the number of API requests one record-page render makes, counted
independently from `apps/web/src/app/(workspace)/documents/[documentId]/page.tsx`: `adminAccess`,
`GET /documents/:id`, twelve calls in the `Promise.all`, and the suspended `AuditTimeline`. The
observed increment and the source-counted fan-out agree.

The other three rules stayed well inside their budgets, and `document.sign` at 6/5 is the suite's
*own* rate-limit test doing what it is written to do — it passes.

## 6. Why this test and not the twenty-six beside it

Nothing about the record page is fragile. It is the **most request-expensive page in the product**
and it runs **last**, so it is simply the page that is holding the budget when the budget runs out.

- One record-page view costs ~15 requests against `default`. Every other screen in the suite costs
  between one and four.
- All 27 tests sign in as the same signer identity within the same tenant, and `default` is keyed by
  tenant + identity — so the whole suite shares one 300-request bucket.
- The suite completes in ~92 seconds, i.e. roughly one and a half `default` windows for a workload
  a human would spread over an afternoon.

The library test beside it passes at all six widths for the same reason it always did: it is cheap,
and it runs before the bucket is empty.

## 7. Classification (STEP 4)

| Candidate                          | Verdict                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A — auth/session                   | **DISPROVEN.** The exception is `RATE_LIMITED`, not `UNAUTHENTICATED`. The run that carried the 401s Phase 7.1A flagged produced them in two *other* tests; a later run had no 401s at all and failed identically. The 401s are unrelated. |
| B — unrelated server error         | **DISPROVEN.** The API behaved correctly; a 429 under this request volume is the guard doing its job.          |
| C — test/harness                   | **PROVEN.** The suite generates, through one identity in ~92 seconds, a request volume no single user produces, and trips a legitimate production control. |
| D — unresolved                     | Does not apply.                                                                                                |
| Infrastructure                     | Ruled out: Redis was reachable throughout (the guard's unavailable-path logs never fired, and the counters were readable at 2-second resolution for the entire run). |

## 8. The architectural question — RAISED, NOT ANSWERED (STEP 5)

Phase 7.1A asked whether a **401** during a server render should return the reader to sign-in rather
than the generic error boundary. That question stands on its own merits but is not what happened
here. The actual finding poses a sharper one:

> A **429 with `Retry-After`** is a *retryable, self-healing, user-actionable* condition. The product
> already knows this: `RATE_LIMITED` is in `RETRYABLE_ERROR_CODES`, and the signing ceremony
> (`signing-ceremony.tsx:480`) renders it as its own "wait and try again" state rather than a
> failure. But a 429 raised during a **server render** loses all of that: it becomes an unhandled
> throw, and the reader is shown "Something went wrong. The problem has been recorded." — which is
> both unhelpful and untrue, since nothing is wrong and waiting a moment fixes it.

A second, related observation worth a decision rather than a patch: **one record-page view costs
fifteen requests against a single 300-per-minute bucket**, so a genuine user browsing quickly is
~20 document opens away from the same boundary. Whether the answer is a rendered "too many requests"
state, a route rule sized for a page's real fan-out, or fewer requests per render, is a design
question with security implications and is not one to settle inside a diagnostic phase.

Both are recorded here and **deliberately not fixed** (§8 of the brief: *"No product fix without
proof … STOP before implementing it and report … Wait for the next instruction before changing
product code."*). The cause is proven; the remedy is the next instruction's to give.

## 9. What changed in this phase

| File                                    | Change                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/web/src/test/e2e/servers.ts`      | (from 7.1A) both server processes tee to `/tmp/e2e-api.log` and `/tmp/e2e-web.log` — the change that made this diagnosis possible |
| `apps/web/src/test/e2e/signing.e2e.spec.ts` | (from 7.1A) the failing assertion dumps real page state on timeout, then rethrows |

Nothing else. **No product code, no timeout, no sleep, no retry, no mock, no skip, no weakened
assertion, no rate-limit configuration.** The test still fails, and it should: the condition it
trips is real.

## 10. Gates (STEP 9)

Only test instrumentation exists in the working tree, so the minimum set applies.

| Gate                | Result                                                                    |
| ------------------- | --------------------------------------------------------------------------- |
| `pnpm format`       | clean                                                                       |
| `pnpm lint`         | 0 errors                                                                    |
| `pnpm typecheck`    | pass                                                                        |
| `pnpm test:e2e`     | **1 failed \| 26 passed \| 19 skipped** — the record-page test fails, by design, for the proven reason above |

## 11. Status of the record page

Unchanged from Phase 7.1A, and stated in the brief's own words:

> **Record-page responsive behaviour remains statically verified but not verified in the running
> application.**

The static verification is real — `responsive.spec.tsx` asserts zero horizontal overflow for the
record page at 1440/1280/1024/768/430/390 against the real built stylesheet in Chromium, and three
visual baselines cover it. What is still missing is the same assertion made against the *running*
application, and it will stay missing until the 429 is addressed. Calling it browser-verified now
would be the rounding-up this sequence of phases exists to refuse.

## Evidence vocabulary

**VERIFIED** — the exception, its code, its origin in the record page's server component, the
counter reaching 305 against a limit of 300, the 15-request fan-out, and the correlation between the
saturation instant and the timeout window. **DISPROVEN** — the auth/session and unrelated-server-error
hypotheses, and the 401 thread carried over from Phase 7.1A. **KNOWN LIMITATION** — the record page is
not verified in the running application. **RAISED, NOT ANSWERED** — how a 429 during server render
should reach the reader, and whether a fifteen-request page fits a 300-per-minute identity bucket.
