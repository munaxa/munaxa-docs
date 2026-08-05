# Phase 15 — Enterprise Reporting: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Reporting phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 16 and after, and whoever audits what Phase 15 claimed.

`reporting` was the last Phase 0.5 module whose contracts shipped and were never implemented — the
fourth time this shape has come up, after delegation in Phase 11, the dashboard in Phase 13 and the
ACL entries in Phase 14. Four files, 127 lines: a README, an `application/ports.ts` declaring
`REPORT_DEFINITION_REPOSITORY` and `REPORTING_SERVICE`, a `domain/events.ts`, and a
`reporting.module.ts` that was a bare `@Module({})`. No `domain/` entities, no `infrastructure/`, no
`presentation/`, and no `report_definition` table behind the repository that names one.

And `apps/web/src/app/(workspace)/reports/` did not exist, though 16 §2 has named it since Phase 0.

Two sentences in that ports file had already decided most of this phase, and neither was re-decided:

> `REPORTING_SERVICE.run(key, parameters, page)` — **Every row is permission-scoped to the caller,
> in SQL, exactly like a document list.**

> `REPORTING_SERVICE.requestExport(key, parameters)` — **Large exports are queued and audited rather
> than streamed from a request.**

The first is only expressible because of Phase 14: `visibilityFilter` returns subject tokens *and*
regions, and `PrismaDocumentRepository.whereFor` is the worked example. The second is the shape
Phase 9 built for evidence bundles.

A third sentence, the file's own header, is the architectural question this phase turns on:

> Reports read from read models, never from another module's tables. That constraint is what keeps
> a reporting query from quietly becoming the reason a schema cannot change (02 §3).

---

## 1. The named risk: a report inverts everything four phases have narrowed

Every phase before this one made the product tell people *less*.

- **Phase 8** pushed the permission predicate into the search query rather than filtering results,
  because 08 §7 says fetch-then-filter "leaks totals, facet counts and page boundaries".
- **Phase 13** refused to answer a count for anybody but the caller, and made a tenant-wide tile
  **absent rather than zero** — because "you may not ask" and "there are none" are different
  answers.
- **Phase 14** made a document absent from a list **and from its total** rather than fetched and
  hidden.

A report inverts that by construction. It is the first thing in this product designed to aggregate
across everything, it takes parameters, it pages, and it produces a **file** — which outlives the
screen, leaves the product, and is opened later by somebody who was not there when it was run.
`report:view` is an `S` row in 08 §6's matrix for the library manager, the author and the approver,
which Phase 14 made expressible for the first time.

So the phase's whole authorisation design is two rules, stated once in `domain/report-catalogue.ts`
so an eleventh report inherits them rather than re-deriving them.

### Rule 1 — A report never widens the audience of the surface it summarises

A catalogue entry's `permissions` is a **conjunction**, not a choice. `report:view` says somebody
may ask an aggregate question about this tenant; it does not say *which rows*, and every report
whose rows an earlier phase put behind a second gate carries that gate too:

| Report | Permissions | Whose gate the second one is |
| --- | --- | --- |
| `documents`, `documents-by-dimension`, `approvals`, `workflow` | `report:view` + `document:view` | The library's |
| `storage` | `report:view` | Phase 13's storage tile, unchanged |
| `departments` | `report:view` + `org:manage` | Phase 13's departments tile |
| `users` | `report:view` + `user:manage` | Phase 13's users tile |
| `deleted-documents` | `report:view` + `document:restore` | ADR-0010 §2's recycle bin |
| `expired-documents` | `report:view` + `retention:manage` | Phase 10's disposition queue |
| `audit` | `report:view` + `audit:view` | 13 §6 and 08 §10's audit search |

The three the brief called out as crossing an earlier boundary are the last three, and each is
answered the same way: **the report is not a second door, because it is behind the same lock.**

A caller without a report's permissions gets a refusal, not an empty page — Phase 13's distinction,
and it is louder here because a report is a page somebody navigated to. And a report they may not
run is **absent** from `GET /reports` rather than listed and disabled: a greyed-out row named
"Deleted documents" tells somebody the product keeps one.

### Rule 2 — Rows are scoped by the caller's reach wherever the subject has reach

`REACH_SCOPED` in the catalogue, and it is not a property this module implements. Every source
adapter is built from the predicate its own module's list is built from — the document reports go
through `PrismaDocumentRepository.whereFor`, which is where Phase 14 put the ACL predicate
*specifically* so that everything counting or listing documents inherits it without knowing how.
The dashboard's counts inherited it in Phase 14's own commit; these reports inherit it now, the same
way, by calling the same function. **The total obeys it too.**

`TENANT_WIDE` is the honest name for the rest, and it is a smaller set than it looks. Storage, users
and departments have no per-row reach — a deduplicated blob is not in a folder anybody was granted,
an account is not filed under a library — so their gate is the whole of their discrimination, and it
is the gate 08 §6 already assigns.

---

## 2. The central architectural question, and the two readings that were rejected

"Reports read from read models" has three defensible readings. The phase argues all three, in
`application/ports.ts`, and takes the first.

**Taken: Phase 13's shape, applied to queries instead of counts.** What Reporting needs is declared
in the *reporting* vocabulary and implemented by whichever module owns the table — the inverted
dependency the dashboard uses eight times and Document already used for `REVISION_WRITER`. Seven
ports, one per contributing module, each with a `query` discriminator rather than a method per
report.

| Port | Implemented in | Built from |
| --- | --- | --- |
| `REPORT_DOCUMENT_SOURCE` | Document | `PrismaDocumentRepository.whereFor` — the list's own predicate |
| `REPORT_WORKFLOW_SOURCE` | Workflow | `approvalTaskWhere` — the inbox's own predicate |
| `REPORT_STORAGE_SOURCE` | Storage | `file_object`, aggregated per library |
| `REPORT_PEOPLE_SOURCE` | Identity | `user`, with roles and department on the page |
| `REPORT_ORGANIZATION_SOURCE` | Organization | `department`, with membership counts |
| `REPORT_RETENTION_SOURCE` | Retention | `retention_schedule`, past its date |
| `REPORT_AUDIT_SOURCE` | Audit | `AuditReadService.search` — the trail's one reader |

**Rejected: materialised read models of its own.** The textbook answer, and it comes with an
invalidation story. Phase 14 has just written a long one about `acl_subjects` — an ACL change
re-projects an affected subtree a page at a time, and the index must never be emptied while it is
live. A report is *more* sensitive to staleness than an index, not less: a search result somebody
cannot see is a missing row, and a report figure somebody cannot see is a **wrong number they act
on**. Owning a second materialisation would mean a second such story, for a capability whose queries
are aggregates over tables already indexed for exactly these predicates.

**Rejected: reading the search index.** Genuinely tempting, because it is already
permission-materialised. It holds documents and nothing else — no approvals, no storage, no
accounts, no retention schedule — so seven of the ten reports could not be answered from it, and the
three that could would be answered from a projection that is only eventually consistent with the
record. A report that disagrees with the document it describes is worse than a slow one.

### So this module has an `infrastructure/` and the dashboard does not

Phase 13 kept "the dashboard owns no data" true by giving that module nothing to own data *with*.
This module cannot do that, because it genuinely owns two tables. The rule is therefore narrower and
still structural: **`infrastructure/` reaches `report_definition` and `report_export` and nothing
else.** A `document.findMany` there would be the second definition of what a document population is,
and the report — a file somebody prints and circulates — would be the copy people believed.

### One translation of one decision

Writing the approvals report needed the caller's document reach as a `where` on `document`, which
`PrismaDocumentRepository` already had. Copying it would have been the same failure this seam exists
to prevent, one level down: the resolver is the single place the *decision* is made, and two
translations of one decision are two chances to write `OR` where the other writes `AND`.

So `documentVisibilityWhere` moved to `core/authorization/document-visibility.ts` — a pure refactor
with no behaviour change — and the document repository, the workflow report and the retention report
all call it. Phase 14's hard-won `OR: [{}]` note travelled with it; it is exactly the kind of thing a
second implementer rediscovers by shipping a hole.

---

## 3. The decisions the specification left open

### 3.1 Export — three formats, and the Excel one is the hard one

The environment decides more of this than taste does. **The lockfile cannot be regenerated, so no
dependency can be added.** There is no spreadsheet library and there cannot be one.

**PDF** was buildable: `pdf-lib` is already an `apps/api` dependency because Preview burns
watermarks with it.

**CSV** is trivial and has four traps, all of which are unit-tested:

1. **Formula injection.** A cell beginning `=`, `+`, `-`, `@`, a tab or a carriage return is
   *executed* by Excel, LibreOffice and Google Sheets on open. In this product that cell is a
   document title, a delete reason or an audit payload — written by a user, opened by a compliance
   officer with access to everything. **Uniform quoting does not fix it**: a CSV reader strips the
   quotes before the spreadsheet parses the cell, so `"=1+1"` is a formula. Only changing the value
   does, and a leading apostrophe is what every spreadsheet reads as "text follows".
2. **A BOM**, or a double-clicked CSV decodes in the system codepage and every Arabic title is
   mojibake.
3. **`\r\n`**, which is what RFC 4180 says and what Excel on Windows cares about.
4. Doubling a quote inside a field — the one most implementations get right.

**Excel was the decision.** Four answers were available, with four honesty levels:

| Answer | Verdict |
| --- | --- |
| CSV called "Excel" | Refused. Excel opens it, which is exactly what makes it dishonest — the product would claim a format it did not produce, and every cell would be text |
| A hand-built minimal XLSX | Refused, and the closest call. Phase 9 refused the same thing in the same words ("a format implementation nobody asked for"), and one property decides it rather than taste: **a ZIP central directory states each entry's size and CRC, so the writer must buffer the sheet or emit data descriptors** — and this lane's entire design is that a report streams a page at a time. An XLSX writer would undo the one property the export exists to have |
| Declining Excel | Refused. The brief asks for it and something honest was available |
| **SpreadsheetML 2003** | **Taken.** Microsoft's own XML workbook format, opened natively by Excel, a single XML document with no container, **typed cells** and a frozen header row — and it streams: header, a `<Row>` per row, footer |

It is **not XLSX and nothing claims it is**. The format is `SPREADSHEET_XML` in the catalogue, in
the database enum, and on the wire; the media type is `application/vnd.ms-excel`; the file is
`.xls`. A wire value called `XLSX` would be the product asserting a ZIP container it never wrote,
and a unit test asserts the naming so it cannot be quietly "tidied up" later.

Typed cells are the whole reason this beats a renamed CSV: `0012-2026` stays text rather than
becoming a subtraction, and a date sorts as a date.

### 3.2 The PDF's Arabic problem, stated rather than hidden

`pdf-lib`'s standard fonts are WinAnsi: Latin-1 and nothing else. Phase 7 hit this and **refused to
render text to PDF at all** — *"a rendition that garbles Arabic text is worse than no rendition"* —
and embedding a font that covers Arabic means adding a dependency or a binary asset, neither of
which this phase can do.

So a character the font cannot encode becomes `?` **and the substitution is counted**. The count
travels onto the export record, onto the wire, into the `REPORT_EXPORTED` audit row, and onto the
download screen as a warning. Phase 7's judgement stands; what makes this acceptable where that was
not is that **nobody is handed the file without being told**. An Arabic tenant exports CSV or the
spreadsheet, both UTF-8, neither of which loses a character.

### 3.3 The export runs under the *requester's* reach — the phase's one load-bearing line

A queue consumer's request context has no user in it. `audit-lane.consumer.ts`'s `systemContext`
sets `userId: null`, correctly, because a nightly verification is nobody's act.

It is emphatically wrong here, and the failure is silent. `PrismaDocumentRepository.visibilityCondition`
returns an **empty** predicate when `context.userId` is null — deliberately, because the search
projection must materialise an entry's answer for everybody. So a report run under the consumer's
own context would be a report over **every row in the tenant**, written to a file and handed to
whoever asked. It is one missing line away in the obvious implementation.

`ReportExportService.run` therefore reconstitutes the requester: it asks Identity for their roles,
builds a context naming them, and runs the whole export inside it. Every source then applies exactly
the reach it applies to a request, because it *is* one.

**The roles are read at the moment the export runs, not copied when it was requested** — Phase 11's
rule applied to a queue: *authority is read at the instant of the decision, never copied at
creation*. A snapshot on the export row would let a backlog hand out reach that had already been
withdrawn. The permissions are then re-resolved against the resolver, so an account that lost
`document:restore` while its export queued gets a failure rather than a file, and an account that has
gone gets one too. The integration suite asserts both.

### 3.4 The audit report — the same reader, not a second one

Phase 9 decided the audit *search* is deliberately **not** ACL-filtered, and 08 §10 records why: a
search spans subjects, so there is no single object to resolve, and `audit:view` is granted to
exactly the three roles whose definition is reading the trail. Narrowing it "would produce an auditor
who cannot audit". 13 §1 is equally emphatic that the trail has one reader.

A report over the trail is that same thing wearing a different name, and it had two answers:

- **A second query here, gated on `report:view`.** Rejected — and it is the *less* code option. It
  would be a second definition of what the trail contains, diverging the first time a filter was
  added to one of them, and it would put the trail behind a permission 08 §6 grants to three roles
  the audit screen does not.
- **Call the reader that already exists.** Taken. `AuditReportSource` is a projection over
  `AuditReadService.search`, and the catalogue requires `audit:view` as well as `report:view`.

What it adds over `/audit` is an export somebody keeps. **It is not an evidence bundle**, and that
distinction is kept sharp: Phase 9's bundle carries the chain, the checkpoints and a signed manifest
stating exactly which columns each digest attests, and it stays behind `audit:export`. This is a
spreadsheet of rows with no hashes on it — deliberately, because a file carrying `hash` and
`previous_hash` columns *without* the manifest's `attests` section would look like evidence and prove
nothing.

### 3.5 "Scheduling ready" — the seam, and only the seam

The phrase most likely to become debt. Phase 4 built the outbox, the queue adapter and the
schedules; Phase 9 fires a daily verification on a named schedule; Phase 10's `retention.run` carries
two. **"Ready" is not "built"**, and four phases have now had to discharge a declared-but-unbound
contract.

So there is **no `report_schedule` table**. What exists is everything a scheduler would need and
nothing that is specific to a person asking:

- a `reporting.export` lane in `QueueName`, with its own definition and its own consumer;
- a `report_export` row that is its own record, with an idempotent `claim`;
- an audited run that publishes `reporting.export-ready` through the outbox.

A scheduled report is then a cron entry that writes a `report_export` row and enqueues it. What is
missing is the schedule table, its editor, and the delivery of the finished file to a recipient —
and delivery is the interesting half, because it is a notification with an attachment and 18 §8's
recipient rules apply to it. **It is owed to Phase 17**, which owns webhooks, SIEM streaming and API
integration, and is where "send this artefact somewhere" belongs.

Naming it here is the whole point. A `report_schedule` table with nothing writing it would have been
the fifth contract in this repository shipped with no binding.

### 3.6 `report_definition` — bound, and what it may never hold

The contract has existed since Phase 0.5 and would have been the fifth unbound one, so it is bound —
to a *saved* definition, like Phase 8's saved searches: a name, a catalogue key, and a parameter map,
owned by one person.

**It holds parameters and never a query.** There is no field on the record, on the table or on the
wire that could carry SQL, a column list or a table name, and that absence is the enforcement of the
constraint at the head of `ports.ts`. A tenant that could author a query would be a tenant that could
pin a column, and no migration would ever again be a decision this repository alone could take. It is
why the *catalogue* is code — reviewed with the module whose table answers each report — and why what
a person saves is which report and which parameters.

Parameters are validated against the catalogue on the way in, because a saved definition outlives the
screen that made it: storing whatever was posted would produce a definition that runs today and, in
six months, either fails or — worse — *succeeds* with a misspelled filter dropped, reporting over more
rows than its name implies.

`report:manage` is **not** bound by this and the reason is stated rather than left to be noticed: 08
§6 gives it to the tenant administrator and the document controller only, which is the shape of a
permission for a *shared* definition. Nothing shares one yet, and putting an author's own saved filter
behind a permission 08 §6 does not give them would be the wrong reading. It is named in §8.

### 3.7 An unknown parameter is refused, not ignored

The tempting behaviour — drop what you do not recognise — is the dangerous one for a report. A
misspelled `departmentId` produces a report over **every** department, and the person reading it
cannot tell: it has rows, it has a total, and it is a confident answer to a question nobody asked.
Refusing costs one round trip and a message naming the parameter.

This makes `GET /reports/{key}` the one endpoint in the API whose query string is not fully
enumerated by a schema — `runReportQuerySchema` is the contracts package's only `passthrough` — and
15 §1 now says so, along with why the validation is the catalogue's rather than Zod's.

### 3.8 Charts, which Phase 13 declined and this phase draws

Phase 13's report declined them for a reason that is still correct: *"nothing on this screen has a
time axis; the trends that would earn one are Phase 15's"*. It is also still true of **eight of this
phase's ten reports**, so two are drawn and eight are not. A chart on a list of documents is a
decoration, and the catalogue's `chart: null` says so — the component renders nothing rather than an
empty axis.

Phase 13's other note — *a chart is the thing that breaks in RTL* — is a warning rather than a
prohibition, and 16 §8 applies to both:

- The **category** axis is reversed in Arabic. A horizontal bar chart reads from the axis outward,
  and in an RTL document the axis is on the right, so the order must invert or the largest bar sits
  where a reader's eye leaves rather than arrives. ECharts does not infer this: the chart is a canvas
  and knows nothing about the page.
- The **time** axis is *not* reversed. A period axis is chronological rather than typographic; Arabic
  readers read the same calendar left to right, and reversing it would put last month to the right of
  this one.

The table renders beside both, always. `@munaxa/ui`'s `Chart` already emits an accessible data table
of its own inputs, which is the same principle 16 §8's "status is never colour alone" states.

### 3.9 What a report cell says

Nothing is translated that somebody filters or exports by: a status, a state, an audit action code,
a disposition, a document number, a role key. That is Phase 9's rule for action codes, restated by
Phase 13, and it applies to **every** cell here because a report is precisely the artefact those
rules exist to protect — a file read six months later by somebody comparing it to a filter.

Column *headers* are translated, in EN and AR, in the same commit.

---

## 4. Two defects found by writing this phase

**`storeStreamed` did not deduplicate, and nothing had noticed for six phases.** ADR-0007 makes
blobs content-addressed and `uq_file_object_checksum` enforces one row per digest per tenant; the
upload path has honoured that since Phase 3 (`alreadyStored`). The streamed path inserted
unconditionally. Phase 9's artefacts can never collide — an evidence manifest names its own export
identifier, so two bundles differ by construction — but **the same report run twice by the same
person is byte-for-byte identical**, and the second run hit the unique index. It now returns the
existing row, which is what content addressing means. Found by the idempotency test, not by reading.

**Phase 9's evidence CSV does not neutralise formulas, and its comment says it does.**
`evidenceCsvRow` quotes every field uniformly and states that a conditional quoting rule "is where an
injection into a spreadsheet formula hides". Uniform quoting is not the mitigation: a CSV reader
strips the quotes before the spreadsheet parses the cell. **This phase did not change it** — an
evidence bundle's bytes are what a signed manifest's digest attests, and rewriting the writer
silently changes what a re-export of the same range produces, which is exactly the property an
auditor relies on. It is recorded here as owed, with an owner, in §8.

---

## 5. What was built

| Area | What exists |
| --- | --- |
| Reporting — domain | `report-catalogue.ts` (ten reports as data, both rules, the format decision); `report-parameters.ts`; `report-writers.ts` (CSV + SpreadsheetML); `report-pdf.ts`; `audit-actions.ts` |
| Reporting — application | `REPORTING_SERVICE` bound; `ReportExportService`; `ReportDefinitionService`; seven source ports and `REPORT_SUBJECT_READER` declared |
| Reporting — infrastructure | Two Prisma repositories (its own tables only); `ReportingLaneConsumer` |
| Reporting — presentation | `ReportingController` — nine routes |
| Document | `DocumentReportSource` — three reports, all through `whereFor` |
| Workflow | `WorkflowReportSource` — composed with `approvalTaskWhere`, reach through the document |
| Storage | `StorageReportSource` — bytes held and referenced, per library. Still no quota |
| Identity | `IdentityReportSource`; `IdentityReportSubjectReader` — whose reach an export runs under |
| Organization | `OrganizationReportSource` — counts of people, never their names |
| Retention | `RetentionReportSource` — past its date, and whether a hold freezes it |
| Audit | `AuditReportSource` — a projection over `AuditReadService.search` |
| Core | `documentVisibilityWhere` extracted to `core/authorization/`; `StreamDigest` promoted to `core/persistence/` and re-exported from Phase 9's file |
| Contracts | `reporting/reporting.ts` — descriptors, pages, exports, definitions |
| Domain package | `QueueName.REPORTING_EXPORT` and its definition |
| Config | `REPORTING_EXPORT_BATCH_SIZE`, `REPORTING_EXPORT_MAX_ROWS`, `REPORTING_PDF_MAX_ROWS` |
| i18n | One `reports` block in EN and AR, plus a `nav.reports` row |
| API | Nine routes under `/api/v1/reports` |
| Web | `/reports` — the catalogue, the descriptor-driven parameter form, the table, two charts, the exports list, saved definitions |
| Database | One migration: `report_definition`, `report_export`, two enums |
| Permissions | **None added.** `report:view` and `report:manage` have been in the catalogue since Phase 1 |
| Audit | **One action.** `REPORT_EXPORTED`, which is exactly what 13 §2 assigned this phase |

---

## 6. What it costs

| Cost | Detail | Mitigation |
| --- | --- | --- |
| **Seven ports for one capability** | One per contributing module, each with a `query` discriminator | The alternative is a query service in `reporting/` issuing its own SQL, which is what the module's own header forbids — and which would have to re-derive the ACL walk |
| **A module that owns tables and must not read others'** | Weaker than Phase 13's "no `infrastructure/` at all" | Narrowed to "its own two models", asserted rather than reviewed. It is the strongest form available to a module that genuinely owns rows |
| **A `passthrough` schema in the contracts package** | The only one | A report's parameters are the catalogue's and differ per key. Validation moved to the catalogue, where the columns and the permissions already are, and unknown names are *refused* |
| **`documentVisibilityWhere` moved into `core/`** | A predicate builder for one model, in a layer that is meant to be model-agnostic | Its name says which model. The alternative was a second copy, and Phase 14's `OR: [{}]` comment is exactly what a second implementer rediscovers by shipping a hole |
| **`StreamDigest` moved out of `audit/domain/`** | A file Phase 9 owns, changed | Re-exported, so no Phase 9 call site or test changed. The alternative was nine duplicated lines that cannot disagree today and can tomorrow |
| **`ReportingService` grew four methods** | Beyond Phase 0.5's two | The two declared ones are byte-for-byte unchanged, including `requestExport` returning a job identifier — which is why the export format travels as a reserved `format` parameter rather than as a third argument |
| **`ReportDefinitionRepository` grew one method** | `softDelete` | Added rather than cast around at the call site. The four declared methods are unchanged |
| **A PDF is assembled in memory** | Unlike the other two formats | Its own, smaller cap, refused rather than silently applied — and the format is the reason, not the library |
| **The trend report reads up to 50,000 instances** | The one query here that could scan a large table | Bucketed in the process rather than by `date_trunc`, because a raw query cannot take the Prisma reach predicate and hand-writing its SQL would be a second ACL walk. Bounded and stated in 19 |
| **Two tables** | `report_definition`, `report_export` | Both are genuinely this module's. No read model, no rollup, no projection |
| **No cache on a query-heavy screen** | Deliberate | §3 of 19. The resolver already caches the *filter* where it is invalidated correctly; caching rows would mean a second thing to invalidate on every document change |

---

## 7. Deliberate limits

| Limit | Why | Unblocked by |
| --- | --- | --- |
| **No `report_schedule` table, no schedule editor, no delivery of a finished export** | §3.5. "Ready" is not "built", and a table nothing writes would be the fifth unbound contract | Phase 17 — delivery is a notification with an attachment |
| **`report:manage` is bound to nothing** | §3.6. It is the shape of a permission for a *shared* definition, and nothing shares one. Binding it to personal definitions would put an author's own saved filter behind a permission 08 §6 does not give them | The phase that makes a definition shareable |
| **No XLSX** | §3.1. The lockfile cannot be regenerated, and a hand-built ZIP writer would end the streaming property the export exists for | The phase that may add a dependency |
| **A PDF of non-Latin text is lossy, and says so** | §3.2. `pdf-lib`'s standard fonts are WinAnsi, and neither a dependency nor a font asset can be added | The phase that may add either |
| **No custom or user-authored reports** | The catalogue is code, deliberately — §3.6. A tenant that could author a query could pin a column | Nothing — this is the decision |
| **No cross-tenant or operator reporting** | ADR-0013 puts cross-tenant operations in a separate, fully audited console | The operator console |
| **No quota, percentage or "% full" anywhere in the storage report** | Phase 10 recorded "no quota accounting"; Phase 13 §3.5 recorded that storage reports bytes and never a quota. Both stay true | Phase 21 and ADR-0012 |
| **The audit report carries no hashes and no manifest** | §3.4. A file with `hash` columns and no `attests` section would look like evidence and prove nothing. The bundle stays behind `audit:export` | Nothing — this is the decision |
| **No report on a *person's* workload across the tenant** | The approvals report is scoped by document reach, not by assignee, so it cannot enumerate somebody's work in a part of the tenant the caller cannot see. Phase 13 refused a tenant-wide "who is covering for whom" for the same reason | The phase that decides such a permission exists |
| **No drill-down from a chart bar to its rows** | The two reports produce the same predicate, so the link is expressible — it is a screen affordance nobody asked for and it would be the only place the client assembles a query | The phase that revises this screen |
| **No paging control on the reports screen** | It reads one page of 100 and the export is the answer for more. A report somebody pages through is a report they should export | A caller that wants it |
| **Phase 9's evidence CSV still does not neutralise formulas** | §4. Changing it changes what a re-export of a range produces, and a signed manifest attests those bytes | Phase 18 — the integrity sweep, which is where evidence artefacts are re-examined |
| **No `documents per confidentiality` dimension** | Four dimensions were built (department, type, category, owner, status). Confidentiality is a *classification* and a breakdown of it is a map of where the sensitive records are — a different disclosure question, and one nobody asked | The phase that decides it |

---

## 8. Limit rows discharged from earlier reports

**Phase 13's "no report engine, no exports, no scheduling" — discharged, except scheduling, which is
named.** `REPORTING_SERVICE` and `REPORT_DEFINITION_REPOSITORY` are bound; ten reports take
parameters, page and export. Scheduling is §3.5, and the phase that closes it is named.

**Phase 13's "no trend, no time axis, no charts" — discharged, narrowly.** Two charts, on the two
reports that have an axis. Its reasoning was not overturned: eight of ten reports still have nothing
worth drawing, and the catalogue's `chart: null` is what says so per report rather than per screen.

**Phase 13's "no documents per department, per type or per user" — discharged.**
`documents-by-dimension` is that report, over the same predicate the list is built from, so a bar's
count and the rows behind it are one query counted two ways. Five dimensions, not three.

**Phase 13's "no tenant-wide who is covering for whom" — *not* discharged, and deliberately.** Its
report named Phase 15 or "the phase that decides such a permission exists" as the unblocker. This
phase decides the second: there is still no permission in the catalogue that means "may see
everybody's absences", and a report on people's cover is a report on people rather than on records.
The approvals report names tasks on documents the caller can already reach, and never absences. It
remains owed, with the same trigger.

**Phase 13's "no storage quota" — not discharged, and reaffirmed.** §7.

**Phase 9's `REPORT_EXPORTED` — written.** 13 §2's owner table is updated, and the two rows it
declined are recorded there with their reasons.

**Phase 10's "no disposition or hold screens beyond the API" — partially discharged again, and the
remainder is unchanged.** The expired-documents *report* now exists behind `retention:manage`, which
is a read. The disposition queue as a screen somebody approves items from is still not built, and
still belongs to the phase that builds the retention surface.

---

## 9. Verification

All six gates clean: `format:check`, `lint`, `typecheck`, `test`, `test:integration`, `build`.

| Gate | Result |
| --- | --- |
| `pnpm format:check` | Clean |
| `pnpm lint` | Clean across all thirteen tasks (two pre-existing `import()` warnings, unchanged) |
| `pnpm typecheck` | Clean across all seven packages |
| `pnpm test` | 522 API tests (1 skipped), plus 126 domain, 21 web and the rest — up from 501 API |
| `pnpm test:integration` | 29 files / 489 tests against real PostgreSQL, two tenant databases (up from 28 / 468) |
| `pnpm build` | Clean, API and web — including `/reports` under `typedRoutes` |
| Migrations | One: `20260806000000_reporting` — two tables, two enums, no change to an existing column |

The unit tests carry the properties that are properties of *bytes*, because a test that had to reach
a bucket to check whether a formula was neutralised is a test nobody runs: the CSV neutralises each
of the six formula leaders, carries a single BOM, ends lines with CRLF and passes Arabic through; the
spreadsheet types its cells, degrades a non-finite number to text rather than losing the workbook to
Excel's refusal, strips the control characters XML 1.0 cannot represent, and closes every element it
opens; the PDF paginates and *counts* what its font could not encode. The catalogue's own invariants
are asserted too — `report:view` on every report, a second permission on each of the five that need
one, `REACH_SCOPED` on every document-sourced report, and no report declaring a parameter called
`format`.

`reporting.integration.spec.ts` carries the disclosure assertions, and each is a question only a
database can answer:

- **The same report answers different rows for two callers**, through the real `PrismaAclResolver`
  over real `acl_entry` rows written through `PermissionService` in a request context — not seeded as
  `edms_owner`, which would write past the row-level security the rows are subject to and would then
  not be testing what a request would see (Phase 14's rule, followed here).
- **A total does not leak what a page omits.** Ben's total is Ada's minus one. Fetch-then-filter
  passes the row assertion and fails this one.
- **The breakdown is scoped by the same reach**, so an aggregate cannot leak what a list hides — the
  shape where it is easiest to forget, because no individual row is visible in the answer.
- **Four reports are refused by permission, not answered emptily**, each naming the permission Phase
  10, Phase 9 or Phase 13 put on the surface it summarises — and all four are served to somebody who
  holds it.
- **A report the caller may not run is absent from the list**, not present and disabled.
- **An export is queued, not produced**: the job is on `reporting.export` with a deterministic
  identifier, and the record is `REQUESTED` with no storage key.
- **`REPORT_EXPORTED` carries the parameters that produced it**, and the format in its own field
  rather than among them.
- **Ben's export contains Ben's rows and Ada's contains Ada's**, produced under the *consumer's* own
  subject-less context — which is the assertion that would fail if the requester were not
  reconstituted, and would fail by producing *more* rows rather than fewer.
- **A disabled account's queued export fails rather than producing a file**, and **a redelivered job
  produces the same file rather than a second one.**
- **All three formats complete**, with a digest of the bytes actually written.
- **A saved definition validates on the way in**, and somebody else's is a `404` rather than a `403`.

Two defects were found by writing the tests rather than by reading the code, and both are in §4.
