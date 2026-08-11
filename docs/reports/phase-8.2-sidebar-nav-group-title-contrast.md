
# Phase 8.2 — SidebarNav Navigation Group Title Contrast

> **Current status: the fix is written, tested and verified — see [§16](#16-third-attempt-access-granted-fix-made-and-verified).**
> Sections 1–15 are the record of two sessions that could not reach `@munaxa/platform`, and they are
> left exactly as they were written. The blocker was real while it lasted, and what it cost is the
> most useful thing in this document.

## 1. Status

**BLOCKED — the fix cannot be made from this repository, and no substitute was made.**

The defect is confirmed, traced to its exact line, and measured in **both themes** for the first
time. The chosen fix is identified, and its resulting ratios are already measured in this product.
What cannot happen here is the change itself: `SidebarNav` lives in `@munaxa/platform`, a package
this repository **installs from GitHub Packages** and does not own, and the brief forbids the two
remedies that are available locally.

No host-side workaround was added. No axe exception was added. No colour was hardcoded. The
measurement is now permanent and guarded, so the day the platform ships the one-token change, this
repository's suite will say so.

## 2. The original Phase 8 finding

> §6.3 — navigation group titles fail AA. `#667085` at 70% over white composites to
> `rgb(148, 155, 170)` — **2.79:1**, against 4.5:1 for 10px text.

Confirmed. And **Phase 8 was not the first to find it** — see §9.

## 3. Source trace, read directly rather than taken from the report

`@munaxa/platform/dist/ui/shell/navigation.js`, inside `SidebarNav`:

```jsx
group.title ? (
  collapsed
    ? <div className="mx-auto my-1 h-px w-6 bg-border" aria-hidden="true" />
    : <p className="px-3 pb-1 font-mono text-[10px] uppercase tracking-wider
                    text-muted-foreground/70">{group.title}</p>
) : null
```

The class the Phase 8 report named is the class the component renders. The `/70` is a **fade of the
muted token**, not a token of its own, and there is no `--sidebar-foreground` or equivalent anywhere
in `themes/base/base.css` or `themes/docs/palette.css` — checked.

**The resting item is a different line and a different class** (`text-muted-foreground`, no fade),
and Phase 7.9 measured it at 4.97:1 light and 6.89:1 dark. That distinction is the whole reason this
phase exists separately; see §9.

## 4. Measured before — both themes, in the running application

`/admin/users`, 1280px, one authenticated session, transitions settled:

```
[group-titles light] Organisation / People and access / Control / Classification / Places / System
                     ratio 2.79  ×6
[group-titles dark ] same six
                     ratio 4.19  ×6
```

| | measured | AA for 10px text | verdict |
| --- | --- | --- | --- |
| light | **2.79:1** | 4.5:1 | **fails** |
| dark | **4.19:1** | 4.5:1 | **fails** |

**Dark had never been measured.** Phase 8 reported light only. Both fail, which strengthens the case
rather than weakening it — and 4.19 is reported because it is what the browser produced; the
palette arithmetic predicted 4.03, and the measurement supersedes it.

### The measurement was wrong first, and is recorded that way

The first version parsed `getComputedStyle().color`, which on a faded element returns
`oklab(0.544376 -0.00296196 -0.034888 / 0.7)`. It failed an `rgba()` regex and silently fell back to
black, reporting **21:1 in light and 1.1:1 in dark** — precisely black-on-white and black-on-canvas.
Those numbers were obviously wrong, which is the only reason they were caught.

It now composites through a 1×1 canvas: paint the background, paint the foreground over it, read the
pixel. The browser does the colour-space conversion and the alpha blend, and `getImageData` returns
what a reader sees. The result — 2.79 in light — matches Phase 8's independently computed figure to
the digit, which is the corroboration a single number cannot give itself.

## 5. The fix, and why no new token is needed

**Drop the `/70`. Keep `text-muted-foreground`.**

```diff
- text-muted-foreground/70
+ text-muted-foreground
```

The resulting ratios are **not a projection**: `text-muted-foreground` on these exact surfaces is
already measured in this product, because it is what `SidebarNav`'s *resting items* use, in the same
rail, on the same backgrounds:

| | current `/70` | after removing `/70` |
| --- | --- | --- |
| light | 2.79:1 ✗ | **4.97:1** ✓ |
| dark | 4.19:1 ✗ | **6.89:1** ✓ |

Both clear AA. **No new semantic token is required**, which is the outcome Part 2 asks for and the
one that keeps the platform's vocabulary from growing for no reason.

Hierarchy is preserved: group titles remain `font-mono`, `text-[10px]`, `uppercase`,
`tracking-wider` — they are distinguished by size, case and letterspacing, not by being too faint to
read. Nothing else in the component needs to change: not the font, the size, the tracking, the
padding, the background, the item colour, the active state, the collapsed divider or the drawer.

## 6. Platform consumers inspected

`SidebarNav` has **two** consumers in this repository:

| Consumer | Passes group titles? | Affected |
| --- | --- | --- |
| `components/workspace-shell.tsx` — the main rail | **No** — `SECTION_HEADINGS_ACCESSIBLE = false` | no titles render, so no defect |
| `features/admin-shared/section-nav.tsx` — administration | **Yes**, six | **the live instance** |

That asymmetry is exactly why axe fires on `/admin/users` and on no other sampled route, and why
Phase 7.9's rail measurement found `headingWorst: null` — there were no headings in the main rail to
find.

**No host-side override of the group title exists anywhere** — searched; the only matches are
comments describing the defect.

Whether the change affects other AXA products cannot be determined from here: their repositories are
not in this session's scope. The change is a strict contrast improvement to a fade, so it can only
raise a ratio, never lower one.

## 7. Why the fix was not applied — the blocker, stated precisely

```
.npmrc            @munaxa:registry=https://npm.pkg.github.com
pnpm-lock.yaml    @munaxa/platform@1.0.0
                  tarball: https://npm.pkg.github.com/download/@munaxa/platform/1.0.0/…
```

`@munaxa/platform` is a **published dependency**, not a workspace package. Its source lives in
`munaxa/munaxa-platform`, which is **not in this session's repository scope**; attempts to reach it
(`list_repos`, `add_repo`) both returned *"MCP tool call requires approval"*, and this session cannot
grant that approval.

Even with the source in hand, the change would not reach this application without a release and a
version bump — `apps/web` consumes `^1.0.0` from the registry.

The three things that *could* have been done here were each rejected on the brief's own terms:

| Option | Why not |
| --- | --- |
| Override the class through `renderLink`/`className` | A host overriding a shared component's styling. Forbidden by `ARCHITECTURE.md` and by Part 4 |
| Set `--muted-foreground` locally | This repository naming a colour. Forbidden outright |
| Stop passing titles in the admin nav, as the main rail does | Not a contrast fix — a **navigation group structure** change, which Part 4 forbids, and it would delete six labels from a 24-destination area. See §12 |

**CLASSIFICATION: PLATFORM CHANGE REQUIRED — the one-line diff in §5, with the ratios in §4 and §5.**

## 8. What was done here instead

The measurement is now **permanent, correct and guarded**, in
`apps/web/src/test/e2e/consistency.e2e.spec.ts`:

- both themes, on the live admin navigation, after `settleColours`;
- composited through a canvas, so it measures the pixel rather than a colour string;
- asserted against floors just under the measured values (2.75 light, 4.15 dark), so the gap cannot
  widen while the fix waits upstream;
- and both floors **start failing the day the `/70` is dropped**, at which point they are replaced
  by a plain `>= 4.5`. That is how the tolerance ends — by breaking, not by being forgotten.

`setTheme` and `settleColours` moved to `test/e2e/theme.ts` and are now shared by the shell and
consistency suites. Extracted rather than copied: the second copy of `settleColours` would be a
second chance to reintroduce the transition bug Phase 7.9 spent a phase diagnosing.

## 9. The distinction that matters — and Phase 7.1 got there first

Three phases have now touched the same number, and the record should read straight:

| Phase | Claim | Verdict |
| --- | --- | --- |
| **7.1** | group headings `text-muted-foreground/70` at `text-[10px]` measure **2.78:1**; no product-side fix exists; the main rail's titles are disabled rather than shipped below AA | **Correct.** `SECTION_HEADINGS_ACCESSIBLE = false` has carried the measurement and the reasoning in a code comment ever since |
| **7.8** | the **resting rail items** are 3.57–3.67:1 in dark | **Wrong** — a transition measured mid-flight |
| **7.9** | retracted 7.8; items are 4.97:1 light and 6.89:1 dark | **Correct**, and the retraction stands |
| **8** | relocated the sub-AA number to the **group titles**, 2.79:1 | **Correct** |
| **8.2** | confirms 8, adds dark at 4.19:1, and credits 7.1 | — |

So the "≈2.78:1" that Phase 7.9 could not reproduce was never a stale or invented figure: it was
**Phase 7.1's own correct measurement of a different element**, and the misattribution happened in
between. Phase 7.9's retraction remains accurate — it retracted a claim about *items*, which was
wrong — and Phase 8's finding remains accurate. Neither is rewritten here.

## 10. Evidence gathered

| Requirement | Result |
| --- | --- |
| Light | **2.79:1 ×6**, measured, `/admin/users`, transitions settled |
| Dark | **4.19:1 ×6**, through the real theme control, transitions settled — first measurement of dark |
| Resting items unchanged | **4.97:1 light / 6.89:1 dark**, re-measured this phase; the shell suite passes 8/8 |
| Active item unchanged | 4.79:1 light / 6.37:1 dark, unchanged |
| Consistency suite | **11/11**, including the two new measurements |
| Phase 8.1 still closed | `[grammar recent] h1Count: 1`, `pageFrame 24px/1280px` |
| Six widths / RTL / keyboard / axe **after a fix** | **NOT APPLICABLE — there is no fix to verify.** Asserting them would be verifying the unchanged product and reporting it as verification of a change |

The axe violation on `/admin/users` **remains**, and remains recorded in `RECORDED_AXE` exactly as
Phase 8 left it. Part 11 asks for it to disappear; it cannot, because the defect is still there. It
was not hidden, re-tolerated, or moved.

## 11. Gates

| Gate | Result |
| --- | --- |
| `pnpm format:check` | PASS |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS — web 176, API 649 + 1 skipped |
| `pnpm verify:styles` | PASS |
| `pnpm build` | PASS |
| Consistency E2E | **11/11** |
| Shell E2E | **8/8** |
| Recent-empty E2E | **15/15** |
| Integration | **NOT RUN** — no platform package was modified, because none could be. No API, schema or package code changed; the diff is one test file, one extracted helper and this report |
| Visual | **NOT RUN** — no product code changed, so no baseline could move |

## 12. Recorded, not fixed — a new finding inside the scope boundary

**The two `SidebarNav` consumers in this product disagree about group titles.** The main rail
suppresses them (Phase 7.1's mitigation for this exact defect); the admin section nav renders six.
One consumer applied the mitigation and the other did not, which is why the defect is still visible.

Options, none taken here:

1. Wait for the platform fix, then restore the main rail's titles by flipping
   `SECTION_HEADINGS_ACCESSIBLE` — the constant exists for this and its comment says so.
2. Suppress the admin titles to match. **A navigation structure change**, forbidden by Part 4, and it
   would remove six labels from a 24-destination area that needs its grouping more than a
   10-destination rail did.

**PRODUCT DECISION REQUIRED**, and it should be taken *after* the platform ships, not instead of it.

## 13. Scope boundary honoured

Untouched: `/delegations` 390px overflow; primary actions on Reports, Notifications, Recycle bin,
Delegations and Audit; `/audit` missing `Page`; `Panel`/`Section` cleanup; `opacity-[0-9]` cleanup;
the tenant-setting-key decision; the `Badge` 4.31:1 finding. Phase 8.1's fix is intact and verified
still closed.

## 14. What is needed to finish

One line, in one repository this session cannot reach:

```diff
  apps/…/ui/shell/navigation.tsx   @munaxa/platform
- className="px-3 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70"
+ className="px-3 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
```

then a release, a version bump here, and the two floors in `consistency.e2e.spec.ts` replaced with
`>= 4.5`. Expected after: **4.97:1 light, 6.89:1 dark**, both already measured on the same surfaces.

If the platform repository is added to a future session's scope, this is a ten-minute change with
its verification already written.

---

## 15. Second attempt, after platform access was reported available — still BLOCKED

A later pass was asked to continue on the basis that `munaxa/munaxa-platform` was now in scope, and
to clone it. **It is not, and it could not be cloned.** Recorded here rather than in a new report,
because it is the same blocker with sharper evidence.

### The control experiment

The same command, the same token, the same method, against both repositories:

```
git -c "http.extraheader=Authorization: Bearer $GITHUB_TOKEN" ls-remote …/munaxa-platform
  → fatal: could not read Username for 'https://github.com'

git -c "http.extraheader=Authorization: Bearer $GITHUB_TOKEN" ls-remote …/munaxa-docs
  → d7b8337… HEAD
  → 39c2d02… refs/heads/claude/enterprise-feature-audit-y30g5o
```

The docs repository answers; the platform repository falls through to a credential prompt, which is
what GitHub returns when a token cannot see a repository at all — it 404s, git retries anonymously,
and then asks for a username. **The session's git credential is scoped to `munaxa-docs`.** This is
not an inference from a tool error: the control proves the token and the transport are fine.

The MCP surfaces agree, verbatim:

```
mcp__github__list_branches → Access denied: repository "munaxa/munaxa-platform" is not
                             configured for this session. Allowed repositories: munaxa/munaxa-docs
add_repo(munaxa, munaxa-platform, push) → MCP tool call requires approval
```

`add_repo` is the mechanism that would grant it, and it needs an approval this non-interactive
session cannot obtain.

### The registry, checked independently

Even with the source, there would be nothing to consume:

```
pnpm view @munaxa/platform versions   → ["1.0.0"]
pnpm view @munaxa/platform dist-tags  → { "latest": "1.0.0" }
```

**`1.0.0` is the only published version.** Parts 5 and 6 — release and consume — are blocked by the
registry as well as by repository access, and neither is something this repository can resolve.

### What was deliberately not done

- **Not cloned by any other route.** There is no other route; a fake clone is a fake fix.
- **Not patched in `node_modules`.** It would not survive an install, would not reach CI, and is the
  host-side workaround the brief forbids twice over.
- **Not moved back into Docs.** The ownership boundary is the finding.
- **Floors not replaced with `>= 4.5`.** Part 7 says to replace them *after* the release is consumed.
  It has not been. Replacing them now would turn a guard into a failing test that proves nothing.
- **axe exception not touched.** The violation is still real.

**No code changed in this pass.** The specification in §5 and §14 is complete and unchanged; what is
missing is access, and the two things needed are named precisely: `munaxa/munaxa-platform` added to
the session's repository scope (an admin can grant this in the Claude GitHub settings), and publish
rights for `@munaxa/platform` on GitHub Packages.

**STATUS: BLOCKED** — unchanged, for a reason now proved by control rather than reported by a tool.

---

## 16. Third attempt, access granted — fix made and verified

The blocker described in §7 and §15 is gone. `git ls-remote https://github.com/munaxa/munaxa-platform`
returned refs on the first try, with no credential prompt, and the repository was already present
in the session's working directory. Nothing about the diagnosis changed; only the access did.

### The change

`packages/platform/ui/shell/navigation.tsx`, line 92 — exactly the line §14 specified, and nothing
else in the component:

```diff
- className="px-3 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70"
+ className="px-3 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
```

Resting items, active items, font, size, tracking, case, padding, background, the collapsed rule,
the mobile drawer, RTL and the navigation semantics are all untouched, as §5 required.

Released as **1.0.1** with a CHANGELOG entry. `VERSIONING.md` names "an accessibility correction"
as a PATCH in as many words, so no judgement call was needed.

Committed as `f709a29` on `claude/sidebar-nav-contrast-fix-nhpu3b` in `munaxa/munaxa-platform`.

### The platform-level test

Added to the existing `ui/shell/shell.test.tsx` rather than to a new harness — the repo has no
contrast harness to reuse, and `toHaveClass` is its established way of asserting a rendered class.
The test asserts the group title carries `text-muted-foreground` and carries no fade of it.

It was proven to fail: reverting the class dropped the file to **1 failed / 25 passed**, and the
failure was the new assertion rather than a collateral break. Restored, **26/26**.

### Platform gates

`format:check`, `lint` (32/32), `typecheck` (32/32), `test` (26/26), `build` (20/20), `validate`,
and `scripts/verify-release.mjs` → *all checks passed*. The built `dist/ui/shell/navigation.js`
contains no `text-muted-foreground/70`.

### Measured after, in the running application

The Docs suite was run against the real stack with the 1.0.1 artefact installed. Six titled groups
in the admin section nav, both themes, transitions settled, composited through a canvas:

| | before (1.0.0) | after (1.0.1) | AA needs |
| --- | --- | --- | --- |
| light | 2.79:1 | **4.97:1** | 4.5:1 |
| dark | 4.19:1 | **7.44:1** | 4.5:1 |

`[axe /admin/users]` returns `[]`. All six serious `color-contrast` nodes are gone.

Two things in that table are worth stating plainly. The **before** numbers were re-measured from
scratch in this session and came back 2.79 and 4.19 — identical to §4, which is independent
confirmation of a measurement that had been wrong twice before it was right. The **dark after**
number is **7.44, not the 6.89 this report and the handover both predicted**. The prediction was an
inference from the resting items' recorded ratio rather than a measurement of these titles on this
surface; the measured value governs, and the projection should not have been written as though it
were data.

### Suite changes

`apps/web/src/test/e2e/consistency.e2e.spec.ts`, committed as `65cdd18`:

- both floors (`2.75` light, `4.15` dark) replaced with a plain `>= 4.5` in each theme;
- `RECORDED_AXE['/admin/users']` deleted, leaving the map empty and the axe assertion unconditional
  for every sampled route.

Proven to fail, the same way as the platform test: with 1.0.0 restored and the build genuinely
re-run, **exactly three** assertions broke — the light floor, the dark floor, and the `/admin/users`
axe check, which reported its six violations again with `text-muted-foreground/70` logged verbatim
in the contrast pairs. The other eight passed. With 1.0.1 restored: **11/11**.

### A methodological trap, recorded because it nearly produced a false result

The first falsification attempt **passed**, which was the wrong answer. Turbo had replayed a cached
`@edms/web:build` — the same hash, `4f29903e9c9b9090`, in both states — because the build hash does
not include `node_modules` contents. The suite therefore measured a bundle built from 1.0.1 while
1.0.0 was on disk, and reported 4.97/7.44 for the unfixed package.

Only after `rm -rf apps/web/.next node_modules/.cache/turbo .turbo` and a forced rebuild did the
real numbers appear. This belongs beside the conventions in §7 of the handover: **when the change
under test lives in `node_modules`, the build cache must be cleared or the measurement is of the
previous build.** A green suite is not evidence that the thing you changed is the thing that ran.

### What was still not done, and why

- **Not published.** `@munaxa/platform` releases go out through a manually-dispatched `Release`
  workflow (`.github/workflows/release.yml`) that publishes every `@munaxa/*` package at its
  declared version using `GITHUB_TOKEN`. Dispatching it from an unmerged branch would publish the
  whole set from unreviewed code, and publishing is irreversible. That decision was put to the
  requester, who chose the documented path: **merge the platform branch, then dispatch `Release`
  from `main`.** `1.0.0` remains the only published version as of this writing.
- **The dependency range was not bumped and the lockfile was not touched.** `apps/web/package.json`
  still asks for `^1.0.0`, which will resolve `1.0.1` once it exists. Bumping the range against an
  unpublished version would only break `--frozen-lockfile`.
- **`node_modules` was not patched as a fix.** The 1.0.1 artefact was packed with `npm pack` and
  unpacked over the installed copy *as a verification harness*: nothing was committed, the tree was
  restored to 1.0.0 to run the falsification, and every claim above was checked in both directions.
  This is the opposite of the workaround §15 refuses — that one would have shipped; this one only
  measured, and left nothing behind.

### The consequence for CI

`65cdd18` asserts AA and therefore requires `@munaxa/platform >= 1.0.1` at runtime. Until that
version is published **and** the lockfile resolves it, the suite builds the old class and those
three assertions fail. The commit is deliberately held unpushed for that reason; it should land
with, or after, the lockfile bump that follows the release.

### Sequence to finish

1. Review and merge `claude/sidebar-nav-contrast-fix-nhpu3b` in `munaxa/munaxa-platform`.
2. Dispatch `Release` from `main` with `dry_run=false`.
3. In Docs: `pnpm install` so the lockfile resolves `1.0.1`, then push `65cdd18` alongside it.
4. Confirm CI green. The measurements above say what the suite should report.

**STATUS: fix complete and verified; publication and consumption pending the release dispatch.**
