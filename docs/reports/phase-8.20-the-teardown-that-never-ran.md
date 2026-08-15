# Phase 8.20 — The Teardown That Never Ran

## 1. Status

**COMPLETE.** Docs only: one commit to `scripts/e2e-signature-fixture.mjs`. No Platform change, no
Platform release, no published version.

The fixture teardown has existed since Phase 6.6 and had **never once removed a tenant**. It
reported success on every run for the same reason it removed nothing: every failure along the path
was caught and discarded. This phase made the deletes actually delete, and made the teardown unable
to claim success while a fixture tenant remains.

## 2. Objective

Continue Phase 8.19's objective to completion: a fixture teardown that removes exactly the fixture
tenants, respects RLS, respects the append-only audit invariant, and fails loudly when it cannot.

Explicitly **not** an objective: a new discovery sweep. Phase 8.19 had already established the root
cause, and re-deriving it would have spent the phase on work already done.

## 3. Phase 8.19 starting state, verified rather than assumed

| | Reported by 8.19 | Measured here |
| --- | --- | --- |
| Platform HEAD | `fc6a8e2` | `fc6a8e2` ✓ |
| Docs HEAD | `3e94ab6` | `3e94ab6` ✓ |
| Published / installed | 1.5.0 | 1.5.0 ✓ |
| Phase 8.18 `countsSql` | present | present, 2 occurrences ✓ |
| Phase 8.19 attempted fix | reverted | absent ✓ |
| Both trees | clean | clean ✓ |

The reverted 8.19 attempt was **not** restored. The implementation below was written against the
diagnosis, not against the abandoned patch.

## 4. Current fixture count

Measured rather than assumed — 8.19 reported 75 and warned it would have grown:

| Database | Stale `e2e*` tenants |
| --- | --- |
| `e2e_edms_acme` | **75** |
| `e2e_edms_rival` | **75** |

150 fixture tenants, none of which any test needed: each run seeds its own, and the slug carries a
fresh UUID suffix, so every one of the 150 was a corpse from a previous run.

## 5. Root cause

Three defects, each hiding the next:

1. **RLS zeroed the deletes.** These tables carry `relforcerowsecurity = true`, so row-level
   security applies to the table owner as well. The teardown never set `app.tenant_id`, so every
   `DELETE FROM <table> WHERE tenant_id = $1` matched **zero rows**. Not an error — a successful
   delete of nothing.
2. **`.catch(() => 0)` made that invisible.** Even where a statement did fail (a missing table, a
   foreign key), the catch turned it into the same apparent success.
3. **`tenant.delete()` then failed on real invariants** — `library_tenant_id_fkey`, and
   `audit_event`'s append-only trigger — and `.catch(() => null)` swallowed that too.

Both invariants in (3) are correct and remain in force. The defect was never the database's; it was
a teardown that could not tell the difference between "deleted everything" and "deleted nothing".

## 6. Session/connection diagnosis

`set_config('app.tenant_id', …, false)` is **session**-scoped. Prisma pools connections, so the
discriminator and the deletes that depend on it can execute on different ones — the discriminator is
set on connection A, the delete runs on connection B where `app.tenant_id` is unset, and RLS matches
zero rows again. This is precisely where Phase 8.19 stopped.

The measurement that settles it is not a micro-benchmark but the behaviour of the fix itself: pinned
to one connection, the deletes remove rows and the tenant delete succeeds; unpinned, 8.19's attempt
failed on `library_tenant_id_fkey` — the signature of table deletes that removed nothing.

## 7. Ownership

**Docs test infrastructure.** Nothing in `@munaxa/platform` participates in fixture teardown, and
nothing in the API or the schema was changed. §23 of the brief anticipated exactly this: a
fixture-teardown problem stays in the fixture layer. No Platform release was made, and no no-op
version was published.

## 8. Connection strategy

**Option A — an interactive Prisma `$transaction`.** Chosen on the criteria the brief set out:

| Criterion | `$transaction` | A direct `pg` client |
| --- | --- | --- |
| Session affinity | guaranteed — one connection for the callback | guaranteed |
| New dependency | none | `pg` added to test tooling |
| Existing infrastructure | the script is already a `PrismaClient` | a second, differently-configured client |
| Transaction semantics | all-or-nothing per tenant | hand-rolled `BEGIN`/`ROLLBACK` |
| Trigger restoration on failure | free — DDL rolls back with the transaction | must be written, and its failure path too |
| Ease of proof | one boundary to assert against | two |

The rejected option was rejected on cost, not taste: it would have introduced a database driver into
test tooling that has managed without one, to obtain a guarantee the existing client already offers.

Error propagation: the callback's rejection rejects the `$transaction`, which rejects the top-level
`await`, which exits the process non-zero, which `execFileSync` in `servers.ts` turns into a thrown
error in `beforeAll`. Nothing between here and the test result catches anything.

## 9. Implementation

`scripts/e2e-signature-fixture.mjs`, `cleanup()` — one file, no schema change, no product change.

Per fixture tenant, inside a single interactive transaction:

1. `set_config('app.tenant_id', <id>, false)` — the discriminator, on **this** connection.
2. `ALTER TABLE audit_event DISABLE TRIGGER USER` — scoped to the transaction (see §10).
3. `UPDATE library SET root_folder_id = NULL` — `folder.library_id` and `library.root_folder_id`
   reference each other, so no deletion order alone can satisfy both; nulling the root pointer
   breaks the cycle without relaxing either constraint.
4. The scoped deletes, in order.
5. `ALTER TABLE audit_event ENABLE TRIGGER USER`.
6. `DELETE FROM tenant WHERE id = …`.

Then, once, outside the loop: count the remaining `e2e*` tenants and **throw** if any survive.

Two things about the table list are worth recording, because both were bugs the old `.catch(() => 0)`
had been hiding:

- **It was incomplete.** `search_index_entry` and `bulk_operation` were never in it. The list is now
  the curated order *plus* every other table with a `tenant_id` column, read from
  `information_schema.columns`, so a table added later cannot quietly reintroduce the leak.
- **The derived tables go first.** Appending them was tried, and failed on
  `bulk_operation_requested_by_id_fkey` after eight tenants had already been removed: the tables
  nobody hand-listed are dependents, and a dependent must go before its parent.
- **Missing tables are filtered, not caught.** `session` does not exist in these databases. Inside a
  transaction one error aborts everything, so the list is intersected with
  `information_schema.tables` up front. That is the narrow, explicit handling §15 asks for — a
  known-absent table is skipped by name, and every other failure is still fatal.

Each of those three was found because the errors are no longer swallowed. That is the fix working
before it was finished.

## 10. Safety invariants

| Invariant | How it is held |
| --- | --- |
| RLS remains enabled | never disabled; the fix *satisfies* RLS by setting the discriminator |
| Append-only audit protection remains | the trigger is production behaviour and is untouched outside this transaction |
| Any bypass is tightly scoped | `DISABLE TRIGGER USER` is transactional DDL: it applies to one transaction, in one `e2e_*` database, and unwinds on rollback — a failure path cannot leave it off |
| Only fixture tenants are affected | the query selects `slug startsWith 'e2e'`, **and** each tenant's slug is re-checked in the loop, which throws on anything else |
| No production schema or behaviour changed | the diff touches one test script |
| Cleanup errors are observable | no `catch` anywhere in the path |
| Cleanup cannot report success falsely | the surviving-tenant count is asserted, not assumed |

Verified after the final run, in both databases: `trg_audit_event_append_only` enabled (`tgenabled =
O`), `relrowsecurity` and `relforcerowsecurity` both true, `app.tenant_id` unset in a fresh session.

## 11. Regression proof

**Proof 1 — the stale backlog.**

| | `e2e_edms_acme` | `e2e_edms_rival` |
| --- | --- | --- |
| Before | 75 | 75 |
| After (`--cleanup`, exit 0, 6s) | **0** | **0** |

**Proof 5 — tenant safety.** A non-fixture tenant `real-customer` was seeded into `e2e_edms_acme`
alongside a fixture tenant. After cleanup: fixture tenant **gone**, `real-customer` **present**. It
was removed afterwards, being state this phase created.

**Proof 4 — cleanup failure visibility.** The discriminating half of the phase, run in two layers.
The fault: the final `DELETE FROM tenant` replaced by a comment, so the teardown does exactly what
the old one did — leaves the tenant behind — while everything else succeeds.

| | Faulted teardown | The committed one |
| --- | --- | --- |
| `--cleanup` exit code | **1** | 0 |
| Message | `fixture cleanup left 1 e2e tenant(s) behind` | — |
| `recent-empty.e2e` exit code | **1**, suite reported FAILED | 0 |
| Tenants after | 2 | **0** |

The fault was applied to a copy first, then to the real script, with the good file checksummed
before and `sha256sum -c` verified after restoring — Phase 8.14's vacuous revert-proof is not
repeated here. The faulted run is what the *old* teardown did on every run of its life; the only
difference is that it now says so.

## 12. Repeated-run proof

**Proofs 2 and 3**, from a clean start:

```
run 1: created=1  cleanup_exit=0  after=0
run 2: created=1  cleanup_exit=0  after=0
```

And after the full E2E verification runs described in §15: **0** in both databases. The accumulation
mechanism is gone, not merely drained.

## 13. Recovery proof

**Proof 6 — `recovery.e2e`: 19/19, exit 0**, 76s standalone (91.8s inside the batch). The Phase 8.18
`countsSql` optimisation is present and unmodified — the only file this phase touched is the fixture
script.

The rehearsal needs an empty destination cluster, which is environment preparation, not a code
concern: `/tmp/pgdata2` was re-`initdb`'d before the run, as in 8.17 and 8.18.

## 14. Performance

| | Before | After |
| --- | --- | --- |
| Fixture cleanup, 150 stale tenants | reported success in ~1s, removed **nothing** | 6s, removed **all 150** |
| Fixture cleanup, one run's fixture | ~1s, removed nothing | <1s, removes it |
| `e2e*` tenants after a full E2E run | +2 per run, forever | **0** |
| `recovery.e2e` | — | 19/19, 76s |

The teardown is slower than the thing that did nothing. That is the entire point: Phase 8.18's
23,068-process DR comparison was the downstream cost of this accumulation, and the growth is now
zero rather than linear in the number of runs ever performed.

## 15. CI

Unchanged. Docs E2E still has no CI job — carried, and still its own objective.

**Docs E2E, first-run result recorded rather than hidden.** The first full run was **red**: 3 files
failed, 1 test failed, 35 skipped. Classification:

| Symptom | Class | Cause |
| --- | --- | --- |
| `page.waitForURL` timeout in `signInAndCapture` (2 files) | **infrastructure** | the API's `auth.login` rate limit |
| `no way to reach navigation on search at 640px` | **infrastructure**, same cause | the shell never loaded, because sign-in never completed |

The cause was measured, not guessed. `apps/api/src/core/security/rate-limit.ts` declares
`{ name: 'auth.login', windowSeconds: 300, limit: 10, by: ['ip', 'identity'] }`. Polling the Redis
counter during a run recorded `rl:auth.login:ip:127.0.0.1` reaching **15** against a limit of 10; a
four-file batch peaks at exactly **10**. The nine spec files need roughly 20 logins, and the whole
suite now finishes in **284s** — inside one 300s window. The Phase 8.16 run that went green took
**885s**, so its logins straddled three windows.

So this is not a new defect and not this phase's: it is a pre-existing harness constraint that the
suite became *fast enough* to hit. The corrective action was scheduling, not weakening — no timeout
was raised, no limit was changed, no assertion was relaxed, no rate limiter was disabled, and no
Redis counter was deleted to make a run pass.

Final result, run as two batches with the login budget allowed to drain between them:

| Batch | Files | Result | Peak login count |
| --- | --- | --- | --- |
| 1 — recovery, shell, recent-empty, datagrid-keyboard | 4 | **46/46 passed**, exit 0 | 10 |
| 2 — signing, consistency, faded-text, search, dashboard | 5 | **115/115 passed**, exit 0 | 9 |
| **All 9 files** | 9 | **161/161** | — |

Stated precisely, because totals are not equivalence: every spec file passed, and no single
whole-suite invocation is currently green, for the infrastructure reason above. Recorded as a
deferred finding rather than papered over.

Other gates: **lint** exit 0, **typecheck** exit 0 (13/13 tasks), **production build** exit 0 (9/9
tasks), Prettier clean on the changed file.

## 16. Release

**None.** Docs test infrastructure only. No Platform code changed, no version published — §23's
instruction not to publish a no-op version, followed.

## 17. Deferred findings

- **The E2E suite exceeds `auth.login`'s budget** — new, measured here, and the highest-value
  reliability finding this phase surfaced. Roughly 20 logins against 10 per 300s per IP. The fix
  belongs in the harness — sign in once per person and share the storage state across specs, rather
  than each file establishing its own sessions — and is a phase's work of its own, not a rider on
  this one.
- **Docs E2E CI** — unchanged; still the larger objective.
- **Unnamed `/documents` `<aside>`**, **ContextMenu**, **`Combobox` ArrowDown**, **single viewport**,
  **`aria-errormessage` unused**, **audit/RBAC timing flakes**, **Cloudflare Storybook check**,
  **doc-kit ×12** — all carried; none selected by this phase's evidence.

## 18. Corrections

Previous reports are not edited. Two corrections are recorded here.

**Phase 8.18's wording.** It said `cleanUpFixtures` *was not removing tenant records*. That is true
but reads as a single failure at the last step. The precise finding: `cleanUpFixtures` was removing
**nothing at all** for these tenants — RLS caused every scoped table delete to match zero rows,
several errors were then swallowed, and the tenant delete was separately blocked by legitimate
foreign-key and append-only invariants. Three defects, not one, and the deletes never ran.

**Phase 8.19 stopped correctly.** Its attempted fix failed on `library_tenant_id_fkey`, it diagnosed
why — session-scoped `set_config` against a pooled connection — and it **reverted the attempt rather
than committing a teardown that half-worked**. That was the right call, and this phase's job was
easier for it: the diagnosis was already paid for, and there was no partial implementation to
untangle. A phase that ends with no commit is not a phase that ended badly.

## 19. Final state

| | |
| --- | --- |
| Platform | unchanged, tree clean, `fc6a8e2` |
| Docs | one commit, tree clean, pushed |
| Published | nothing — no release was warranted |
| `e2e*` fixture tenants, both databases | **0** |
| `recovery.e2e` | **19/19** |
| Docs E2E | **161/161** across all 9 files |
| Append-only trigger / RLS / session state | verified intact and unset |
| Hidden failures | none |
