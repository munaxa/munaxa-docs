# Phase 6.5 — Enterprise API Surface & Missing UI Completion

**Status: PARTIALLY COMPLETE**

All six named surfaces were re-audited against the current code. Four are genuine, verified gaps;
one is genuine but larger and security-critical; one needed a placement decision rather than a
screen. **Two were implemented in full.** The rest are specified, sized and backlogged rather than
half-built — and the honest status word is `PARTIALLY COMPLETE`, not `COMPLETE`, because verified
gaps remain open and calling the audit finished is not the same as finishing the phase.

Two documents the brief names do not exist in this repository:
`docs/architecture/munaxa-architecture-reference-manual.md` and
`docs/architecture/future-product-migration-guide.md`. The audit used the twenty-two numbered
architecture documents, the twenty ADRs and the Phase 6.0–6.4 reports instead.

---

## 1. Backend Surface Inventory

34 controllers, traced route → controller → service → domain → authorization → persistence →
**actual caller**. Classification is from call sites; `grep` for the route path across `apps/web`
was run for every candidate.

| Class | Count | Notable members |
| --- | --- | --- |
| **A — backend + UI complete** | 26 | documents, revisions, approvals, bulk approvals, bulk documents, audit, dashboard, delegations, library admin, permissions, notifications ×2, organization, reporting, search (query half), uploads, workflow admin, approval routing, administration, identity admin, api clients, mfa, auth, preview stream, document preview, recycle bin |
| **B — deliberate non-UI consumer** | 3 | `audit/stream` (a collector's cursor, `audit:export`), `auth/federation` ×2 (the sign-in screen and the provider callback), `local-transfer` (the storage driver's own I/O) |
| **C — backend exists, intended UI missing** | 5 | **document templates**, **legal holds**, **search rebuild**, **identity provider admin**, **audit sink** |
| **D — internal/operational, no UI wanted** | 2 | `health`, `metrics` — scraped, not read by a person |
| **E — dead/unreachable** | 0 | — |
| **F — reserved/future** | 1 | document **signatures** — reachable, complete, and no surface (see §5) |
| **G — missing backend** | 0 | Nothing in this phase needed a capability the API lacks |

## 2. UI Surface Inventory

39 routes: 2 auth, 11 workspace, 26 under `/admin`. Navigation is generated from two registries —
`lib/navigation.ts` for the workspace and `lib/admin/sections.ts` for Administration — and both are
permission-filtered, so a destination and its page guard cannot silently disagree if they are
entered in the same table. Every admin screen is built from `features/admin-shared`: `AdminScreen`,
`ResourceList`, `FormDialog` and a typed field set. Nothing in this phase needed a new primitive.

## 3. API → UI Mapping Matrix

Only the rows that were not already A. Everything else is in §1.

| Capability | API | Permission | UI | Navigation | Status |
| --- | --- | --- | --- | --- | --- |
| Document templates | `GET/POST/PATCH/DELETE /document-templates`, `POST /:id/restore` | `template:manage` | **`/admin/templates`** | **Configuration** | ✅ **Implemented** |
| Create from template | `POST /document-templates/:id/documents` | `document:create` | none | — | 🟠 Backlog — belongs on the library, not the admin screen |
| Search rebuild | `POST/GET /search/rebuild` | `settings:manage` | **`/admin/settings`** | existing | ✅ **Implemented** |
| Legal holds | `GET/POST /documents/:id/holds`, `POST /:holdId/release` | `legal-hold:manage` | none | — | 🟠 Verified gap, not implemented |
| Identity provider | `GET/PUT/DELETE /admin/identity-provider` | `integration:manage` | none | — | 🟠 Verified gap, not implemented |
| Audit sink (SIEM) | `GET/PUT/DELETE /admin/audit-sink` | `integration:manage` | none | — | 🟠 Verified gap, not implemented |
| Signatures | `GET/POST /documents/:id/signatures`, verification, withdrawal | `document:sign`, `document:view` | none | — | 🟠 Verified gap, not implemented |

## 4. Templates Assessment — **REAL, and implemented**

Every question the brief asks answers yes:

- **Domain model?** `DocumentTemplate` in `schema.prisma`, 20 columns, soft delete, `version`.
- **CRUD?** Five routes, a 373-line service, optimistic concurrency via `If-Match`.
- **Referenced by a workflow?** Yes — `POST /:id/documents` produces a real document through the
  ordinary create path, so numbering, confidentiality floor and metadata validation all still run.
- **Permissions?** `template:manage` for authoring, `document:create` for using. Deliberately split.
- **Navigation or route?** **None.** `grep -rn "document-templates" apps/web` returned nothing.
- **A business workflow requiring administration?** Yes — a template fixes the type, the
  classification and the default folder a controlled document starts from.

So an entire domain was unreachable from the product. `/admin/templates` now exposes it, in
Configuration, after document types, in the section's existing dependency order. The screen is
declarative over `admin-shared` and adds no component.

**Three things deliberately left out**, each because including them would have invented something:

- **Attaching a template body.** `fileObjectId`/`filename` are real, and setting one needs the
  upload pipeline's scan gate and presign. A second upload path inside an admin dialog is the
  parallel implementation §5 forbids. The columns are *shown* so an administrator can see whether a
  template carries a body.
- **`defaultMetadata`.** A JSON map validated against the selected type's fields. Editing it means
  rendering those field definitions, which is `metadata-field-form.tsx`'s job. It is preserved
  untouched: `changedFields` omits what the form does not name.
- **Create-from-template.** Gated on `document:create`, not `template:manage`. Putting that button
  on this screen would put it behind the wrong permission and in front of the wrong person.

## 5. Signatures Assessment — **REAL, complete, not implemented**

ADR-0017 is unusually precise and the implementation matches it: `document_signature` rows,
`serialiseSignatureStatement` in `@edms/domain`, `statement_body` stored verbatim, an HMAC witness
under a named `key_id`, `DOCUMENT_SIGNED` in the trail, withdrawal as its own columns, and
verification answering **three** booleans rather than one. Four routes, all `@ScopedTo` the
document. `document:sign` is seeded to no role, including the tenant administrator — deliberately.

**Nothing is missing from the domain.** This is not blocked by an incomplete contract.

It is not implemented here because of what the UI has to be, not what the backend is. ADR-0017 §6
requires re-authentication by default — the password again, plus TOTP where the signer has a
confirmed authenticator — and whether a given signature required it is recorded *on that signature*.
A signing surface is therefore a credential-collecting flow inside a document screen, and it is the
manifestation of a 21 CFR Part 11 control: getting the ceremony wrong (pre-filling, remembering,
signing the wrong revision, showing "signed" before the server witnessed it) weakens the control
while looking finished. That deserves its own phase with its own threat model, not the tail of a
six-surface phase. **Backlogged as P1, ~1 week.**

## 6. Legal Holds Assessment — **REAL, not implemented**

Implemented: `documents/:documentId/holds` with list, place and release, class-gated on
`legal-hold:manage`; persistence; and consumption — a held document refuses deletion and its
retention schedule does not run. `retention.hold-placed` / `hold-released` are real events with real
notification types and a working consumer (verified in Phase 6.4).

**The visible defect**: the administrator dashboard already renders a `legalHolds` count tile
linking to `/admin/retention` — and that screen administers retention *policies*. There is nowhere
to see which documents are held, and nowhere to place or release one. A number with no destination.

Not implemented because the API is per-document, so the honest surface is a panel on the document
detail page — an existing, complex screen — plus a way to reach the set from the dashboard tile.
That is two surfaces, not one. **Backlogged as P1, ~3 days.** No business rules would need
inventing; the lifecycle is complete.

## 7. Search Rebuild Assessment — **operator action, implemented in the right place**

The brief asks which of four things it is. Answer, from the code: an **operator action** that is
**already asynchronous**. `POST /search/rebuild` answers `202`, the work runs on the search lane and
is resumable; `GET /search/rebuild` reports state, count and error. Both declare `settings:manage`.

So it is exposed as a section on `/admin/settings` — the screen that already requires exactly that
permission — and **not** as a menu destination. §12 says an operator capability with an appropriate
existing surface belongs there, and that building an operations console for one button is what not
to do. No new permission, no new destination, no new guard.

Three details worth stating: the status is read with `adminRead` rather than `adminGet`, because a
tenant that has never rebuilt gets a `404` and that is an answer rather than a broken page; the
failure reason is displayed rather than swallowed, since a silently failed rebuild leaves an index
serving stale results; and the button is **not** disabled while a rebuild runs, because the API
decides admissibility and a client that guessed would block a legitimate re-run after a failure.

## 8. Identity Provider Assessment — **REAL, not implemented**

Not scaffolding. `IdentityProviderAdminService`, a persisted configuration row, and a concrete
contract: `kind`, `issuer`, `discoveryUrl`, `clientId`, `domains`, `claimMapping`, `roleMappings`,
`defaultRoleKeys`, `jitProvisioning`, `enabled`. `PUT` rather than `POST` because there is at most
one per tenant. Behind `integration:manage`. The public half — discovery and callback — is wired
and reachable.

**Secret handling is already correct and needs no UI decision**: `clientSecret` is absent from the
wire type entirely, which the code notes is the enforcement — "there is no field a mapper could
forget to omit". A UI would write it and never read it back.

Not implemented for scope, not for doubt. It is the largest of the three remaining config screens —
`claimMapping` and `roleMappings` are nested editors — and authentication is a surface where a
half-finished admin screen can lock a tenant out of its own product. **Backlogged as P2, ~4 days.**

## 9. SIEM Assessment — **tenant-admin configurable, not implemented**

The brief asks whether this belongs in deployment configuration. It does not: `admin/audit-sink` is
a **per-tenant** resource behind `integration:manage`, the same permission as `/admin/webhooks`,
which already has a screen. It is a sibling of an existing surface, not an operations concern.

Verified: configuration is persisted per tenant; delivery is the audit stream's pull cursor
(`GET /audit/stream`, gated separately on `audit:export` — an administrator who may point the trail
at a collector is not thereby someone who may read it); the split is deliberate and documented.

Not implemented for scope. **Backlogged as P2, ~2 days.** When it is built, the credential must
follow the identity provider's precedent — write-only, absent from the wire type — and the screen
must not become a "SIEM dashboard", which §14 rules out.

## 10. Platform Component Reuse Assessment

No component was created. Both surfaces are composed from what exists:

| Used | From |
| --- | --- |
| `AdminScreen`, `ResourceList`, `FormDialog`, `Prerequisite`, `StateBadges` | `features/admin-shared` |
| `TextField`, `TextAreaField`, `PickerField`, `SwitchField` | `features/admin-shared/fields` |
| `Section`, `Panel`, `Button`, `Badge`, `Alert`, `useToast` | `@munaxa/ui` |
| `changedFields`, `isEmptyPatch`, `unchanged`, `text`, `flag`, `nullableText` | `features/admin-shared/patch` |

One helper was **not** reused, and the reason is a contract fact: `useAdminColumns` is typed on
`AdministeredRecord`, which requires `createdBy`, `updatedBy`, `deletedAt` and `deletedBy`. The
template wire type carries none of the four. Widening the API response to satisfy a column helper
would be changing a shape to suit a screen — §15 — and would start returning actor identifiers to a
list with no use for them. Three columns are written out instead, using the same `Intl` format.

No new dependency. No new library. `verify:styles` green.

## 11. Permission Mapping Report

No permission was created, renamed or re-scoped.

| Surface | Permission | Where enforced | Where advertised |
| --- | --- | --- | --- |
| `/admin/templates` | `template:manage` | the five API routes | `ADMIN_SECTIONS`, and `adminAccess` on the page |
| Search rebuild | `settings:manage` | both `/search/rebuild` routes | the settings page's existing guard |

`template:manage` was one of the permissions Phase 6.3 examined; it was **not** among the phantoms,
because it was genuinely enforced on real routes. What it lacked was a caller. It now reaches the
Administration menu through `ADMIN_PERMISSIONS`, which is derived from the destination table rather
than hardcoded — so a holder of only `template:manage` sees Administration containing exactly one
destination, asserted by test.

**The UI is not the boundary and is not treated as one.** Four tests assert menu/page *agreement*
and its converse — that `settings:manage` does not confer sight of templates — and each says in its
own comment that this is a courtesy (08 §7), never a control.

## 12. Tenant Isolation Report

Neither surface introduces a data path. Templates are read through `adminList`/`adminOptions`, which
attach the caller's token; every query behind them carries `requireContext().tenantId`, and under
ADR-0015 a tenant is a whole database. The rebuild routes take no identifier at all — a rebuild is
scoped to the caller's tenant by construction, so there is no parameter through which another
tenant's index could be named.

No new isolation mechanism was added, and none was needed. The two-tenant suite ran green
(`tenant-isolation.integration.spec.ts` 6/6, full suite 617/617).

## 13. Security Hardening Report

Each control below has a demonstrated purpose in this diff; nothing was added because a scanner
would ask for it.

| Concern | Finding |
| --- | --- |
| Server-side authorization | Unchanged. Both surfaces call routes that were already gated |
| Enumeration | The template list is the tenant's own; the rebuild status takes no identifier |
| Secret exposure | None on either surface. Templates carry no credential; the rebuild status carries a count and an error string |
| Signed-URL leakage | None — attaching a template body is exactly the part deliberately left out |
| Input validation | Both actions go through `validated(schema, …)` with the API's own Zod schemas, then the API validates independently |
| CSRF / cookies | Unchanged — server actions on the existing session mechanism |
| Idempotency | Rebuild is a `202` the API may refuse; no client-side retry was added |
| Rate limiting | Unchanged. The rebuild route inherits the global throttler |
| Error messages | Failures render `result.detail` or a translated code — no stack, no internal path |
| Output encoding | React escaping throughout; no `dangerouslySetInnerHTML` |

**One finding, recorded rather than fixed**: the rebuild's `error` string is rendered verbatim to an
administrator. It originates in the search lane and could carry infrastructure detail. It is shown
because a silently failed rebuild is worse, the audience already holds `settings:manage`, and
truncating it would hide the reason. Flagged for the operator-surface phase.

## 14. Accessibility Report

Run, not inspected — axe against a rendered tree, which is the standard this repository set after
Phase 19 reported `SkipLink` as absent from a `grep` that could not see it being passed as a prop.

| Surface | States asserted |
| --- | --- |
| Templates | populated, empty, prerequisite-missing — three genuinely different trees |
| Search index | never-rebuilt, running, failed |

All axe-clean. Both use the platform's labelled field primitives, so controls are keyboard
reachable with associated labels and visible focus by construction. Contrast is checked in Chromium
against the built stylesheet by `test:visual` (28 passing) — those baselines cover workspace
surfaces, and admin screens remain outside them, which is a pre-existing boundary this phase did not
change and did not claim to.

## 15. Implemented Changes Report

| File | Change |
| --- | --- |
| `apps/web/src/features/admin-configuration/templates-screen.tsx` | **new**, 279 lines — the templates screen |
| `apps/web/src/app/(workspace)/admin/templates/page.tsx` | **new**, 71 lines — guard + five parallel reads |
| `apps/web/src/features/admin-configuration/templates-screen.spec.tsx` | **new**, 134 lines — 8 tests |
| `apps/web/src/features/admin-configuration/search-rebuild.spec.tsx` | **new**, 98 lines — 7 tests |
| `apps/web/src/features/admin-configuration/actions.ts` | +5 server actions (4 template, 1 rebuild) |
| `apps/web/src/features/admin-configuration/settings-screen.tsx` | +`SearchIndexSection` and its two label maps |
| `apps/web/src/app/(workspace)/admin/settings/page.tsx` | reads the rebuild status via `adminRead` |
| `apps/web/src/lib/admin/sections.ts` | +1 destination, gated on `template:manage` |
| `packages/i18n/src/catalogues/{en,ar}.ts` | +29 keys each, both locales |

**No API file was touched.** No controller, service, port, schema or migration changed.

## 16. API Compatibility Report

No response shape changed. No route renamed. No permission changed. No audit action, event name or
notification semantic touched. No endpoint or field was added — every value both screens render was
already on the wire, including the denormalised `documentTypeName`, `confidentialityName` and
`defaultFolderPath` the template contract has always returned, which is itself evidence the contract
was written expecting a list screen.

## 17. Audit Integrity Report

Unchanged, and unchangeable from here. Both surfaces call existing endpoints; every mutation is
audited by the application layer exactly as it was when the only caller was a test. No audit record
is written from React, no second writer exists, and the `AdministeredWriter`'s one-transaction rule
is untouched. Creating, editing, deleting and restoring a template writes the same rows it did
before this phase — there were simply no callers to write them.

## 18. Notification/Event Impact Report

**No event, notification type, producer, consumer or recipient rule changed.** No notification type
was added. The four Phase 6.4 gaps remain separate and untouched, as the brief requires:

| Phase 6.4 item | Status after 6.5 |
| --- | --- |
| `security.password.changed` producer | Still open, P1, untouched |
| `security.session.revoked` producer | Still open, P1, untouched |
| Failed bulk operation notification | Still open, P2, untouched |
| Dead-letter UI | Still open, P2 — and note it is a *sibling* of the surfaces here, so the operator-surface phase should take it alongside legal holds and the audit sink |

## 19. Deleted Code Report

**Nothing was deleted.** No dead code was found. The five C-class surfaces are complete backends
with no callers, which is the opposite of dead code — none had drifted, and every one still
typechecks against its contract.

## 20. Dependency Reduction Report

No dependency added, removed or upgraded. No new component, primitive or utility. The one place a
shared helper was declined (`useAdminColumns`, §10) traded three inline columns for not widening an
API response.

## 21. Validation Report

Every gate executed. None skipped, none cached for the new work.

| Gate | Result |
| --- | --- |
| `pnpm install` | up to date |
| `pnpm format:check` | pass |
| `pnpm lint` | 0 errors, 5 warnings (all pre-existing) |
| `pnpm typecheck` | 13/13 |
| `pnpm test` | **97 web** (was 82 — +15), 636 API, 164 domain, 26 contracts, 11 utils, 4 i18n, 2 worker |
| `pnpm build` | 9/9 |
| `pnpm verify:styles` | 10/10 |
| `pnpm test:visual` | 28 |
| `pnpm test:integration` | **617 passed, 33 files, 0 skipped** |
| Two-tenant isolation | included above, 6/6 |

**An infrastructure failure is recorded rather than hidden.** Midway through the final run the
container reclaimed PostgreSQL's *data directory*, not merely the process — 31 of 33 integration
files failed at once with connection errors. The databases and cluster roles were recreated and both
tenants re-migrated using the repository's own documented procedure (`infra/sql/cluster/01-roles.sql`
and `scripts/migrate-tenants.mjs`, the same commands CI runs), and the suite then passed 617/617.
No test was changed, skipped or weakened in response.

## 22. Architecture Compliance Report

| Rule | Held |
| --- | --- |
| One canonical surface per capability | ✅ No `-new`/`-v2` route; templates extend Configuration, rebuild extends Settings |
| Platform design system only | ✅ No component created, no library introduced |
| Menu and page guard agree | ✅ Same permission in both, asserted by test |
| UI is never the authorization boundary | ✅ Stated in code and in every test that touches it |
| Asynchronous stays asynchronous | ✅ Rebuild is `202` + status; nothing waits |
| No second job system | ✅ Existing lane, existing status model |
| No audit writing from the UI | ✅ No audit code in `apps/web` |
| API contract stability (§15) | ✅ Zero API files changed |
| Operator ≠ user features (§12) | ✅ Rebuild is on Settings, not in the menu |

## 23. Remaining Product Surface Backlog

| # | Item | Verdict | Priority | Estimate |
| --- | --- | --- | --- | --- |
| 1 | Signature UI on the document screen | Verified gap; needs the Part 11 re-authentication ceremony designed | P1 | ~1 week |
| 2 | Legal-hold panel + a destination for the dashboard tile | Verified gap; no business rules missing | P1 | ~3 days |
| 3 | Identity provider admin screen | Verified gap; nested claim/role mapping editors | P2 | ~4 days |
| 4 | Audit sink admin screen | Verified gap; sibling of `/admin/webhooks` | P2 | ~2 days |
| 5 | Create-from-template on the document library | `document:create`, belongs beside Upload | P2 | ~2 days |
| 6 | Attach a template body | Needs the upload pipeline's scan gate and presign | P3 | ~2 days |
| 7 | `defaultMetadata` editor | Needs the selected type's field definitions rendered | P3 | ~2 days |
| 8 | Restore a deleted template | API supports it; the list does not return deleted rows | P3 | ~1 day |
| 9 | Admin screens in the Chromium contrast/visual baselines | Pre-existing boundary, not introduced here | P3 | ~1 day |
| 10 | Truncate or classify the rebuild error string | §13's recorded finding | P3 | ~2 hours |

## 24. Phase 6.5 Final Status

**PARTIALLY COMPLETE.**

Six surfaces audited; six verdicts reached; two implemented end to end with tests and every gate
green. Four verified gaps remain open, each specified, sized and prioritised — and none of them is
blocked. That is the accurate word: the audit is finished, the phase is not, and `COMPLETE` would
claim otherwise.

What was **actually missing**: a complete document-template domain with no caller anywhere in the
product, and an operator action reachable only by hand-crafting an HTTP request.

What **already existed** and was left alone: every backend behind all six surfaces. No controller,
service, port, schema, migration, permission, event or notification changed in this phase.

What was **deliberately not implemented**: attaching a template body, editing `defaultMetadata`, and
create-from-template — each because doing it here would have meant a second upload path, a duplicated
field renderer, or a button behind the wrong permission. Signatures, legal holds, the identity
provider and the audit sink — each a real gap, none of them small, none of them started rather than
half-started.

What was **found to be false in earlier reports**: nothing in the Phase 6.0 audit's six-surface list
was wrong about existence — all six backends are real. What that audit did not distinguish, and this
one does, is *operator* from *user* surface: it listed search rebuild alongside templates as though
both wanted a page, and only one does.

What remains **blocked**: nothing. Every open item has a complete backend contract behind it.
