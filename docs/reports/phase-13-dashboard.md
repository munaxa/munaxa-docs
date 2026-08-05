# Phase 13 — Dashboard: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Dashboard phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 14 and after, and whoever audits what Phase 13 claimed.

`dashboard` was the last Phase 0.5 module whose contracts shipped and were never implemented. Three
files: a README, an `application/ports.ts` declaring `DASHBOARD_SERVICE` and a four-field
`DashboardSummary`, and a `dashboard.module.ts` that was a bare `@Module({})` composed into
`app.module.ts` and providing nothing.

Its README stated the rule the whole phase turns on:

> **The dashboard owns no data.** It composes what other modules already expose — the approval
> inbox, recent documents, overdue tasks — so a widget cannot become a second, divergent definition
> of "overdue".

And `apps/web/src/app/(workspace)/page.tsx` — the route 16 §2 describes as "dashboard: my tasks, my
documents, recent activity" — still rendered an `EmptyState`, with a Phase 0.5 comment explaining
why: *"a mocked dashboard is indistinguishable from a broken one the day the real data arrives"*.
That comment is now spent.

So this phase built almost no logic. What it built is **seams**, and the report is mostly about the
decisions behind them.

## 1. The rule, and how it was made unbreakable rather than merely written down

A dashboard can violate "no second definition" on every widget. "Pending", "Overdue", "Checked Out",
"Rejected" and "Due for review" are all *already defined* — in `ApprovalReadService.inbox`, in
`DocumentQueryService.list`, in `RetentionService.listDue`, in the legal-hold service. A widget that
counts rows itself is a second answer to a question the product has already answered once, and the
day the two disagree the dashboard is the one people believe.

Writing that in a comment would not have held. What holds is that **the dashboard module has no
`infrastructure/` folder and no Prisma import reachable from anything under `dashboard/`**. There is
nothing in it to count rows *with*.

What it needs is declared in `application/ports.ts` in the dashboard's own vocabulary, and
implemented by whichever module owns the table — the inverted dependency Document already uses for
`REVISION_WRITER` and `DOCUMENT_CONTENT_GATE`, applied seven times:

| Port | Implemented in | Built from |
| --- | --- | --- |
| `DASHBOARD_DOCUMENT_METRICS` | Document | `PrismaDocumentRepository.whereFor` — the list's own predicate |
| `DASHBOARD_APPROVAL_METRICS` | Workflow | `approvalTaskWhere` — the inbox's own predicate |
| `DASHBOARD_STORAGE_METRICS` | Storage | `file_object`, aggregated |
| `DASHBOARD_PEOPLE_METRICS` | Identity | `user`, grouped by state |
| `DASHBOARD_ORGANIZATION_METRICS` | Organization | `department`, counted |
| `DASHBOARD_RETENTION_METRICS` | Retention | `dueScheduleWhere` — `listDue`'s own predicate |
| `DASHBOARD_DELEGATION_METRICS` | Identity | `DELEGATION_SERVICE`, not its tables |
| `DASHBOARD_NOTIFICATION_METRICS` | Notification | `NOTIFICATION_SERVICE.unreadCount` |

Three of those required **extracting a predicate that already existed into a function**, so the tile
and the list share it rather than resemble each other:

- `PrismaDocumentRepository.whereFor` became public. It was already the one place the document list
  built its `where`; now the metrics adapter builds its `groupBy` from the same call.
- `approvalTaskWhere` was extracted from `PrismaApprovalQueryRepository.inbox`. **There is now
  exactly one `dueAt < now` in the workflow module**, and both the inbox and the dashboard count
  through it.
- `dueScheduleWhere` was extracted from `PrismaRetentionScheduleRepository.listDue`, with one
  difference recorded in its comment: `listDue` takes a `limit` because the sweep processes what it
  reads, and the tile does not, because a count that stopped at the batch size would sit at "200"
  through a backlog of any size.

The integration suite asserts the property rather than the arrangement: a tile's number is compared
to `documents.list(...)`'s `meta.total` for the same filter, through the repository the library
itself serves from.

## 2. The named risk: a count is a disclosure

08 §7 is explicit that fetch-then-filter "leaks totals, facet counts and page boundaries" — which is
why Phase 8 built `visibilityFilter` to push the predicate into SQL. A dashboard is nothing but
totals and counts, and "you have 14 documents pending" computed without the caller's predicate tells
somebody exactly how many documents exist that they may not see, on the first screen they open,
every day.

**The rule is stated once, in `dashboard.service.ts`, as two sentences with no third.** A widget
added later inherits the answer instead of re-deriving it:

1. **A user widget is a query whose predicate names the caller.** Drafts and rejected are
   `owner_user_id = caller`; pending and overdue are `assignee_id IN (caller + their cover)`; checked
   out is `locked_by = caller`; favourites and recents are keyed on the caller; activity is
   `forActor(caller)`. None can be made to answer a question about anybody else's work, because
   there is no parameter by which to ask — the same enforcement-by-absence the notification and
   delegation controllers use. **That is why the whole user object sits behind one ordinary grant
   (`document:view`) rather than a permission per tile.**

2. **An administrator widget crosses the tenant, so it is gated on the permission that already
   governs the screen it summarises**, and it is **absent** rather than zero when the caller does not
   hold it.

| Tile | Permission |
| --- | --- |
| Documents by status, Workflow by state, Approvals, Storage | `report:view` |
| Users | `user:manage` |
| Departments | `org:manage` |
| Dispositions due | `retention:manage` |
| Legal holds | `legal-hold:manage` |

The last two are deliberately **not** one permission. The retention controller already reads holds
behind the same grant as writing them, on the stated ground that who is holding a record and for
which matter is counsel's business; a dashboard that leaked the count under the looser permission
would undo that in one tile.

### `FORBIDDEN` and `READY: 0` are different answers

This is the phase's central safety decision and it is expressed in the type. `TileState` is
three-valued, and a tile carries `state` beside its value rather than a nullable number:

- **`FORBIDDEN`** — you may not ask. A statement about the caller.
- **`READY: 0`** — there are none. A statement about the tenant.
- **`UNAVAILABLE`** — the source did not answer. A statement about the product.

Collapsing the first two would make the first screen everybody opens a daily report on how much
exists in the parts of the tenant they cannot see into — and the day the real number stopped being
zero, they would learn that too. Collapsing the last two would tell somebody who *does* hold a
permission that they do not, sending them to ask an administrator for something they already have.

**A refused tile is not computed and then hidden.** `gated()` does not run the query when the
permission is absent, so the tenant-wide number never enters this process's memory for a caller who
may not have it — the shape 08 §7 calls fetch-then-filter, and the one that leaks through a timing
difference even when the value never reaches the wire.

The permissions are resolved in **one** `capabilitiesFor` call against the tenant scope, not one
`resolve` per tile. Not merely for the round trip: eight decisions taken milliseconds apart are eight
chances for the answer to change mid-render, and a role revoked between the storage tile and the
users tile would produce a screen that was never true at any instant. Reading the token's
`permissions` list would have been cheaper still and is wrong — 08 §3 makes collecting the subject
the resolver's job, and the token is a snapshot from sign-in.

### What this phase deliberately did **not** do: apply a predicate its source does not

Phase 8 built `visibilityFilter`; the search index consumes it. **The document list does not.** It is
gated by the tenant-level `document:view` grant and scoped by RLS, which is the whole of the
discrimination this generation of `PrismaAclResolver` can make — its own comment says so, since with
no ACL entries on any chain every decision falls through to the role grant.

So a document count here applies exactly what the list applies, and no more. That is not a shortcut;
it is the module README's rule. **A count filtered more tightly than the list it summarises would be
a second, divergent definition of "your documents"**, and the first screen of the product would
disagree with the second. When the ACL phase pushes `visibilityFilter` into the document list, these
counts inherit it in the same commit **without `dashboard.service.ts` changing**, because they are
built from that list's own predicate.

Phases 11 and 12 each declined to extend `PrismaAclResolver` and recorded why. This one declines for
the same reason and one more: extending it *here* would make the dashboard the only screen in the
product enforcing a rule the library did not.

## 3. The decisions the specification left open

The brief is a list of tile names. Eight decisions were genuinely open.

### 3.1 Checked Out — the one widget with no endpoint

`DocumentListRequest` had `status`, `favorite` and `ownerUserId` and no way to ask "locked by me".
Phase 6 built the lock and Phase 3 built the list, and neither needed the join. Three options:
widen the request, add a query on the lock repository, or compose from what exists.

**Widened the request, as a flag rather than a holder identifier.** `lockedByMe: boolean`, not
`lockedByUserId: string`, and the asymmetry with `ownerUserId` beside it is the decision:

- The schema anticipated exactly this. `ix_document_lock_holder` is indexed `(tenant_id, locked_by)`
  and commented **"What do I have checked out" — one person's live claims**.
- "What has Bob got checked out" is a *report* on somebody's work in progress. Reports are Phase
  15's, with their own permission and their own export. Adding the identifier would have shipped the
  second question as a side effect of needing the first.
- It is not a secrecy argument — `DocumentRow.liveLock` already names the holder on every row. It is
  a scope one.

A lock-repository query was rejected because it would have produced a count no *list* serves, which
is the divergence §1 exists to prevent. Widening the list instead means the tile links to
`/documents?lockedByMe=true` and the rows behind it are the same query — and `DOCUMENT_FILTER_KEYS`
on the web gained `lockedByMe` and `ownerUserId` in the same commit, so the links are honoured
rather than silently ignored.

**"Live" means unexpired as well as unreleased.** An expired lock excludes nobody and the next
operation sweeps it aside; counting one would tell somebody they hold a claim the product has
already let go of. The suite seeds two locks for one person, one of them lapsed, and asserts the
count is one.

### 3.2 The activity feed — whether to add a tenant-wide reader

`ACTIVITY_READER` had been bound since Phase 9 with no caller. It exposes `forSubject` and `forActor`
and nothing else, and its own contract says why: it is *a projection of the audit trail, not a second
log*, because "two records of what happened can disagree, and when they do, the one shown to users
and the one shown to auditors will be the pair that disagrees".

Adding a tenant-wide method was a decision with a disclosure consequence, not a convenience.
**Declined.** The dashboard calls `forActor(caller)` — what *this person* did, which can disclose
nothing they did not already do, and needs no permission for the same reason.

A tenant-wide feed is the audit search: already built, already behind `audit:view`, already a screen
at `/audit`. A second one on the home page differing from it only in permission is precisely how the
two come to disagree.

**Consequence worth stating:** the port is unchanged. Phase 9's "no activity feed screen" is
discharged by a *caller* rather than by a new method.

### 3.3 Where the administrator dashboard lives

A screen under `/admin`, or a second panel on `/`? **A panel on `/`.**

- 16 §2 assigns `page.tsx` to "dashboard" and names no administrator route.
- `/admin` is *configuration* — its own subtitle is "How this organisation is configured" — and a
  page of counts configures nothing.
- An administrator is also a person with drafts and an inbox. Putting the tenant's health one
  navigation away from their own work means they see one of the two.

**Neither `lib/navigation.ts` nor `lib/admin/sections.ts` gains a row**, because no route was added.
`nav.home` already pointed at `/` with no permission.

The API mirrors it: the administrator half is a *field* on `GET /dashboard`, not a second endpoint. A
separate route would need a permission to guard it, and there is no single permission meaning "may
see some administrative figure" — `report:view` is one of five, and gating the route on the loosest
is the mistake `NavigationDestination.anyOf` exists to avoid. A caller holding none of the five gets
`anyGranted: false` and eight `FORBIDDEN` tiles, which renders as no panel. It is not an error: being
an ordinary user is not a failure to be an administrator.

### 3.4 Reports, Statistics and KPIs — where Phase 15 begins

The brief lists all three as administrator tiles. Phase 15 is Enterprise Reports — documents,
approvals, workflow, storage, departments, users, deleted, expired, audit, with PDF/Excel/CSV export
and "scheduling ready" — and `reporting`'s contracts (`REPORTING_SERVICE.run`, `requestExport`,
`REPORT_DEFINITION_REPOSITORY`) are declared and bound to nothing, exactly as the dashboard's were.

**The line drawn:** *a tile showing a count is this phase's; a query that takes parameters, pages, or
exports is not.*

So "Statistics" and "KPIs" **are** the tiles — a breakdown is a `groupBy` with no parameters and no
paging. "Reports" is **not built**: the moment a tile grows a dimension ("documents per department",
"approvals over time") it is the report engine wearing a card, and building one here would leave
Phase 15 to either delete it or inherit it. `report:view` gates four tiles because the permission for
"may see aggregate figures about this tenant" already existed and already means exactly this. What it
does not buy is `REPORTING_SERVICE`, still bound to nothing.

The `dashboard` module's Phase 0.5 header said it depends on "Reporting, Workflow, Document, Search".
**Two of those turned out wrong**, and the module comment records it: Reporting is Phase 15's and
depending on it would mean importing an empty module; Search is not a dependency either, because
every figure here is an aggregate over a table and none of them is a query anybody typed. What the
capability actually needed was Storage, Identity, Organization, Retention and Notification.

### 3.5 Storage — the tile with a trap

Phase 10 recorded "no quota accounting" as a deliberate limit. `file_object` knows what a tenant
*holds*; nothing anywhere knows what a tenant is *entitled to*.

**Three figures, and no fourth.** `storedBytes` is what the blobs occupy. `referencedBytes` is
`sum(size × ref_count)` — what they would occupy if every reference were its own copy. The gap is
what content addressing saved (ADR-0007), and it is the only storage claim this product can currently
make that is arithmetic over rows rather than a policy. Plus a blob count and the unreferenced count
a reclamation sweep would remove.

A "72% of your quota" tile would have to invent the denominator, and inventing it here would put an
entitlement in the storage module rather than in ADR-0012's data model — where Phase 21 has to
enforce it against billing, plan changes and overage, none of which a tile can know about.
`DashboardStorageMetrics` has no method that could return one, which is the point.

### 3.6 Composition, cost and cache

A dashboard is N widgets, and the naive implementation is N round trips on the most-loaded route in
the product. Three decisions:

**Each widget runs in its own unit of work, and they run together.** `UnitOfWork.run` joins an outer
transaction when one exists, so composing inside a single `run` would let one failing widget abort
every other. Independent transactions are what allow a slow or broken source to degrade to
`UNAVAILABLE` on its own card while the rest of the page renders — which is the answer to "what does
a widget do when its source is slow rather than making the whole page wait".

It is deliberately **not a timeout**. A per-widget deadline needs a number nothing has measured, and
abandoning a query the database is still running does not make it cheaper — it makes the connection
unavailable *and* the work wasted.

**The query count is bounded by widgets, never by rows.** Measured at the driver: **7 model
operations for the user dashboard and 11 for the administrator's eight tiles** (the eleventh being
the single `capabilitiesFor` call that gates them). The suite asserts both the ceiling *and* that
ten-times the rows produces an identical count.

**Nothing is cached, and that is a decision rather than an omission.** 16 §4's cache-policy table
assigns staleness to the approval inbox, document detail and admin configuration; it assigns none to
this. `CACHE_PORT` is bound and per-tenant and would work — but **a cached count is a stale count
somebody acts on**, and every number here is about work waiting for the person reading it. Being told
three approvals are pending when four are is the failure this screen exists to prevent. Caching only
the tenant-wide administrator tiles was the tempting middle and is worse: those are the numbers
somebody reports upward.

### 3.7 What the two document cards carry

"Recently opened" and "Favourites" already have endpoints serving exactly those lists. Three options:
put rows on the dashboard payload, put identifiers on it, or let the cards call the endpoints.

**The cards call the endpoints.** Rows would make the dashboard a second projection of a document,
which drifts from the library's the first time a column is added and then shows the same document two
ways on two screens. Identifiers would be no better — the client would still have to resolve them,
and there is no "these ids" filter to resolve them with, so it would have meant inventing one.

The page therefore makes three calls, fetched together, and each is a list somebody could already
open. `DashboardSummary.recentDocumentIds` — Phase 0.5's declared field — is still served, by
`summaryFor` alone, and deliberately *not* computed inside `userDashboard`: composing a read for a
caller that does not exist on the hot path would be a query per page load for nothing.

### 3.8 Time

Three widgets ask a question about an instant — is this lock live, is this task past its deadline, is
this schedule due. `CLOCK_PORT` is injected rather than `new Date()` called, for the reason
`clock.port.ts` exists, and **read once for the whole composition** so every widget answers about the
same instant. Composed in parallel with three separate reads, the pending and overdue counts could
disagree about a task whose deadline fell between them.

## 4. The audit trail gains nothing, and that is stated rather than inferred

13 §2 gives this phase no Dashboard group and no row. **It needs none, and does not get one.**

Phase 9 already buffers read auditing for documents above a confidentiality rank, and a *count is not
a read of a document*: nothing here opens a record. A row per dashboard load would add one event per
person per session to a table that already carries one per document view, answering no question the
underlying acts do not.

`activity.port.ts`'s constraint — "an activity feed can never show something the audit trail does not
contain; if a feature wants to surface an event, it writes an audit event" — is satisfied by
construction: the activity card reads *through* `ACTIVITY_READER` rather than around it, so it can
surface nothing the trail lacks. **This phase writes nothing at all**, so `AdministeredWriter` is not
used either.

## 5. Responsive, and how it was verified

The brief asks for it and no test catches it, so it is stated:

- The KPI grid steps **2 → 3 → 4** columns (`base`/`md`/`xl`) and the tenant grid **1 → 2 → 4**,
  through `Grid`'s own breakpoints, which come from the shared tokens rather than a media query
  written here. Two columns on a phone rather than one, because a count tile is short and a single
  column turns seven of them into a scroll before anything else is on screen.
- Every card is `h-full` inside its cell, so a row of tiles is one height whatever its longest hint
  wraps to.
- The two list columns collapse to one below `lg` rather than becoming two narrow columns of
  truncated titles.
- Checked at **360, 768, 1024 and 1440** in both directions.

**The RTL pass is the one a widget grid is easiest to get wrong (16 §8), and it holds because nothing
in this feature uses a physical direction.** The layout is `Grid` and `Stack`; the spacing is logical
(`gap`, `justify-between`, `truncate`, `shrink-0`); there is no `ml-`, `pr-`, `left-` or `text-left`
anywhere in `features/dashboard/`. Byte counts are formatted with `Intl.NumberFormat`'s `unit: 'byte'`
rather than a hand-rolled KB/MB ladder, so the unit name, the separator and the rounding are the
locale's decisions — a ladder written here would render Arabic numerals with English abbreviations.

**No charts.** `@munaxa/ui` ships them and a breakdown could have been a donut. A five-slice donut of
enum counts is decoration: the reader wants the numbers, the labels must be translated anyway, and a
chart is the thing that breaks in RTL. Charts belong where a *shape over time* is the message, and
nothing on this screen has a time axis — the trends that would earn one are Phase 15's, with the
ranges and the export.

**Audit action codes render verbatim**, following the rule Phase 9's timeline established and stated:
`DOCUMENT_APPROVED` is 13 §2's own vocabulary — what an auditor filters by and what an evidence
export contains — and a translated phrase in its place would give one event two names, one on a
screen and one in the bundle.

## 6. What was built

| Area | What exists |
| --- | --- |
| Dashboard | `DASHBOARD_SERVICE` bound at last; eight declared ports; `DefaultDashboardService`; the three-valued tile; `DashboardController` |
| Document | `DASHBOARD_DOCUMENT_METRICS`; `whereFor` made public; `lockedByMe` on `DocumentListRequest` and on the wire; `liveLockOf` extracted |
| Workflow | `DASHBOARD_APPROVAL_METRICS`; `approvalTaskWhere` extracted from the inbox — one definition of "overdue" in the module |
| Storage | `DASHBOARD_STORAGE_METRICS` — bytes held, bytes referenced, blobs, unreferenced blobs. No quota |
| Identity | `DASHBOARD_PEOPLE_METRICS`; `DASHBOARD_DELEGATION_METRICS` (Phase 11's widget), through `DELEGATION_SERVICE` |
| Organization | `DASHBOARD_ORGANIZATION_METRICS` |
| Retention | `DASHBOARD_RETENTION_METRICS`; `dueScheduleWhere` extracted from `listDue` |
| Notification | `DASHBOARD_NOTIFICATION_METRICS` — Phase 12's badge, through the service its endpoint calls |
| Contracts | `dashboard/dashboard.ts` — the three-valued tile, the two dashboards |
| i18n | One `dashboard` block in EN and AR, plus user-state labels |
| API | One route: `GET /api/v1/dashboard`, taking no user identifier |
| Web | `/` — the user panel, four list cards, and the administrator panel when granted |
| Testing | `realDashboard` in `real-collaborators.ts` — seven real adapters, the real resolver, the real activity reader |
| Database | **No migration.** Every figure is an aggregate over a table that already existed |
| Permissions | **None added.** Every tile is gated on a permission that already meant this |
| Audit | **No action added.** §4 |

## 7. What it costs

| Cost | Detail | Mitigation |
| --- | --- | --- |
| **Seven transactions for the user dashboard, nine for the administrator's** | One per widget, so one failure degrades one card | The alternative is a single transaction in which the first failing widget aborts the other eight. Every one is an aggregate; none scales with rows |
| **Three HTTP calls for the home page** | `/dashboard`, `/documents/recent`, `/documents?favorite=true` | Fetched together, so the page is as slow as its slowest part rather than their sum — and the alternative is a dashboard that projects documents itself |
| **`whereFor` is public on `PrismaDocumentRepository`** | An infrastructure method exposed beyond its class | It is what makes the tile and the list one predicate. Its comment says so, and the alternative — a private duplicate in the adapter — is four lines shorter and one release from disagreeing |
| **Three predicates extracted from three modules** | `whereFor`, `approvalTaskWhere`, `dueScheduleWhere` | Pure refactors with no behaviour change, each covered by its own module's existing suite. Two of them removed a duplicate that did not exist yet |
| **`DocumentListRequest` grew a filter** | `lockedByMe` | It is a list somebody can open, which is what makes the tile's number checkable. §3.1 records why it is not `lockedByUserId` |
| **Eight ports for one screen** | One per contributing module | The alternative is one query service in the dashboard, which is exactly what the module's README forbids. Each port is two to four methods |
| **A `$queryRaw` in the storage adapter** | `sum(size_bytes * ref_count)` has no Prisma aggregate | The alternative loads every blob row to add up one number — the shape 02 §5 exists to prevent |
| **No cache on the busiest route in the product** | §3.6 | Deliberate. Every number is about work waiting for the reader, and a stale one is acted on |

## 8. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| **No report engine, no exports, no scheduling** | §3.4. A tile showing a count is this phase's; a parameterised, paged, exportable query is not. `REPORTING_SERVICE` and `REPORT_DEFINITION_REPOSITORY` remain bound to nothing | Phase 15 |
| **No storage quota, percentage or limit** | §3.5. Phase 10 recorded "no quota accounting"; what a tenant may store is ADR-0012's data | Phase 21 |
| **No trend, no time axis, no charts** | §5. Nothing here has a period to compare against, and a period is a report parameter | Phase 15 |
| **No tenant-wide activity feed** | §3.2. `ActivityReader` gained no method. A feed of what everybody did is the audit search, already behind `audit:view` at `/audit` | Nothing — this is the decision |
| **No tenant-wide "who is covering for whom"** | A report on everybody's absences, and no permission in the catalogue currently means it. The delegation card is the caller's own arrangements in both directions | Phase 15, or the phase that decides such a permission exists |
| **No "documents per department", "per type" or "per user"** | A tile with a dimension is a report wearing a card. §3.4 | Phase 15 |
| **The document counts apply no ACL predicate beyond the tenant-level grant** | §2. They apply exactly what the list applies. Filtering more tightly than the list they summarise would be the divergence the module exists to prevent | The ACL phase — and these counts inherit it without this module changing |
| **`PrismaAclResolver` is unchanged** | This phase calls `capabilitiesFor` and extends nothing. Phases 11 and 12 both declined and recorded why; this one declines for the same reason and one more (§2) | The ACL phase |
| **No `DASHBOARD_SUMMARY` endpoint** | `summaryFor` is Phase 0.5's declared contract and is implemented and reachable in-process, but no route serves it: the screen wants the wider object, and a second endpoint answering a subset would be a second thing to keep in step | A caller that wants it |
| **No dashboard configuration — no widget order, no hiding, no per-user layout** | Nothing in the brief or in 16 asks for one, and a layout preference is a settings model, not a dashboard | The phase that decides personalisation is wanted |
| **No refresh, polling or live update** | A server component rendered per request. 16 §4 assigns this route no staleness, so there is nothing to invalidate | The phase that gives the workspace a live channel |
| **No unread badge in the navigation shell** | Phase 12's limit is discharged *on the dashboard*, which is where its report said it belonged. A badge beside the sidebar's Notifications row is a shell change, and the shell is not this phase's | The phase that revises the workspace shell |

## 9. Limit rows discharged from earlier reports

**Phase 9's "no activity feed screen" — discharged**, as the caller's own feed. §3.2 records that the
port gained no method and why adding one would have been a disclosure decision rather than a
convenience.

**Phase 10's "no disposition or hold screens beyond the API" — partially discharged, and the
remainder is named.** The two *numbers* now exist on the dashboard, each behind its own permission,
and each links to where the work is done. The disposition *queue* and the hold *register* as screens
are not built: `GET /retention/dispositions` and `GET /documents/:id/holds` serve them, and rendering
a queue somebody approves items from is a screen with actions, not a tile. It remains owed to the
phase that builds the retention surface.

**Phase 11's "no delegation widget on the dashboard" — discharged**, including the "who is covering
for whom" clause, and the clause is discharged *by declining it*: the card shows the caller's own
arrangements in both directions, and a tenant-wide summary is named in §8 as a report.

**Phase 12's "no unread badge anywhere but the notification screen" — discharged.** Its report noted
that `GET /notifications/unread-count` exists precisely so a badge has something to call; the
dashboard calls the service that endpoint calls, in-process, because composing server-side and then
reaching its own API over HTTP to render one number would be a round trip through the whole guard
chain to reach a provider already in the container. The badge in the *navigation shell* is not built
and is named in §8.

**Phase 8's `visibilityFilter` on the document list — not discharged, and this phase deliberately did
not.** §2. It remains the ACL phase's.

**Phase 9's "`ACCESS_DENIED` from `AclGuard` is wired but unreached" — not discharged.** This phase
adds no `@ScopedTo` route. A `FORBIDDEN` tile is not a refused request — nothing was denied; a
question was simply not asked — and writing a denial for each would put eight rows in the trail every
time an ordinary user opened the home page.

**Phase 10's "no monthly partitions"** carries a two-part trigger: twenty million rows in one
tenant's trail, or the phase that gives audit its own disposition. This phase fires neither — it
writes no audit rows at all. The trigger stands as Phase 10 left it.

## 10. Verification

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean across all thirteen tasks (three pre-existing `import()` warnings, unchanged) |
| `pnpm typecheck` | Clean across all seven packages |
| `pnpm test` | 441 API tests (1 skipped), plus 126 domain, 26 contract, 21 web, 11 utils, 4 i18n and 2 worker — unchanged; this phase's assertions are all database questions |
| `pnpm test:integration` | 26 files / 444 tests against real PostgreSQL, two tenant databases (up from 25 / 431) |
| `pnpm build` | Clean, API and web — including the typed `/documents?lockedByMe=true` links under `typedRoutes` |
| Migrations | **None.** `pnpm prisma:deploy` unchanged; no table, column or enum value was added |

`dashboard.integration.spec.ts` carries the phase's own assertions, and each asks something only a
database can answer:

- **A count matches the list it summarises.** The drafts tile and `documents.list({ ownerUserId,
  status: DRAFT })` are compared — number *and* rows — through the repository the library serves from,
  not through a second query written in the test.
- **The same count for a caller who owns less returns less.** Ada's three and Bob's one, from the same
  code, because the predicate names the caller.
- **Only live locks, and only the caller's.** Two locks for one person, one lapsed an hour ago: the
  count is one, and the `lockedByMe` list agrees with it.
- **Pending and overdue come through the inbox's own predicate**, and a person assigned nothing gets
  zero rather than the tenant's total.
- **A widget whose permission the caller does not hold returns `FORBIDDEN`, never `READY: 0`** — every
  one of the eight, against the **real** `PrismaAclResolver` over real `role_permission` rows, with
  the request context's `permissions` deliberately empty so a service reading the token would fail.
- **The two retention figures are gated separately.** A caller holding `retention:manage` and not
  `legal-hold:manage` gets the disposition count and a `FORBIDDEN` hold count — and nothing
  `report:view` gates leaks in beside them.
- **Storage reports four figures and no fifth.** The object's keys are asserted exactly, so a quota
  added later fails here.
- **The activity feed is the caller's own**, from the real trail through the real `ACTIVITY_READER`,
  with somebody else's events in the same table — and bounded at eight rows out of thirteen written.
- **An unbound optional capability is `UNAVAILABLE`, not zero.** A composition without notifications
  has no unread count; it does not have an unread count of zero.
- **Ten times the rows costs the same number of queries** — measured at the driver through a client
  extension, asserted *identical* rather than merely bounded, while the answers themselves move.
- **A failing source degrades one card, not the page.** The document metrics reject; the document
  tiles read `UNAVAILABLE`; the approval and notification tiles still answer.
