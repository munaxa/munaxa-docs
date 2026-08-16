# Phase 9.4 — Administrative Enforcement & Final Production Certification

## 1. Starting certified state

| | |
| --- | --- |
| Docs last code-bearing certified commit | `471be82` — CI run 232, seven of seven green, first attempt |
| Docs chain | `478a7d8` → `471be82` → `26649bf` → `e56c6f4` → `2d240e2` (Phase 9.3 report) |
| Platform | `61810a6`, `@munaxa/platform@1.5.1` |
| Docs `main` | `1f0c8d6` |
| Platform `main` | `72009f2` |

No product code was modified in this phase. No commit was made to generate CI activity. No Platform
version was published. Nothing in the certified application changed, so §9 and §10's evidence
carries forward intact and was not re-run.

## 2. GitHub identity

```
login: tam2om   (id 44133590)
```

The account that **owns both repositories**. This is stated first because it is the fact most likely
to be misread: the blocker is not that the wrong person is signed in, and an administrator logging in
as themselves would hit the same wall.

## 3. GitHub App permissions — Layer A

Measured this phase, once per repository. A `GET` is a read, which the proxy permits, so a 403 here
is GitHub's own answer about the App installation and nothing else:

```
GET /repos/munaxa/munaxa-docs/branches/main/protection      → 403  Resource not accessible by integration
GET /repos/munaxa/munaxa-platform/branches/main/protection  → 403  Resource not accessible by integration
```

`Resource not accessible by integration` is GitHub's phrasing for *this App installation was never
granted this permission*. The installation lacks **`administration`** on both repositories.

Corroborating, from the repository object itself:

```
permissions: { admin: false, maintain: false, push: false, triage: false, pull: false }
```

**Layer A is still blocking. Unchanged since Phase 9.3.**

## 4. Proxy capabilities — Layer B

Measured this phase, once per repository:

```
POST /repos/munaxa/munaxa-docs/rulesets      → 403  Write access to this GitHub API path is not permitted through this proxy.
POST /repos/munaxa/munaxa-platform/rulesets  → 403  Write access to this GitHub API path is not permitted through this proxy.
```

That refusal is emitted by the agent proxy **before the request reaches GitHub**, so the App's
permission set is never consulted. It is a different system giving a different answer for a different
reason, and it is why granting Layer A alone would not be enough.

The read side of the same path is open:

```
GET /repos/munaxa/munaxa-docs/rulesets      → 200  []
GET /repos/munaxa/munaxa-platform/rulesets  → 200  []
```

Read-yes / write-no on one endpoint is the cleanest available demonstration that the boundary is the
proxy's write policy rather than anything about the repositories.

**Layer B is still blocking. Unchanged since Phase 9.3.**

Exactly one attempt was made against each of the four surfaces above. Nothing was retried, and no
attempt was made to route around either layer.

## 5. Branch protection configuration

**Not configured.** Read back from GitHub rather than inferred from any command's response, as
required:

```
munaxa-docs/main      sha 1f0c8d6   protected: false
  protection: { enabled: false, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } }

munaxa-platform/main  sha 72009f2   protected: false
  protection: { enabled: false, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } }

rulesets (both repositories): []
```

`enforcement_level: "off"` with `contexts: []` and `checks: []` is the explicit statement that no
check gates a merge on either default branch. A direct push to `main` on either repository would be
accepted today.

## 6. Required check contexts

Carried from Phase 9.3, where they were read from the check-runs GitHub actually stored on the
certified commits — not from the workflow YAML, because the required-check context *is* the
check-run name and a job rename would orphan a required check silently.

**`munaxa/munaxa-docs`** — all seven `success` on `471be82`, app `github-actions`:

```
Lint · Typecheck · Test · Build
Integration · real PostgreSQL, two tenants
End-to-end · signing, faded text and search
End-to-end · recovery and the data grid
End-to-end · the screens
Container images · three targets from one commit
Product isolation
```

**`munaxa/munaxa-platform`** — three `success` on `61810a6`:

```
Lint · Typecheck · Test · Build
Accessibility · contrast and keyboard, every story, four brands, light and dark
Façades match the platform surface
```

The separator is U+00B7 MIDDLE DOT with a space on each side. It must be copied exactly; a visually
similar hyphen produces a required check that can never report.

**Deliberately excluded**, per the phase brief and for the reasons already recorded:

- `Publish @munaxa/* to GitHub Packages` — a release action. Requiring it would make every merge wait
  on a publish.
- `Workers Builds: platform-storybook` — a Cloudflare Workers preview build, currently **failing** on
  the platform's default branch (build `c727023f`, app `cloudflare-workers-and-pages`). It is not
  produced by `ci.yml`, requiring it would couple every platform merge to Cloudflare's availability,
  and it is not fixed here. It remains separately visible as an existing platform CI issue.

These are a specification for whoever configures protection. Nothing about them is in force.

## 7. Merge-enforcement proof

**None. Not attempted, and that is the correct outcome rather than an omission.**

With `enforcement_level: "off"` on both branches, a test pull request would demonstrate only that a
pull request can be opened — which was never in question — and would leave a branch behind for the
administrator to clean up. The phase brief prohibits opening one when protection is absent, and
independently of the instruction it is the right call: a green-looking merge on an unprotected branch
is not weak evidence of enforcement, it is evidence of the opposite.

The proof that certification requires — *an ordinary maintainer cannot merge while a required check
is failing* — is not available until §12's actions are complete.

## 8. Stray branch cleanup

`claude/phase-9-certification` (`08b7c65`) is still present; confirmed this phase by a read
(`HTTP 200`).

Deletion was attempted once in Phase 9.3 and refused **403** over the git transport, which is
governed by the same proxy write policy measured in §4. Since neither layer changed, the operation
was **not repeated** — repeating a request whose governing condition has just been shown unchanged is
the behaviour the brief prohibits, not diligence.

Phase 9.3 established that the branch carries nothing unique: `git cherry HEAD
origin/claude/phase-9-certification` prefixes its single commit with `-`, meaning a patch-equivalent
commit is already on the designated branch.

Classification: **ADMINISTRATIVE CLEANUP.** Not a production gate and not a factor in §14.

## 9. Existing production evidence

From Phase 9.2, valid because nothing in the certified application changed:

```
production image:        built from one commit and actually executed
smoke:                   10/10, run twice (before and after the rollback round trip)
authentication:          anonymous 401, session 200
RBAC:                    reader refused the signing statement 403, signer granted 200
tenant isolation:        both directions, 404 each way
RLS:                     77/77 tables enabled AND forced
tenant scoping:          app.tenant_id correct → 3 document rows; foreign → 0
audit:                   UPDATE and DELETE both refused — as the table owner
health:                  200 → 503 → 200 across a real postgres stop and restart
liveness:                200 throughout the outage
```

## 10. Existing rollback evidence

```
478a7d8 → 78c6a59:       ~2 s to liveness, image confirmed by docker inspect
78c6a59 behaviour:       readiness 200 with body DOWN; login 500 (the pre-fix state, reproduced)
78c6a59 → 478a7d8:       readiness 200 / UP in ~2 s
smoke after round trip:  10/10
migration files between: 0
```

The limit, restated rather than smoothed: `78c6a59` cannot reach a database, so the drill proves the
**mechanism**, not a safe harbour. `471be82` is the first version of this product that has ever run
and is therefore the first viable rollback target.

## 11. Final certification matrix

| # | Gate | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Package integrity | PASS | `@munaxa/platform@1.5.1` consumed from GitHub Packages; no `file:`/`link:` |
| 2 | Build integrity | PASS | three targets from one commit; CI run 232 |
| 3 | Component matrix | PASS | 52/52 |
| 4 | Application accessibility | PASS | 177 measurements, 0 findings |
| 5 | Responsive behaviour | PASS | 320/390/1280, 0 overflow |
| 6 | Keyboard behaviour | PASS | Phase 8 keyboard contracts |
| 7 | Overlay semantics | PASS | 12/12 focus contracts; menu modality released in 1.5.1 |
| 8 | Authentication | PASS | deployed: anonymous 401, session 200 |
| 9 | RBAC | PASS | deployed: 403 without `document:sign`, 200 with |
| 10 | Tenant isolation | PASS | deployed, both directions |
| 11 | Data integrity | PASS | RLS 77/77 enabled and forced; scoping 3 → 0 |
| 12 | Audit / security | PASS | UPDATE and DELETE refused as table owner |
| 13 | Migrations | PASS | expand-only; 0 migration files between rollback images |
| 14 | Recovery | PASS | 19/19 |
| 15 | Fixture safety | PASS | 0 fixture tenants left behind |
| 16 | E2E | PASS | 161/161, three shards in CI |
| 17 | CI execution | PASS | 7/7 green, first attempt, run 232 |
| 18 | **CI enforcement** | **FAIL** | `enforcement_level: "off"`, `contexts: []` on both repositories |
| 19 | **Branch protection** | **FAIL** | `protected: false` on both default branches |
| 20 | Visual certification | PASS | 107/107 canonical in CI |
| 21 | Deployment | PASS | images executed against real PostgreSQL and Redis |
| 22 | Health / readiness | PASS | 200 → 503 → 200; liveness 200 throughout |
| 23 | Post-deployment smoke | PASS | 10/10, twice |
| 24 | Rollback | PASS (mechanism) | both directions, ~2 s each way |
| 25 | Operational readiness | PARTIAL | runbook corrected in 9.2; no hosted environment, no load baseline, no in-quarter restore test |

**23 PASS · 2 FAIL · 1 of the passes qualified.** Gates 18 and 19 are the same blocker seen from two
angles, and they are the only gates that have ever been unresolved. Stray-branch cleanup is not a
gate.

## 12. Remaining administrative limitations

Both layers must change. Granting either alone leaves the other refusing, and that is the single
most important sentence in this report.

**Layer A — GitHub App.** Grant the installation `administration: write` on `munaxa/munaxa-docs` and
`munaxa/munaxa-platform`. Grant nothing else. Then verify it is reflected in the installation token
rather than only in the settings page — the check is that
`GET /repos/{owner}/{repo}/branches/main/protection` stops returning `Resource not accessible by
integration`.

**Layer B — agent proxy.** Permit writes to the branch-protection and ruleset API surface. The check
is that `POST /repos/{owner}/{repo}/rulesets` stops returning `Write access to this GitHub API path
is not permitted through this proxy`.

**Alternatively, and more simply:** the repository owner can configure both branches directly in the
GitHub web UI, which is subject to neither layer. That path needs no permission change at all — only
the settings in §5's target state and the exact contexts in §6.

Then, in either case:

1. Protect `main` on both repositories: require a pull request, require the contexts in §6 verbatim,
   require the branch to be up to date, block direct pushes, block force pushes, block deletion. The
   minimum policy — nothing unrelated.
2. **Prove it**, rather than stopping at `protected: true`: open a harmless pull request and confirm
   it cannot merge while a required check is pending or failing, and can once all are green. Do not
   disable protection to run the test.
3. Delete `claude/phase-9-certification`.

Also outstanding, none of which blocks the above: no hosted production environment, no known-good
rollback target before this release, no load baseline, no in-quarter restore test, and the red
Cloudflare preview build on the platform's default branch.

## 13. Corrections

**Nothing changed between Phase 9.3 and this phase.** This report is a re-measurement, and it found
the same state. It is recorded as a distinct phase because "we checked again and it is still blocked"
is a different and more useful statement than "we assume it is still blocked" — but no reader should
take §3–§5 as new information about the repositories.

**No correction to Phase 9.3 is required.** Its finding that the blocker is a two-layer permission
boundary rather than a lack of repository ownership is confirmed by measurement here, on both
repositories rather than one.

Phase 9.3 has not been rewritten, and neither has Phase 9.2.

## 14. Final production decision

# PHASE 9.4 — NOT PRODUCTION READY

## MUNAXA DOCS IS NOT PRODUCTION READY BECAUSE REQUIRED CI CHECKS ARE NOT ADMINISTRATIVELY ENFORCED.

**This is not a code failure.** The exact remaining blocker, naming the layer as required:

```
GitHub App:   missing `administration` capability on both repositories
              (403 "Resource not accessible by integration")
      AND
agent proxy:  administrative ruleset/protection writes prohibited
              (403 "Write access to this GitHub API path is not permitted through this proxy")
```

Both, not either. Confirmed on `munaxa-docs` and `munaxa-platform` independently.

The distinctions this phase exists to hold:

```
CI GREEN                        ≠   CI REQUIRED
BRANCH PROTECTION CONFIGURED    ≠   MERGE ENFORCEMENT PROVEN
REPOSITORY OWNER                ≠   CURRENT GITHUB APP CAPABILITY
GITHUB APP PERMISSION           ≠   PROXY WRITE CAPABILITY
DEPLOYED AND VERIFIED           ≠   MERGE GOVERNANCE ENFORCED
```

Twenty-three of twenty-five gates pass on measured evidence. The product has been deployed and run
rather than argued about; the defects that would have made its first release a failure were found by
running it and are fixed and guarded. What remains is that `main` on both repositories accepts a
direct push today, and every one of those twenty-three gates could be bypassed by a single commit
that faced no check at all.

```
CODE → TESTED → CI → DEPLOYED → HEALTHY → SMOKE TESTED → TENANT ISOLATED
     → AUDITED → ROLLED BACK → RESTORED → [ MERGE ENFORCEMENT ] → PRODUCTION READY
```

Everything left of the bracket is done and has been for two phases. The bracket is an administrator's
action on the GitHub App installation and the proxy — or ninety seconds in the GitHub settings UI as
the repository owner. It is not an engineering problem, and no further engineering phase should be
created to approach it.

**Run this phase again for verification once enforcement is configured. Until then the answer does
not change, and re-running it will not change it.**
