# Munaxa Docs — documentation index

**Purpose:** the entry point to every Munaxa Docs document.
**Audience:** everyone building or reviewing Munaxa Docs, human or AI.

This product's documents live here. Repository-wide rules live in
[`PLATFORM_ENGINEERING_STANDARDS.md`](https://github.com/tam2om/munaxa/blob/main/PLATFORM_ENGINEERING_STANDARDS.md); it lives in the
corporate repository and governs all five. This file is Munaxa Docs' own documentation index.
Where they disagree, the rulebook governs.

```text
docs/
├── README.md            THIS INDEX
├── architecture/        the binding Phase 0 blueprint (00–21) + adr/
├── operations/          the runbooks (Phase 18) — living documents, unlike reports
├── ui/                  how the web client is verified (Phase 5.2)
└── reports/             point-in-time findings — evidence, not guidance
```

**`architecture/` says what a thing *is*; `operations/` says what somebody *does*.** The split
arrived in Phase 18, and it matters in both directions: an architecture document that accumulated
commands becomes a runbook nobody trusts, and a runbook that argues about topology is one nobody
finishes reading at three in the morning. `operations/` is also the one directory here that is
**edited** rather than superseded — a procedure that is out of date is worse than no procedure.

The code the architecture describes exists through Phase 15 — the platform foundation, the whole of
Administration, the per-tenant infrastructure the remaining phases are built on, the document library
that is the first thing to hold a customer's own content, the approval engine that moves a document
through it, the numbering engine that gives an approved document its permanent identifier, the
revision control that publishes what was approved and produces the next controlled version, the
preview pipeline that shows a controlled document without handing its bytes over, and the search
that finds a document by its number, its words and its people without ever disclosing one the
caller may not see, the read half of the audit trail — the timeline, the audit search, the
daily verification with its signed checkpoints, and the evidence bundle — and the deletion half:
one answer to what deleting a document reaches, the recycle bin, the retention schedule, the legal
hold that refuses regardless of permission, and the purge that destroys a record while its trail
survives it, and the delegation that lets one person decide another's approvals without the task
ever moving — a routing overlay whose trail names both people and the arrangement that authorised
them, and the notifications that finally tell people any of it happened: an inbox, an email, a
digest, quiet hours, a suppression when an address stops accepting mail, and one summary where a
sweep would otherwise have sent five hundred, the dashboard that composes all of it without owning
a row of it, and the permission model itself made real at last — ACL entries on the scope tree, the
walk over the materialised paths, deny winning at any level, a folder that can stop inheriting while
the administrators accountable for it still reach through, a list and its total that omit what the
caller may not see rather than hiding it, a screen that says which node decided and why, and a second
factor on the way in, and the reports that finally ask about the whole rather than about one record —
ten of them, each gated on the permission that already governs the surface it summarises and each
scoped by the caller's own reach, exported to CSV, to a real Excel format and to PDF through a
queued job that runs under the requester's reach rather than the consumer's absent one. Its map is
[`apps/api/src/modules/README.md`](../apps/api/src/modules/README.md), and each module carries
its own contract — what it owns, what it depends on, which core port it binds.

## 1. Architecture — the binding blueprint

Every later phase conforms to these or supersedes them with an ADR. Index:
[`architecture/README.md`](./architecture/README.md).

| # | Document | Scope |
| --- | --- | --- |
| 00 | [System Architecture](./architecture/00-system-architecture.md) | C4 context and containers; the system at a glance |
| 01 | [Monorepo & Folder Structure](./architecture/01-monorepo-and-folder-structure.md) | Where every file goes, and why |
| 02 | [Backend Architecture](./architecture/02-backend-architecture.md) | Clean Architecture layers, modules, ports, DI |
| 03 | [Domain Model](./architecture/03-domain-model.md) | Bounded contexts, aggregates, ubiquitous language |
| 04 | [Domain Relationships & ERD](./architecture/04-domain-relationships-and-erd.md) | Every relationship, with cardinality |
| 05 | [Database Design](./architecture/05-database-design.md) | Tables, keys, indexes, constraints, tenancy, soft delete |
| 06 | [Document Lifecycle](./architecture/06-document-lifecycle.md) | States, legal transitions, illegal transitions |
| 07 | [Workflow Architecture](./architecture/07-workflow-architecture.md) | The configurable approval engine |
| 08 | [Permission Model](./architecture/08-permission-model.md) | RBAC, inheritance, overrides, the permission matrix |
| 09 | [Numbering Architecture](./architecture/09-numbering-architecture.md) | Configurable, gapless, never-reused document numbers |
| 10 | [Revision Architecture](./architecture/10-revision-architecture.md) | Identity vs revision vs file; check-out/in, compare, restore |
| 11 | [Storage Architecture](./architecture/11-storage-architecture.md) | Provider-agnostic blob storage, dedupe, lifecycle |
| 12 | [Search Architecture](./architecture/12-search-architecture.md) | Metadata + full text + OCR, permission-filtered |
| 13 | [Audit Architecture](./architecture/13-audit-architecture.md) | Append-only, hash-chained, complete |
| 14 | [Preview Architecture](./architecture/14-preview-architecture.md) | Independent renderer plugins, derivative artefacts |
| 15 | [API Architecture](./architecture/15-api-architecture.md) | REST conventions, versioning, errors, pagination |
| 16 | [Frontend Architecture](./architecture/16-frontend-architecture.md) | App Router structure, feature modules, state, caching |
| 17 | [Security Architecture](./architecture/17-security-architecture.md) | AuthN/Z, uploads, encryption, OWASP posture |
| 18 | [Notification Architecture](./architecture/18-notification-architecture.md) | Email, in-app, digests, future push |
| 19 | [Performance & Scalability](./architecture/19-performance-and-scalability.md) | Millions of documents, thousands of users |
| 20 | [Deployment Architecture](./architecture/20-deployment-architecture.md) | Environments, topology, CI/CD, backup and DR |
| 21 | [SaaS Commercial Architecture](./architecture/21-saas-commercial-architecture.md) | Plans, entitlements, metering, provisioning, operator console |

### Decision records

Immutable. Supersede, never edit. [`architecture/adr/`](./architecture/adr/).

| ADR | Decision |
| --- | --- |
| [0001](./architecture/adr/0001-product-root-placement.md) | The product root is `edms/`, not `docs/` |
| [0002](./architecture/adr/0002-multi-tenant-isolation-model.md) | ~~Shared database, row-level tenant isolation, RLS backstop~~ — superseded by 0015 |
| [0003](./architecture/adr/0003-document-identity-revision-file-separation.md) | Document, revision and file are three separate things |
| [0004](./architecture/adr/0004-numbering-assigned-at-approval.md) | Numbers are reserved at submission, assigned at approval, never reused |
| [0005](./architecture/adr/0005-hierarchical-acl-with-deny-precedence.md) | Inherited ACLs on the scope tree, explicit deny wins |
| [0006](./architecture/adr/0006-declarative-workflow-engine.md) | Workflow definitions are versioned data, not code |
| [0007](./architecture/adr/0007-storage-port-and-content-addressing.md) | One storage port; blobs are content-addressed and deduplicated |
| [0008](./architecture/adr/0008-postgres-first-search.md) | PostgreSQL full-text first, behind a search port |
| [0009](./architecture/adr/0009-append-only-hash-chained-audit.md) | Audit is append-only and hash-chained |
| [0010](./architecture/adr/0010-soft-delete-and-retention.md) | Soft delete everywhere, purge only by retention policy |
| [0011](./architecture/adr/0011-transactional-outbox-for-async-work.md) | Async work is dispatched through a transactional outbox |
| [0012](./architecture/adr/0012-entitlements-as-data-enforced-centrally.md) | Plans and entitlements are data, enforced centrally, separate from permissions |
| [0013](./architecture/adr/0013-operator-console-as-separate-surface.md) | Cross-tenant operations live in a separate, fully audited console |
| [0014](./architecture/adr/0014-materialised-path-as-text.md) | The scope tree's ancestry is a materialised path stored as `text` |
| [0015](./architecture/adr/0015-database-per-tenant.md) | One database, storage location and search index per tenant; where each lives is a placement resolved through a registry |
| [0016](./architecture/adr/0016-inheritance-break-truncates-the-chain.md) | An inheritance break truncates the ACL chain, for both effects; the list predicate is regions |
| [0017](./architecture/adr/0017-electronic-signature-as-witnessed-attestation.md) | A signature is a witnessed 21 CFR Part 11 attestation over a revision's content digest, never a qualified signature |
| [0018](./architecture/adr/0018-machine-identity-as-a-delegated-subject.md) | A machine caller is bound to a person and acts as them, narrowed by scopes — never a principal of its own |
| [0019](./architecture/adr/0019-webhooks-are-not-notifications.md) | A webhook is its own delivery path; `NotificationChannel.WEBHOOK` is a value nothing uses |
| [0020](./architecture/adr/0020-key-management-and-rotation.md) | The deployment's secret store *is* the key management service; what the product owes is one key per purpose and a rotation each sealed value can survive |

## 2. Reports

Point-in-time evidence. **Historical, never edited afterwards** — superseded, not revised.

### Phase 6.3 — authorization and permission enforcement completeness

> The third phase from the Phase 6.0 roadmap, and the one that had to disprove a finding of its own.

| Document | Purpose |
| --- | --- |
| [Phase 6.3 — Authorization & Permission Enforcement Completeness](./reports/phase-6.3-authorization-enforcement.md) | The P1 Phase 6.2 raised about `context.roles` carrying role keys where the ACL subject expects identifiers — investigated empirically and **disproved**, along with the claim that the integration suite had caught it. Neither was true: the failure that prompted the change reported a *domain* refusal rather than a reach refusal, its real cause was a metadata field the test had invented, and `roleIdsFor` matches `role.key` or `role.id` by design at a single deliberate boundary. Four tests now prove a role key and a role id produce identical decisions down to the node that decided them — and that an unknown name and another tenant's role id both grant nothing, because a tolerance that accepted anything would be a hole. Why `library:view` was not the phantom the audit called it but a real gap wearing a phantom's clothes: the capability existed and was gated on `library:manage`, so an auditor — seeded with view and deliberately without manage — could not list a library at all, and the document browser's library selector showed them nothing. Why `report:manage` was left unused, again. And the blind spot in a boot-time assertion that had run for eighteen phases: it checked every route against the catalogue and never the catalogue against the routes, which is exactly where two permissions hid. The third check added here found a fourth on its first run — and that one turned out to be enforced in a handler body, because whether a decision is a rejection is a property of the request rather than of the route |
| [Phase 6.4 — Event Consumers & Notification Completeness](./reports/phase-6.4-event-consumers-notifications.md) | Sixty-six declared event types traced to their actual publish call sites, and the discovery that a route is not a producer: `document.approved` and `document.rejected` had a catalogue entry, `en` and `ar` templates, a consumer branch, a lane and a test asserting they reach it — and no code had ever published one, so two of 18 §4's named notifications had never been sent to anybody. Approval and rejection run through `DocumentService.transition`, which wrote an audit row and no outbox row. Why nothing caught it: the notification suite hands the consumer a synthetic event, which proves translation rather than production. The second gap was the one row of 18 §7's reliability table nothing had built — a transient send wrote `FAILED`, `claimQueued` selects `QUEUED`, and `DeliveryState.FAILED` was read by no query in the product, so a provider unreachable for a minute lost every email queued in it, permanently and invisibly because the in-app copy survived. Retry now uses the columns that already existed. And an authorization defect found while tracing recipient resolution: a controller documenting that none of its routes takes a user identifier had one that did, so any signed-in colleague could clear somebody else's unread marker — both guarding tests confirmed to fail against the old predicate. Ten event types stay unproduced, three lifecycle events stay deliberately silent, and three limitations are named rather than worked around, because the objective was a truthful system rather than a maximal one |
| [Phase 6.5 — Enterprise API Surface & Missing UI Completion](./reports/phase-6.5-api-surface-and-ui-completion.md) | Thirty-four controllers traced route → controller → service → authorization → **actual caller**, and the finding that five complete backends had no caller anywhere in the product. Document templates were the clearest: a twenty-column model, five routes, a 373-line service, soft delete and restore, `template:manage`, and `grep -rn "document-templates" apps/web` returning nothing at all — an entire domain unreachable. It now has one canonical screen in Configuration, built from the existing admin primitives with no component created and no API file touched. Search rebuild needed a placement decision rather than a screen: it is an operator action that was already asynchronous, so it sits on the settings page that already requires its permission, because building an operations console for one button is what the brief rules out. Why the status word is PARTIALLY COMPLETE rather than COMPLETE — four verified gaps remain open, none blocked, each specified and sized: signatures, whose backend is complete and whose UI is a Part 11 re-authentication ceremony that deserves its own threat model; legal holds, where the dashboard already counts them and links to a screen that administers something else; and the identity-provider and audit-sink configuration screens. Also why `useAdminColumns` was declined for one screen: it is typed on a record shape the template contract does not carry, and widening an API response to satisfy a column helper is changing a shape to suit a screen |
| [Phase 6.6 — Electronic Signature & Witnessed Attestation UI](./reports/phase-6.6-electronic-signature-ui.md) | **COMPLETE** — the ceremony, and the two production-breaking defects building it uncovered. `Sign` opens a review rather than signing: the statement stage shows the server's exact bytes in a focusable, scrollable region with **no credential field on it at all**, which makes "read before you attest" a property of the markup rather than of the copy. Re-authentication is a stage *of* the confirmation rather than one before it, and the reason is stated rather than glossed — there is no re-authentication endpoint, deliberately, because a standalone "check my password" call is the credential oracle ADR-0017 §6's single undifferentiated refusal exists to prevent. Credentials live nowhere: uncontrolled inputs read out of `FormData` at submit, never in state, and the field is *gone* rather than cleared after success. Proven in real Chromium against a booted API and a booted web server, unmocked: the stored `statement_body` differs from what was displayed in `signed-at` and nothing else; preview and cancellation write neither a signature nor an audit row; a reader is refused the preview route with `403`. **And the part that matters most:** booting the application for the first time in this repository's history found that `/login` answered `500` in every built deployment — a `'use server'` module exported a plain object — and that the document screen and the document library both requested `pageSize: 200` against a maximum of 100, so *neither page could be opened, in any environment, since it was written*. Six phases of green suites, because nothing below the login page had ever loaded the product |
| [Phase 6.6A — Electronic Signature Statement Preview API](./reports/phase-6.6a-signature-statement-preview.md) | **COMPLETE**, and Phase 6.6 is unblocked: one additive `GET /documents/:id/signatures/statement`, behind `document:sign` and the same `@ScopedTo` binding, returning the canonical §11.50 manifestation before there is a signature to verify. The point of the phase is that there is now exactly **one** call to `serialiseSignatureStatement` in the product and both callers reach it — `signWithin` became four ordered steps so the duplicate check still runs where it ran before, and the facts type is `Omit<SignatureStatement, …>` so a field added to what a signature attests is a field the preview must resolve rather than one it could silently omit. Proven the only way worth proving: a preview taken over HTTP, the same revision signed over HTTP, the stored `statement_body` read from the table, and `['signed-at']` asserted as the *only* differing field — with the stored HMAC recomputed, because a preview matching bytes nothing was signed over proves nothing. The instant is the one thing a preview cannot promise, so `preparedAt` names it instead of hiding it. Also proven: three previews leave `document_signature` and `audit_event` at their prior counts, and eight previews do not spend `document.sign`'s five-per-fifteen-minutes budget. **And the defect the phase was not looking for:** §11.200 re-authentication read `user_credential` outside any unit of work, so with the setting on — its default, and the reason the endpoint takes a password — *every signature this product has ever been asked to take answered `500`*. Six phases of green suites missed it because the uniqueness suite asserts the index directly, the Phase 6.7 HTTP test is refused by authorization first, and a service-level spec is unconstructible: `requireTransaction()` lives in `AsyncLocalStorage` only `PrismaUnitOfWork` can populate. The fourth control in four phases found to be declared, configured and unreachable |
| [Phase 6.7 — Security Control Completion: Rate Limiting & Signature Concurrency](./reports/phase-6.7-security-control-completion.md) | **PARTIALLY COMPLETE.** One of Phase 6.6's two blockers is cleared and one is not, so Phase 6.6 stays blocked. The invariant `document_signature` has described since Phase 16 — *one live signature per person, revision and purpose, partial on `withdrawn_at`* — is now a real partial unique index, and the property is proven by ten rounds of a genuine race: two transactions inserting before either commits, exactly one winning each round, the loser failing with SQLSTATE `23505`. Why it is declared in migration SQL and deliberately **not** in `schema.prisma`: Prisma cannot express a partial unique index, so `@@unique` would tell it the constraint is *total* and a later `migrate dev` could repair it into one, breaking withdraw-then-re-sign — the same convention `uq_user_department_primary` already follows, and a mistake made and reverted here. The race maps to the existing `purpose: duplicate` refusal rather than a 500, matched on the index by name so a future unrelated index cannot be misreported. Also a correction to Phase 6.6's evidence: `RATE_LIMIT_RULES` is a six-rule per-surface table that a narrow grep missed — still consumed by nothing, but it makes Part A *wiring* rather than design. Part A was not started and is not dressed up: no limiter, no two-instance test, and the Redis-unavailable fail-safe policy remains an undecided question rather than an assumed one |
| [Phase 6.7B — Distributed Rate Limiting Completion](./reports/phase-6.7b-distributed-rate-limiting.md) | The survey that overturned its own brief. Phase 6.7B was to wire the existing `@munaxa/security` RateLimiter into the request pipeline; that package **does not exist** in this workspace, nor does `@munaxa/cache`, and `@munaxa/platform` is a frontend package whose `exports` map is tokens, themes, icons, hooks, patterns, layouts, shell, date and charts — with no server-side surface at all, and no dependency on it from the API. So there was no Platform limiter to wire and no `RateLimitTarget` whose expressiveness could be judged, which is the exact condition the brief names for STOP-and-document rather than substitute. Why that is nonetheless not a blocker: the product already owns the primitive in its own tree — `CachePort.increment` is an atomic Redis `INCR` + `EXPIRE NX`, bound and in production use — so a guard over it would be the *first* limiter rather than a duplicate of a Platform one. Also the coverage matrix's two findings: `auth.password-reset` is a rule for a route that does not exist, and the signature endpoint has no rule at all, so no number was invented for it. The two decisions left deliberately open for a person: the Redis-failure policy, and the signature rule's window and maximum |
| [Phase 6.7 — Rate Limiting Completion (Part A)](./reports/phase-6.7-rate-limiting-completion.md) | **COMPLETE.** The rule table that had sat unread since Phase 5, wired into a guard registered ahead of authentication — because credential stuffing is unauthenticated by definition — counting through the existing `CachePort`, whose Redis adapter is `INCR` plus `EXPIRE NX` in one `MULTI` and therefore atomic across connections. Proven at two levels, and the second level is the point: nine guard tests prove the mechanism (two independent adapters sharing one budget, tenant isolation, concurrency, fail-closed on Redis loss), and a booted Nest application proves a real HTTP request reaches it — six `POST /api/v1/documents/:id/signatures` calls where the first five are refused by authorization and the sixth by the limiter with `429`, a shape that can only occur if the guard runs first. Writing that last test was not a formality: it found that the route table never matched a real path, because `configureApp` mounts everything under `/api` and the matcher stripped only the version — **every rule would have been inert in production while all nine guard tests reported green**. The third time this sequence has found a control that was declared, configured and unreachable, after Phase 6.3's phantom permissions and Phase 6.4's unread `DeliveryState.FAILED`. Both Phase 6.6 blockers are now closed |

### Phase 6.2 — bulk operations and asynchronous processing

> The second phase built from the Phase 6.0 roadmap, and the one that closes its P0.

| Document | Purpose |
| --- | --- |
| [Phase 6.2 — Bulk Operations & Async Processing](./reports/phase-6.2-bulk-operations-async.md) | A tenant setting that had been read by nothing since Phase 16, so a request naming up to five thousand objects executed every one of them inside one HTTP request — the failure the setting's own documentation describes. Why three of the six findings in the phase's own commissioning audit did not survive inspection: `maxObjects` had always been enforced, `RUNNING` had always been written, and the item table had always been an upsert keyed for redelivery. The obstacle nobody had seen: a `BulkPlan` carries closures, so the lane had no producer not because the consumer was unwritten but because there was nothing to tell one what to do — and why the fix is a payload column that is deliberately *not* the audited one, since `parameters` is copied into the audit row and 13 §3 requires it minimised. Why an `APPLIED` item row now commits inside its object's transaction while the other three outcomes keep Phase 16's placement: the two cases have different requirements, and the gap between them is a second document on an `UPLOAD` redelivery. Why the requester's authority is re-read when the job runs rather than copied when it was asked for, and why that is a second port rather than a reuse of Reporting's. The two architecture violations the repository's own lint caught in this work — core importing a module, and a test reaching into another module's internals — and how each was fixed where the rule pointed rather than worked around. A Phase 6.1 test corrected rather than deleted, with the cause of its flake finally understood. And one new finding raised on the way past: `context.roles` holds role keys where the ACL subject expects identifiers |

### Phase 6.1 — document lifecycle completion

> The first phase built from the Phase 6.0 roadmap. It closes four of that audit's rows and opens
> three new ones.

| Document | Purpose |
| --- | --- |
| [Phase 6.1 — Document Lifecycle Completion](./reports/phase-6.1-document-lifecycle-completion.md) | Two states the design table allowed from Phase 0 and nothing performed, finally performed: `ARCHIVED`, which until now happened only as a retention sweep's side effect, and `EXPIRED`, which was reachable by nothing at all — so a document could carry an expiry date that never arrived. Why `LEGAL_TRANSITIONS` was not edited by one line, and why that is the evidence the lifecycle was completed rather than redesigned. How the audit action varies without a second lifecycle: two optional fields on the one transition method, omitted by every caller that predates the phase. Why the two archive paths stay two code paths and converge on one invariant — `setStatus` matches on `deleted_at IS NULL` and the retention disposition's job includes archiving deleted records, so merging them would have meant weakening the predicate that keeps any caller from moving a deleted document's status. Why the expiry sweep is hourly rather than nightly (one firing is after midnight for some tenants and hours before it for others), why it shares the `retention.run` lane rather than taking one (a second subscriber would race the lane's existing consumer — the defect that gave delegation a lane of its own), and why `effective_to` is inclusive. The permission that was in the catalogue, in the matrix, seeded to two roles and named by no route for eighteen phases, and why that is worse than an absent one. The defect this phase introduced and its own integration suite caught before it shipped — a stated reason in the payload rather than in the trail's attested column, which would have left an archive's justification outside Phase 9's hash digest. Why `LINKED` was deliberately **not** written. And every gate run against a real PostgreSQL with two tenant databases: 594 integration tests, zero skipped |

### Phase 6.0 — enterprise feature completion audit

> The audit that turns nineteen phases of delivery into a roadmap. Numbered by the brief that
> commissioned it; it follows Phase 5.2 and opens the feature track that Phase 6.1 continues.

| Document | Purpose |
| --- | --- |
| [Phase 6.0 — Enterprise Feature Completion Audit](./reports/phase-6.0-enterprise-feature-completion-audit.md) | Every module measured against its own architecture document, ADR, permission matrix, audit catalogue and notification catalogue — by reading the code rather than the reports about it. The four things genuinely missing rather than merely unpolished: a lifecycle that stops short of its own state machine, so `ARCHIVED` happens only as a retention sweep's side effect, nothing watches `effective_to`, and `EXPIRED` is unreachable; a bulk path whose asynchronous half was never wired, so `bulk.synchronousLimit` is a setting nothing reads, `documents.bulk` is a lane with no producer and no consumer, and five thousand transactions run inside one HTTP request — the exact failure the setting's own documentation describes; four shipped API surfaces with no UI at all, two of which have their server actions already written and called by nothing; and sharing, watching, acknowledgement and document linking, three of which the notification catalogue already names as recipient classes. The mechanical census: zero `TODO`s, exact `en`/`ar` key parity at 1 383, and exactly three permissions that are documented, seeded to roles and enforced by nothing. Why Phase 19's nine-row platform violation list was re-verified rather than carried forward, and which seven of the nine are closed. A prioritised roadmap in which twenty-four of twenty-seven items are a screen, a consumer, a writer or an enforcement against something already built — and none is a rebuild |

### Phase 5.1 — UI foundation completion and platform design system adoption

> Numbered by the brief that commissioned it rather than by position: it follows Phase 19 and
> finishes what that audit found, on the UI-foundation track rather than the feature track.

| Document | Purpose |
| --- | --- |
| [Phase 5.1 — UI Foundation Completion](./reports/phase-5.1-ui-foundation-completion.md) | The ten deliverables, and the three things they turned up. Why the regression guard took two attempts — the first draft passed against a deliberately broken build, because `css.includes('.bg-primary')` matches inside `.bg-primary-strong`, so every sentinel resolved on the strength of a different class and the check reported a healthy stylesheet missing 59% of itself; a guard that fails open converts an absent check into a false assurance, which is why its helpers now have tests of their own and why the sentinel list is documented as the weaker signal. The second silent defect, of Phase 19's exact family: `--color-surface-hover` referenced by five hover states and defined nowhere in the platform, the tokens or this repository, so five affordances had never done anything and nothing could have caught it. And a correction to Phase 19 itself, which called `SkipLink` unused and its absence an accessibility defect — it is used, through `AppShell`'s `skipLinkLabel`, and a symbol grep cannot see a prop. What moved: every raw table to the platform's `Table` and the `scope="col"` the hand-written markup omitted, both audit trails to `Timeline`, twelve hand-styled form controls to `Field`/`Input`/`Select`, adoption 54 to 62 of 180. What deliberately did not, with the type signatures the platform would need instead: `FileManager`, whose fixed name/size/modified columns cannot carry a document number or a confidentiality mark; and `ApprovalFlow`, whose binary all/any cannot express `QUORUM` or `PERCENT` and whose statuses have no `CANCELLED` — mapping which onto `skipped` would tell an auditor a control was evaluated and did not apply when it was never reached, which is a false statement in a compliance record rather than a visual imperfection |

### Phase 19 — shared platform compliance and integration audit

| Document | Purpose |
| --- | --- |
| [Phase 19 — Shared Platform Compliance & Integration Audit](./reports/phase-19-shared-platform-compliance.md) | The audit that had to install the platform before it could say anything true, and what reading it rather than assuming it produced. The critical finding: a Tailwind `@source` pointing at a transitive dependency pnpm does not link, which removed 64% of the design system's stylesheet — 136 of 249 platform utility classes generating no CSS rule at all, every one of them a class the product never writes itself, `bg-card` and `bg-primary` and every surface and brand colour the platform's own components declare — through five green gates and a whole production-readiness phase, because a stylesheet that is silently too small is not a type error, a lint error, a test failure or a build failure. One line fixes it and the report measures the fix. The second finding needed the same install: the platform exports 180 components and this product uses 54, and among the other 126 are a `Table`, a `Timeline`, an `ApprovalFlow` and a `FileManager` that Munaxa Docs each built by hand, against a rule the development recommendations put first in their table. Why the brief's sections on authentication, audit, logging and notifications could not be followed — the registry publishes seven `@munaxa/*` packages and every one is design system or lint configuration — and why the local implementations of those are the product rather than violations of it. Why both real findings have one root that is not carelessness, why the answer to *should we start the UI* is no, and why the honest description is that the UI has never actually been seen |

### Phase 18 — production readiness

| Document | Purpose |
| --- | --- |
| [Phase 18 — Production Readiness](./reports/phase-18-production-readiness.md) | Sixteen brief items that are mostly seams which already existed, and finding out which was the phase's first work. Why binding `METRICS` is a question about *shape* rather than about whether, why the exporter pulls, and why the label rule became a catalogue the exporter enforces; why tracing gets a different answer from metrics; what a production image contains, answered with the commands that show the registry is reachable and the private scope's credential is not; how Phase 15's evidence-CSV objection was answered rather than ignored; why Phase 14's "key management service" row was about rotation rather than about an integration; how Phase 12's SMTP refusal was answered by producing the evidence it asked for; the integrity sweep three reports called this phase's; why a security suite that restates a tested property is ceremony; why the load harness exists and its numbers do not; what the phase costs, and what it deliberately does not do |

### Phase 17 — API and integration

| Document | Purpose |
| --- | --- |
| [Phase 17 — API & Integration](./reports/phase-17-api-integration.md) | Eleven brief items that are four groups, and sorting them was the first decision: SSO, Azure AD and Google Workspace are one OIDC adapter; LDAP and Microsoft 365 are two different things and neither is federation; migration and import APIs are mostly Phase 16's. Why a machine caller is a delegated subject and what the alternative would have cost; why a webhook is not a notification; why the outbox routing table's default changed; what `jose`, `ldapjs`, `samlify` and `cbor` actually are, answered with commands, and why hand-writing OIDC verification is not the trade SAML refuses; how 17 §6's SSRF row stopped being unfalsifiable; why the OpenAPI document and the OpenAPI explorer are two things; what the phase costs, and what it deliberately does not do |

### Phase 16 — advanced document features

| Document | Purpose |
| --- | --- |
| [Phase 16 — Advanced Features](./reports/phase-16-advanced-features.md) | Twelve brief items that are three groups, and sorting them was the first decision: five capabilities already built, two with no design at all, and five bulk operations over machinery built in anticipation of them. Why every bulk operation is a permission decision repeated N times and what the shortcut would have cost; why a bulk route cannot carry `@ScopedTo` and what replaced it; why one transaction per object is the difference between partial success and a silent skip; the four readings of "digital signature" and why this product means a witnessed Part 11 attestation and may never call it qualified; why a bulk operation writes N + 1 audit rows and never an identifier list; why bulk export diverges from two existing export mechanisms and produces a manifest rather than an archive; which operations notify and to whom; what `sharp` and `@pdf-lib/fontkit` actually are, answered with commands; how 19 §5's fairness claim was made true; what the phase costs, and what it deliberately does not do |

### Phase 15 — enterprise reporting

| Document | Purpose |
| --- | --- |
| [Phase 15 — Enterprise Reporting](./reports/phase-15-reporting.md) | The last Phase 0.5 module whose contracts shipped and were never implemented, bound at last — and bound so it cannot become the door around four phases of narrowing. Why a report never widens the audience of the surface it summarises, and why that made `document:restore`, `retention:manage` and `audit:view` conditions rather than alternatives; why the rows are scoped by the *module that owns the table* rather than by a query in this one, and what materialised read models and the search index would each have cost; the Excel decision and the three answers not taken; why the export runs under the requester's reach and reads their roles at the instant it runs; why "scheduling ready" ships the seam and names the phase that closes it; what a report cell may never translate; the two defects the tests found; what the phase costs, and what it deliberately does not do |

### Phase 14 — enterprise security

| Document | Purpose |
| --- | --- |
| [Phase 14 — Enterprise Security](./reports/phase-14-security.md) | The ACL phase: the entries ADR-0005 described in Phase 0 and nothing had, the walk over the materialised paths, deny precedence, and `@ScopedTo` on the object routes — so `AclGuard` fires for the first time and Phase 9's `ACCESS_DENIED` is finally reached. The resolver **extended, not rebuilt**: four method signatures unchanged and not one caller touched. Why an inheritance break truncates the chain for *both* effects rather than only for grants; how a relational list gets a predicate the search index's token arrays cannot give it, and why putting it in the repository is what made Phase 13's inherited-counts claim true; what an ACL change costs the search index and what the index serves in the meantime; why MFA is TOTP and not WebAuthn, and why its policy half went to 17; why Share is declined and who owns each reading of it — and the defect six phases old that only firing the guard could find |

### Phase 13 — dashboard

| Document | Purpose |
| --- | --- |
| [Phase 13 — Dashboard](./reports/phase-13-dashboard.md) | The last Phase 0.5 module whose contracts shipped and were never implemented, bound at last — and bound so that its own rule cannot be broken: the module has no `infrastructure/` and no Prisma import, so a widget has nothing to count rows with, and every figure is built from the predicate the list or the inbox it summarises is built from. Why a count is a disclosure and why a refused tile is *absent* rather than zero; the decisions the brief left open — where "Checked Out" comes from, whether the activity feed gains a tenant-wide reader, where the administrator dashboard lives, where Phase 15 begins, and why storage reports bytes but never a quota; why nothing is cached on the busiest route in the product; what the phase costs, and what it deliberately does not do |

### Phase 12 — notifications

| Document | Purpose |
| --- | --- |
| [Phase 12 — Notifications](./reports/phase-12-notifications.md) | The framework Phase 1 built with no producers, finally called: the `notifications.deliver` lane's first consumer, fourteen rows of 18 §4 given catalogue entries and templates, the four phases that deferred delivery here discharged — and the outbox routing table found to have been silently discarding every `delegation.*` event since Phase 11. The decisions 18 left open — what a held message *is*, where a digest's list is composed, what holds a suppression, and which mail adapter is worth building — why the recipient walk is the phase's central safety property, what the phase costs, and what it deliberately does not do |

### Phase 11 — delegation

| Document | Purpose |
| --- | --- |
| [Phase 11 — Delegation](./reports/phase-11-delegation.md) | The most carefully pre-cut seam in the product, bound at last: `DELEGATION_REPOSITORY` and `DELEGATION_SERVICE` given a table, the one check Phase 4 named relaxed in the one place it lives, a task that never moves so a revocation has nothing to reassign, authority read at the instant of the decision rather than copied at creation, a chain bounded by arithmetic and a cycle refused before any setting is consulted, an emergency delegation whose bypass is recorded in the trail's own attested column, expiry as a predicate with a lane that only records it — the decisions 07 §4 left open, why 08 §3 lost a clause rather than the resolver gaining a subject, what the phase costs, and what it deliberately does not do |

### Phase 10 — soft delete & retention

| Document | Purpose |
| --- | --- |
| [Phase 10 — Soft Delete & Retention](./reports/phase-10-soft-delete-and-retention.md) | The deletion half made real: one table answering what a delete cascades to after three modules had answered it locally, the tombstone that keeps a purged document's number where the purge cannot reach it, the recycle bin 16 §2 named in Phase 0, the `retention.run` lane consumed at last with both its schedules, the legal hold finally throwing the error code that had waited since Phase 0.5 — the decisions the specification left open, why Phase 9's partitioning trigger fired and the answer was still no, what the phase costs, and what it deliberately does not do |

### Phase 9 — audit & compliance

| Document | Purpose |
| --- | --- |
| [Phase 9 — Audit & Compliance](./reports/phase-9-audit-compliance.md) | The audit architecture's read half made real: the digest widened and versioned rather than backdated, the timeline filtered at its subject through the resolver Phase 8 bound, signed checkpoints kept outside the database they attest, the daily verification finally firing on a named schedule, read auditing buffered as §5 always claimed, the streamed evidence bundle and its honest manifest, `ACCESS_DENIED` given the writer it never had, and the event catalogue reconciled with the code — what the phase costs, and what it deliberately does not do |

### Phase 8 — search

| Document | Purpose |
| --- | --- |
| [Phase 8 — Search](./reports/phase-8-search.md) | The search architecture made real: the `search.index` lane finally consumed, the weighted index with its materialised ACL subjects, the permission predicate inside the query, Arabic beside English in the query path, the resumable shadow-table rebuild, saved and recent searches — the decision that finally bound `ACL_RESOLVER` and why search is what forced it, what the phase costs, and what it deliberately does not do |

### Phase 7 — document preview

| Document | Purpose |
| --- | --- |
| [Phase 7 — Document Preview](./reports/phase-7-document-preview.md) | The preview architecture made real: the renderer registry bound with four plugins, the lanes finally consumed behind the antivirus gate, watermark and print made meaningful, the compare API's text state filled in, the decisions 14 left open and how each was taken — the DWG refusal, the client-side raster, the per-user mark — and what the phase deliberately does not do |

### Phase 6 — revision control

| Document | Purpose |
| --- | --- |
| [Phase 6 — Revision Control](./reports/phase-6-revision-control.md) | The revision architecture made real: the check-out lock under concurrency, publication superseding in one transaction, restore as a row rather than a copy, the decisions 06 and 10 left open and how each was taken, the numbering seam's revision-cycle branch, and what the phase deliberately does not do |

### Phase 5 — document numbering

| Document | Purpose |
| --- | --- |
| [Phase 5 — Document Numbering](./reports/phase-5-document-numbering.md) | The issuance half of the numbering architecture: the counter under concurrency, the decisions §2 and §3 left open and how each was taken, what binding Phase 4's seam proved, and what the phase deliberately does not do |

### Phase 4 — the workflow engine

| Document | Purpose |
| --- | --- |
| [Phase 4 — Workflow Engine](./reports/phase-4-workflow-engine.md) | The approval engine and the async half of the architecture: what one primitive bought, why the calendar was built rather than deferred, the concurrency defect the integration suite found, and what the phase deliberately does not do |

### Phase 3 — the document library

| Document | Purpose |
| --- | --- |
| [Phase 3 — Document Library](./reports/phase-3-document-library.md) | The first phase to store a customer's bytes: the two storage adapters, the upload pipeline and its gate, what it costs, and what it deliberately does not do |

### Phase 2.5 — the deployment-agnostic foundation

| Document | Purpose |
| --- | --- |
| [Phase 2.5 — Per-tenant infrastructure](./reports/phase-2.5-per-tenant-infrastructure.md) | The refactor that gave every tenant its own database, storage and index — what moved, what did not, and what it costs |

### Phase 2 — administration

| Document | Purpose |
| --- | --- |
| [Phase 2 — Administration](./reports/phase-2-administration.md) | What the Administration phase built, the decisions worth carrying forward, and every limit it left deliberately in place |

### Phase 0.5 — the technical skeleton

| Document | Purpose |
| --- | --- |
| [Architecture compliance report](./reports/phase-0.5-architecture-compliance-report.md) | The formal gate before Phase 1: what was built, what holds, what is owed, and the verdict |
| [Architecture gate verification](./reports/phase-0.5-architecture-gate-verification.md) | Independent re-audit of that report — every falsifiable claim re-derived from the repository |
| [Technical debt](./reports/phase-0.5-technical-debt.md) | Every boundary the skeleton leaves owing, with an owner and a trigger |

### Phase 0 — the architecture

| Document | Purpose |
| --- | --- |
| [Repository analysis](./reports/repository-analysis.md) | What exists in this repository, what Munaxa Docs reuses, what it must not duplicate |
| [Technical debt report](./reports/technical-debt.md) | Defects and drift found during the Phase 0 analysis, with owners |
| [Risk assessment](./reports/risk-assessment.md) | What can go wrong, likelihood, impact, mitigation |
| [Development recommendations](./reports/development-recommendations.md) | How to build phases 0.5 → 18 without repeating known mistakes |

## Maintaining this index

Adding a document means adding a row here in the same commit, and a row in the repository index
this index if it matters outside a single document. A document not linked
from an index is invisible.
