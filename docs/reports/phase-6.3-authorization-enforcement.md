# Phase 6.3 — Authorization & Permission Enforcement Completeness

**Purpose:** resolve the Phase 6.2 P1 about `context.roles`, and finish the three permission
findings Phase 6.0 raised.
**Scope:** authorization enforcement boundaries. No change to the authorization model.
**Status:** point-in-time report. Not edited afterwards.
**Method:** the P1 was investigated empirically against real data rather than by reading names. Every
gate below executed in this container against real PostgreSQL 16 with two tenant databases and Redis.

## Final status: **COMPLETE**

The P1 is **proven harmless**, with tests rather than a paragraph. Two of the three permission
findings are closed; the third is confirmed reserved. A fourth phantom permission was found by the
check this phase added — and it turned out to be enforced.

---

## 1. Authorization Architecture Report

Two layers, and the distinction is real. Phase 6.0's brief warned against collapsing them; nothing
here does.

| Question | Layer | Where |
| --- | --- | --- |
| *"May this person do this kind of thing at all?"* | **RBAC** | `RbacGuard`, from `context.permissions` — the tenant-wide floor, declared by `@RequirePermission` |
| *"May this person do it to **this object**?"* | **ACL** | `AclGuard` → `PrismaAclResolver`, from ACL entries walked up the scope tree with deny precedence |

The full path:

```text
request
  → AuthenticationMiddleware        JWT claims  or  API-key principal
  → RequestContext                  { tenantId, userId, roles, permissions, … }
  → RbacGuard                       required ⊆ context.permissions          … the floor
  → AclGuard (@ScopedTo routes)     AuthorizationSubject → resolver          … the object
  → PrismaAclResolver.roleIdsOf     ── normalisation happens here ──
  → PrismaAclRepository.roleIdsFor  matches role.key OR role.id → canonical ids
  → grantedAmong + entries + breaks deny precedence, inheritance breaks
  → Decision { allowed, decidedAt, reason }
```

**Neither layer is sufficient alone, and that is the design.** A tenant-wide `document:edit` does not
say *which* documents; an ACL entry does not say whether the person may edit at all. The bulk
executor is the clearest statement of it: the controller checks the floor once, and the executor
resolves the object question N times.

---

## 2. Role/ACL Representation Report

Four things are called some variant of "role" and they are not the same:

| Name | What it is | Example |
| --- | --- | --- |
| **Role id** | `role.id`, a UUID, the primary key | `019489f0-…-0a1` |
| **Role key** | `role.key`, a stable string a tenant may not rename | `AUDITOR` |
| `context.roles` | **Role keys**, from `claims.roles` / `principal.roleKeys` | `['AUDITOR']` |
| `AuthorizationSubject.roleIds` | **Either** — see below | `['AUDITOR']` *or* `['019489f0-…']` |
| Permission key | `document:view`, from the catalogue | — |
| ACL subject id | A composed token: `user:…`, `role:…`, `department:…` | — |

**`AuthorizationSubject.roleIds` is misnamed and behaviourally correct.**
`PrismaAclRepository.roleIdsFor` partitions its input by UUID shape and queries
`OR: [{ key: { in: keys } }, { id: { in: ids } }]`, returning canonical identifiers either way. The
tolerance is deliberate and carries a comment saying so:

> *"A key is anything that is not one of these; the column they are compared against is `uuid`."*

Normalisation therefore happens at **one** boundary, and every caller above it may pass either
representation. The field name is the only thing wrong, and renaming it would touch six call sites
to change no behaviour — so this phase documented the contract at the port and proved it instead.

---

## 3. P1 `context.roles` Investigation

### 3.1 The finding, and why it was wrong

Phase 6.2 reported that `AuthenticationMiddleware` fills `context.roles` with role keys while every
ACL call site maps that array onto a field called `roleIds`, and filed it P1: *"either harmless or a
live authorization defect."* It cited the integration suite as having caught it.

**Both halves were wrong, and they were my own.**

**The suite did not catch it.** The failure that prompted the change reported `BLOCKED` — a *domain*
refusal — not `REFUSED`, which is the reach answer. Its actual cause was a metadata field the test
had invented, on a document type that does not define it. I changed the representation, saw the test
still fail, found the real cause, fixed that, and then wrote up the representation change as though
the suite had proven it necessary. It had proven nothing of the sort. The inference was never
checked against the evidence it claimed.

**And there is no mismatch.** §2 shows the resolver normalises both representations at a single
deliberate boundary.

### 3.2 The proof

Four tests in `acl.integration.spec.ts`, against real PostgreSQL. The suite's `READER_ROLE` is a UUID
and its key is the string `READER`, so the two representations are genuinely different values:

| Assertion | Result |
| --- | --- |
| A caller carrying the role **key** and one carrying the role **id** get **identical** decisions — not merely both allowed, but equal down to `decidedAt` and `reason` | ✅ |
| Both representations refuse a permission the role does not hold (`document:delete`) | ✅ |
| An unrecognised role name grants nothing — `CLOSED_BY_DEFAULT`, not everything | ✅ |
| A well-formed UUID naming another tenant's role grants nothing | ✅ |

The last two matter as much as the first: a tolerance that accepted anything would be a hole. It
resolves to *no role* rather than to *any role*, and the lookup is tenant-scoped.

### 3.3 Verdict

**A harmless representation difference with a misleading field name.** Not a localized bug, not a
broader defect. The synchronous path is correct and always was.

`BulkLaneConsumer` still passes identifiers — a preference, not a correctness requirement — and its
comment now says so. The Phase 6.2 report carries a correction block rather than an edit, because a
report that silently rewrites its own findings is one nobody can audit.

**Step 12 did not apply.** It prescribes fixing a real mismatch at one boundary rather than patching
consumers. There is no mismatch, and the one boundary already exists.

---

## 4. Permission Enforcement Matrix

All 39 catalogue entries, measured by counting non-seed references.

| Category | Count | Permissions |
| --- | --- | --- |
| **A — enforced and tested** | 31 | `document:view`, `download`, `create`, `edit`, `approve`, `reject`, `publish`, `restore`, `delete`, `history:view`, `sign`, `archive`, `library:view`, `library:manage`, `folder:manage`, `workflow:manage`, `delegation:manage`, `notification:manage`, `retention:manage`, `legal-hold:manage`, `audit:view`, `audit:export`, `search:all`, `report:view`, `user:manage`, `role:manage`, `org:manage`, `settings:manage`, `document:permission:manage`, `numbering:manage`, `integration:manage` |
| **B — enforced, thinly tested** | 7 | `document:print`, `submit`, `checkout`, `checkin`, `force-checkin`, `move`, `template:manage` — each declared on exactly one route with no negative test of its own |
| **C — intentionally reserved** | 1 | `report:manage` — §7 |
| **D — phantom** | **0** | Was 2 at the start of this phase (`library:view`, and `document:archive` before Phase 6.1) |
| **E — missing enforcement** | **0** | `library:view` was the last one; §6 |
| **F — duplicate / obsolete** | 0 | No two permissions name the same decision |

Only category E was changed. B is recorded rather than fixed: adding a negative test per permission
is a week of work with no defect behind it, and inventing one to close a category is how a matrix
stops meaning anything.

---

## 5. `document:archive` Verification (Phase 6.1, re-audited)

| Check | Result |
| --- | --- |
| Enforced server-side at the route | ✅ `POST /documents/{id}/archive` and `/reinstate`, `@RequirePermission(DOCUMENT_ARCHIVE)` |
| Object-scoped | ✅ `@ScopedTo('id', ScopeType.DOCUMENT)` — the ACL guard resolves the chain first |
| Enforced only in the UI? | ❌ No. The UI hides the button; the route refuses regardless |
| Service-level invocation | The service does not re-check the floor, by design — that is `RbacGuard`'s, and the same shape every document use case has. The **object** check is not skippable: the lifecycle table refuses an illegal transition whoever calls it |
| Lifecycle validation | ✅ Integration-tested: a draft cannot be archived, and the refusal writes nothing |
| Tenant isolation | ✅ Integration-tested: another tenant's document is a `404` |
| UI visibility | ✅ Six rendered assertions in `archive-affordance.spec.tsx` |

**Unchanged.** Phase 6.1 put it at the correct boundary.

---

## 6. `library:view` Assessment — **a real gap, now closed**

Phase 6.0 called it a phantom. It was not: the **capability existed and was gated on the wrong key**.

The only route that lists libraries — `GET /admin/libraries` — carried the controller's class-level
`library:manage`. The consequence is concrete rather than theoretical:

- `AUDITOR` is seeded with `library:view` and deliberately **without** `library:manage`; the role
  *"reads everything in scope and may never mutate anything, at any scope"*.
- So an auditor could not list a library at all.
- And `apps/web/src/app/(workspace)/documents/page.tsx:50` fetches this exact route to populate the
  document browser's library selector — so an auditor browsing documents was shown nothing to browse.

**The fix is two method-level declarations.** `GET /admin/libraries` and `GET /admin/libraries/:id`
now declare `library:view`, which overrides the class's `library:manage`
(`RbacGuard` reads `getAllAndOverride([handler, class])`). Every write keeps `library:manage`. No new
route, no new capability, no change to the model — the boundary the matrix always described.

**One consequence, stated rather than left to be found:** a tenant that has hand-built a role holding
`library:manage` *without* `library:view` loses list access. Every seeded role holding manage also
holds view, and §6's matrix grants view strictly more widely, so that combination is a
misconfiguration rather than a supported shape — but it is a change, and the guard requires *all*
declared permissions rather than any, so "either" cannot be expressed without altering the model.

Proven by six tests across two files — split because the seed is Identity's and the boundary lint
refuses a library spec that reaches into it. Each file names the other.

---

## 7. `report:manage` Assessment — **confirmed reserved, unchanged**

Phase 6.0's conclusion holds, and `report-definition.service.ts` states it in its own words:

> *"08 §6 gives `report:manage` to the tenant administrator and the document controller only, which
> is the shape of a permission for **shared** definitions … Nothing here shares one, so nothing here
> needs it. Binding it to personal definitions would be the wrong reading and would put an author's
> own saved filter behind a permission 08 §6 does not give them."*

Verified: every definition is scoped to its owner, `remove` answers `404` for somebody else's, and
there is no route that takes an owner. **No enforcement was added.** Adding some to consume the
permission is exactly what the brief forbids. It is now recorded in `UNROUTED_BY_DESIGN` with that
reason, so it is a decision on the record rather than an absence.

---

## 8. Route Authorization Audit

The boot-time `RoutePermissionRegistry` made two checks, and both hold:

1. Every mutating route declares a permission or an explicit public reason.
2. Every declared permission exists in the catalogue.

### The demonstrated blind spot

Both checks run **route → catalogue**. Neither can see the opposite direction — and that is precisely
where `document:archive` and `library:view` hid for eighteen phases: in the catalogue, in the matrix,
seeded to roles, declared by no route, with nothing failing. Phase 6.0 found them by counting
references by hand, which is not a check; it is somebody remembering to look.

Step 7 permits strengthening on a demonstrated blind spot. Two permissions is a demonstration.

**A third check now runs catalogue → routes**, with an `UNROUTED_BY_DESIGN` allowlist so that a
permission enforced somewhere other than a decorator is a *recorded decision* rather than an absence.
Adding an unenforced permission now costs a line and a sentence.

**It found a fourth phantom on its first run: `document:reject`** — and it turned out to be enforced,
which is the more interesting outcome. `POST /approval-tasks/{id}/decision` is gated on
`document:approve`; a *rejection* additionally needs `document:reject`, and whether a request is one
is a property of the **body**. `@RequirePermission` declares a route's fixed requirement and cannot
express "only when the decision is REJECTED", so the handler checks it and the engine resolves it
per object as well. That is a third legitimate reason to name no route, and it is now on the record.

**The check was proved rather than assumed.** Reverting the `library:view` fix makes the boot throw,
naming `library:view`. Restoring it makes it pass.

### What it still cannot see

Stated so nobody mistakes it for total coverage:

- **A route declaring a permission that is too weak for what it does.** No mechanical check can know
  that `GET /admin/libraries` should be `library:view` rather than `library:manage` — that is the
  judgement this phase made by hand, and it is how the gap arose in the first place.
- **Non-mutating routes with no permission.** Deliberate: many `GET`s are gated by an ACL predicate
  in the query rather than by a route permission.
- **Service methods called from another service.** RBAC is a request-boundary concern by design; the
  object question is answered per object, further in.

---

## 9. Tenant Isolation Report

| Path | Assertion | Where |
| --- | --- | --- |
| Role resolution | Another tenant's role id grants nothing | `acl.integration.spec.ts` — added this phase |
| ACL entries | `roleIdsFor` and every entry read are tenant-scoped | Pre-existing, `acl.integration.spec.ts` |
| HTTP | Cross-tenant object is a `404`, never a `403` | `08 §7`; pre-existing suites |
| Service call | `library.getLibrary` under another tenant refuses | `library-admin.integration.spec.ts` |
| Bulk execution | Another tenant cannot execute an operation; the sweep examines zero rows | Phase 6.2 |
| Direct ids / manipulated parameters | Every repository read carries `tenantId`; RLS is the backstop | `tenant-isolation.integration.spec.ts`, run against the second database |

The integration run for this phase included `SECOND_DATABASE_URL`, so the cross-database assertions
**ran** rather than skipping: 607 passed, 0 skipped.

---

## 10. UI Permission Report

| Permission | Server | UI affordance | Verified |
| --- | --- | --- | --- |
| `document:archive` | Route + `@ScopedTo` | Archive / Reinstate buttons, permission-gated | `archive-affordance.spec.tsx`, 6 tests |
| `library:view` | Route (this phase) | The document browser's library selector — the surface the gap broke | Server-side proven; the selector itself has no rendered test |
| `report:manage` | None (reserved) | **None** — and none was created | §7 |
| Other document actions | Routes | `canEdit` / `canMove` / `canDownload` / `canManagePermissions`, server-computed | Partly — `capabilities` still reaches only a handful of files (Phase 6.0 §4.2) |

**No UI was created for a capability that does not exist.** The `library:view` fix needed none: the
selector already existed and was being refused.

---

## 11. Negative Security Test Report

Refusal, not merely success. Added this phase:

| Case | Assertion |
| --- | --- |
| Wrong permission, both role representations | `document:delete` refused for a `READER` role, as key and as id |
| Unknown role name | Grants nothing — `CLOSED_BY_DEFAULT` |
| Another tenant's role id | Grants nothing |
| Auditor → library writes | Refused for all four mutating routes |
| Auditor → any `:manage` grant | The seed holds none, asserted as an invariant |
| Phantom permission | The boot refuses to start, proven by reverting the fix |

Pre-existing and re-run: deny precedence, inheritance breaks, `404`-not-`403`, cross-tenant refusal,
per-object bulk refusal.

---

## 12. Changed / Deleted Code Report

**Nothing was deleted. The authorization model is unchanged** — no new guard, no new port, no change
to `AuthorizationSubject`, `Decision`, `RbacGuard`, `AclGuard` or the resolver.

| File | Change |
| --- | --- |
| `library-admin.controller.ts` | Two method-level `@RequirePermission(LIBRARY_VIEW)` on the reads |
| `route-permission.registry.ts` | A third check (catalogue → routes) and its allowlist |
| `bulk-lane.consumer.ts` | **Comment only** — the Phase 6.2 justification corrected |
| `acl.integration.spec.ts` | +4 tests |
| `library-permissions.spec.ts`, `role-seed.spec.ts` | **New**, +6 tests |
| `docs/reports/phase-6.2-…md` | A correction block and a backlog row closed |

No migration. No contract change. No permission added or removed.

---

## 13. Validation Report

PostgreSQL 16 and Redis provisioned by the repository's own procedure against two tenant databases.

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | **Clean** |
| `pnpm format:check` | **Clean** |
| `pnpm lint` | **Clean** — 0 errors, 5 warnings (pre-existing, matching Phase 19) |
| `pnpm typecheck` | **Clean** — 13/13 |
| `pnpm test` | **Clean** — 636 API (+1 skipped), 164 domain, 82 web, 26 contracts, 11 utils, 4 i18n, 2 worker |
| `pnpm build` | **Clean** — 9/9 |
| `pnpm verify:styles` | **Clean** |
| `pnpm test:visual` | **Clean** — 28 browser tests |
| **`pnpm test:integration`** | **Clean** — **607 passed, 33 files, 0 skipped** |

**Not run:** the load harness (needs a staging deployment); the container image build (needs a
registry). No UI changed, so the visual suite is a regression check rather than a coverage claim.

---

## 14. Architecture Compliance Report

| Rule | Held |
| --- | --- |
| Do not rewrite authorization | ✅ No guard, port or resolver changed |
| Do not replace RBAC | ✅ |
| No second permission system | ✅ Nothing added; one route declaration moved to the narrower key |
| Do not change semantics to make tests pass | ✅ The one change follows §6's matrix, which predates it |
| Preserve the RBAC/ACL distinction | ✅ §1. Nothing collapsed |
| Do not invent a capability to consume a permission | ✅ `report:manage` left unused; `library:view` wired to a capability that already existed |
| Do not replace the boot assertion | ✅ Extended with a third check, both originals untouched |
| Strengthen only on a demonstrated blind spot | ✅ Two permissions had already slipped through it |
| Never bypass a lint rule | ✅ The cross-module spec import was split, not suppressed |

---

## 15. Remaining Phase 6 backlog

| # | Item | Status |
| --- | --- | --- |
| — | P1 `context.roles` | ✅ **Closed — proven harmless**, §3 |
| — | `library:view` phantom | ✅ **Closed — was a real gap**, §6 |
| — | `report:manage` | ✅ **Confirmed reserved**, §7 |
| — | `document:archive` | ✅ **Re-audited, unchanged**, §5 |
| **1** | **Rename `AuthorizationSubject.roleIds`** to say it accepts either representation. Six call sites, no behaviour change | **New. P3** — cosmetic, and the port now documents the contract |
| 2 | Category B: seven permissions enforced on one route with no negative test | **New. P3**, §4 |
| 3 | `capabilities` reaches 4 of 166 web files | **Open.** Phase 6.0 §4.2, P1 |
| 4 | Bulk import screen + progress UI | **Open.** Phase 6.2 §9 |
| 5 | Six admin screens for shipped APIs | **Open, P1** |
| 6 | Signature UI | **Open, P1** |
| 7 | Read-and-understood acknowledgement | **Open, P1** |
| 8 | Document linking + `LINKED` writer | **Open, P2** |
| 9 | End-to-end controlled-document journey test | **Open, P1** |
| 10 | Everything else in Phase 6.0 §28 | **Open** |

### What this phase deliberately did not do

**It did not rename `roleIds`.** The name is wrong and the behaviour is right; a six-site rename to
change nothing is churn dressed as rigour. Filed P3.

**It did not add negative tests for category B.** Seven permissions, a week, no defect behind it.
Recorded rather than closed, because a matrix that only ever shows green stops being read.

**It did not touch `report:manage`.**

**It did not widen anything.** The one enforcement change moves reads to a *narrower* key.
