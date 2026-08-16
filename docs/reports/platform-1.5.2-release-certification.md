# Platform 1.5.2 — release certification and Docs adoption

**Scope:** verifying an already-published Platform release and adopting it in Docs. No Platform code
was changed, no release was dispatched, no Docs application code was touched, and no visual baseline
was regenerated.

## 1. Previous published version

```
@munaxa/platform@1.5.1   published 2026-08-15T17:25:11Z
```

## 2. Released version

```
@munaxa/platform@1.5.2   published 2026-08-15T21:54:25Z by github-actions[bot]
```

**It was already published before this task began.** The brief's starting state recorded
`published registry version = 1.5.1`; the registry says otherwise, and the registry is authoritative.
Nothing was dispatched here, because there was nothing left to release — §6 below.

## 3. Release commit

```
munaxa-platform main @ 72009f2   "fix(date): make the calendar's month arrows actually page (#16)"
release run 31910652929, branch main, 2026-08-15T21:53:08Z, conclusion success
```

The apparent ordering confusion is a timezone artefact and is recorded so it is not rediscovered:
`72009f2` is dated `Sun Aug 16 00:35:39 2026 +0300`, which is **2026-08-15T21:35:39Z** — eighteen
minutes before the release run, not the day after it.

Platform `main` has since advanced to `56dd25c`, but the package content is unchanged:

```
git diff 72009f2..main -- packages/   →   empty
```

The commits in between touch only `.github/workflows/ci.yml` and `docs/reports/`. The published
1.5.2 therefore corresponds exactly to the package content on `main` today.

## 4. Version-bump origin

`72009f2` (PR #16), before this task. Not attributable to this work, and not to the Platform CI
cleanup that preceded it — that change touched no manifest.

## 5. Release contents

Everything between published 1.5.1 and published 1.5.2, in `packages/`:

```
packages/platform/CHANGELOG.md                       24 +
packages/platform/package.json                        2 +-      1.5.1 → 1.5.2
packages/platform/ui/components/date/calendar.tsx    19 +-      the fix
packages/platform/ui/components/date/date.test.tsx   41 +       its tests
```

**One product change.** The calendar's header arrows did nothing: the pane is driven by `cursor`,
and an effect pulls `cursor` back to the month the focused day sits in, so moving `cursor` alone was
undone on the next commit. The fix moves the focused day with the pane.

It is behaviourally relevant to Docs — every `DatePicker` surface — which is why §11 and §12 below
are measured rather than assumed.

## 6. Why no release workflow was dispatched

`release.yml` is `workflow_dispatch` only, unchanged, and was not modified. It did not need to run:
1.5.2 already exists on the registry, from the correct commit, with `latest` pointing at it.
Dispatching again would at best be a no-op and at worst republish an identical version under a new
build. The brief's §6 says to stop rather than publish when anything is ambiguous; nothing here is
ambiguous, and the correct action was to verify rather than to publish.

## 7. Required CI results

**On the released commit `72009f2`** — the state that was actually published:

```
Lint · Typecheck · Test · Build                                     success
Accessibility · contrast and keyboard, every story, four brands, …  success
Façades match the platform surface                                  success
```

**On Platform `main` (`56dd25c`)** — a later commit whose package content is byte-identical:
`Lint · Typecheck · Test · Build` **failed**, on `@munaxa/audit#test`.

That is the wall-clock budget class already documented in `platform-ci-docs-only-pr.md` §7, seen
there on `@munaxa/rbac`. Two different packages, both budget-based, alternating across runs on
unchanged code — which is what runner variance looks like, and not what a defect looks like. It does
not bear on the release: the published artefact came from `72009f2`, which was green, and the
package content has not changed since. Neither budget was modified.

## 8. Registry verification

Queried directly rather than inferred from a workflow's success:

```
npm view @munaxa/platform versions   →   [ …, '1.5.0', '1.5.1', '1.5.2' ]
npm view @munaxa/platform dist-tags  →   { latest: '1.5.2' }
```

## 9. Tarball inspection

`npm pack @munaxa/platform@1.5.2` from the registry:

```
files                    503
name / version           @munaxa/platform / 1.5.2
dependencies             19   — local-protocol entries: none
peerDependencies          2   — local-protocol entries: none
test / spec / stories / __tests__ / .storybook leaks   none
top level                README.md assets dist package.json scripts themes tokens ui
```

**The artefact carries the fix it claims.** The package ships compiled output, so the check was made
against `dist/ui/components/date/calendar.js`:

```
present: function page · page(-1) · page(1)
absent:  setCursor(paging.previous) · setCursor(paging.next)
```

That is exactly the before/after of `72009f2`. A version number and a changelog entry are not
evidence that the code shipped; this is.

## 10. Docs dependency update

```
apps/web/package.json   "@munaxa/platform": "^1.5.1"  →  "^1.5.2"
```

No other dependency was touched. Note that `^1.5.1` already permitted 1.5.2 by semver — the lockfile
was pinning 1.5.1, so the range was widened *and* the lock updated, and the lockfile is what decides.

## 11. Clean-install proof

`node_modules` removed at every level, then `pnpm install --frozen-lockfile`:

```
copies in the virtual store   @munaxa+platform@1.5.2  — exactly one
apps/web resolves             1.5.2
lockfile references to 1.5.1  0
resolution                    https://npm.pkg.github.com/download/@munaxa/platform/1.5.2/8d20003f…
```

That tarball digest is the same `8d20003f…` the registry reported in §8. No `file:`, `link:`,
`portal:` or `workspace:` protocol is used for any `@munaxa` package. The thirteen local-protocol
entries in the lockfile are this repository's own workspace packages (`@edms/contracts`,
`@edms/domain`, `@edms/i18n`, `@edms/utils`) and are expected.

## 12. Docs compatibility results

Run sequentially, as CI runs them:

```
typecheck   PASS
lint        PASS
test        PASS
build       PASS
```

### A turbo race, not a regression

Running all four concurrently under `turbo --force` reported `@edms/web#typecheck` as failed, while
the same task passed in isolation and passed when run directly. The cause is `build` rewriting
`.next` while `typecheck` reads the route types `next typegen` generates into it. CI runs these as
separate sequential steps, so it does not occur there. Recorded because a red task that is green on
its own invites exactly the wrong conclusion.

A second false alarm is recorded for the same reason: the first run of the Docs gates failed across
`@edms/api` because this task had deleted `node_modules`, and the Prisma client had not been
regenerated. `pnpm prisma:generate` resolved it. Neither finding involves 1.5.2.

## 13. Visual and accessibility regression

This is a Platform **UI** release, so the certified visual surface was measured on both versions
rather than assumed unchanged. **No baseline was regenerated and no accessibility policy was
touched.**

```
@munaxa/platform@1.5.1   14 failed | 93 passed (107)
@munaxa/platform@1.5.2   14 failed | 93 passed (107)
```

Identical counts, and identical test names — all fourteen are the Arabic right-to-left baselines:
`ar-document-list-{one,two,few,many,mobile}`, `ar-dashboard`, `ar-dashboard-mobile`, each in light
and dark.

**1.5.2 introduces no visual difference.** The fourteen are the pre-existing Arabic
visual/environment classification: these baselines are canonical in CI, where the suite is 107/107,
and differ locally on font rendering. That classification is unchanged, and nothing in 1.5.2
implicates it — the controlled comparison is what establishes that rather than the classification
being reused as an excuse.

## 14. E2E and recovery

The E2E and recovery suites require a running API, web server, PostgreSQL and Redis, and are
executed by CI's three shards. Locally they report as skipped, and their suite-level hooks fail for
want of a server — that is the expected local shape and is not evidence about 1.5.2.

The authoritative result is the required CI run on the pull request carrying this change:
`End-to-end · signing, faded text and search`, `End-to-end · recovery and the data grid` and
`End-to-end · the screens` are all required contexts and must be green before it can merge.

## 15. Remaining non-blocking issues

1. **Platform wall-clock budget sensitivity** — `@munaxa/rbac` and `@munaxa/audit` performance tests
   fail intermittently on CI runners. Known, documented, budgets deliberately unchanged.
2. **No operational load baseline** for Docs; **no in-quarter restore exercise**. Unchanged.
3. **`claude/phase-9-certification`** — administrative cleanup, still blocked by proxy write policy.

## 16. Cloudflare Storybook status

`Workers Builds: platform-storybook` remains **failing** on Platform `main`. It is a Cloudflare
integration with its own triggers, not a workflow in either repository, and not a required check. It
was failing before this task and was not touched by it. The release workflow does not depend on it —
`release.yml` is `workflow_dispatch` with no reference to it — so it did not gate publication.

```
pre-existing external/integration issue — non-blocking
```

## 17. Final release decision

*(completed once the Docs pull request's required checks report)*
