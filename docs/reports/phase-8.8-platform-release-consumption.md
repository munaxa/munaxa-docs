# Phase 8.8 — Platform Accessibility Release & Docs Registry Consumption

## 1. Status

**COMPLETE.**

`@munaxa/platform` **1.3.1** is published through the official Release workflow, independently
confirmed on GitHub Packages with `latest` pointing at it, and consumed by Munaxa Docs from the
registry — proven end to end, including a round-trip falsification through the running product.

The chain, every link measured rather than assumed:

```
Phase 8.7 source  →  platform main c33b74f  →  Release run 31690249107
      →  @munaxa/platform@1.3.1  →  GitHub Packages  →  pnpm-lock.yaml (registry tarball + integrity)
      →  clean frozen install  →  node_modules/.pnpm/@munaxa+platform@1.3.1
      →  Docs production build  →  browser verification on /admin/libraries
```

## 2. Phase 8.7 baseline, re-verified before publishing

The local release state was confirmed clean before anything outward-facing happened: working tree
clean, `1.3.1` in `package.json`, CHANGELOG entry present, `dist` rebuilt, and the Phase 8.7 commit
`42affe1` at the head of the branch.

| | |
| --- | --- |
| Keyboard matrix | **800/800** — 100 stories × 4 brands × 2 schemes |
| Interactive / static / excluded / failing | 528 / 272 / 0 / **0** |
| Contrast matrix | **800/800** |

## 3. Pre-release platform gates

Run locally on the release state, all green:

| Gate | Result |
| --- | --- |
| `eslint` | 32/32 tasks |
| `tsc --noEmit` | 32/32 tasks |
| `pnpm test` | 26/26 tasks — 522 platform tests |
| `check:faded` | no faded foreground text |
| `validate:contract` | 66 semantic roles × 4 themes × 2 schemes |
| `validate:tokens` | 49 typed values match their CSS mirrors |
| `test:a11y` | **38/38** — contrast 800/800, keyboard 800/800, 4 proofs |
| `build` | 20/20 tasks |

Then on CI, on the pull request (run `31688944393`):

| Job | Result |
| --- | --- |
| Lint · Typecheck · Test · Build | **success** |
| Façades match the platform surface | **success** |
| Accessibility · contrast **and keyboard**, every story, four brands, light and dark | **success** |

Merged to `main` as **`c33b74f`** (PR [#9](https://github.com/munaxa/munaxa-platform/pull/9)).

## 4. Release

| | |
| --- | --- |
| Workflow | `.github/workflows/release.yml`, `workflow_dispatch` |
| Run ID | **31690249107** |
| Ref / commit | `main` / **`c33b74f`** |
| Input | `dry_run=false` — the "Pack only (dry run)" step is recorded **skipped**, the "Publish" step **success** |
| Attempts | **1** |
| Duration | 74s |

No manual upload, no publish from a branch, no dirty tree, no registry patching.

**The known wall-clock flake did not occur.** Phase 8.6 recorded three of five releases blocked by
timing assertions in `@munaxa/audit` (`<14ms`) and `@munaxa/rbac` (`<7500ms`); this release's
`Verify` step passed first time. Those packages were not touched.

## 5. Registry verification, independent of the workflow

Queried directly rather than trusting the run's success message:

```
$ npm view @munaxa/platform versions
["1.0.0","1.0.1","1.0.2","1.1.0","1.2.0","1.3.0","1.3.1"]

$ npm view @munaxa/platform dist-tags
{ "latest": "1.3.1" }
```

## 6. Published tarball

Downloaded from the registry with `npm pack @munaxa/platform@1.3.1` — the artifact itself, not the
local `dist`:

| | |
| --- | --- |
| Manifest | `@munaxa/platform` **1.3.1** |
| Files | **503** |
| Phase 8.7 fix present | `dist/ui/components/data-grid/data-grid.js:130` — `if (!event.target.matches('[data-cell]') && event.key !== 'Escape')` |

**Package boundary — clean.** Zero matches across the whole tarball for `.test.`, `.spec.`,
`.stories.`, `storybook`, `test/a11y`, `harness`, `fixture`. The keyboard harness, the Storybook
build and the Playwright suites stay in the repository.

**Artifact-level differentiator.** The same grep against the published **1.3.0** tarball returns
**0** occurrences of the guard; against **1.3.1**, **1**. The two published artifacts differ in
exactly the place the fix lives.

## 7. Docs dependency update

`apps/web/package.json`: `"@munaxa/platform": "^1.3.0"` → **`"^1.3.1"`**, matching the caret range
the repository already uses for every `@munaxa/*` dependency. No workspace link, no copied source,
no patched `node_modules`.

## 8. Lockfile

`pnpm install --lockfile-only` against the registry resolved:

```yaml
'@munaxa/platform':
  specifier: ^1.3.1
  version: 1.3.1(...)

'@munaxa/platform@1.3.1':
  resolution:
    integrity: sha512-FSnR0UfiHNFjXZbxQDcitHV/Kx9dxBsawiq7QtM5GxCWbhedq692+JT+RxogCnTBNH6WUWeyhLIwectgKGGpZw==
    tarball: https://npm.pkg.github.com/download/@munaxa/platform/1.3.1/c2cd0ffe3863359ad910dede536679a13c2944bf
```

Grepping every `@munaxa/platform` line in the lockfile for `file:`, `link:`, `workspace:` or a local
`.tgz` returns **nothing**.

## 9. Clean frozen install

`node_modules` deleted at the root and in every workspace package, then:

```
$ pnpm install --frozen-lockfile
Done in 18.6s     (exit 0)
```

## 10. The installed artifact

Read from what pnpm actually installed, never from the platform source tree:

| | |
| --- | --- |
| Resolved path | `node_modules/.pnpm/@munaxa+platform@1.3.1_…/node_modules/@munaxa/platform` |
| Manifest version | **1.3.1** |
| Fix present | `dist/ui/components/data-grid/data-grid.js:130`, the `[data-cell]` guard |
| Boundary | no `*.test.*`, `*.stories.*` or Storybook files anywhere in the installed package |

## 11. Clean production build

`.next`, the Turbo cache and `.turbo` were removed first — with absolute paths, because a cached
build masking a reverted dependency is a trap this sequence has fallen into twice.

```
@edms/web:build: cache miss, executing 21e6dee8b9736260
✓ Compiled successfully in 47s
Tasks: 9 successful, 9 total
```

The `@edms/web:build` hash moved from `4f29903e…` (the value recorded when the tree last built
against the previous platform) through `d3abcc00…` to `21e6dee8…`, corroborating that the
dependency change reached the build inputs. Recorded as corroboration only — the browser evidence
in §13 is what actually proves it.

## 12. Docs gates

| Gate | Result |
| --- | --- |
| `format:check` | all matched files use Prettier style |
| `lint` | 13/13 tasks (pre-existing warnings only, 0 errors) |
| `typecheck` | 13/13 tasks |
| `test` | 13/13 tasks — web 176, api 649, domain 164, i18n 80 |
| `verify:styles` | 251 platform utility classes, all generated (61 kB) |
| `build` | 9/9 tasks |

## 13. Docs accessibility and consistency, against the installed 1.3.1

These are **Docs** results, measured in the running product — distinct from the platform's own
Storybook matrix in §2, which is not re-claimed here.

| Suite | Result |
| --- | --- |
| `consistency.e2e` | **12/12** — `[axe /audit] []`, `/approvals`, `/reports`, `/admin/users`, `/documents` all empty |
| `shell.e2e` | **8/8** — axe in light and dark, rail readability in both, every width on every reference screen, Arabic at 1280 and 390, keyboard operability |
| `search.e2e` | **23/23** |
| `dashboard.e2e` | **19/19** |
| `recent-empty.e2e` | **15/15** |
| `faded-text.e2e` | **4/4** — includes opening a document row from the keyboard |
| `datagrid-keyboard.e2e` | **3/3** — new, §14 |

### Regression coverage, 1.3.0 → 1.3.1

Nothing was duplicated: the existing suites already carry these guarantees, and all of them pass.

| Concern | Where it is covered |
| --- | --- |
| axe | `consistency` on five routes, `shell` in both schemes, `search`, `dashboard`, `recent-empty` |
| contrast | `shell` rail readability light and dark, `faded-text` compositing sweep |
| dark | `shell` axe + rail in dark, `consistency` group-title measurement in both |
| light | as above |
| RTL | `shell` renders in Arabic at 1280 and 390 |
| responsive | `shell` every width on every reference screen |
| keyboard | `shell` operability, `faded-text` row opening, and the new `datagrid-keyboard` |

**One intermittent result, recorded not fixed.** The first `shell.e2e` run failed on
`no way to reach navigation on search at 640px`; it passed on the next three runs and on the final
run against the released artifact. It is a timing flake in a responsive navigation probe, not a
regression: the only runtime change in 1.3.1 is one line in `DataGrid`'s key handler, and the
failing assertion concerns the application shell's navigation at a viewport, on a route that renders
no grid. Recorded here rather than investigated further, which belongs to whoever owns that suite.

## 14. DataGrid regression, verified through the browser

Not inspected in source — driven in Chromium against the running product on the registry-installed
package.

The Docs surface had to be chosen carefully. `ResourceList` puts a `DropdownMenu` trigger in a
`DataGrid` row-action cell on every admin list, but the defect only bites where the grid also has an
`onRowActivate` to run: without one, the old code reached the end of its `Enter` branch, called no
`preventDefault`, and the button's own handler survived. **`/admin/users` therefore passes on both
versions** — the first attempt at this proof used it and proved nothing. `/admin/libraries` and
`/admin/workflows` pass `onRowActivate` and do reproduce it.

Measured on platform **1.3.0**, on `/admin/libraries`:

```
Enter on the row-actions trigger → menuOpen: false, navigated: true
URL became /admin/libraries/90e903ec-…/folders
```

The grid activated the row underneath and the button's own menu never opened — with a mouse the same
control worked. On **1.3.1**, same page, same keystroke: `menuOpen: true, navigated: false`.

`apps/web/src/test/e2e/datagrid-keyboard.e2e.spec.ts` asserts three things: that the trigger really
sits in a grid cell (the shape that broke), that Enter opens the menu **and** does not navigate, and
that the package under test resolves to `node_modules/.pnpm/@munaxa+platform@1.3.1`.

## 15. Test-proof of registry consumption

A full round trip, with nothing committed from the middle step:

| Step | Platform | Result |
| --- | --- | --- |
| 1 | 1.3.1 from registry | `datagrid-keyboard.e2e` **3/3** |
| 2 | downgraded to 1.3.0, `.next` wiped, rebuilt | **2 failed** — `{ menuOpen: false, navigated: true }`, and the installed version assertion reported `1.3.0` |
| 3 | restored to 1.3.1, `node_modules` wiped, `--frozen-lockfile`, rebuilt | `datagrid-keyboard.e2e` **3/3** |

The expected 1.3.1 behaviour disappears when the package is replaced and returns when it is put
back, in the browser and at the artifact level both. The registry was not mutated and the temporary
downgrade is not committed.

## 16. Phase 8.7 limitations, recorded unchanged

Not expanded during this release phase; they belong to a future keyboard-coverage phase:

- `input` typing is classified but not fully machine-checked.
- `link` activation is classified but not fully machine-checked.
- `combobox` is classified but not fully machine-checked.
- `radio` is classified but not fully machine-checked.
- Tab traversal stops after four controls in a story.

## 17. Unrelated failures, recorded not fixed

- **Cloudflare `Workers Builds: platform-storybook`** reports failure on the platform PR. It failed
  identically on PR #8, which was merged, so it pre-dates this work; it is a Storybook deployment
  check outside the release chain, and its detail lives in a Cloudflare dashboard this session
  cannot reach. Not touched.
- **`@munaxa/audit` and `@munaxa/rbac` wall-clock assertions** — did not fire this time, unchanged
  either way.
- **`shell.e2e` intermittency** — §13.
- Pre-existing `no-console` and `consistent-type-imports` **warnings** in the Docs API and e2e
  helpers. Warnings, not errors; untouched.

## 18. Deferred

- Extend the per-kind keyboard contracts to `input`, `link` and `combobox`.
- Widen axe beyond `color-contrast` on the platform matrix; add a second viewport.
- The `shell.e2e` responsive-navigation probe's intermittency.
- The Cloudflare Storybook deployment check.

## 19. Final state

```
@munaxa/platform 1.3.1
    ├── 800/800 contrast matrix
    ├── 800/800 keyboard matrix — 528 interactive, 272 static, 0 excluded, 0 failing
    └── Phase 8.7 DataGrid fix
             ↓  GitHub Packages, latest → 1.3.1
       Munaxa Docs
             ├── apps/web/package.json → ^1.3.1
             ├── pnpm-lock.yaml → registry tarball + integrity hash
             ├── clean pnpm install --frozen-lockfile ✓
             ├── clean production build ✓
             └── gates, accessibility and DataGrid regression ✓
```

No local overlay, no patched dependency, no workspace link. Both trees clean; all changes pushed.
