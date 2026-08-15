# Phase 8.11 — Accessibility Matrix Performance Optimization

## 1. Objective and outcome

Phase 8.10 measured that the two accessibility matrices each rendered the same 800 story × brand ×
scheme combinations, about **1 040 worker-seconds** of duplicated work, and deferred the question of
whether one render could safely serve both.

**Outcome: safe sharing was proven and implemented.** The matrices now share one canonical render
per combination. Every result is identical to the previous architecture, combination by combination,
and the coverage numbers are unchanged.

| | Phase 8.10 | Phase 8.11 | Change |
| --- | --- | --- | --- |
| Full `test:a11y` suite | **703s** | **515–524s** | **−26%** |
| Renders performed | 2 256 | **1 464** | −792 |
| Pages created | 12 | 6 | −6 |
| Contrast combinations | 800 | **800** | — |
| Keyboard combinations | 800 | **800** | — |
| Interactive / static | 528 / 272 | **528 / 272** | — |
| Excluded / failing | 0 / 0 | **0 / 0** | — |
| Proofs | 9 | **14** | +5 |
| Suite tests | 45 | **48** | +3 |

## 2. Baseline, measured again rather than quoted

Phase 8.10's 962s was not reused. The current architecture was re-run in this session and measured
at **703s**, with the per-combination result inventory captured as the oracle for §6.

The environment is unchanged and remains the reason wall-clock is secondary evidence: **4 CPUs, 6
workers**, deliberately not tuned (§22 of the brief). Primary evidence throughout is operation
counts, which are exact and machine-independent.

## 3. What the two lifecycles actually did

Read from the implementation, not inferred from names. They differed in three ways that mattered:

| | Contrast | Keyboard |
| --- | --- | --- |
| Settle after render | **150ms** | 120ms |
| Render retry | none | one, counted |
| `INTERACTIONS` (opens the command palette) | **yes**, before axe | no |

A shared render therefore had to take the **longer** settle, keep the retry, and give the one
interacting story its own keyboard render.

## 4. The canonical initial state

For each story × brand × scheme: the right story, the right brand, the right scheme, settled CSS, a
stable DOM, and nothing typed, selected, expanded, opened or focused.

The architecture is:

```
canonical render
   ├── contrast + axe   (reads only — measures the state a person meets on arrival)
   └── keyboard         (mutates — runs after, and re-renders for each mutating contract)
```

The order is the safety argument. The reverse — keyboard then contrast — would measure a page nobody
navigated to, and §6's proof J states exactly what that would cost.

## 5. Four isolation proofs, all mandatory

| Proof | Claim | Result |
| --- | --- | --- |
| **I** | axe leaves the page exactly as it found it | focus, URL, input values, checked/expanded/selected state, overlay count, DOM size and the story's own classification are **identical** before and after a run |
| **J** | the keyboard contracts change the page enough that contrast could not follow them | typing empties a `DataGrid` from **96 gridcells to 0**; a contrast run placed after would inspect a different page |
| **K** | the one interacted story genuinely differs from canonical | palette closed → 0 `[cmdk-input]`, opened → >0, and a re-render restores 0 |
| **L** | the shared render still catches a contrast regression | an injected low-contrast element is reported; removed, clean |

Proof I is what makes contrast-then-keyboard sound; proof J is what makes the reverse unacceptable.
Both are in `keyboard-proof.a11y.spec.ts` and run on every accessibility run.

## 6. Differential verification — the part that decides the phase

"800/800 both times" is not equivalence: two runs can agree on a total while disagreeing about which
story failed, which kinds were detected, or which contracts ran. So the suite now writes a **per
combination inventory** — 800 rows each for contrast and keyboard, carrying detected kinds, executed
contracts, failures, violations and errors — and the two architectures were diffed row by row.

```
=== contrast ===   rows: oracle 800, candidate 800
  missing 0 · extra 0 · field differences 0
=== keyboard ===   rows: oracle 800, candidate 800
  missing 0 · extra 0 · field differences 0

EQUIVALENT
```

Reproduced on every subsequent run. The inventory writer is gated behind `A11Y_INVENTORY_DIR`, so
normal runs and CI are untouched.

## 7. A failure that was investigated rather than re-run

The second verification run reported **8 discrepancies** — all one story,
`foundations-themes--munaxa-docs`, failing its 15-second render wait across six keyboard
combinations and one contrast combination.

That was investigated before anything was changed, because the obvious suspicion was that the shared
render had introduced state accumulation on a longer-lived page:

- The story renders in **~300ms** on an idle machine.
- Render time across **24 consecutive navigations on one page** was **flat**: 308ms for the first
  six, 297ms for the last six. There is no accumulation.
- Phase 8.10 recorded the same class of failure under the **separate** architecture, on a different
  story.

A 15-second timeout against a 300ms render is fifty-fold starvation, not a defect and not a
consequence of sharing. The single retry was insufficient for it, so a render now gets **three
attempts** with a short backoff.

It remains a *render* retry. A story that genuinely cannot render fails all three attempts and
reports the same error; no timeout was inflated and nothing is suppressed. The ledger reports
`story render retried`, `story render retry succeeded` and `story render retry exhausted`
separately, so contention stays visible instead of hiding inside a green run.

## 8. Where the time goes now

| Step | Count | Worker-seconds |
| --- | --- | --- |
| story render (reload for a contract) | 656 | 688 |
| story render (canonical, shared) | 800 | 676 |
| axe | 800 | 577 |
| tab walk | 528 | 136 |
| grid arrows | 120 | 128 |
| overlay (menu) | 104 | 124 |
| typing | 200 | 96 |
| classify | 800 | 68 |
| overlay (dialog) | 80 | 67 |
| tablist arrows | 40 | 56 |
| activation (Space) | 64 | 50 |
| overlay (combobox) | 40 | 18 |
| re-detect kinds after reload | 592 | 10 |
| **story render (keyboard needs canonical again)** | **8** | **7** |
| new page | 6 | 5 |
| radio arrows | 8 | 2 |
| harness startup | 1 | 2 |
| link targets | 96 | 0.6 |

The 8 extra renders are exactly the palette story across its 8 brand × scheme combinations — the
design in §3 and §4, visible as a number.

## 9. Coverage

| | Before | After |
| --- | --- | --- |
| Stories discovered / eligible / excluded | 100 / 100 / 0 | 100 / 100 / 0 |
| Brands × schemes | 4 × 2 | 4 × 2 |
| Contrast combinations | 800 | 800 |
| Keyboard combinations | 800 | 800 |
| Interactive / static | 528 / 272 | 528 / 272 |
| Contrast violations | 0 | 0 |
| Keyboard failures | 0 | 0 |
| Reclassified on reload | [] | [] |

The two 800s remain **two separate guarantees** with independent failure inventories: a contrast
failure never prevents keyboard results from being collected, and neither total is folded into the
other.

Every keyboard contract from Phases 8.7–8.9 survives unchanged: typing, link targets, radio arrows,
combobox open/dismiss/restore, tabs, menus, dialogs, grid roving, Space activation, focus visibility
and complete Tab traversal.

## 10. Discovery, now proved rather than asserted

Every phase since 8.5 has asserted a floor under the discovered story count; none had ever shown the
floor fire. `discovery-proof.a11y.spec.ts` removes entries from a copy of the built index and asks
discovery again: it reports the smaller inventory, that inventory falls below the floor, and the
untouched build still returns the full list in the same order. No browser, milliseconds, runs every
time.

## 11. Stability

Three consecutive full runs of the final architecture, each diffed against the oracle:

| Run | Tests | Wall | Differential |
| --- | --- | --- | --- |
| 1 | 48/48 | 515s | **EQUIVALENT** |
| 2 | 48/48 | 526s | **EQUIVALENT** |
| 3 | 48/48 | 522s | **EQUIVALENT** |

An earlier set of three on the same architecture, before the discovery proof was added, reported
46/46 at 521s, 522s and 524s and was equally equivalent. Six runs of the shared-render architecture
have now produced the same 1 600 rows.

## 12. Gates

| Gate | Result |
| --- | --- |
| `eslint` · `tsc --noEmit` · `format:check` | 32/32 · 32/32 · clean |
| `pnpm test` | 26/26 tasks, 522 platform tests |
| `check:faded` · `validate:contract` · `validate:tokens` | clean · 66 roles · 49 values |
| `build` · `build-storybook` | 20/20 · success |
| Package boundary | 504 files, **zero** test, spec, story, harness or instrumentation files |

No platform product code changed, so no release: the version stays **1.3.1** and Docs is untouched.

## 13. Rejected and not attempted

- **Keyboard before contrast** — rejected by proof J: it would measure a filtered grid.
- **Sharing a render across the mutating contracts** — rejected by Phase 8.9's evidence; each
  mutating contract still gets its own render, which is 656 of the 1 464.
- **Tuning the worker count** — out of scope by instruction, so the architectural comparison stays
  valid.
- **Reducing the settles** — forbidden, and the shared render takes the *longer* of the two.

## 14. Remaining bottlenecks

`axe` is now the largest single step at 577 worker-seconds for 800 runs, followed by the 656
contract reloads at 688. The reloads are the price of contract isolation and Phase 8.9 documents why
they exist. Beyond that, the honest remaining lever is the machine: 6 workers on 4 CPUs.

## 15. Limitations

- One viewport (1280×900), and `color-contrast` remains the only axe rule.
- The `Combobox` ArrowDown enhancement from Phase 8.9 is still open.
- Wall-clock on this runner is noisy; the counts, not the clock, are the evidence.
