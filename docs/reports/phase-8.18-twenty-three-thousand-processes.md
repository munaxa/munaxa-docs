# Phase 8.18 — Twenty-Three Thousand Processes

## 1. Status

**COMPLETE.** The DR rehearsal gate, red across Phases 8.15–8.17, is green: **19/19 in 149s**,
down from a failing 1 181s. No platform code changed and no version was published.

## 2. Objective

Find the next highest-value confirmed problem, fix it at the owning layer, prove it.

## 3. Starting state, verified rather than assumed

| | Reported by 8.17 | Measured here |
| --- | --- | --- |
| Platform HEAD / remote | `fc6a8e2` | `fc6a8e2` / `fc6a8e2` ✓ |
| Docs HEAD / remote | `40a3095` | `40a3095` / `40a3095` ✓ |
| Published / installed | 1.5.0 | 1.5.0 ✓ |
| `@munaxa/ui` façade | 3 lines, one platform copy | **re-verified** ✓ |
| 320px enforcement | 3 suites | **3** ✓ |
| Both trees | clean | clean ✓ |

## 4. Candidate findings

The only red thing in either repository was `recovery.e2e`. Everything else — component matrix,
overlays, RTL, routes, roles, reflow — was measured clean in 8.16/8.17 and re-confirmed here. So the
phase measured the one failure properly rather than assuming it.

| # | Finding | Class | Evidence | Selected |
| --- | --- | --- | --- | --- |
| 1 | DR rehearsal exceeds its own 600s timeout | **R2** | 18/19; 409s → 619s → >600s over three phases | **yes** |
| 2 | e2e fixture tenants accumulate in the source cluster | **R3** | **73** tenants, all `e2e…` | contributing cause, §9 |
| 3 | doc-kit `scrollable-region-focusable` ×12 | C | unshipped Storybook docs | no |
| 4 | Unnamed `<aside>` on `/documents` | B | carried | no |

## 5. Root cause — measured, not guessed

§14 asks where the time goes. It is not where it looked.

- The databases are **15 MB and 13 MB**. Data volume is not the cause.
- The dumps finish in seconds: 459 KB and 384 KB, written early.
- At **617s** the script was still running with **no `pg_dump`, `pg_restore` or `psql` child alive** —
  so the time was not in any single database operation.

It was in how many of them there are. `checkpointOf` gathered row counts like this:

```js
for (const tenant of tenants)      // 73
  for (const table of tables)      // 79
    askAsTenant(url, tenant.id, `SELECT count(*) FROM "${table}"`)
```

`askAsTenant` **spawns a `psql` process per call**. Across two databases and two sides (source
checkpoint and restored checkpoint):

> 79 tables × 73 tenants × 2 databases × 2 sides = **23 068 process spawns**

Nothing was slow. Something was repeated twenty-three thousand times.

That also explains the trend exactly. The cost is O(tables × tenants), and the tenant roll grows
every e2e run — all 73 rows are `e2e…` fixtures. Each accumulated tenant adds 79 more spawns, so the
runtime climbs monotonically: 409s → 619s → past its timeout.

## 6. Ownership

**R2 — the recovery tooling**, `scripts/dr-rehearsal.mjs`.

Finding 2 (fixture tenants accumulating) is a real contributing cause and is *not* the right place to
fix this. Cleaning fixtures would have made the symptom go away on this machine while leaving the
algorithm intact — and an operator rehearsing recovery on a real deployment with a few hundred
tenants would hit the same wall, harder. The rehearsal owns how it compares.

## 7. Implementation

One `UNION ALL` returns every table count for a tenant in a single round trip, under the same
`set_config('app.tenant_id', …)` the loop already used — same query semantics, same tenant
discriminator, same answers. Spawns fall from O(tables × tenants) to O(tenants): **23 068 → 292**.

## 8. Regression proof

| | Before | After |
| --- | --- | --- |
| Rehearsal script, same data, empty destination | still running at **617s** (killed) | **68s** |
| `recovery.e2e` suite | **1 181s, 18/19** — one test past its 600s timeout | **149s, 19/19** |
| `differences` reported | — | **0** |
| Tenants compared | — | `primary`, `secondary` |
| Artefacts | — | 2 |

The correctness assertions are unchanged and still pass: `differences: []`, both tenants restored,
every artefact with a digest and a table count above 50. The comparison still reads every table of
every tenant — it just stops opening a process to do it.

**No timeout was raised.** The 600s limit is untouched; the work now fits inside it with room.

## 9. Reliability

| | 8.15 | 8.16 | 8.17 | 8.18 |
| --- | --- | --- | --- | --- |
| Rehearsal suite | 409s ✓ | 619s ✓ | **1 181s ✗** | **149s ✓** |

Deterministic, reproducible, and now independent of the tenant roll.

Recorded honestly: the first `recovery.e2e` run after the fix **skipped** — Redis had died, so the
API could not start. Environment, not the change; restarted and re-run, 19/19.

## 10. Coverage, CI, Release

Coverage unchanged — no assertion was weakened or removed. CI unchanged. **No release**: no platform
code changed, and publishing a no-op version to look symmetrical was explicitly not done.

## 11. Deferred

- **Fixture tenants accumulate** (R3). Real, now harmless to the rehearsal, and worth its own look:
  73 stale tenants in the source cluster means `cleanUpFixtures` is not removing tenant rows.
- doc-kit `scrollable-region-focusable` ×12 (unshipped), unnamed `<aside>` on `/documents`,
  ContextMenu, Docs E2E CI, `Combobox` ArrowDown, single viewport, `aria-errormessage`, audit/rbac
  timing flakes, Cloudflare Storybook check — all carried, none selected by this evidence.

## 12. Corrections

None to previous reports. Phase 8.17's classification of the DR failure as "environment /
infrastructure" is worth revisiting rather than correcting: it was right that the failure was not a
product regression and right not to raise the timeout, and the deeper cause — an O(tables × tenants)
comparison — was only reachable by profiling the stages, which is what this phase did.

## 13. Final state

| | |
| --- | --- |
| Platform | unchanged, clean, no release |
| Docs | clean, pushed |
| DR rehearsal | **19/19, 149s** |
| Hidden failures | none |
