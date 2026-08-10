# Phase 7.1A — Record-Page Real-Browser Responsive Verification

**Outcome: UNRESOLVED, substantially narrowed.** The cause of the record-page browser timeout is not
established. Four hypotheses were eliminated by controlled experiment, the browser's actual state at
the moment of failure was captured, and that capture points somewhere none of the earlier guesses
did. It is not enough to call anything verified, and §11's stop condition applies.

> **Record-page responsive behaviour remains statically verified but not verified in the running
> application.**

---

## 1. The original failure

`9 · responsive layout > keeps the record page usable at every width` times out after 30s waiting
for its readiness signal. It reproduces in every full-suite run. The library test beside it — same
section, same shape, same fixture — passes at all six widths.

## 2. Browser evidence at the moment of timeout — VERIFIED

The failing assertion was wrapped so that a timeout dumps the page's real state before rethrowing.
This is what the browser sees:

```json
{
 "url": "http://127.0.0.1:3210/documents/cab8d420-e86d-448a-99ec-a5bea1072128",
 "title": "Munaxa Docs",
 "headings": [],
 "buttons": ["Try again", "Open navigation", "Appearance", "Account"],
 "busy": 0,
 "body": "Something went wrong\n\nThe problem has been recorded. Try again, or contact
          your administrator.\n\n2626124548\n\nTry again"
}
```

**The page is the route error boundary.** Every earlier theory is dead on this one observation:

| Was it…                    | No, because                                                                   |
| -------------------------- | ----------------------------------------------------------------------------- |
| still loading?             | `busy: 0`, no skeleton, `readyState` complete                                 |
| a permission-denied state? | that renders its own screen with a different sentence                         |
| a slow signature panel?    | there are **no headings at all** — nothing of the record page rendered        |
| a locator problem?         | the button genuinely is not there; four buttons are, and they are the shell's |
| the viewport?              | the shell rendered fine at the same width                                     |

`app/error.tsx` is doing exactly what Phase 1 designed it to do: show the correlation id, show
nothing else, offer a retry. The server render of `/documents/[documentId]` threw.

**And in the same run, two unrelated tests failed with `401` where they expected `403` and `429`** —
both of them tests that call the API _directly_ with a session token. That is the thread §3 of this
report follows.

## 3. Experiments — VERIFIED

A dedicated diagnostic spec drove the same navigation under four conditions. **All four passed**,
which is what makes this interesting:

| #   | Condition                                                                            | Result            |
| --- | ------------------------------------------------------------------------------------ | ----------------- |
| A   | Record page in isolation, first navigation of a fresh session                        | **ready in 5.0s** |
| B   | Second navigation to the same record on the same page object                         | **ready in 3.8s** |
| C   | Record page reached after the library, fresh context                                 | **ready in 2.5s** |
| D   | Record page with **25 browser contexts left open**, recreating what a full run leaks | **ready in 5.7s** |

D deserves a note because it disproved the strongest structural hypothesis. The suite calls
`pageFor` **28 times**, each opening a new browser context, and every caller closes the _page_ and
never the context — so a full run ends holding ~25 live contexts. Recreating that exactly did not
reproduce the failure.

Prior phases had already eliminated locator ambiguity and viewport width (the failure follows test
_position_, not width), and Phase 7.1's swap of the readiness signal eliminated the signature panel.

**Six hypotheses eliminated. The failure needs something only a full suite run supplies.**

## 4. Root cause — UNDETERMINED

The honest state of knowledge:

**Established.** The record page's server render throws, and the error boundary renders. The failure
requires full-suite context — no isolated reproduction exists after four attempts. Direct API calls
in the same run return 401 where the tests expect 403 and 429.

**The strongest surviving hypothesis, and it is not proven.** The suite establishes three sessions
through the real sign-in form in `beforeAll` and is frequently re-run; `auth.login` rate limiting
tripped repeatedly during this investigation, costing several runs outright at setup. If a session
is established inside a throttled window, or is invalidated during the run, the token it carries
would produce exactly the 401s observed — and a 401 reaching the record page's server component
would produce exactly the error boundary observed.

**What would settle it, and was not obtainable here.** The exception behind correlation id
`2626124548`. Both servers now write to `/tmp/e2e-api.log` and `/tmp/e2e-web.log` (added this phase,
kept), but every subsequent run died at sign-in on the rate limiter before reaching the record test.

## 5. A product question this raises — not a defect, not yet

If the hypothesis holds, then **a 401 from the API during a server render surfaces as "Something
went wrong" rather than sending the reader back to sign in.** For an expired session that is the
wrong answer: the correct response to "your credentials are no longer valid" is re-authentication,
not a generic failure with a correlation id.

It is written here as a **question for a future phase**, not a finding. Nothing in the evidence yet
shows the API returned 401 to _that_ render; the 401s were observed on different calls in the same
run. Asserting the link would be the same substitution this sequence of phases exists to refuse.

## 6. What changed in this phase

- **Evidence capture on failure** (kept). The record-page assertion dumps URL, title, headings,
  buttons, busy-state and body text before rethrowing, so the next run produces the evidence rather
  than another guess.
- **Server logs captured to disk** (kept). `startServers` pipes both servers to `/tmp/e2e-api.log`
  and `/tmp/e2e-web.log`. A failure that only reproduces inside a full run cannot be diagnosed
  without them.
- **The diagnostic spec was removed** once its four experiments were recorded here.

**No product code changed.** No timeout was raised, no sleep added, no retry, no mock, no weakened
assertion, no skip. The test still fails, and it should.

## 7. Verification status

| Claim                                                                                 | Label                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Record page does not overflow at 1440/1280/1024/768/430/390                           | **VERIFIED** — static suite, real built stylesheet, 6/6 |
| Record page at 390px shows title, number, revision, status, Download and More actions | **VERIFIED** — baseline inspected as an image           |
| Record page usable at six widths **in the running application**                       | **UNRESOLVED**                                          |
| Library at six widths in the running application                                      | **VERIFIED** (Phase 7.1)                                |
| Phone navigation drawer in the running application                                    | **VERIFIED** (Phase 7.1)                                |
| Root cause of the record-page timeout                                                 | **UNRESOLVED**                                          |
| A 401 during server render renders the error boundary rather than re-authenticating   | **KNOWN LIMITATION / open question** (§5)               |

## 8. Gates

Unchanged from Phase 7.1 and re-confirmed where this phase touched anything: typecheck 13/13; the
only files changed are two E2E harness files and this report. No visual baseline was touched, no
product source was modified.

## 9. Next step, for whoever takes this

One run, with `auth.login` given its five-minute window first, reaching the record test and reading
`/tmp/e2e-api.log` for the request that carries correlation id from the failure. That single line
decides between "the harness's session was invalid" and "the record page's server render has a real
fault", and nothing short of it should be allowed to close this.
