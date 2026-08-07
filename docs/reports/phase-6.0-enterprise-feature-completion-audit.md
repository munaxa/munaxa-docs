# Phase 6.0 — Enterprise Feature Completion Audit

**Purpose:** establish, by inspection rather than by assumption, what every module of Munaxa Docs
actually implements — and what it does not — so that Phase 6.1 onward has a roadmap instead of a
guess.
**Scope:** every application, package, module, migration, controller, consumer, screen and
architecture document in this repository, at commit `0821d5b` (Phase 5.2).
**Status:** point-in-time report. Audit only. **No source file was modified and no functionality
was redesigned, rebuilt or replaced.**

---

## 0. Method, and what this audit could and could not verify

| Verified by | What |
| --- | --- |
| Reading the source | 548 API files, 166 web files, 5 worker files, 98 package files, 23 migrations, 3 985 lines of Prisma schema |
| Enumerating | 276 HTTP routes across 34 controllers, 39 permissions, 13 queues, 13 scheduled jobs, 23 notification types, 110 spec files |
| Cross-referencing | 22 architecture documents, 20 ADRs, 27 phase reports, the permission matrix, the audit-action catalogue and the notification catalogue against the code that is supposed to implement them |
| Mechanical checks | Permission-enforcement reachability, i18n key parity, queue producer/consumer pairing, admin route ↔ screen pairing, `TODO`/`FIXME` census |

**Not verified:** `pnpm lint`, `typecheck`, `test`, `build`, `test:integration` and `test:visual`
were **not run** — this container has no `node_modules` and no PostgreSQL, and installing requires
the `read:packages` credential `.npmrc` deliberately does not commit. Every gate figure quoted below
is Phase 19's measurement, attributed as such and not re-measured. Nothing in this report depends on
a gate result; every finding comes from reading the code.

**Census results worth stating up front:**

- `TODO` / `FIXME` / `HACK` in application source: **zero**.
- i18n key parity, `en` ↔ `ar`: **1 383 / 1 383**, exact.
- Queue lanes with no producer or no consumer: **one** (`documents.bulk` — §22).
- Permissions declared, documented in the matrix, seeded to roles, and enforced by **nothing**:
  **three** (§4.1).

This is a disciplined, unusually well-documented codebase. The findings below are almost entirely
*unfinished* rather than *wrong*, and several were disclosed by the code's own comments before this
audit found them — which is the reason an audit of it is cheap.

---

## 1. Executive summary

**Munaxa Docs is a complete controlled-document platform on the API and database, with a UI that
covers roughly three-quarters of it, and four functional areas whose absence is structural rather
than cosmetic.**

The core journey works end to end: create → submit → route → approve → number → publish →
supersede → check-out → check-in → search → audit → retain → dispose. It is backed by a hash-chained
audit trail, an ACL resolver with deny precedence, a declarative workflow engine, a transactional
outbox, per-tenant databases and RLS, 33 integration suites against real PostgreSQL, and a
permission catalogue that the API asserts at boot.

Four things are genuinely missing rather than merely unpolished, and each is named in a section
below:

1. **The document lifecycle stops short of its own state machine.** `ARCHIVED`, `EXPIRED`,
   `SUPERSEDED` (at document level) and `REINSTATED` are states the table allows, the audit
   catalogue names, and *no code performs by user action*. Archival happens only as a side effect of
   a retention disposition; nothing watches `effective_to`, so a document with an expiry date never
   expires. (§5, §14)
2. **Bulk operations have no asynchronous path.** `bulk.synchronousLimit` is a tenant setting whose
   own documentation describes a `202`-and-poll flow, and **nothing reads it**. A bulk request may
   name 5 000 objects by default and all 5 000 run inside the HTTP request — the exact proxy-timeout
   failure the setting was written to prevent. `documents.bulk` is a lane with no producer and no
   consumer. (§22)
3. **Four API surfaces have no UI at all**, despite complete endpoints, contracts and tests:
   document templates, electronic signatures, legal holds, and search index rebuild. Two more —
   identity providers and the SIEM audit sink — have *server actions written and no screen calling
   them*, which is the repository's only dead code. (§9, §12, §16, §19)
4. **Sharing, watching, acknowledgement and document linking do not exist**, and the notification
   catalogue in `18-notification-architecture.md` §4 names three of them as recipients
   ("watchers", "subscribers of the folder or type", "everyone who acknowledged the previous
   revision"). Read-and-understood acknowledgement is the single largest missing business capability
   for a controlled-document product in a regulated setting. (§13, §17)

**Nothing in this repository should be rebuilt.** Every finding below is a completion, an
enforcement, a screen, or a consumer — attached to an existing seam that was designed for it.

**Overall completion: 78 %.** API and domain ≈ 88 %; database ≈ 95 %; web ≈ 68 %; operational
capability ≈ 70 %.

---

## 2. Status legend

| Symbol | Meaning |
| --- | --- |
| ✅ | Complete — implemented, tested, exposed, audited |
| 🟡 | Complete but needs refinement — works, with a named quality or coverage gap |
| 🟠 | Partially implemented — a real subset works; a named part of the same capability does not |
| 🔴 | Missing functionality — declared, designed or documented, and absent |
| ⚫ | Duplicate implementation — a second implementation of something that already exists |
| ⚪ | Dead code — present, reachable by nothing |
| 🔵 | Candidate for future Platform adoption |

---

## 3. Feature Completion Matrix — summary

| # | Module | Status | Production risk | Priority | Effort |
| --- | --- | --- | --- | --- | --- |
| 1 | Documents | 🟠 | High | P1 | 3–4 w |
| 2 | Folders & Libraries | 🟡 | Low | P3 | 1 w |
| 3 | Metadata | 🟡 | Low | P3 | 4 d |
| 4 | Versioning / Revisions | 🟡 | Medium | P2 | 1 w |
| 5 | Check-in / Check-out | 🟡 | Medium | P2 | 4 d |
| 6 | Approval workflows | 🟡 | Low | P3 | 1 w |
| 7 | Search | 🟠 | Medium | P2 | 1.5 w |
| 8 | OCR & Preview | 🟡 | Medium | P2 | 1 w |
| 9 | Sharing | 🔴 | Medium | P2 | 2–3 w |
| 10 | Permissions & ACL | 🟠 | **High** | **P0** | 3 d |
| 11 | Records management | 🔴 | **High** | **P1** | 3–4 w |
| 12 | Retention & Legal hold | 🟠 | Medium | P1 | 1.5 w |
| 13 | Notifications | 🟠 | Medium | P2 | 2 w |
| 14 | Dashboard | ✅ 🟡 | Low | P4 | 3 d |
| 15 | Reports | 🟠 | Low | P3 | 1 w |
| 16 | Administration | 🟠 | Medium | P1 | 2 w |
| 17 | Electronic signatures | 🟠 | **High** | **P1** | 1.5 w |
| 18 | Templates | 🟠 | Medium | P2 | 1 w |
| 19 | Identity, MFA & Federation | 🟠 | **High** | **P1** | 2 w |
| 20 | Audit & Compliance | 🟡 | Medium | P2 | 1.5 w |
| 21 | API surface | 🟡 | Medium | P2 | 1 w |
| 22 | Background workers | 🟠 | **High** | **P0** | 1.5 w |
| 23 | Integrations | 🟠 | Medium | P2 | 2 w |
| 24 | Mobile support | 🔴 | Medium | P3 | 2 w |
| 25 | Web test floor | 🟠 | **High** | **P1** | 2 w |

---

## 4. Cross-cutting findings

These cut across modules and are listed once rather than repeated in every row.

### 4.1 🔴 Three permissions are documented, seeded and enforced by nothing — **P0**

Mechanically established: for each of the 39 catalogue entries, count the non-seed, non-spec files
referencing it. Three score zero.

| Permission | Matrix (08 §6) | Seeded to | Enforced by |
| --- | --- | --- | --- |
| `document:archive` | Row present | Document controller, library manager | **Nothing.** There is no archive route (§5) |
| `library:view` | Row present, granted to 8 roles | 8 roles | **Nothing.** Library browsing is gated on `document:view` |
| `report:manage` | Row present | Tenant admin, document controller | **Nothing** — and this one is *deliberate and documented*: `report-definition.service.ts` states that `report:manage` is for **shared** definitions, which do not exist yet. It is owed, not broken |

`document:archive` and `library:view` are the two that matter: a permission granted in the UI's role
editor that gates nothing is a control an administrator believes they have applied. Either the
capability lands (archive — §5) or the row is withdrawn from the catalogue, the matrix and the seed
in one commit. `library:view` is the cleaner case: `library:view` was intended as "may see that this
library exists" distinct from "may read documents in it", and today those are one decision.

**Risk:** High — a phantom control. **Effort:** 3 days for `library:view` enforcement plus the
matrix correction; `document:archive` is folded into §5.

### 4.2 🟠 `capabilities` is read by 4 files out of 166 — **P1**

`development-recommendations.md` §4 makes it a standing rule: *"every mutating endpoint carries a
permission; every affordance reads `capabilities`."* `capabilities` appears in
`app/(workspace)/documents/page.tsx`, `features/documents/library-screen.tsx`,
`features/admin-shared/resource-list.tsx` and `lib/session.ts`. The other 162 files render
affordances from props or unconditionally. The API is the real gate, so this is not an
authorisation hole — it is a **UX and support-cost defect**: users are shown buttons that return
403. Phase 19 filed this as V-7 and it is unchanged.

### 4.3 🟡 The web test floor still cannot catch two defect classes — **P1**

Phase 5.2 raised web coverage from 21 tests to ~42 across 7 spec files: axe against 9 of 11 surfaces
populated *and* empty in both themes, keyboard traversal across 6 of 9 categories, a browser-mode
contrast and visual-regression project over 7 surfaces × 2 themes, and a `verify:styles` CI step
that is a direct regression test for Phase 19's V-1. That is a real improvement and it closes the
specific hole V-1 fell through.

Two gaps remain, and both are named in Phase 5.2's own roadmap:

- **No test asserts an affordance is hidden without its capability** (4.2's enforcement). Phase 5.1
  filed this as backlog item 4 and Phase 5.2 did not take it.
- **There is no end-to-end test of the controlled-document journey** —
  `development-recommendations.md` §5 names it as "the one journey the product exists for". The
  integration suite covers each leg (`workflow-engine`, `revision-control`, `document-library`) but
  nothing traverses create → submit → approve → number → publish → revise → supersede in one run.

Also open from Phase 5.2: `DocumentScreen` — 16 props including a full document, preview manifest,
workflow, revisions and audit — is the largest uncovered surface, and no human has used the product
with a screen reader.

### 4.4 🟡 Coverage asymmetry: 548 API files / 33 integration suites vs 166 web files / 7 specs

Per Phase 19's measurement: 614 API unit, 578 integration across 33 files, 164 domain, 26 contracts,
11 utils, 4 i18n, 2 worker — against ~42 web. The worker's 2 tests for the process that runs every
scheduled job in the product is the thinnest ratio in the repository, and §25 is what that costs.

### 4.5 🔵 Platform adoption — the V-8 triage is **done**, and this audit confirms it

**Correction to the framing a reader coming from Phase 19 would expect.** Phase 19's V-8 listed nine
hand-built equivalents and asked for a decision per row. **Phase 5.1 and 5.2 delivered that
decision**, and this audit verified it against the current source rather than accepting the report:

| Phase 19 V-8 row | Verified state at this commit |
| --- | --- |
| `Table` family | ✅ Adopted. `grep '<table'` over `apps/web/src` returns **zero**; `permissions-screen.tsx` and `reports-screen.tsx` import `THead`/`TBody` |
| `Timeline` / `TimelineItem` | ✅ Adopted. `audit-screen.tsx:16-17,197` |
| `SkipLink` | ✅ **Phase 19 was wrong.** It is used, via `AppShell`'s `skipLinkLabel` prop at `workspace-shell.tsx:164`; a symbol grep cannot see a prop. Corrected by Phase 5.1 and re-verified here |
| Raw `<select>`/`<input>` controls | ✅ Migrated to `Field`/`Input`/`Select`. The remaining `<input>` occurrences are hidden form-state fields and one documented native `<select>` |
| `FileManager` | 🔵 **Kept, with a written reason and the type signature the platform would need**: no column API, so a document number or confidentiality mark cannot be a column |
| `ApprovalFlow` | 🔵 **Kept, with a written reason**: `'all' \| 'any'` cannot express `QUORUM`/`PERCENT`, and there is no `CANCELLED` status — mapping it onto `skipped` would tell an auditor a control was evaluated and did not apply when it was never reached. That is a false statement in a compliance record, and refusing the migration on that ground is the correct call |
| `WorkflowCanvas`, `SearchBuilder`/`FilterBuilder`, `DatePicker` | 🔵 Kept, each with a named blocking field |

Adoption moved 54 → **62 of 180**. Nothing in §28 asks for any of this to be revisited.

**What remains open** is Phase 5.2's roadmap, not Phase 19's violations: two platform PRs
(`Badge` contrast, `FileManager` columns / `ApprovalFlow` quorum), `DocumentScreen` coverage,
interactive visual baselines, broader icon adoption, `Breadcrumb` on folder navigation, and the
AR/RTL per-string sweep. All are additive quality work; none is a defect.

Promotion candidates *out* of this repository (proposals only, per Phase 19 §8): the `admin-shared/`
harness as `@munaxa/admin-kit`; `@edms/utils`'s `pagination`, `text` (Arabic normalisation) and
`uuid`; the `TEXT_DIRECTION` locale mapping. Explicitly **not** candidates: ACL resolution, workflow
evaluation, numbering, retention arithmetic, the audit chain.

---

## 5. Documents — 🟠 Partially implemented

**Implemented:** create, read, list (keyset-paginated), edit, move, soft-delete, restore, favourite,
recent, duplicate detection by content digest, content download via signed URL, metadata values,
lifecycle state machine as a pure table with 13 states, frozen-content rule, `capabilities` on the
detail response, per-document activity timeline. 13 routes, all permission-gated. Two integration
suites.

**Missing business functionality**

| Gap | Evidence |
| --- | --- |
| 🔴 **No archive / reinstate.** `IMPLEMENTED_TRANSITIONS` offers `PUBLISHED → CHECKED_OUT` only; `ARCHIVED` is reachable *solely* through `RetentionDispositionAdapter.archive`, i.e. as a nightly sweep's side effect. There is no route, no service method and no audit writer | `domain/lifecycle.ts`; `infrastructure/retention-disposition.adapter.ts:172-190`; `13-audit-architecture.md:63` — "`ARCHIVED`, `REINSTATED`, `LINKED` … still owing after Phase 17" |
| 🔴 **Nothing expires a document.** `document_revision.effective_to` is captured at publication and read back in the revision panel. No scheduled job, no predicate and no notification acts on it. `DocumentStatus.EXPIRED` is unreachable | `SCHEDULE` in `packages/domain/src/queues.ts` has 13 entries and none is an expiry sweep; `06-document-lifecycle.md:189` — "nothing yet watches `effective_to`" |
| 🔴 **Document-level supersession is unreachable.** A revision supersedes a revision; the document stays `PUBLISHED`. The `SUPERSEDED` document state exists in the table and in the enum with no writer | `lifecycle.ts` `IMPLEMENTED_TRANSITIONS[PUBLISHED]` |
| 🔴 **No document linking / relationships.** No `document_link` table, no `LINKED` audit writer, no "supersedes / references / attachment-of" relation. `13-audit-architecture.md` reserves the action | Schema census; `13-audit-architecture.md:63` |
| 🔴 **No watchers / subscriptions.** The notification catalogue names "watchers" and "subscribers of the folder or type" as recipient classes for `DocumentPublished`. Neither concept exists in the schema or the code | `18-notification-architecture.md:82` |
| 🟠 **No bulk delete and no bulk move.** Bulk covers upload, metadata, approval, restore, export. In an EDMS, reorganising a subtree is the operation most needing a bulk path | `bulk-documents.controller.ts`; `BulkOperationKind` enum |

**Missing validations:** none found — metadata is validated against the type's field set, uploads
against `upload-policy`, transitions against the table, and optimistic concurrency is enforced by
version on every `PATCH`.

**Missing workflows:** archive, reinstate, expire, manual supersede.

**Missing permissions:** `document:archive` exists and gates nothing (§4.1). A `document:link`
permission would be needed by the linking capability.

**Missing audit events:** `ARCHIVED`, `REINSTATED`, `LINKED` — named in the catalogue, no writer.
This is the fourth consecutive phase report to carry the row.

**Missing notifications:** `ChangesRequested` (the catalogue names it beside Approved/Rejected;
`document.changes-requested` is not among the 23 implemented types), `RevisionPublished` to prior
acknowledgers, `LockExpiring`.

**Missing UI states:** archived-document view, expired-document banner, superseded badge on the
document header, linked-documents panel, watch/unwatch affordance.

**Missing tests:** the end-to-end controlled-document journey (§4.3); archive/expire have nothing to
test yet.

**Technical debt:** none of substance. The lifecycle table's own comment discloses the gap, which is
why this section could be written with confidence.

**Production risk:** High. A regulated customer will ask "how do I retire a document without
deleting it" in the first week, and the honest answer today is "wait for the retention sweep."

**Priority: P1. Effort: 3–4 weeks** (archive/reinstate 1 w; expiry sweep + notification 1 w; linking
1 w; bulk delete/move 3 d).

---

## 6. Folders & Libraries — 🟡 Complete but needs refinement

**Implemented:** libraries and folders as materialised-path trees (ADR-0014), CRUD, move with
subtree re-pathing, soft delete and restore, per-node ACL, inheritance break with chain truncation
(ADR-0016), owner scope, admin screens for both, a workspace folder tree, `acl-walk` and
`folder-tree` as pure tested domain functions, two integration suites including a dedicated ACL
suite.

**Missing:** `library:view` enforcement (§4.1). No folder-level subscription (§5). No drag-and-drop
move in the workspace tree — move is admin-screen only, so a librarian reorganising content works in
the admin area rather than the library they are looking at. No folder-level bulk permission
application UI (the API supports it; the screen applies one node at a time).

**Missing audit events:** none — `FOLDER_CHANGED` / `LIBRARY_CHANGED` are written.

**Missing UI states:** deep-tree virtualisation is claimed in `16-frontend-architecture.md` §"Folder
browser" and the tree renders eagerly; a 5 000-folder tenant is untested.

**Technical debt:** none. 🔵 `FileManager` is unused here **for a written reason** — it has no column
API, so a document number and a confidentiality mark cannot be columns (Phase 5.1 §4). The
unblocking work is a platform PR, not a change here.

**Production risk:** Low. **Priority: P3. Effort: 1 week.**

---

## 7. Metadata — 🟡 Complete but needs refinement

**Implemented:** metadata fields with 6 data types, per-type field binding with defaults and
required flags, category tree, confidentiality levels, document-type configuration, validation at
write, admin screens for all four (`fields`, `categories`, `document-types`, `confidentiality`),
`type-fields-editor` and `metadata-field-form` UIs, `TypeMetadataField` join with ordering.

**Missing:** no cascade/consequence analysis when a field is removed from a type that has values
(the API rejects; the screen does not warn first). No metadata-driven conditional visibility. No
per-field ACL (a field visible to authors but not readers) — not in the design either, so it is a
product question rather than a gap.

**Missing UI states:** bulk metadata edit exists in the API (`POST /documents/bulk/metadata`) and is
reachable from `bulk-panel.tsx`; the preview-of-effect before applying to 500 documents is absent.

**Production risk:** Low. **Priority: P3. Effort: 4 days.**

---

## 8. Versioning / Revisions — 🟡 Complete but needs refinement

**Implemented:** document/revision/file separation (ADR-0003), revision labels with configurable
style, publish with `effectiveFrom`/`effectiveTo`, supersession of the prior revision inside the
publishing transaction, restore-from-revision, text diff as a pure tested function, revision history
and compare UI, signed download per revision, `revision-control` integration suite (peak file:
publication, lock, restore, history, compare).

**Missing:** nothing acts on `effectiveTo` (§5). Binary/PDF visual compare is text-only — the
architecture says a missing artefact queues the comparison and the UI says so, which is honest, but
"compare two PDF renditions" is a capability regulated users expect. No revision-level retention
(retention is per document).

**Missing notifications:** `RevisionPublished` to acknowledgers of the previous revision — the
mechanism by which "read the current version" is enforced, per `18-notification-architecture.md:83`.
It has no recipients today because acknowledgement does not exist (§13).

**Production risk:** Medium — the expiry gap is what makes it medium.
**Priority: P2. Effort: 1 week.**

---

## 9. Check-in / Check-out — 🟡 Complete but needs refinement

**Implemented:** exclusive lock with `expiresAt` from `documents.checkoutExpiryHours`, check-out,
check-in with a new draft revision, cancel, **force check-in behind `document:force-checkin`**,
`CHECKED_OUT` in `FROZEN_STATUSES` so metadata cannot drift under a holder, lock surfaced on the
document response, revision panel UI, audit actions for all four transitions, integration coverage
("the check-out lock" describe block).

**Missing:** nothing sweeps expired locks — expiry is a read predicate (`expiresAt: { gt: now }`),
which is *correct* and matches the delegation design, but it means no `LockExpiring` notification
and no audit row when a lock lapses. `18-notification-architecture.md:84` names
`CheckedOutByOther` / `LockExpiring` as an in-app notification pair; `document.checked-out` exists,
`LockExpiring` does not.

**Missing UI states:** no "your check-out expires in N hours" indicator; no lock-holder contact
affordance for the person blocked by it.

**Production risk:** Medium — a stale lock is the classic EDMS support ticket, and today the only
remedy is an administrator with `document:force-checkin`.
**Priority: P2. Effort: 4 days.**

---

## 10. Approval workflows — 🟡 Complete but needs refinement

**Implemented:** declarative engine (ADR-0006) with versioned definitions and a version validator,
stages, conditions as pure evaluated data, parallel and sequential completion rules, approval
groups, working calendars with holidays, timers as delayed jobs (deadline, reminder, escalation) so
the engine needs no polling, auto-approval on non-controlling stages, withdrawal, delegation
resolution at task assignment, bulk approval, number allocation at approval (ADR-0004), the approval
inbox and decision dialog, admin screens for workflows, versions, a definition editor, approval
groups and calendars. Two integration suites plus `completion`, `conditions` and `version-validator`
unit suites.

**Missing:** `ChangesRequested` produces no notification type (§5). No workflow-instance
visualisation for a non-admin (the approval panel shows the current stage; the whole route is
admin-only). No ad-hoc reviewer addition to a running instance. No "reassign this task" from the
inbox (escalation is automatic; manual reassignment is `TASK_REASSIGNED` in the audit catalogue and
has no route).

**Missing audit events:** `TASK_REASSIGNED` — catalogued, no writer, because the capability is
absent.

**Missing UI states:** none of substance. 🔵 `ApprovalFlow` and `WorkflowCanvas` are unused **and the
decision is written down** (Phase 5.1 §5): `ApprovalFlow`'s `'all' | 'any'` cannot express
`QUORUM`/`PERCENT` and it has no `CANCELLED` status, and `WorkflowCanvas` needs persisted `{x, y}`
per node that a stage list does not have. Both are correct refusals; the unblocking work is a
platform PR.

**Production risk:** Low. This is the most complete module in the product.
**Priority: P3. Effort: 1 week.**

---

## 11. Search — 🟠 Partially implemented

**Implemented:** Postgres-first search (ADR-0008), a projection consumer on `search.index` with
coalescing, a query parser as a pure tested function, facets, saved searches (personal,
ownership-enforced), recent searches, an ACL predicate inside the query rather than
fetch-then-filter, `SEARCH_PERFORMED` audit when `search:all` bypasses the predicate, a rebuild
service with `search_rebuild` state, a shadow index table for zero-downtime rebuild, the search
screen with facets and saved-search management.

**Missing business functionality**

| Gap | Evidence |
| --- | --- |
| 🔴 **Saved-search sharing.** `05-database-design.md:186` and `12-search-architecture.md:105` both say "shareable by ACL". `12-search-architecture.md:162` explains the deferral — sharing waited for ACL entries to exist. **They exist now** (Phase 14), so the stated unblocking condition has been met and the capability has not been built | Two architecture documents against `saved-search.service.ts`, which is personal-only |
| 🔴 **Index rebuild has no UI.** `POST /search/rebuild` and `GET /search/rebuild` exist behind `settings:manage`. No admin screen calls them. An operator cannot rebuild an index without curl | `admin/sections.ts` has no row; no web action references `/search/rebuild` |
| 🔴 **No did-you-mean / fuzzy matching.** Deferred with a stated reason (`pg_trgm` is installer surface) | `12-search-architecture.md:161` |
| 🟠 **No result highlighting / snippets** in the response or the screen | `search.service.ts` |

**Missing audit events:** `SEARCH_REBUILD_REQUESTED` is catalogued; verify it is written when the
route fires (the route exists, the action is defined — the writer was not traced in this pass).

**Missing UI states:** rebuild progress, index-lag indicator, "your search hit the ACL predicate and
N results were withheld" (deliberately absent — it would leak existence — worth writing down).

**Missing tests:** the shadow-index swap under a concurrent write.

**Technical debt:** 🔵 `SearchBuilder` / `FilterBuilder` unused, with a written reason —
server-computed facet counts have no representation in the platform's `FilterField` (Phase 5.2 §8).
One arbitrary Tailwind value remains in this screen, justified in Phase 5.2's design-system
exceptions.

**Production risk:** Medium — the missing rebuild UI is an operational risk, not a functional one,
but it is the screen you need at 2 a.m.
**Priority: P2. Effort: 1.5 weeks.**

---

## 12. OCR & Preview — 🟡 Complete but needs refinement

**Implemented:** a renderer registry with PDF, image, Office (LibreOffice) and text renderers behind
ports; a preview consumer on `documents.preview`; OCR on its own slow lane with engine, version,
language and confidence recorded as derived artefacts that never modify the original; per-user
watermarking with confidentiality-driven marks; signed stream tokens; PDF/image/text viewers in the
web client; `NoOfficeConverter` as an explicit null adapter; quality heuristics (`ocr-quality`,
`text-quality`) as pure functions; a preview-pipeline integration suite.

**Missing:** the rasteriser (`sharp`), the Arabic watermark font (`@pdf-lib/fontkit`) and non-PNG
thumbnails are **blocked on a registry credential, not on design** — Phase 18 characterised it
precisely and it remains open. "Verification on every preview fetch" (17 §8's second clause) is
deliberately not done for a cost reason that is stated. No OCR language configuration per tenant
(languages come from process config, not settings). No re-OCR trigger from the UI.

**Missing UI states:** OCR-in-progress and OCR-failed are handled; OCR-quality-low is recorded and
not surfaced.

**Production risk:** Medium — an Arabic-locale deployment without the watermark font ships a
degraded compliance mark. **Priority: P2. Effort: 1 week** (mostly a `pnpm add` from a credentialed
environment plus wiring).

---

## 13. Sharing — 🔴 Missing functionality

**There is no sharing feature.** The only "share" in the product is
`17-security-architecture.md`'s signed-URL row — a short-TTL, single-object, method-bound,
issuance-audited download link, which is a *transfer* mechanism, not a sharing model.

Absent: internal share ("give this person access to this document" without editing the folder ACL),
external share links with expiry and optional password, share revocation, a "shared with me" view,
share audit events, and saved-search / report-definition sharing (§11, §15).

This is not an oversight in the code — it was never designed. `08-permission-model.md` models access
as roles + hierarchical ACL, and per-document grants are expressible (`document:permission:manage`
and the `documents/[id]/permissions` screen exist). So the *foundation* is there and what is missing
is the product surface on top of it: a share dialog, a share record with an expiry, and the audit
actions to go with it.

**Recommendation:** build sharing **on the existing ACL** — a share is an ACL entry with an
expiry and a provenance, not a second permission system. `12-search-architecture.md:163` already
states the principle: *"a sharing model invented before grants would be a second permission
system."* Grants now exist.

**Missing permissions:** a `document:share` decision distinct from `document:permission:manage`
(sharing is narrower than re-permissioning).

**Missing audit events:** `SHARED`, `SHARE_REVOKED`, `SHARE_LINK_ISSUED`, `SHARE_LINK_ACCESSED`.

**Missing notifications:** "X shared a document with you".

**Production risk:** Medium — customers will ask; nothing is broken without it.
**Priority: P2. Effort: 2–3 weeks.**

---

## 14. Permissions & ACL — 🟠 Partially implemented

**Implemented:** the permission catalogue as a single source with a boot-time assertion that every
mutating route declares one; RBAC with roles, role-permissions and user-roles; hierarchical ACL with
deny precedence (ADR-0005); inheritance break truncating the chain (ADR-0016); `:manage` and
`audit:*` permissions surviving a break (`INHERITANCE_PROOF_PERMISSIONS`); a decision cache
invalidated by prefix inside the transaction that changed the answer; `capabilitiesFor`; scope
chains; ACL subject resolution including departments and groups; the effective-permission screen at
`documents/[id]/permissions`; a dedicated ACL integration suite plus `acl-walk` and `acl-subjects`
unit suites; 404-not-403 for existence-leaking refusals.

This is the strongest subsystem in the product. Its one defect is §4.1's.

**Missing:** `library:view` and `document:archive` enforcement (§4.1). No permission-simulation
("what would this user see") beyond the per-document effective view. No bulk ACL application UI.
`ACCESS_DENIED` is in the audit catalogue — verify a writer exists before the next release; it was
not traced in this pass.

**Production risk: High**, entirely because of §4.1: a granted permission that gates nothing is
worse than an absent one.
**Priority: P0. Effort: 3 days.**

---

## 15. Records management — 🔴 Missing functionality

**Nothing in this repository implements records management as a discipline**, as distinct from
retention (§16), which is implemented well.

Absent, by census of the schema and the code:

| Capability | Status |
| --- | --- |
| Record declaration (a document becomes an immutable record) | 🔴 Absent. `FROZEN_STATUSES` freezes content by lifecycle state; there is no declaration act, no declarer, no declaration date |
| File plan / classification scheme (beyond the category tree) | 🔴 Absent |
| Vital-record marking | 🔴 Absent |
| **Read-and-understood acknowledgement** | 🔴 Absent — and named in the notification catalogue as an existing recipient class (`18-notification-architecture.md:82-83`) |
| Training / distribution records | 🔴 Absent |
| Controlled-copy register (who holds a printed copy) | 🔴 Absent, though `DOCUMENT_PRINTED` is audited and `document:print` is enforced — the audit trail is the raw material for it |
| Periodic review cycle ("this SOP is due for review in 24 months") | 🔴 Absent. `RetentionSchedule` schedules *disposition*, not *review of currency* |

**Acknowledgement is the highest-value single item in this report.** For an ISO 9001 / GxP / QMS
deployment — which the confidentiality model, the electronic-signature module (ADR-0017) and the
hash-chained trail all imply is the target — "prove every affected person read revision 4" is a
question the product cannot answer, and every other piece needed to answer it already exists: the
notification fan-out, the recipient resolver, the audit chain and the revision model.

**Missing permissions:** `record:declare`, `acknowledgement:manage` (or acknowledgement as an
attribute of `document:view`).

**Missing audit events:** `RECORD_DECLARED`, `ACKNOWLEDGED`, `REVIEW_DUE`, `REVIEW_COMPLETED`.

**Missing notifications:** `AcknowledgementRequired`, `AcknowledgementOverdue`, `ReviewDue`.

**Missing UI states:** an acknowledgement banner on the document, a "pending acknowledgements" inbox
tile, an acknowledgement-status report.

**Production risk: High** for the regulated segment; nil for a general document store.
**Priority: P1. Effort: 3–4 weeks** (acknowledgement 2 w; periodic review 1 w; record declaration
1 w).

---

## 16. Retention & Legal hold — 🟠 Partially implemented

**Implemented:** retention policies with trigger and disposition, schedules with state, a nightly
sweep on a single-consumer lane, disposition decision as a pure tested function, legal holds checked
twice (once in the decision, once inside the purge transaction), tombstones written before removal
from facts read before it, blob dereferencing and a reaper, the recycle bin with restore, soft
delete with `DOCUMENT_DELETION_RULES`, `retention.review-due` coalesced per tenant-day, the admin
retention-policy screen, the recycle-bin screen, a soft-delete-and-retention integration suite.
ADR-0010's "no purge button" is enforced by there being no route.

**Missing**

| Gap | Detail |
| --- | --- |
| 🔴 **Legal holds have no UI.** `POST/DELETE /documents/:documentId/holds` and `LEGAL_HOLD_MANAGE` exist. The web client's only reference to a hold is a *count tile* on the admin dashboard. Placing or releasing a hold requires curl | `dashboard-screen.tsx:313`; no `/holds` call anywhere in `apps/web` |
| 🔴 **Retention schedules have no operational view.** An administrator cannot see what is due, what is held, or what was disposed of last month, except through the reports module | No screen; `RetentionScheduleState` is API-only |
| 🟠 **Audit partitioning still not built.** Two trigger conditions set in Phase 10, neither fired (no deployment). Correctly deferred | `13-audit-architecture.md:353` |
| 🟠 **Quota accounting does not exist.** ADR-0012's, and Phase 21's. Recorded by five phase reports | Phase 18 §11 |

**Missing notifications:** `DispositionRequiresReview` is catalogued alongside `RetentionDue`;
`retention.review-due` is implemented and the disposition-approval variant is not.

**Production risk:** Medium — a legal hold that can only be placed by an engineer is a compliance
process failure waiting to happen.
**Priority: P1. Effort: 1.5 weeks** (legal-hold screen 4 d; retention operations screen 4 d).

---

## 17. Notifications — 🟠 Partially implemented

**Implemented:** 23 notification types with declared placeholders validated at save *and* send time;
in-app (authoritative), email via Resend and a hand-written SMTP adapter; digests hourly/daily/weekly
at the tenant's own morning; quiet hours; per-user preferences; suppression keyed by address with a
threshold, an audit row and a single alert; coalescing batches for storm control with two families;
recipient-visibility filtering; default templates in `en` and `ar`; the notifications screen and the
notification-template admin screen; a notification integration suite plus `digest`, `quiet-hours` and
`notification` unit suites. Five scheduled jobs drive it.

**Missing types** — measured against the catalogue in `18-notification-architecture.md` §4:

| Catalogued | Implemented |
| --- | --- |
| `ChangesRequested` | 🔴 No — `document.approved` / `document.rejected` exist; the third does not |
| `RevisionPublished` to prior acknowledgers | 🔴 No — depends on §15 |
| `LockExpiring` | 🔴 No (§9) |
| `DispositionRequiresReview` | 🔴 No (§16) |
| `ExportReady` | 🟠 Half — `audit.export-ready` is a real event and `reporting.export-ready` exists as an event with **no notification type**; the code says so itself at `notification-types.ts:83` |
| Webhook endpoint auto-disabled | 🔴 No — Phase 17's open row, "nobody is notified when a webhook endpoint disables itself" |

**Missing channels:** push (web/mobile) is explicitly future and correctly unbuilt.
`NotificationChannel.WEBHOOK` is an enum value nothing uses — ⚪ **dead enum value**, deliberately so
per ADR-0019 ("webhooks are not notifications"); it is documented, so leave it or drop it in the same
commit as the matrix correction.

**Missing:** inbound provider webhooks for delivery receipts (Phase 12's open row). Report delivery
as a notification with a signed link (Phase 15's open row) — the machinery exists and it is nobody's
phase.

**Production risk:** Medium. **Priority: P2. Effort: 2 weeks.**

---

## 18. Dashboard — ✅ / 🟡

**Implemented:** one route serving a per-role tile set; bounded queries independent of row count;
tiles that degrade individually (a tile that cannot be answered says *which* of two reasons applies —
a genuinely good piece of design); metrics adapters contributed by six modules; user and
administrator variants; the dashboard screen with the platform's charts; a dashboard integration
suite; a load-test scenario because it is the most-loaded route.

**Missing:** nothing functional. The legal-holds tile links nowhere because the screen it should
open does not exist (§16). No per-user tile configuration. No date-range control.

**Production risk:** Low. **Priority: P4. Effort: 3 days.**

---

## 19. Reports — 🟠 Partially implemented

**Implemented:** a report catalogue of ten reports as data with per-report permission conjunctions
resolved in the service against the ACL resolver; parameter parsing and validation as a pure tested
function; asynchronous export (`202` + poll) on its own lane; CSV/JSONL/PDF writers with a named
CSV-injection-neutralising profile stated in the manifest; personal saved definitions with
ownership enforced by absence; signed download that re-checks the report's full permission set; a
reporting integration suite.

**Missing:** shared report definitions — which is what `report:manage` is for, and the reason it
gates nothing today (§4.1); this is documented in the service and is owed rather than broken. Report
scheduling ("email me this monthly") does not exist. Report delivery as a notification with a signed
link is Phase 15's open row. No report builder — reports are a fixed catalogue, which is a deliberate
architectural constraint (a tenant that could author a query could pin a column), and correct.

**Missing UI states:** no scheduled-report management, no delivery history. (Phase 19's raw-`<table>`
finding for this screen is **closed** — it composes from the platform's `Table` family; verified.)

**Production risk:** Low. **Priority: P3. Effort: 1 week.**

---

## 20. Administration — 🟠 Partially implemented

**Implemented:** 22 admin screens across 6 sections composing through one `AdminScreen` harness that
supplies `Page`, `PageHeader` and `Stack` — which is why those files contain zero `className`s and is
the best-engineered part of the web client. Organization (companies, entities, branches,
departments), people (users, roles, permissions), control (numbering, retention, workflows, approval
groups, calendars), classification (confidentiality, fields, categories, document types), places
(libraries, folders), system (settings, notification templates, API clients, webhooks). Settings as a
typed catalogue with bounds, cached reads and a reset route. 44 + 13 admin routes.

**Missing screens for shipped APIs**

| API | Screen |
| --- | --- |
| `PUT/DELETE /admin/identity-provider` | 🔴 None — **and the server actions exist**, in `admin-integration/actions.ts:77-82`, called by nothing. ⚪ Dead code |
| `PUT/DELETE /admin/audit-sink` | 🔴 None — same, `actions.ts:87-92`. ⚪ Dead code |
| `document-templates` (7 routes) | 🔴 None (§21) |
| `documents/:id/holds` | 🔴 None (§16) |
| `POST/GET /search/rebuild` | 🔴 None (§11) |
| `GET /documents/bulk` (operation history) | 🟠 The bulk panel shows the result of the operation you just ran; there is no operations log screen |

This is the single most mechanical body of work in the report: six screens against a harness that
already drives 22 of them, and two of the six have their server actions written already.

**Missing UI states:** no import/export of tenant configuration; no configuration diff or change
history view (the audit trail has `SETTING_CHANGED` and nothing renders it as a configuration
timeline).

**Production risk:** Medium — a tenant cannot configure SSO or a SIEM sink through the product.
**Priority: P1. Effort: 2 weeks.**

---

## 21. Electronic signatures & Templates — 🟠 Partially implemented (API complete, UI absent)

### Signatures

**Implemented:** ADR-0017's witnessed-attestation model; `document:sign` deliberately distinct from
`document:approve` and **seeded to no role including the tenant administrator**, which is exactly
right and is the kind of decision that makes this codebase trustworthy; a closed `SignaturePurpose`
vocabulary; signature over an exact content digest; re-authentication via
`identity-signer.authenticator`; verification and withdrawal routes; `DOCUMENT_SIGNED` audited; four
routes; `signature` domain spec.

**Missing:** 🔴 **no UI whatsoever.** `grep -il signature` over `apps/web/src/features/documents`
returns files matching "sign" inside `window.location.assign` and nothing else. A Part 11 signature
capability that cannot be exercised from the product is a capability the product does not have.

Also missing: signature manifestation on the rendered preview (Part 11 §11.50 expects the signed
record to display the signer, date and meaning); multi-signatory sequencing.

**Production risk: High** for the regulated segment — the module is shipped and unusable.
**Priority: P1. Effort: 1.5 weeks.**

### Templates

**Implemented:** `DocumentTemplate` model, `TEMPLATE_MANAGE` with a well-argued rationale, 7 routes,
`DOCUMENT_TEMPLATE_CHANGED` audited, a template service and repository.

**Missing:** 🔴 **no UI** — no admin screen to author templates, and no "new document from template"
affordance in the library. The capability exists end to end in the API and is unreachable.

**Priority: P2. Effort: 1 week.**

---

## 22. Identity, MFA & Federation — 🟠 Partially implemented

**Implemented:** local accounts with scrypt hashing and a password policy; sessions as families with
refresh-token rotation and family-kill on replay; TOTP MFA with sealed secrets, recovery codes shown
exactly once, and a genuinely good enrolment screen; OIDC federation with discovery, one-way role
mapping, and a mapped-key-that-matches-nothing dropped rather than created; JIT provisioning; API
clients with key authentication and rate limiting; delegation with a predicate-based expiry and a
nightly recorder; machine identity as a delegated subject (ADR-0018); five integration suites.

**Missing**

| Gap | Detail |
| --- | --- |
| 🔴 **MFA role policy is unenforced.** `MFA_REQUIRED_ROLES` names three roles and **nothing reads it**. Declined by Phase 14, Phase 17 and Phase 18 for one reason: switching it on locks out exactly the accounts that administer a tenant, and the recovery path is ADR-0013's operator console, which nobody has built | `17-security-architecture.md:62-70` |
| 🔴 **No operator console.** ADR-0013's, and it is now the blocker on the MFA row, on tenant recovery and on break-glass access | Phase 17 §12, Phase 18 §13 |
| 🔴 **No identity-provider admin UI** (§20) — SSO is configurable only by API call |
| 🟠 **LDAP, SAML, WebAuthn** unbuilt — LDAP for a stated design reason (it is a wire protocol, not an HTTP redirect); SAML and WebAuthn blocked on the same registry credential as `sharp` |
| 🟠 **An API client cannot be scoped to a folder** — ADR-0018's refused alternative, so this is a decision rather than a gap; worth re-opening if a customer asks |

**Missing UI states:** no session list ("sign out my other devices") despite `SESSION_REVOKED` being
audited and session families being modelled. No user-facing security activity view.

**Production risk: High** — the MFA row means the product cannot enforce MFA on privileged accounts,
which is a control most enterprise procurement checklists name explicitly. It is correctly blocked
rather than ignored, and the unblocking work is the operator console.
**Priority: P1. Effort: 2 weeks** for the identity-provider screen, the session list and the
acknowledged design of the console; the console itself is its own phase.

---

## 23. Audit & Compliance — 🟡 Complete but needs refinement

**Implemented:** append-only hash-chained trail (ADR-0009) with a per-tenant advisory lock,
signed daily checkpoints, `DELETE` refused to every role at the database, nightly chain verification
as the highest-severity alert, evidence bundles streamed to storage with a manifest and a named
CSV-neutralising profile, audit export behind `audit:export`, a chain-verification service, buffered
read-audit writing, a SIEM sink by push (cursor-serial per tenant) and pull, the audit screen with
filters and a timeline, two integration suites.

**Missing:** `ARCHIVED`, `REINSTATED`, `LINKED` writers (§5) — the fourth report to carry the row.
`TASK_REASSIGNED` (§10). Partitioning, correctly deferred against unfired triggers. No audit-sink
admin UI (§20). No configuration-change timeline view.

**Missing UI states:** no configuration-change timeline; no chain-verification status surface (the
nightly verdict reaches administrators as a notification and has no screen). **Phase 19's V-4 and
V-8 findings for this screen are closed and verified:** `audit-screen.tsx` now imports and renders
the platform's `Timeline`/`TimelineItem`, and its filters use `Field`/`Select` rather than bare
native controls. `DatePicker` remains deliberately unused — it is controlled, and both forms here
are read through `FormData` on submit (Phase 5.2 §8).

**Production risk:** Medium — the trail itself is excellent; the gaps are in what is *not yet*
recorded because the capability does not exist.
**Priority: P2. Effort: 1.5 weeks.**

---

## 24. API surface — 🟡 Complete but needs refinement

**Implemented:** 276 routes across 34 controllers, all URI-versioned at `v1`; a boot-time
`RouteRegistry` assertion that every mutating route declares a permission or a stated reason for
being public; zod schemas shared from `@edms/contracts` with `whitelist` + `forbidNonWhitelisted`;
idempotency keys with replay; correlation IDs; a uniform collection interceptor; keyset pagination;
a uniform error shape; rate limiting; OpenAPI served at `/api/openapi.json` under a config flag,
with the explorer separated from the document — a decision worth keeping.

**Missing:** the OpenAPI document **describes routes, not body shapes** (Phase 17's open row) — a
zod-to-JSON-Schema projection over `@edms/contracts` closes it and is the highest-value item here,
because an integration platform whose schema is untyped is one every customer hand-writes against.
No SDK. No webhook-delivery replay route (Phase 17's open row). No API changelog or deprecation
mechanism beyond the versioning convention in `15-api-architecture.md` §308.

**Production risk:** Medium. **Priority: P2. Effort: 1 week.**

---

## 25. Background workers — 🟠 Partially implemented — **P0**

**Implemented:** 13 lanes separated by cost with per-lane concurrency, per-tenant concurrency caps on
three of them, retry policies, dead-letter queues, timeouts; 13 scheduled jobs each claimed under a
distributed lock; idempotent consumers throughout; the outbox dispatcher claiming rows
`FOR UPDATE SKIP LOCKED`; consumers for preview, OCR, search index, workflow timers, notifications,
retention, delegation, audit export, reporting export, webhooks and audit stream.

**The finding**

🔴 **`documents.bulk` is a lane with no producer and no consumer, and `bulk.synchronousLimit` is a
setting nothing reads.**

Mechanically established: `grep -rn "DOCUMENTS_BULK" apps` returns **zero** results outside the queue
catalogue itself; `grep -rn "synchronousLimit" apps/api/src` returns **two** results, both of them
prose in code comments.

The consequence is stated by the setting's own documentation
(`packages/domain/src/settings.ts:396-406`):

> *"Below the threshold the caller gets the per-object outcomes back and can act on them; above it
> they get a `202` and an operation to poll, because a request holding a connection open for four
> thousand transactions is a request that dies to a proxy timeout with half its work committed and
> no way to find out which half."*

That is the current behaviour of the product. `bulk.maxObjects` defaults to **5 000** and is the only
bound enforced (`bulk-executor.ts:205`). `BulkExecutor` writes `BulkOperationState.COMPLETED` and
nothing else — `REQUESTED`, `RUNNING` and `FAILED` are enum values with no writer, which is precisely
the shape of a table designed for an asynchronous path that was never wired.

Phase 16 shipped the seam, Phase 17 and Phase 18 each recorded it as open and untouched. It is now
the highest-severity incomplete item in the product, because the failure mode is a partially
committed bulk operation with no record of which half committed — in a system whose entire value
proposition is a complete audit trail.

**Also missing:** no document-expiry sweep (§5); worker test coverage is 2 tests for the process
running 13 scheduled jobs; no dead-letter inspection or requeue surface for an operator.

**Missing UI states:** no bulk-operations log screen (§20); no queue-health view.

**Production risk: High.** **Priority: P0. Effort: 1.5 weeks** (wire the consumer to the existing
executor, honour `synchronousLimit`, return `202` above it, write `REQUESTED`/`RUNNING`/`FAILED`,
add the operations screen).

---

## 26. Integrations — 🟠 Partially implemented

**Implemented:** API clients with scoped keys and rate limits; outbound webhooks with per-endpoint
event subscriptions, HMAC signing, a delivery record carrying its own attempt count and
`nextAttemptAt` (deliberately *not* BullMQ's retry, for three stated reasons, all correct), a
retry sweep, dead-lettering, a delivery list route, admin screens for API clients and webhooks; the
SIEM audit sink by push and pull with a strictly serial per-tenant cursor; OIDC federation;
`13-audit-architecture.md`'s six integration audit actions, all written.

**Missing**

| Gap | Source |
| --- | --- |
| 🔴 No identity-provider or audit-sink UI, with the server actions already written (§20) | This audit |
| 🔴 Nobody is notified when a webhook endpoint disables itself | Phase 17, open |
| 🔴 A dead delivery cannot be replayed from the screen | Phase 17, open |
| 🔴 Import mapping (CSV/legacy migration) — untouched | Phase 17, open |
| 🔴 Microsoft 365 / SharePoint content integration — correctly identified as a *content* integration rather than authentication, and unbuilt | `federation.ports.ts:22-24` |
| 🟠 No inbound webhooks of any kind (including mail delivery receipts) | Phase 12, open |

**Production risk:** Medium — an EDMS with no import path is an EDMS no existing customer can move
onto. Import mapping is the commercially significant row here.
**Priority: P2. Effort: 2 weeks** for the screens, the replay and the disable notification; import
mapping is its own phase.

---

## 27. Mobile support — 🔴 Missing functionality

Responsive utilities (`sm:` / `md:` / `lg:`) appear across 10+ feature files and the platform's
`AppShell`/`NavigationDrawer` supply a mobile shell, so the product is **not** desktop-only. But:

- No PWA manifest, no service worker, no installability.
- No offline capability of any kind — for a field-inspection or shop-floor EDMS use case, this is
  the whole requirement.
- No mobile-specific capture (camera-to-document upload).
- No push channel — explicitly future in `18-notification-architecture.md:42`, and the port and
  message model already accommodate it.
- No responsive verification in the test suite: the visual project runs in a browser and its
  viewport coverage was not established in this pass.
- No native application, and none is implied by the architecture.

**Recommendation:** decide explicitly whether "mobile support" means *responsive web* (largely done,
needs verification and a viewport matrix in the visual suite) or *an offline-capable mobile
experience* (a phase of its own). Do not build the second by accident.

**Production risk:** Medium — depends entirely on which of the two the business means.
**Priority: P3. Effort: 2 weeks** for responsive verification + PWA shell + push channel; a native or
offline experience is a separate phase.

---

## 28. Prioritised roadmap for Phase 6.1 onward

Ordered by risk-adjusted value, not by module number. Every item completes an existing
implementation; **none is a rebuild.**

### P0 — before the next release (≈ 2 weeks)

| # | Item | Module | Effort |
| --- | --- | --- | --- |
| 1 | Wire the bulk consumer, honour `bulk.synchronousLimit`, return `202` above it, write the three unwritten `BulkOperationState` values | §25 | 1.5 w |
| 2 | Enforce `library:view`, and either implement `document:archive` (item 4) or withdraw the row from catalogue + matrix + seed in one commit | §14, §4.1 | 3 d |

### P1 — the next quarter (≈ 10 weeks)

| # | Item | Module | Effort |
| --- | --- | --- | --- |
| 3 | Six admin screens against the existing harness: identity provider, audit sink (server actions already written), document templates, legal holds, search rebuild, bulk-operations log | §20 | 2 w |
| 4 | Archive / reinstate as user actions, with `ARCHIVED` and `REINSTATED` audit writers | §5, §23 | 1 w |
| 5 | Document expiry: a scheduled sweep on `effective_to`, the `EXPIRED` transition, and a `document.expiring` notification | §5, §17 | 1 w |
| 6 | Signature UI: sign, verify, withdraw, and manifestation on the rendition | §21 | 1.5 w |
| 7 | Read-and-understood acknowledgement, end to end | §15 | 2 w |
| 8 | Web test floor: one capability-affordance assertion per screen family, and the end-to-end controlled-document journey | §4.2, §4.3 | 2 w |

### P2 — the quarter after (≈ 12 weeks)

| # | Item | Module | Effort |
| --- | --- | --- | --- |
| 9 | Sharing, built as expiring ACL entries — never as a second permission system | §13 | 2–3 w |
| 10 | The five missing notification types + report delivery + webhook-disabled alert | §17 | 2 w |
| 11 | OpenAPI body schemas from `@edms/contracts`; webhook delivery replay | §24, §26 | 1 w |
| 12 | Saved-search sharing and shared report definitions (both unblocked since Phase 14) | §11, §19 | 1 w |
| 13 | Templates UI + "new document from template" | §21 | 1 w |
| 14 | Lock-expiry notification and holder-contact affordance; bulk delete and bulk move | §9, §5 | 1 w |
| 15 | Preview/OCR dependency unblock (registry credential): `sharp`, `@pdf-lib/fontkit`, non-PNG thumbnails | §12 | 1 w |
| 16 | Document linking with the `LINKED` audit writer | §5 | 1 w |
| 17 | Phase 5.2's UI quality roadmap: `DocumentScreen` a11y + visual coverage, interactive visual baselines, visible-focus assertion, `Breadcrumb` on folder navigation, the AR/RTL per-string sweep, and the two platform PRs (`Badge` contrast; `FileManager` columns / `ApprovalFlow` quorum) | §4.5 | 1 w + 2 platform PRs |

### P3 — after that

Periodic review cycles; record declaration; import mapping; mobile decision and PWA shell; session
list; configuration change timeline; folder-tree virtualisation; the operator console (which unblocks
MFA enforcement and is its own phase); audit partitioning when a trigger fires; quota accounting
(Phase 21).

---

## 29. Rules observed by this audit

| Rule | How it was observed |
| --- | --- |
| Never recommend rebuilding | No item in §28 replaces working code. Every one attaches to an existing seam, table, port or harness |
| Never recommend redesigning | Where a design decision looked like a gap — `report:manage`, the ACL-first sharing model, the absent purge button, per-lane retry for webhooks, the fixed report catalogue, MFA deferral — the code or an ADR was read until the reason was found, and the reason was recorded rather than overruled |
| Never duplicate functionality | Sharing is specified as ACL entries with expiry, explicitly because a parallel grant system is what `12-search-architecture.md:163` warns against. Bulk async reuses `DefaultBulkExecutor` over the same per-object function |
| Prefer completing existing implementations | 24 of the 27 roadmap items are a screen, a consumer, a writer or an enforcement against something already built |
| Platform adoption only where it removes duplication without changing behaviour | §4.5 recommends **no new adoption**. Phase 5.1/5.2 already adopted what removes duplication without changing behaviour, and each of the six components it kept has a written blocking field. This audit verified those against the source rather than repeating Phase 19's open list, and one of Phase 19's findings (`SkipLink`) turned out to have been wrong |

---

## 30. What this phase did not do

**It changed no source file.** The deliverable is this report.

**It did not run the gates.** No `node_modules`, no PostgreSQL, no `read:packages` credential. Every
gate figure is Phase 19's, attributed. No finding here depends on one.

**It did not re-audit platform compliance from scratch.** Phase 19 measured it and Phase 5.1/5.2
acted on it. What this audit did do is **re-verify Phase 19's nine open V-8 rows against the current
source**, because a roadmap built on a superseded violation list would send Phase 6.1 to rewrite
screens that are already correct. Seven of the nine are closed; §4.5 records the verification and the
one Phase 19 finding that was wrong.

**It did not trace every audit writer to its call site.** Three actions —`ACCESS_DENIED`,
`SEARCH_REBUILD_REQUESTED`, `ROUTING_CHANGED` — are defined in module catalogues and their writers
were not individually verified. They are flagged in §11 and §14 as "verify", not asserted as missing.

**It did not decide what "mobile support" means.** §27 states the two readings and refuses to pick
one; that is a product decision, and building the wrong one is a phase wasted.

**It did not open a pull request**, per the brief.
