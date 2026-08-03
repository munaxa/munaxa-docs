# Phase 2 — Administration: what was built, and what it deliberately does not do

**Status:** point-in-time record of the Administration phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 3 and after, and whoever audits what Phase 2 claimed.

Phase 1 delivered authentication, the hash-chained audit trail, settings, notification and activity,
provisioning, and the **read** side of the organisation scope tree. Phase 2 delivers Administration:
sixteen areas of configuration, each with create, edit, soft delete, restore, audit, search, sort, page
and filter, on both the API and the web.

There is **no document upload**. What this phase builds is every place a document will go and every
policy it will be created under.

## 1. What exists

| Area | Service | Permission |
| --- | --- | --- |
| Companies, entities, branches, departments | `SCOPE_ADMIN_SERVICE` | `org:manage` |
| Users | `USER_ADMIN_SERVICE` | `user:manage` |
| Roles, the permission catalogue | `ROLE_ADMIN_SERVICE` | `role:manage` |
| Confidentiality levels, metadata fields, categories, document types | `CONFIGURATION_SERVICE` | `settings:manage` |
| Numbering rules | `NUMBERING_ADMIN_SERVICE` | `numbering:manage` |
| Retention policies | `CONFIGURATION_SERVICE` | `retention:manage` |
| Libraries, folders | `LIBRARY_ADMIN_SERVICE` | `library:manage`, `folder:manage` |
| Workflow definitions and versions | `WORKFLOW_ADMIN_SERVICE` | `workflow:manage` |
| Tenant settings | `SETTINGS_ADMIN_SERVICE` | `settings:manage` |

The web mirrors them one screen each under `/admin`, plus a nested folder tree per library and a
version page per workflow.

## 2. The shared write foundation

Eighteen resources with identical lifecycle requirements is a duplication problem and an
over-abstraction trap in equal measure. What was factored out is only the part that is genuinely the
same, and each piece is small enough to read in one sitting:

| Piece | What it owns |
| --- | --- |
| `core/persistence/record-stamps.ts` | One clock reading per operation, so `createdAt` and `updatedAt` cannot disagree |
| `core/persistence/optimistic-lock.ts` | `If-Match` checking; a missing version is a conflict, not a wildcard |
| `core/persistence/listing.ts` | Deleted filter, `LIKE`-escaped search, allow-listed sort with an `id` tiebreak, page arguments |
| `core/persistence/administered-writer.ts` | One transaction, one audit event, one actor — and the read-only tenant check |

What was **not** built is a generic repository. Each resource keeps its own typed Prisma repository, so
the tenant predicate and the soft-delete predicate stay type-checked at every call site. A shared
`findAll(model, filters)` would have made those two clauses stringly-typed, and they are the two
clauses that decide whether one tenant can read another's data.

`refuseWhenReadOnly()` reads `tenant.status` **inside the transaction**, not from a token claim. A
claim is stale for the life of the token, and a suspended tenant has to be read-only immediately.

## 3. Decisions worth carrying forward

**One audit action per area, not per resource and verb.** `ORG_CHANGED` covers four node kinds and five
operations; `before`, `after` and an `operation` in the payload say what happened. Three names are
exceptions and each earns it: `RULE_CHANGED`, `WORKFLOW_PUBLISHED` and `USER_CHANGED` are questions
asked on their own. Section 2 of
[13-audit-architecture.md](../architecture/13-audit-architecture.md) now carries the rows and the
reasoning.

**A delete is refused with a count, never cascaded** — except a folder, where the cascade is the point
and is stamped with a `deleteCascadeId` so a restore returns exactly the subtree that delete took.

**Re-parenting is its own endpoint** for departments, categories and folders, because it rewrites a
subtree's materialised path and every permission granted along the old chain stops applying. It is not
a field on an edit form.

**Some fields cannot be edited at all**, and the API has no endpoint for them rather than an endpoint
that fails: an entity's company, a library's owner scope, a metadata field's data type, a role's key, a
numbering rule's padding once a series is live. Each would silently invalidate data that already
exists.

**A published workflow version is immutable**, enforced in the service *and* in the `WHERE` of the
update statement. It is the engine's most important property and may not rest on a check that ran a
moment earlier.

**The permission matrix's `S` cells are not seeded.** Step 6 of the resolution algorithm falls back to
the tenant-level role grant, so seeding a scoped permission would grant it tenant-wide in a tenant with
no ACLs yet.

**The web holds list state in the URL.** Paging, sorting, searching and filtering are navigations, so a
shared link reproduces what the sender was looking at, and the server renders the right page on the
first paint.

**No browser-side API client.** Reads are server components, writes are server actions, and the access
token never leaves the `httpOnly` cookie.

## 4. Deliberate limits

These are decisions, not omissions. Each one was cheaper to build than to build correctly, and building
it cheaply would have shipped something worse than its absence.

| Limit | Why | Unblocked by |
| --- | --- | --- |
| Role grants are tenant-wide; `user_role` has no scope columns | A scoped grant needs the ACL resolver to enforce its boundary. Without it the grant would be *stored* as scoped and *enforced* as tenant-wide | The permissions phase |
| No invitation tokens; an administrator sets the first password | A credential-bearing token belongs with the credential lifecycle, not bolted onto administration | The security phase |
| No approval-group administration, though `ParticipantKind.GROUP` can name one | A workflow can reference a group; nothing creates one. Modelling it now would mean guessing at membership semantics the engine has not asked for yet | The workflow engine phase |
| The workflow validator does not ask whether a resolver yields anybody | That is a question about a particular document at a particular moment, not about a definition | The workflow engine phase |
| `instanceCount` is zero on every version row | There are no instances until the engine exists. It is on the row so the immutability rule reads the same way once it is filled in | The workflow engine phase |
| `POLICY_EVALUATOR` and `FEATURE_FLAGS` remain unbound | They answer a different question from settings: a flag hides unfinished work, an entitlement expresses what a customer bought, a setting is what the customer chose | The commercial phase |
| The outbox **dispatcher** is still unbound; the writer is now bound | Events are written transactionally and accumulate. Nothing consumes them, so cross-process cache invalidation still relies on the five-minute settings TTL | R5 |
| Administration timestamps render as a date in UTC | The rows are server-rendered and hydrated, and anything reading the machine's zone or locale renders differently on the two sides. The exact instant is in the audit trail | A tenant-timezone-aware formatter |

## 5. Defects found and fixed in existing code

Phase 2 began by establishing a green baseline, and two of the things it found were pre-existing.

**Two integration tests asserted that `FORCE ROW LEVEL SECURITY` scopes reads made as the schema
owner.** It does not: `edms_owner` is a superuser both locally and under compose's `POSTGRES_USER`, and
a superuser bypasses RLS whether or not it is forced. Both tests read across every tenant and passed
only while the database held one. Fixed with explicit `tenant_id` predicates and corrected comments.

**`RoutePermissionRegistry` reported class-gated controllers as ungated.** It looked for class-level
`@RequirePermission` on the prototype while `RbacGuard` reads it from the constructor. Fixed to use the
same two targets in the same order as the guard — a registry that disagrees with the guard is worse
than no registry.

**Prisma's `contains` does not escape `LIKE` wildcards**, so `?search=%` matched every row in every
administered list. `escapeLikeTerm` escapes the backslash first, or it would double the backslashes it
introduces.

## 6. Verification

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Clean across all seven packages |
| `pnpm lint` | Clean, including the module-boundary rule that forbids one module's test reaching into another's infrastructure |
| `pnpm test` | 16 API files / 188 tests, plus the shared packages and 2 web files / 21 tests |
| `pnpm test:integration` | 12 files / 183 tests against a real PostgreSQL 16 |
| `pnpm build` | Clean, API and web |

The integration suite is the one that matters for this phase, because almost everything Administration
promises is a statement about a database: that a library and its root folder appear together or not at
all; that a cascade delete takes a whole subtree in one statement and a restore returns exactly that
subtree; that a code freed by a soft delete is reusable; that a published version cannot be edited even
with the service bypassed; that a second primary department is refused rather than accepted with the
winner decided by query order.
