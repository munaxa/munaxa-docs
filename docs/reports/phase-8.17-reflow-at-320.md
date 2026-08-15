# Phase 8.17 — Reflow at 320

## 1. Status

**COMPLETE** for the objective, with one disclosed failure that is not this phase's: the
`recovery` DR-rehearsal suite times out on this container (§12a). The honest headline is a negative:
**no product defect was found.**

The dimension measured this phase — WCAG 2.1 **AA** 1.4.10 Reflow, at the 320 CSS px the criterion
actually names — had never been tested anywhere in either repository. Munaxa Docs turned out to
already satisfy it: twelve routes, two narrow widths, both themes, **zero horizontal overflow and
zero axe violations**. That property is now enforced rather than merely true.

The platform's *stories* do overflow at 320, and this report is careful about what that means: the
one case touching a shipped component was traced to the story's own fixture content, and a fix I
wrote for it was measured, found to make things **worse**, and reverted. No platform code changed;
no release was required.

## 2. Objective

Find the next highest-value confirmed problem, fix it at the owning layer, prove it.

## 3. Starting state, verified rather than assumed

| | Reported by 8.16 | Measured here |
| --- | --- | --- |
| Platform `main` | `fc6a8e2` | `fc6a8e2` ✓ |
| Docs HEAD | `ad75d06` | `ad75d06` ✓ |
| Published / installed | 1.5.0 | 1.5.0 ✓ |
| `@munaxa/ui` façade | 3 lines → one platform copy | **re-verified**: 3 lines, 1 copy, resolves 1.5.0 ✓ |
| `@munaxa/*` local deps in lockfile | none | **0** (the 25 `workspace:` entries are Docs' own `@edms/*`) ✓ |
| Stories | 106 | 106 ✓ |
| Contrast · keyboard · overlays | 848 · 848 · 74 | **848/848 · 848/848 · 74, 0 violations, 0 errors** ✓ |
| Both trees | clean | clean ✓ |

## 4. Fresh baseline

### 4.1 Choosing where to look

Components, runtime states, overlays, routes, roles, themes and writing direction have all been
measured in the last four phases and are clean. Reviewing what remains, one dimension stood out:
**every one of the 848 combinations renders at 1280×900**, and Docs' responsive suites stop at 390 —
a device width. 1.4.10 names **320**. Nothing, anywhere, had tested it.

### 4.2 The component matrix at 320px

All 106 stories, at 320 and at 1280 as the control:

| | 320px | 1280px |
| --- | --- | --- |
| Stories overflowing horizontally | **12** | 0 |
| axe violations | **12** | 0 |

### 4.3 The product at 320px

Twelve routes, at 320 and 390, both themes:

| | 320px | 390px |
| --- | --- | --- |
| Routes overflowing | **0 / 12** | **0 / 12** |
| axe violations, any impact | **none** | **none** |

The product satisfies the criterion. That is the phase's most important measurement and it is a
negative one.

## 5. Candidate findings

| # | Finding | Cat | Evidence | Frequency | Owner | Selected |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Reflow untested anywhere; 320 never measured | **C/E** | 848 combinations at one width; Docs stops at 390 | universal | harness | **yes** |
| 2 | `AppShell` stories overflow 8px at 320 | **C** | story passes two *text-labelled* buttons; Docs passes icon-width controls | 4 stories | story fixture | no — §15 |
| 3 | `scrollable-region-focusable` ×12 at 320 | **C** | doc-kit token tables; **not shipped** — `files` excludes `docs/`, 0 entries in the tarball | 12 stories | Storybook docs | no — §15 |
| 4 | Charts and the two-month range calendar overflow at 320 | **D** | 1.4.10 exempts content requiring two-dimensional layout | 4 stories | — | documented exception |
| 5 | Unnamed `<aside>` on `/documents` | B | carried from 8.16 | 1 route | Docs | no — §15 |
| 6 | ContextMenu / E2E CI / ArrowDown / `aria-errormessage` | — | unchanged | — | — | no — §15 |

### Why finding 1 was selected, and why nothing was "fixed"

There was no Category A or B defect to fix. Three of the four things the measurement surfaced are
properties of stories and documentation pages, and the fourth is an exception the criterion itself
grants. Selecting one of those and calling it a product fix would be manufacturing work.

What is genuinely valuable is the measurement: the product's conformance with an AA criterion was
**unknown**, is now **known**, and is now **enforced**. §18 of the brief warns against selecting a
finding because it is easy or because it increases coverage; it does not require inventing a defect
when the evidence says there isn't one.

## 6. The fix I wrote, measured, and reverted

Finding 2 is the one that touched a shipped component, so it got the most scrutiny.

`TopBar` renders `<div className="ms-auto flex items-center gap-2">{actions}</div>`. A flex item
defaults to `min-width: auto` and refuses to shrink below its content, so at 320px the header
overflowed its own box — `scrollWidth` 304 inside `clientWidth` 272, pushing the page to 328.

That reads like a textbook shared-component defect, and I implemented the textbook fix: `min-w-0` on
the actions track, with a long comment explaining why the component rather than each product should
absorb it. Then I measured it:

| | Before | After `min-w-0` |
| --- | --- | --- |
| document `scrollWidth` at 320 | 328 | **407** |
| header `scrollWidth` | 304 | **383** |

**The fix made it 79px worse.** Letting the wrapper shrink simply let the `whitespace-nowrap`
buttons inside spill further. It was reverted, and no platform code changed in this phase.

Two conclusions, and the second only became visible because the first fix failed:

1. Container CSS cannot fix content that will not shrink. Reflowing this bar at 320 would need a
   layout decision — wrapping to two lines, or dropping labels — imposed on every consumer.
2. **It is not the component's defect.** The story passes two text-labelled buttons
   (`Notifications`, `Account`); Munaxa Docs passes icon-width controls — a bell, a theme toggle, an
   avatar menu — and measures clean at 320. The overflow is a property of the fixture, not of
   `TopBar`. Changing a shared component's layout for every product to satisfy a story would have
   been precisely the "harness exception for a product defect" inversion, run backwards.

Recorded in full because a plausible fix that measurement rejects is worth more in the report than
in the diff.

## 7. Root cause of the blind spot

Two correct decisions with a gap between them, which is now the recurring shape of this audit:

- the component matrix fixed one viewport because contrast and keyboard contracts do not vary with
  width, which is true;
- Docs' responsive suites chose real device widths, of which the narrowest common one is 390.

Neither owns "the width WCAG names", so nobody tested it.

## 8. Ownership

| Layer | Owns | Decision |
| --- | --- | --- |
| Docs test harness | whether the product's reflow conformance is enforced | **fixed here** |
| Story fixture | what `AppShell` stories pass as `actions` | recorded, §15 |
| Storybook docs (`doc-kit`) | its own scrolling token tables | recorded, §15 — not shipped |
| `@munaxa/platform` | — | **nothing to fix; no release** |

## 9. Implementation

`320` is added to the `WIDTHS` list of the three Docs suites that assert responsive behaviour
(`shell`, `search`, `recent-empty`), with the reason stated at the constant: it was measured clean
first, so this locks in a property the product already has rather than announcing a new one.

## 10. Regression proof

The discriminating evidence for a coverage change is that the coverage can fail, and that it
reports the truth in both directions:

| | Result |
| --- | --- |
| Product at 320 before the change (measured, 12 routes × 2 themes) | **0 overflow, 0 violations** |
| The same suites with 320 added | **pass** — the property is now asserted |
| The instrument at 320 against content that *does* overflow (106 stories) | **12 detected** |

That last row is the important one: the same 320px measurement that reports Docs clean reports
twelve platform stories overflowing, so a green result at 320 is a measurement rather than a blind
spot. An instrument that found nothing anywhere would prove nothing here.

## 11. Coverage

| | Before | After |
| --- | --- | --- |
| Narrowest width tested anywhere | 390 | **320** |
| Docs responsive suites × widths | 3 × 6 | **3 × 7** |
| Component matrix | 848 · 848 · 74 | unchanged |
| Platform code changed | — | **none** |

## 12. Performance

Not a target. The 320 column adds one viewport pass to three suites; the full e2e project remains
within its existing budget.

## 12a. Docs E2E — one suite did not pass, and it is not this phase's

Reported in full, per the discipline the brief sets for E2E failures.

| Run | Infrastructure | Result |
| --- | --- | --- |
| 1 | DR destination cluster still held the previous phase's databases | `recovery` timed out; 4 suites skipped on sign-in timeouts under contention |
| 2 | destination cluster re-initialised empty, Redis flushed | `recovery` timed out; 3 suites skipped |
| 3 | the eight suites *without* `recovery` | **7 pass**, `dashboard` and `recent-empty` skipped under contention |
| 4 | `recovery` alone, idle box (load 0.25, 13.8 GB free), empty cluster | **18/19** — the backup-and-restore test times out |

**Every one of the nine suites passed with this phase's change in place**, across runs 1–3 —
including all three suites the change touches: `shell` 8/8, `search` 25/25, `recent-empty` 16/16.
The test counts rose 23→25 and 15→16, which is the 320 column being asserted.

**`recovery` did not pass this phase.** Classification, with evidence:

- **Not product**: 18 of its 19 tests pass. The failure is one test that shells out to the DR
  rehearsal script and exceeds the suite's own 600s per-test timeout.
- **Not this phase's change**: `recovery.e2e` contains zero references to `WIDTHS`; nothing in this
  phase touches it.
- **Not contention**: it fails identically on an otherwise idle machine.
- **Environment / infrastructure**, and a genuine trend rather than a one-off: the same rehearsal
  took **409s in Phase 8.15** and **619s in Phase 8.16**, and now exceeds 600s with the suite
  running 1 181s. It has grown past its own timeout in this container.

This is recorded as a reliability finding in §15 rather than resolved here. Raising the timeout
would be exactly the "silently increase timeout values" move the standing constraints forbid, and
the interesting question — why a fixed-size rehearsal has tripled — is its own objective.

## 13. CI

Unchanged. Docs E2E still has no CI job — re-measured, still its own objective.

## 14. Release

**None.** No platform code changed, so no version was published and Docs remains on `^1.5.0`,
resolved from the registry. §23 of the brief applies only if the platform changes; asserting a
release here would have meant publishing a version identical to 1.5.0 to make a report look
complete.

## 15. Deferred findings

- **`AppShell` story fixtures overflow at 320** — Category C. The stories could pass icon-width
  actions, as the product does, and then demonstrate the shell at 320. Worth doing; it is a story
  change and not this phase's objective.
- **`scrollable-region-focusable` ×12 on doc-kit token tables** — Category C, and the only *actual
  axe violation* found this phase. Storybook documentation only: `package.json`'s `files` field
  excludes `docs/`, and the published 1.5.0 tarball contains **zero** doc-kit entries. Real, cheap,
  and not shipped to any product.
- **Charts and the two-month range calendar at 320** — Category D. 1.4.10 exempts content requiring
  two-dimensional layout for its meaning; a sparkline and a two-month calendar qualify. Recorded
  with the exemption rather than silently ignored.
- **Unnamed `<aside>` on `/documents`** — carried from 8.16, unchanged.
- **The DR rehearsal has tripled in wall-clock and now exceeds its own timeout** — 409s in Phase
  8.15, 619s in 8.16, and past 600s here on an idle machine with an empty destination cluster. A
  fixed-size backup-and-restore should not do that, and the question of why is a reliability
  objective in its own right. Deliberately **not** addressed by raising the timeout.
- **ContextMenu**, **Docs E2E CI**, **`Combobox` ArrowDown**, **`aria-errormessage`**, **audit/rbac
  timing flakes**, **Cloudflare Storybook check** — all carried; none selected by this evidence.
- **Single viewport (component matrix)** — no longer a blind statement: measured at 320 this phase.
  Adding 320 to the matrix permanently would double it to re-assert stories whose overflow is
  fixture-driven or exempt, so it is recorded rather than done.

## 16. Corrections

Previous reports are not edited. One correction, to work done *inside this phase*:

**I implemented a `TopBar` `min-w-0` fix before verifying it, and it was wrong.** It increased the
overflow from 328px to 407px. It is reverted and no platform code changed. The lesson is the one
this audit keeps relearning in new forms: a fix that has not been measured is a hypothesis, and the
comment I had already written for it was more confident than the evidence.

## 17. Final state

| | |
| --- | --- |
| Platform | **unchanged**, tree clean, no release |
| Docs | tree clean, pushed |
| Docs E2E | 8 of 9 suites green; `recovery` times out — §12a |
| Published | `@munaxa/platform@1.5.0` (unchanged) |
| Docs consumes | `^1.5.0` from the registry store |
| Component matrix | 848/848 · 848/848 · 74 overlays · 0 failures |
| Product reflow at 320 | **0 overflow, 0 violations — now enforced** |
| Hidden failures | none |
