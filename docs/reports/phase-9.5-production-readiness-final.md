# Phase 9.5 — Final Production Readiness Verification

## 1. Final certified commits

| | |
| --- | --- |
| Docs last code-bearing certified state | `471be82` — CI run 232, seven of seven green, first attempt |
| Docs report chain | `478a7d8` → `471be82` → `26649bf` → `e56c6f4` → `2d240e2` → `9071eae` |
| Docs `main` | `1f0c8d6` |
| Platform | `61810a6` |
| Platform `main` | `72009f2` |

No product code, CI definition, deployment configuration or visual baseline was touched in this
phase. No commit was made to generate CI activity.

## 2. Platform version

```
@munaxa/platform@1.5.1
```

Unchanged. No release was cut and none was required.

## 3. Branch protection state

**Something changed since Phase 9.4, and it is real.** Read from GitHub, not from a screenshot, a
statement, or a command's output.

### `munaxa/munaxa-docs`

```
branches/main → protected: true
rulesets      → 1 ruleset: "Protect main", target branch, enforcement ACTIVE
                conditions: refs/heads/main
                bypass_actors: null
rules/branches/main → 5 effective rules
```

The five rules actually in force:

| Rule | Configuration |
| --- | --- |
| `deletion` | branch deletion blocked |
| `non_fast_forward` | force push blocked |
| `pull_request` | required; 1 approval; dismiss stale reviews on push; require last push approval |
| `required_status_checks` | strict (branch must be up to date); **4 contexts** — see §4 |
| `required_linear_history` | enforced |

`bypass_actors: null` matters: nobody is exempt, which is what makes the rest of it mean anything.

**A note on a misleading field.** The legacy `protection` block on the branch object still reads
`enabled: false, enforcement_level: "off", contexts: []`, and the legacy
`/branches/main/protection` endpoint still returns 403 to this session. Neither indicates a
half-configuration: rulesets and classic branch protection are separate mechanisms, and this branch
is governed by a ruleset. `branches/main → protected: true` and the `rules/branches/main` endpoint —
which reports what is *effectively* in force, including any organisation-level rules — are the
authoritative reads, and both agree.

### `munaxa/munaxa-platform`

```
branches/main → protected: false
rulesets      → 0
rules/branches/main → 0 effective rules
```

**Nothing is configured.** A direct push to `munaxa-platform/main` would be accepted today.

## 4. Exact required check contexts

Every configured context on Docs was compared byte-for-byte against the check-run names GitHub
actually stored on `471be82`.

**The four that are configured all match exactly** — separator U+00B7, capitalisation, punctuation,
`integration_id: 15368` (GitHub Actions):

```
MATCH   Lint · Typecheck · Test · Build                      → success
MATCH   Integration · real PostgreSQL, two tenants           → success
MATCH   Container images · three targets from one commit     → success
MATCH   Product isolation                                    → success
```

**Three required checks are absent from the ruleset:**

```
UNGATED  End-to-end · signing, faded text and search         (success, but not required)
UNGATED  End-to-end · recovery and the data grid             (success, but not required)
UNGATED  End-to-end · the screens                            (success, but not required)
```

`configured: 4 · real: 7 · ungated: 3`

This is not a naming defect — nothing is misspelled and no context fails to report. It is a coverage
gap, and it is a consequential one. **The entire end-to-end suite is ungated.** All three shards, 161
tests, covering sign-in, document signing, faded-text rendering, search, disaster recovery, the data
grid and every screen. A pull request that broke every one of them could merge into `main` today with
the ruleset reporting itself satisfied.

That suite is also the one Phase 8.23 existed to add: before it, CI ran zero end-to-end tests. Making
it required is the difference between having the suite and being protected by it.

`Publish @munaxa/* to GitHub Packages` is correctly not required — a release action is not a merge
gate.

### What Platform requires

Nothing is configured, so nothing to compare. The three contexts to use, from Phase 9.4:

```
Lint · Typecheck · Test · Build
Accessibility · contrast and keyboard, every story, four brands, light and dark
Façades match the platform surface
```

Excluded, as previously recorded: `Publish @munaxa/* to GitHub Packages`, and
`Workers Builds: platform-storybook` — a Cloudflare preview build, separately failing on the default
branch, not part of the certification gate and not addressed here.

## 5. Merge enforcement proof

**Not obtained, and deliberately not manufactured.**

The certification condition in §15 of the brief cannot be satisfied in this state for two independent
reasons — Platform has no protection at all, and Docs' required set omits three of seven checks — so
no test could produce a passing result. Given that, opening a pull request would have demonstrated
only that pull requests can be opened, and would have left a branch behind for the administrator.

The brief's §11 offers the alternative explicitly when a direct-push test is unsafe: *use the
branch-protection configuration plus mergeability evidence instead*. That is what §3 records. A
direct push to `munaxa-docs/main` was **not** attempted, because the failure mode is asymmetric: a
rejected push proves the rule, but a push that succeeded would have landed commits on `main` outside
the review requirement — bypassing the very policy under test to test it. That trade is not worth
making for evidence the ruleset read already provides.

So the honest position: **the Docs ruleset is configured and active, and its enforcement has not yet
been observed in operation.** Observation belongs in the run of this phase that follows the two
corrections in §12.

## 6. Direct push policy

From the effective rules, not inferred:

| | Docs `main` | Platform `main` |
| --- | --- | --- |
| Direct push | blocked (`pull_request` required, no bypass actors) | **permitted** |
| Force push | blocked (`non_fast_forward`) | **permitted** |
| Branch deletion | blocked (`deletion`) | **permitted** |
| Linear history | required | not required |
| Up-to-date before merge | required (strict) | not required |

## 7. Stray branch status

`claude/phase-9-certification` (`08b7c65`) remains.

Deletion was attempted once more this phase — justified, because the repository's administrative
state demonstrably changed — and was refused again over the git transport. The refusal is the proxy's
write policy, which §3 shows is unchanged; the new Docs ruleset scopes to `refs/heads/main` only and
does not govern this branch.

Its content is not at risk: Phase 9.3 established that `git cherry HEAD
origin/claude/phase-9-certification` prefixes its single commit with `-`, meaning a patch-equivalent
commit is already on the designated branch.

Classification: **ADMINISTRATIVE CLEANUP.** Not a production blocker and not a factor in §14.

## 8. Existing deployment evidence

Carried forward from Phase 9.2, valid because no application artefact changed. Not re-run.

```
production images:  built from one commit and actually executed
health:             /api/health/live 200 · /api/health/ready 200 · /api/health 200 · /api/v1/health/ready 404
readiness gate:     200 → 503 → 200 across a real postgres stop and restart
liveness:           200 throughout the outage
```

## 9. Existing smoke evidence

```
deployed smoke:     10/10, run twice (before and after the rollback round trip)
authentication:     anonymous 401 · session 200
RBAC:               reader refused the signing statement 403 · signer granted 200
tenant isolation:   both directions, 404 each way
RLS:                77/77 tables enabled AND forced
tenant scoping:     app.tenant_id correct → 3 document rows · foreign → 0
audit:              UPDATE and DELETE both refused, as the table owner
```

## 10. Existing rollback evidence

```
478a7d8 → 78c6a59:        ~2 s to liveness, image confirmed by docker inspect
78c6a59 behaviour:        readiness 200 with body DOWN · login 500 (pre-fix state reproduced)
78c6a59 → 478a7d8:        readiness 200 / UP in ~2 s
smoke after round trip:   10/10
migration files between:  0
```

Restated limit: `78c6a59` cannot reach a database, so the drill proves the mechanism rather than a
safe harbour. `471be82` is the first viable rollback target this product has ever had.

## 11. Final 25-gate matrix

| # | Gate | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Package integrity | PASS | `@munaxa/platform@1.5.1` from GitHub Packages; no `file:`/`link:` |
| 2 | Build integrity | PASS | three targets from one commit; CI run 232 |
| 3 | Component matrix | PASS | 52/52 |
| 4 | Application accessibility | PASS | 177 measurements, 0 findings |
| 5 | Responsive behaviour | PASS | 320/390/1280, 0 overflow |
| 6 | Keyboard behaviour | PASS | Phase 8 keyboard contracts |
| 7 | Overlay semantics | PASS | 12/12 focus contracts; menu modality in 1.5.1 |
| 8 | Authentication | PASS | deployed: 401 anonymous, 200 session |
| 9 | RBAC | PASS | deployed: 403 without `document:sign`, 200 with |
| 10 | Tenant isolation | PASS | deployed, both directions |
| 11 | Data integrity | PASS | RLS 77/77 enabled and forced; scoping 3 → 0 |
| 12 | Audit / security | PASS | UPDATE and DELETE refused as table owner |
| 13 | Migrations | PASS | expand-only; 0 migration files between rollback images |
| 14 | Recovery | PASS | 19/19 |
| 15 | Fixture safety | PASS | 0 fixture tenants left behind |
| 16 | E2E | PASS | 161/161 green in CI |
| 17 | CI execution | PASS | 7/7 green, first attempt |
| 18 | **CI enforcement** | **FAIL** | Docs requires 4 of 7 — all three E2E shards ungated; Platform requires 0 |
| 19 | **Branch protection** | **FAIL** | Docs ruleset active and correct in every other respect; Platform `main` has 0 effective rules |
| 20 | Visual certification | PASS | 107/107 canonical in CI |
| 21 | Deployment | PASS | images executed against real PostgreSQL and Redis |
| 22 | Health / readiness | PASS | 200 → 503 → 200; liveness 200 throughout |
| 23 | Post-deployment smoke | PASS | 10/10, twice |
| 24 | Rollback | PASS (mechanism) | both directions, ~2 s each way |
| 25 | Operational readiness | PARTIAL | runbook corrected in 9.2; no hosted environment, no load baseline, no in-quarter restore test |

**23 PASS · 2 FAIL · 1 qualified.** The count is unchanged from Phase 9.4, and that is the honest
result rather than a disappointing one — gates 18 and 19 moved substantially toward passing without
crossing the line. Docs went from nothing to an active, bypass-free ruleset with four correctly-named
required checks; Platform did not move. No gate was inflated to reflect partial progress.

## 12. Remaining administrative limitations

Two corrections, both in the GitHub Settings UI, neither requiring any change to the App installation
or the proxy:

**1 · `munaxa-docs` — add the three missing required checks** to the "Protect main" ruleset
(id `20906159`), copied exactly:

```
End-to-end · signing, faded text and search
End-to-end · recovery and the data grid
End-to-end · the screens
```

Everything else about that ruleset is already right and should be left alone.

**2 · `munaxa-platform` — create the equivalent ruleset on `main`**: require a pull request, require
the three contexts in §4, strict up-to-date, block deletion, block force push, no bypass actors.

Then, for the phase that follows: **prove it**. Open a harmless pull request against a protected
branch and confirm it cannot merge while a required check is pending or failing, and can once all are
green. Do not disable protection to run the test.

Also outstanding, none of it blocking the above: no hosted production environment, no known-good
rollback target predating this release, no load baseline, no in-quarter restore test, the red
Cloudflare preview build on the platform's default branch, and the stray branch in §7.

## 13. Corrections

**Phase 9.4 said re-running the verification would not change the answer.** The decision did not
change, but the state did — Docs went from unprotected to an active ruleset between the two phases.
That statement was about the decision and it held, but it read as though re-measurement were
pointless, and this phase found a material change and a new, more specific defect. Measuring again
was right.

**"The remaining blocker is administrative" needs one qualification.** It was true, and it remains
true, but it is no longer a single action. Enabling protection surfaced a second question —
*which checks are required* — that could not be asked until protection existed. Configuring
protection and configuring it *completely* are different steps, and the first has now been done.

Nothing in Phase 9.4, 9.3 or 9.2 has been rewritten.

## 14. Final production decision

# PHASE 9.5 — NOT PRODUCTION READY

## MUNAXA DOCS IS NOT PRODUCTION READY BECAUSE REQUIRED CI CHECKS REMAIN ADMINISTRATIVELY UNENFORCED.

**This is not a code failure.** Two specific, independent blockers, each naming its repository:

```
munaxa-platform   main is entirely unprotected — 0 effective rules.
                  A direct push, a force push or a branch deletion would all be accepted.

munaxa-docs       main is protected and the ruleset is active, correctly named and
                  bypass-free — but requires only 4 of the 7 certification checks.
                  All three End-to-end shards are ungated: 161 tests covering sign-in,
                  signing, search, recovery, the data grid and every screen. A pull
                  request that broke every one of them would merge today.
```

The distinctions this programme has held throughout, applied to today's state:

```
CI GREEN                       ≠  CI REQUIRED           — 7 green, 4 required
BRANCH PROTECTION CONFIGURED   ≠  CORRECTLY CONFIGURED  — Docs protected, incompletely
CONFIGURED                     ≠  ENFORCEMENT PROVEN    — not yet observed in operation
ONE REPOSITORY PROTECTED       ≠  BOTH PROTECTED        — Platform has nothing
```

Twenty-three of twenty-five gates pass on measured evidence, and the product itself is in better
shape than at any point in this programme: deployed and run rather than argued about, with the
defects that would have wrecked its first release found by running it, fixed, and guarded.

```
CODE → TESTED → CI → DEPLOYED → HEALTHY → SMOKE TESTED → TENANT ISOLATED
     → AUDITED → ROLLED BACK → RESTORED → [ MERGE ENFORCEMENT ] → PRODUCTION READY
```

The bracket is now partly filled rather than empty. Closing it is the two settings changes in §12
plus one observation — no engineering, and no further engineering phase should be created for it.

**Run this phase again once §12 is done.** Unlike the last time that sentence was written, there is
now a specific reason to expect a different answer.
