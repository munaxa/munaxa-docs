# Phase 8.10 — Accessibility Matrix Performance & Contract Hardening

## 1. Status

**COMPLETE.** Coverage is byte-for-byte unchanged and the suite is measurably cheaper.

| | Baseline | After | Change |
| --- | --- | --- | --- |
| **Full `test:a11y` suite** | **1134s** | **962s** | **−15%** |
| Keyboard matrix | **641s** | **536s** | −16% |
| Contrast matrix | **441s** | **294s / 362s** (see §6) | −18% to −33% |
| Renders performed | 2 353 | 2 256 | −97 |
| Pages created | 1 600 | 12 | −1 588 |
| Combinations | 1 600 | **1 600** | — |
| Contracts, assertions, proofs | — | — | **unchanged** |

The full suite — contrast, keyboard, the component measurements and the eight proofs — passes
**42 of 42** after the change, as it did before.

Nothing was excluded, tolerated, weakened or skipped. Every reduction removes work that was buying
nothing, and each is justified below by the measurement that found it.

## 2. The measurement

The suite had never been instrumented, so "11 minutes" was the only number anyone had. `timing.ts`
now records a count and a total per named step and prints a ledger with each matrix's coverage
summary. It is permanent: a suite that cannot say where its minutes go cannot be optimised honestly.

The totals are **worker-seconds**, not wall-clock — six workers run in parallel, so they sum to
roughly six times the elapsed time. That is the number that decides what is worth changing and the
wrong number for predicting a run's length, and the ledger says so where it prints.

### Keyboard matrix — baseline, 641s wall

| Step | Count | Worker-seconds | Each |
| --- | --- | --- | --- |
| story render (first) | 800 | **1030** | 1288ms |
| story render (reload for a contract) | 753 | **1026** | 1362ms |
| tab walk | 528 | 546 | 1034ms |
| new page | 800 | 216 | 270ms |
| grid arrows | 120 | 180 | 1504ms |
| overlay (menu) | 104 | 169 | 1626ms |
| typing | 200 | 151 | 754ms |
| overlay (dialog) | 80 | 95 | 1193ms |
| activation (Space) | 64 | 79 | 1238ms |
| tablist arrows | 40 | 72 | 1809ms |
| classify | 800 | 55 | 69ms |
| overlay (combobox) | 40 | 26 | 655ms |
| harness startup | 1 | 19 | — |
| re-detect kinds after reload | 593 | 17 | 28ms |
| radio arrows | 8 | 4 | 516ms |

Sum ≈ 3 690 worker-seconds ÷ 6 ≈ 615s against 641s measured, so the ledger accounts for essentially
the whole run.

### Contrast matrix — baseline, 441s wall

| Step | Count | Worker-seconds | Each |
| --- | --- | --- | --- |
| axe | 800 | **1145** | 1431ms |
| story render | 800 | **1039** | 1299ms |
| new page | 800 | 237 | 296ms |
| settle (fixed 150ms) | 800 | 121 | 152ms |
| browser context | 6 | 0.4 | 63ms |
| harness startup | 1 | 0.2 | — |

### The finding the number 11 hid

**Rendering is 56% of the keyboard matrix and 42% of the contrast matrix**, and the two matrices
render *the same 800 combinations independently*. That duplication — about 1 040 worker-seconds — is
the largest single inefficiency in the architecture. It is not fixed here; §8 explains why, and what
fixing it would take.

## 3. Machine context, which changes how the numbers read

The runner has **4 CPUs** and the matrix runs **6 workers**, with load average between 7.6 and 12.8
during a run. The box is oversubscribed, so a "1.3s render" is mostly contention rather than
inherent cost.

That has a consequence for this whole phase: **wall-clock on this machine is noisy**. Identical
contrast code measured **294s, 362s and 441s** across three runs. Wall-clock is therefore reported
as corroboration, and the load-bearing evidence is the count of work removed, which is exact and
machine-independent.

## 4. What changed

### One page per worker, not one per combination

Every combination already begins with a full navigation, which replaces the document — so a reused
page carries nothing across: no marker attributes, no listeners, no component state. The isolation
came from the navigation, not from the page. Creating 1 600 pages cost **453 worker-seconds** and
bought none of it.

A page is still replaced whenever a combination throws, where its state is genuinely unknown.

### The read-only contract stopped reloading

`linksHaveTargets` asks which anchors lack an `href`. It reads and changes nothing, so it needs no
fresh render — but it does need to run **before** anything that mutates the story, because a
contract that filtered a list away would leave fewer links to inspect and quietly check less. It now
runs immediately after the Tab walk.

The measurement makes the trade obvious: the contract itself costs **20ms**, and it was forcing a
**1.4s render**. 96 renders removed for 2 worker-seconds of actual work.

### A render is retried once, and every retry is counted

A render that times out is a failure by design — a story nobody can render is a story nobody can
use — and that stays true. But one measured run lost three renders of the heaviest story to the
15-second wait, and a repeat run of the *same code* rendered all 800 comfortably. Failing a suite for
machine contention teaches a team to re-run rather than to read.

One retry keeps the sensitivity: a story that genuinely cannot render fails both attempts. Every
retry is counted in the ledger, so contention surfaces instead of hiding inside a green run. The
verification run needed **zero** retries.

## 5. Coverage, unchanged

| | Baseline | After |
| --- | --- | --- |
| Stories discovered / eligible / excluded | 100 / 100 / 0 | 100 / 100 / 0 |
| Brands × schemes | 4 × 2 | 4 × 2 |
| Contrast combinations | 800 | 800 |
| Keyboard combinations | 800 | 800 |
| Interactive / static | 528 / 272 | 528 / 272 |
| Keyboard failures | 0 | 0 |
| Contrast violations | 0 | 0 |
| Reclassified on reload | [] | [] |
| Test-proofs | 8 | 8 |

Every keyboard contract — typing, links, radio, combobox, tabs, menus, dialogs, grids, activation,
focus visibility and full Tab traversal — is asserted exactly as Phase 8.9 left it.

## 6. An error I made and corrected

Reading the first post-change contrast run, I reported it as "800/800, still passing" from the
coverage summary. That was wrong: the summary counts *contrast* failures only, and the run had
actually **failed** a separate assertion — three `workspace-files--grid-view` combinations timed out
waiting for the story root, so axe ran 797 times rather than 800.

The ledger is what caught it, because `axe count: 797` contradicted `combinations: 800`. That is a
coverage regression of exactly the kind this phase forbids, and it is why the retry in §4 exists and
why the run was repeated rather than accepted. Recorded here rather than quietly fixed.

## 7. Gates

| Gate | Result |
| --- | --- |
| `eslint` · `tsc --noEmit` | 32/32 · 32/32 |
| `pnpm test` | 26/26 tasks, 522 platform tests |
| `check:faded` · `validate` | clean · 66 roles, 49 values |
| `test:a11y` | contrast **800/800**, keyboard **800/800**, **8** proofs |

## 8. Deferred, with the measurement that justifies it

**Share one render between the two matrices.** They render the same 800 combinations separately, at
about 1 040 worker-seconds each; axe is read-only, so one render could serve both the contrast check
and the keyboard classification, saving roughly **170 seconds of wall-clock**.

It is not done here because it is an architectural change, not a local one:

- The contrast matrix performs `INTERACTIONS` before axe on one story (it opens the command palette).
  Classifying the keyboard contract on that post-interaction render would change what the keyboard
  matrix measures, so that story would need to keep its own render.
- Merging couples two failure inventories that are currently independent, and this suite's value
  rests on being able to say precisely which contract failed where.

Doing it properly means proving the merged run produces identical results for both matrices, story
by story. That is a phase, not an afterthought at the end of one — so it is measured, designed and
handed over rather than rushed.

Also still open, unchanged from Phase 8.9: the `Combobox` ArrowDown enhancement, widening axe beyond
`color-contrast`, and a second viewport.

## 9. What was deliberately not done

- **The worker count was not tuned.** Six workers on four cores looks wrong, but changing it trades
  wall-clock for contention in a way this noisy box cannot measure reliably in the time available,
  and it changes no coverage either way.
- **The 120ms and 150ms settles were left alone.** Together they are 307 worker-seconds — real, but
  they are the cushion that keeps colour measurements off a mid-transition frame, and Phase 8.4
  learned that lesson the expensive way.
- **No assertion was relaxed to gain speed.** Every second saved here came from removing work, never
  from asking less.
