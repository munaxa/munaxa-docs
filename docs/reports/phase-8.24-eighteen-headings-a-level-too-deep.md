# Phase 8.24 — Eighteen Headings A Level Too Deep

## 1. Status

**COMPLETE.** Docs only: one commit. No Platform change, no release, no published version.

The phase closed one confirmed accessibility defect and — as §28 of the brief asks — finished
classifying every remaining candidate, so the audit knows which of them are defects, which are
accepted, which are environmental, and which belong to somebody with permissions this session does
not have. Three candidates were investigated to a verdict this phase and are now **closed as
accepted** rather than carried: the portal wrapper, `doc-kit`, and the `/documents` landmarks.

## 2. Objective

Find the next highest-value confirmed problem, fix it at the owning layer, prove it — and understand
every remaining candidate well enough to classify it. Nothing was preselected.

## 3. Starting state, verified rather than assumed

| | Reported by 8.23 | Measured here |
| --- | --- | --- |
| Platform HEAD | `61810a6` | `61810a6` = `origin/main` ✓ |
| Docs HEAD | `d32914c` | `d32914c`, equal to its remote ✓ |
| Published / installed | 1.5.1 | 1.5.1 from the registry ✓ |
| `@munaxa/ui` façade | 3 lines → one copy | **re-verified**: 3 lines, 1 copy ✓ |
| `file:` / `link:` / `workspace:` | none | **0** ✓ |
| `countsSql` · teardown · 320 enforcement · `overflows: []` | present | all present ✓ |
| Menu `modal = false` | present | present **in the installed tarball** ✓ |
| E2E CI workflow | present, green | present; last run on `d835a27` green ✓ |
| Stale fixture tenants | 0 | **0 / 0** ✓ |
| Both trees | clean | clean ✓ |

One environmental note, recorded because it recurs: the container's PostgreSQL and Redis had stopped
between phases and were restarted. Nothing in either repository caused it and no state was lost —
both fixture databases still held 0 tenants.

## 4. Fresh baseline

| | Measured |
| --- | --- |
| Component matrix | **52/52**, 106 stories × 4 brands × 2 schemes, 734s |
| Docs E2E, three shards | **161/161** (83 + 56 + 22) |
| `recovery.e2e` | **19/19** |
| Fixture tenants after | **0 / 0** |
| Unit: api / web / domain / contracts | 649 (+1 skipped) / **179** / 164 / 26 |
| lint · typecheck · build · `verify:styles` | green |
| Docs CI | **7 of 7 jobs green** |
| Visual | 93 pass, 14 Arabic fail (environmental) |

## 5. Candidate findings

| # | Finding | Class | Evidence | Owner | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | Dialogue accordions at heading level 4 under an `h2` | **B** | `/admin/roles`: **18** level-4 headings; `/admin/workflows`: 1 | Docs | **selected** |
| 2 | Unnamed `<aside>` + nameless `<section>` on `/documents` | B | 2 of 271 landmarks | Docs | **accepted** — §16.1 |
| 3 | `region` on the menu portal wrapper | **D** | one Radix element, no role, `tabIndex -1`, gone when closed | Radix | **accepted** — §16.2 |
| 4 | `doc-kit` `scrollable-region-focusable` ×12 | **D** | **not in `files`, not in the 1.5.1 tarball** | platform docs | **accepted, unshipped** — §16.3 |
| 5 | CI wall-clock headroom | R4 | 8.22: 13–15× runner variance, ≈92% local headroom | CI infra | deferred |
| 6 | Arabic visual baselines | R3 | 14/107, zero Arabic fonts in container | environment | deferred |
| 7 | `main` is not a protected branch | **E / R4** | `protected: false`; protection API returns 403 to this session | repository admin | **escalated** — §16.4 |
| 8 | E2E login budget | R2 | resolved as a CI contract in 8.23 | — | closed |
| 9 | ContextMenu, ArrowDown, viewport, `aria-errormessage` | — | unchanged | — | deferred |

### Why finding 1 was selected

- **It is the only remaining confirmed defect in shipped product markup.** Everything else on the
  list is unshipped, environmental, a third-party implementation detail, or outside this session's
  permissions.
- **The measurement is larger than the report of it.** axe emits one `heading-order` node per
  dialogue — the first jump — so the finding had been carried as "2 moderate nodes". The outline
  says otherwise: on `/admin/roles` **eighteen** headings sat at level 4 under a level-2 title, one
  per permission group, with level 3 never used. Moving by heading is exactly how somebody reaches
  the eighteenth group.
- **Reach**: three dialogue contexts across two administration areas — the roles dialogue, the "Add
  workflow" dialogue, and the draft dialogue on a workflow's versions screen.
- **Ownership is unambiguous and the platform is already right**: `AccordionTrigger` takes the level
  as a prop, documents it as "match the surrounding outline", and defaults to 3. Docs overrode it.
- **Scope**: one prop in each of two components, and neither component renders anywhere but inside a
  dialogue.

## 6. Root cause

`Dialog` renders its title as `<h2 id={titleId}>` and labels itself by it. Content inside a dialogue
therefore starts at level 3. Both `PermissionMatrix` and `DefinitionEditor` passed `level={4}`:

```
before  h1 Roles → h2 Add role → 4:document · 4:template · 4:library · … (18 of them)
after   h1 Roles → h2 Add role → 3:document · 3:template · 3:library · … (18 of them)
```

Why 4 was plausible: on a *page*, an accordion under a section heading would be level 4. These two
components are only ever in a dialogue, where the outline is one level shallower.

## 7. Ownership

**Docs.** The platform exposes the level as a prop with the correct default and the correct
documentation; the application passed the wrong value. No platform change, and therefore no release.

## 8. Implementation

`level={4}` → `level={3}` in `permission-matrix.tsx` and `definition-editor.tsx`, each with the
measured outline recorded beside it, plus a committed guard —
`apps/web/src/features/dialog-headings.a11y.spec.tsx`, three tests.

The guard asserts the **relationship** — every heading the content contributes is exactly one level
below the dialogue's own — rather than the literal 3, so it survives a change to the dialogue's own
level and still catches a drift back.

## 9. Regression proof

**In the running product**, before and after, same routes and same dialogues:

| | `/admin/roles` | `/admin/workflows` |
| --- | --- | --- |
| Outline, before | `h1` · `h2` · **18 × level 4** | `h1` · `h2` · level 4 |
| `heading-order`, before | 1 node (moderate) | 1 node (moderate) |
| Outline, after | `h1` · `h2` · **18 × level 3** | `h1` · `h2` · level 3 |
| `heading-order`, after | **[]** | **[]** |

**The committed guard, both directions.** Reverted to `level={4}` with nothing else changed, all
three tests fail, each naming its own jump:

| Test | Fix | Reverted |
| --- | --- | --- |
| the matrix is one level below the title | ✓ | ✗ `"document · 0 of 2" is level 4 under a level-2 title` |
| the stage headings are one level below | ✓ | ✗ `"1. Review" skips a level` |
| the outline is contiguous | ✓ | ✗ `heading 1 jumps from 2 to 4` |

**And in CI**, on the pushed commit: 7 of 7 jobs green, including all three E2E shards.

## 10. Coverage

| | Before | After |
| --- | --- | --- |
| Web unit tests | 176 | **179** |
| Dialogue heading outlines guarded | 0 | **2 components, 3 assertions** |
| Candidates classified to a verdict | 6 open | **3 newly closed as accepted, 1 escalated** |

## 11. Performance

Not a target and not affected: the change is one attribute value per component. Suite timings are
within noise of Phase 8.23 (component matrix 734s vs 667s — the same band this container has shown
all audit).

## 12. Reliability

| | |
| --- | --- |
| Docs E2E, locally and in CI | **161/161** |
| `recovery.e2e` | **19/19** |
| Fixture tenants | **0 / 0** |
| Retries used | none |

## 13. CI

Green, 7 of 7, on the pushed commit. The Phase 8.23 E2E job did what it was built for: it ran the
suite on this change without being asked.

**Workflow robustness check (§19 of the brief).** Reviewed rather than assumed: workflow-level
`concurrency` with `cancel-in-progress` is present; each shard's PostgreSQL, PostgreSQL-DR and Redis
are per-job containers, so shard isolation and login-budget isolation are structural rather than
conventional; the restore destination's emptiness is asserted before the suite runs; server logs
upload on failure. Two observations, neither promoted to an objective: every job authenticates to
GitHub Packages with `secrets.GITHUB_TOKEN`, so a **fork** pull request cannot install dependencies
— true of the pre-existing jobs too, and a decision about fork policy rather than a defect; and
finding 7 below, which is not a workflow property at all.

## 14. Visual verification

93 pass, **14 fail** — the same Arabic screens, unchanged across four phases. Baselines were **not**
re-recorded. The unchanged count is again the differential result: this phase's change moved no
pixels.

## 15. Release

**None.** Docs only. Platform untouched at `61810a6`; Docs still consumes `@munaxa/platform@1.5.1`
from the registry, re-verified this phase.

## 16. Deferred and accepted findings

### 16.1 The `/documents` landmarks — accepted

Investigated per §13 of the brief. The `<aside class="lg:w-72 lg:shrink-0">` contains exactly one
thing: `FolderTree`, which renders its own `<nav aria-label="Libraries and folders">`. So the aside
contributes an **anonymous `complementary`** wrapped around a **named `navigation`** — the landmark
list gains an entry that names nothing the entry inside it does not already say. The
`<section class="min-w-0 flex-1">` holds the document list and has no accessible name, so it is not
a landmark at all: a `<div>` wearing a semantic tag.

Both are layout containers. The honest change is to make them `<div>`s — but that is a change to how
this screen's structure is described, on the screen the product is named after, and Phase 8.16's
history here is a caution rather than a precedent: the rail went `<aside>` → `<div>` → `<nav>` across
three phases because each step fixed one reading and broke another. It is 2 elements of 271, both
inside `main`, orphaning nothing. **Accepted for now, with the semantics recorded**, and it is a
one-line change whenever a phase wants to own that decision.

### 16.2 The portal wrapper — accepted, and it is not a defect

Investigated per §14, comparing all three families in the running product:

| State | Body-level wrapper | Role | `tabIndex` | `region` reported |
| --- | --- | --- | --- | --- |
| Nothing open | none | — | — | **none** |
| Menu open | `div[data-radix-popper-content-wrapper]` | **none** | **−1** | 1 node |
| Dialogue open | **none** — `Dialog` uses its own portal | `dialog` | — | **none** |

The wrapper carries three attributes — `data-radix-popper-content-wrapper`, `dir`, `style` — and
exists only to position the layer. It takes no focus, claims no role, holds the `menu` and its
`menuitem`s, and disappears when the menu closes. axe counts the menu's items as content outside a
landmark, which is true and which no sensible fix improves: wrapping a transient menu in a landmark
would add a landmark to the page for as long as the menu is open, which is worse for the person the
rule protects. **Accepted as a third-party implementation detail.** The rule stays on, so the finding
stays visible in every future measurement rather than being suppressed.

### 16.3 `doc-kit` — accepted, and now proven unshipped

Re-confirmed per §18 rather than recalled: `package.json`'s `files` lists `dist`, `tokens/css`,
`themes`, one CSS file, `assets` and one script — **`docs/` is not among them** — and the published
`@munaxa/platform@1.5.1` tarball, unpacked and listed, contains no `docs/` directory. `doc-kit` is
imported only by `docs/*.stories.tsx`. The 12 findings are in Storybook documentation pages that
reach no product. **Accepted, unshipped**, and the evidence is now a tarball listing rather than a
memory.

### 16.4 `main` is not a protected branch — escalated, not fixable here

Measured this phase: `GET /repos/munaxa/munaxa-docs/branches/main` reports `"protected": false`, and
the protection endpoint returns **403** to this session. So the seven CI jobs — including the E2E
suite Phase 8.23 added — run on every commit and **gate nothing**: nothing prevents a red pipeline
from being merged.

This is the largest remaining release-architecture item, and it is deliberately not this phase's
objective because it is not a code change: it is a repository setting requiring admin rights this
session does not hold. Recorded here so that Phase 9 starts with it rather than discovering it.

### 16.5 Still deferred, unchanged

CI wall-clock headroom (R4); the Arabic font environment (R3); ContextMenu — the platform ships it,
Docs uses none; `Combobox` ArrowDown; single viewport; `aria-errormessage` unused; the platform's
Cloudflare Storybook check.

## 17. Production-readiness inventory

Prepared for a later certification phase, per §28. **This is not a readiness declaration.**

**Resolved and guarded**

| Item | Phase | Guarded by |
| --- | --- | --- |
| DR rehearsal scalability (23,068 → 292 processes) | 8.18 | `recovery.e2e`, in CI |
| Fixture teardown that never deleted | 8.20 | teardown assertion + `recovery.e2e`, in CI |
| `/delegations` 1.4.10 reflow failure at 320 | 8.21 | `consistency.e2e` at 1280/390/320, in CI |
| Menus hiding the application from AT | 8.22 | `menu-modality.test.tsx` in platform CI |
| E2E suite absent from CI | 8.23 | the E2E matrix itself |
| Dialogue heading outline | 8.24 | `dialog-headings.a11y.spec.tsx` |

**Open — needs a decision or an owner**

- `main` unprotected, so no check is required to merge (§16.4) — **needs a repository admin**.
- The Arabic visual environment: the canonical font must be established before the 14 baselines can
  be trusted or re-recorded.
- CI wall-clock headroom on shared runners.

**Accepted**

- The portal wrapper's `region` (§16.2).
- `doc-kit` ×12, unshipped (§16.3).
- The `/documents` landmark pair (§16.1).
- ContextMenu's unmeasured sub-parts — the platform ships it, this product uses none.

**Environmental**

- 14 Arabic visual failures — no Arabic font in this container.
- The platform's Cloudflare Storybook check, red since PR #8.
- Local PostgreSQL/Redis stopping between phases.

**Post-launch / not release blockers**

- `Combobox` ArrowDown (an APG enhancement, no product evidence of a defect).
- Single-viewport component matrix.
- `aria-errormessage`, currently unused by the product.

**Release blockers**

None identified. The nearest thing is §16.4, which blocks *enforcement* rather than release: every
gate exists, runs and is green — nothing yet compels it.

## 18. Corrections

Previous reports are not edited. Two corrections, both to this audit's own accounting.

**Phase 8.22 recorded the dialogue heading finding as "2 nodes — `heading-order` (moderate) on two
dialogues".** That is what axe reported and it is what the finding looked like. The outline shows the
defect was larger: **eighteen** headings on `/admin/roles` were at the wrong level, not one. axe
reports the first jump in a run, so a count of axe nodes undercounts a systematic level error — worth
remembering the next time a finding is ranked by node count.

**Phase 8.23 described the `/documents` `<aside>` as needing "a semantic decision about what that
panel *is*".** The panel's content had already answered it: `FolderTree` declares itself a named
`navigation` landmark, so the question was never what the panel is, only whether the wrapper should
add a second, anonymous landmark around it. The narrower question is the one recorded in §16.1.

## 19. Final state

| | |
| --- | --- |
| Platform | unchanged, tree clean, `61810a6` |
| Docs | one commit, tree clean, pushed |
| Published | nothing — no release warranted |
| Docs CI | **7 of 7 green**, including three E2E shards |
| Dialogue `heading-order` | **0** |
| Docs E2E | **161/161** |
| `recovery.e2e` | **19/19** |
| Fixture tenants | **0 / 0** |
| Candidates left unclassified | **none** |
| Red gates | two, both proven not this repository's code — the Arabic visual environment and the platform's Cloudflare check |
| Hidden failures | none |
