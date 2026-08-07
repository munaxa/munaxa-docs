# Munaxa Docs — architecture rules

## Dependency direction

```text
munaxa-platform  ──►  munaxa-docs
```

That is the only edge. This repository must never depend on Munaxa School, Munaxa Work,
Munaxa Docs or Munaxa Corporate, and the platform must never depend on this repository.
CI enforces the first half of that in the `boundaries` job.

## What this repository owns

Business logic, the API, the database and its Prisma schema and migrations, routing,
domain models, permissions, workflows, and every Munaxa Docs-specific feature.

## What it does not own

The design system. Components, tokens, themes, icons and typography are installed:

| Need                        | Package                | Published |
| --------------------------- | ---------------------- | --------- |
| Components, patterns, hooks | `@munaxa/ui`           | Yes       |
| Design tokens               | `@munaxa/tokens`       | Yes       |
| Themes                      | `@munaxa/theme`        | Yes       |
| Icons                       | `@munaxa/icons`        | Yes       |
| Typography                  | `@munaxa/typography`   | **Not yet** — carried by `@munaxa/theme` until it exists |
| Shared helpers              | `@munaxa/utils`        | **Not yet** — `@edms/utils` holds this product's helpers meanwhile |

The last two rows are the platform's intent, not its registry. Neither package resolves from
GitHub Packages today, so a helper that belongs there has nowhere to go yet; keep it in
`@edms/utils` and move it when the package lands. The [Phase 19 compliance
report](./docs/reports/phase-19-shared-platform-compliance.md) names the three helpers that
should go first.

If something shared is missing, add it to
[munaxa-platform](https://github.com/tam2om/munaxa-platform) — never rebuild it here. A
component copied into a product is the failure mode this whole architecture exists to
prevent.

## Branding

Branding is configuration, not code. The only visual difference between this product and
the others is the theme it imports:

```css
/* apps/<app>/src/app/globals.css */
@import 'tailwindcss';
@import '@munaxa/theme/css/docs';
@source '../../node_modules/@munaxa/platform/dist';
```

Never hardcode a colour, a font, a radius or a shadow. The Munaxa Docs palette is authored in
the platform, and retuning it there updates this product with no change here.

## Expected layout

```text
munaxa-docs/
├── apps/
│   ├── api/        # the product API
│   ├── web/        # the product's web client — the document workspace
│   └── worker/     # background jobs
├── packages/       # domain, contracts, utils, i18n — this product's own
├── prisma/         # this product's schema and migrations, shared with no one
├── infra/          # compose stack, database roles, RLS, and the load harness
└── Dockerfile      # three targets from one commit — api, web, worker (Phase 18)
```

> A mobile client is named in the Phase 0 design and is not built. Phase 17 was the phase that
> would have needed one, and it did not: what the brief asked for is a *machine-callable* API, and
> what that needs is a credential model rather than a client. An empty app would still only be a
> directory to maintain.

## Status

The architecture is designed, the phase specifications are written (see `docs/` and `prompts/`),
and the product is built through **Phase 18**:

- **Phase 0.5** — the technical skeleton: three applications, four packages, fifteen domain modules
  with enforced layer boundaries, ports for every external capability, the message pipeline, the API
  and frontend foundations, the database foundation with row-level security.
- **Phase 1** — authentication, the permission catalogue, the hash-chained audit trail, optimistic
  locking, the transactional outbox, settings, and the organisation scope tree.
- **Phase 2** — the whole of Administration: sixteen areas of tenant configuration, on the API and
  the web.
- **Phase 2.5** — per-tenant infrastructure ([ADR-0015](./docs/architecture/adr/0015-database-per-tenant.md)):
  a database, a storage location and a search index per tenant, resolved through a registry.
- **Phase 3** — the document library. The first phase to store a customer's own bytes: two storage
  adapters, content-addressed and deduplicated blobs behind the antivirus gate, the controlled record
  and its business metadata, folder and library navigation, favourites, recents, duplicate detection
  and the upload-time thumbnail.
- **Phase 4** — the approval engine, and the async half of the architecture. Submission, approval,
  rejection, return for modification, sequential and parallel routing from one primitive, conditional
  stages, deadlines against a working-day calendar, reminders, escalation, the approval timeline and
  the task inbox — plus the transactional outbox dispatcher and the queue adapter, neither of which
  had ever run.
- **Phase 5** — document numbering. Phase 2's rules and sequences finally draw: reservation at
  submission, assignment inside the approval's own transaction through the seam Phase 4 left
  unbound, a voided value never returned to the pool, gapless mode, manual assignment and held
  blocks — every issued value recorded forever in `number_reservation`.
- **Phase 6** — revision control. The revision architecture made real: publication superseding the
  prior revision in one transaction, the check-out lock with its race decided by a partial unique
  index, check-in creating the next controlled revision beneath the still-effective published one,
  restore as a row rather than a copy, the revision timeline and the compare API — and the version
  badge beside the number, never inside it.
- **Phase 7** — document preview. `RENDERER_REGISTRY` finally binds, with four independent
  plugins; the preview lanes finally consume — rendering behind the antivirus gate, idempotent
  under redelivery, OCR in its own slow lane; the confidentiality columns finally mean something —
  `allow_print` refuses, `watermark` is burned into the served rendition per viewer; the compare
  API's text state fills in from extracted text; and the document screen gains the modular viewer
  with zoom, rotate, page navigation, in-document search, fullscreen and gated print.

- **Phase 8** — search. The `search.index` lane Phase 0.5 declared and Phase 7 filled is finally
  consumed: a coalescing consumer, an idempotent projection into the weighted per-tenant index,
  the permission predicate pushed into the query before scoring — computed by the first real
  `ACL_RESOLVER` binding, one implementation serving both the index and the API — Arabic
  normalisation in the query path, keyset pagination, saved and recent searches, the audited
  `search:all` bypass, and the resumable shadow-table rebuild that never empties a live index.

- **Phase 9** — audit and compliance. The half of the audit architecture that reads: `AUDIT_SERVICE`
  bound at last, the document timeline filtered at its subject through the resolver Phase 8 bound
  rather than by a second predicate, the audit search behind `audit:view`, the chain's digest widened
  to cover the reason, the delegate and the sequence — versioned rather than backdated, because the
  table refuses the `UPDATE` that would rehash it — signed daily checkpoints kept in a store the
  database cannot reach, the verification job finally firing on a named schedule, read auditing
  buffered as 13 §5 had specified since Phase 0, evidence bundles streamed to storage with a manifest
  that states exactly what each row's digest attests, and `ACCESS_DENIED` given the writer 08 §7 has
  required since Phase 1.

- **Phase 10** — soft delete and retention. The two halves of one capability, introduced to each
  other: `DOCUMENT_DELETION_RULES` is the single answer to "what does deleting this cascade to"
  after Phase 3, Phase 2 and Phase 6 had each answered it locally and incompatibly — a document
  with four revisions gave back one reference, so its blobs could never reach zero and the sweep
  that reclaims at zero was never written. Now the delete takes every revision and gives back every
  reference, a folder's delete reaches the documents inside it, and both are stamped with one
  cascade identifier so a restore reverses exactly one delete. The recycle bin 16 §2 named in
  Phase 0 exists; a delete states a reason, recorded in the trail's own `reason` column where
  Phase 9's widened digest attests it; `ErrorCode.LEGAL_HOLD` is finally thrown by something; the
  `retention.run` lane is consumed with both of its schedules; and the purge destroys a record
  while its trail survives — with `document_tombstone` holding the document number where the purge
  cannot reach, because `audit_event` refuses `DELETE` to every role and the payloads already
  written cannot be rewritten to carry it.

- **Phase 11** — delegation. The most carefully pre-cut seam in the product, bound at last:
  `DELEGATION_REPOSITORY` and `DELEGATION_SERVICE` had been declared since Phase 0.5 with no table
  behind them, and `Permission.DELEGATION_MANAGE` had been seeded to two roles as an `own` scope
  whose use case did not exist. 07 §4's first sentence decides the shape — delegation is a **routing
  overlay, never a permission grant** — so nothing in this phase writes `assignee_id`: a delegate
  decides a task that stays the delegator's, and a revocation reverts in-flight work by having
  nothing to reassign. Authority is read at the instant of the decision from the delegator's current
  grants rather than copied onto the delegation at creation, which is §4's rule made
  unrepresentable to get wrong; a chain is bounded by arithmetic and a cycle refused before any
  tenant setting is consulted; an emergency delegation bypasses the approval and nothing else, with
  its stated ground in `audit_event.reason` where Phase 9's digest attests it. Expiry is a predicate
  in the authority query, so a stalled queue can never leave an authority in place — the
  `identity.delegation` lane exists only to *record* what the predicate already enforced. And 08 §3
  lost its "active delegations" clause rather than the ACL resolver gaining a subject, because a
  delegation that could be named in an ACL entry would be the permission grant §4 says it must never
  be.

- **Phase 12** — notifications. The framework Phase 1 built and gave no producers, finally called:
  `notifications.deliver` was the last declared lane in the product without a subscriber, and the
  four phases that deferred delivery here in the same words — *the outbox row is the record until a
  consumer exists* — are discharged. Nineteen catalogue entries with EN and AR templates for every
  channel each offers; three workflow events where one had been carrying three meanings; a digest
  whose list is composed in code and handed to a renderer that still does substitution and nothing
  else; quiet hours as a clock face rather than two timestamps; a suppression keyed by the mailbox
  rather than by a person, alerting once and recorded in the trail under the one audit action this
  phase added; and one summary where a sweep would otherwise have sent five hundred. Its central
  safety property is that **no recipient list derived from a document reaches a renderer without
  every name in it passing the ACL resolver** — a notification that tells somebody a document
  exists is a disclosure even when the link then refuses them. And the outbox routing table was
  found to have been silently discarding every `delegation.*` event since Phase 11, which is now a
  test rather than an assumption.

- **Phase 13** — the dashboard. The last Phase 0.5 module whose contracts shipped and were never
  implemented, and the one whose own README named the way it would most likely be got wrong: *the
  dashboard owns no data; it composes what other modules already expose, so a widget cannot become a
  second, divergent definition of "overdue"*. That is a rule a dashboard can break on every widget,
  so it is enforced rather than written down — **the module has no `infrastructure/` and no reachable
  Prisma import**, and what it needs is declared as eight ports the owning modules implement, each
  built from the predicate its own list is built from. Three predicates were extracted to make that
  literal, and there is now exactly one `dueAt < now` in the workflow module. Its central safety
  property is that **a count is a disclosure**: every user widget is a query whose predicate names the
  caller, with no parameter by which to ask about anybody else; every tenant-wide widget is gated on
  the permission that already governs the screen it summarises, and is **absent rather than zero**
  when the caller does not hold it — because "you may not ask" and "there are none" are different
  answers, and collapsing them would make the first screen everybody opens a daily report on how much
  exists in the parts of the tenant they cannot see into. Nothing is cached, on the most-loaded route
  in the product, because a cached count is a stale count somebody acts on; each widget composes in
  its own transaction so a failing source degrades one card rather than the page; and the whole
  screen costs a number of queries bounded by widgets and independent of rows, asserted rather than
  assumed. It adds no table, no permission and no audit action — a dashboard that writes nothing
  needs none — and it discharges four earlier phases' limit rows: Phase 9's activity feed, as the
  caller's own; Phase 10's disposition and hold figures; Phase 11's delegation widget, including the
  "who is covering for whom" clause, by declining it; and Phase 12's unread badge.

- **Phase 14** — enterprise security. The ACL phase, and the one the product had been deferring to by
  name since Phase 8. `acl_entry` is the table ADR-0005 has described since Phase 0 and nothing had:
  08 §3's steps 3–5 have found nothing since the resolver was bound, because what they read did not
  exist. They read it now, and the model is unchanged — capability from roles, reach from entries,
  both required. `PrismaAclResolver` is **extended rather than rebuilt**, which was the test the
  phase set itself: its four methods keep their signatures and not one caller of `ACL_RESOLVER`
  changed, while the answers behind them became object-dependent for the first time. Behind them are
  the chain assembled from ADR-0014's materialised paths at one query per *table* rather than per
  ancestor, deny winning at any level, and a folder that may stop inheriting — truncating the chain
  for **both** effects (ADR-0016), because a break that stopped grants and let refusals through
  would be a flag whose behaviour an administrator cannot read off the screen. `*:manage` and
  `audit:*` cross it regardless, so nobody can hide a subtree from the people accountable for it.
  `@ScopedTo` went onto the object routes, so `AclGuard` fires for the first time in the product's
  life and Phase 9's `ACCESS_DENIED` is finally reached — and making it fire found a defect six
  phases old: a token carries role *keys* and the resolver was comparing them against UUIDs, matching
  nothing, invisible because nothing that could observe a grant had ever run with a non-empty role
  list. The document list gained the predicate inside `whereFor` rather than in its service, which
  is what made Phase 13's promise true — its counts inherited the filter in the same commit and
  `dashboard.service.ts` did not change — so a document the caller cannot reach is *absent* from the
  list and from its total rather than fetched and hidden. 08 §8's cache arrives with the walk exactly
  as the resolver's own comment predicted, invalidated by prefix inside the transaction that changed
  an answer; an ACL change re-projects the affected search subtree one page at a time rather than
  rebuilding an index that must never be emptied. ADR-0005 asked for one mitigation by name and
  `Decision.decidedAt` had carried the field unread since Phase 0.5 — the permissions screen now
  shows, for any user and object, the effective permission *and the node that decided it*, with the
  chain rendered whether or not anything is broken, because an over-broad allow is loud and a deny
  that inherits too far is silent. And `user.mfa_enrolled` — read by the auth response and the admin
  view since Phase 1, written by nothing — stopped being a boolean that answers "no" whatever the
  truth is: TOTP is enrolled, proved, challenged at sign-in and recorded, with WebAuthn and the role
  policy deferred to 17 rather than half-built here.

- **Phase 15** — enterprise reporting. The last Phase 0.5 module whose contracts shipped and were
  never implemented — four files, a bare `@Module({})`, and a `REPORT_DEFINITION_REPOSITORY` with no
  table behind it. Its `ports.ts` had already decided the two things that mattered, and neither was
  re-decided: every row is permission-scoped to the caller *in SQL*, which only Phase 14's
  `visibilityFilter` regions made expressible, and large exports are queued rather than streamed from
  a request. What the phase had to decide is that **a report is the first thing in this product
  designed to aggregate across everything**, and four phases of narrowing run through it: Phase 8's
  predicate in the query, Phase 13's tile that is absent rather than zero, Phase 14's document absent
  from a list *and its total*. So a catalogue entry's permissions are a **conjunction** — the deleted
  report requires `document:restore` because that is where ADR-0010 put the recycle bin, the expired
  report `retention:manage`, the audit report `audit:view` — and **a report never widens the audience
  of the surface it summarises**. Its rows are scoped by the module that owns the table, over the
  predicate that module's own list is built from, so `whereFor` and `approvalTaskWhere` are called
  rather than reimplemented; materialised read models and the search index were both weighed and both
  rejected, and the report says what each would have cost. The audit report is a projection over the
  audit module's *own* reader rather than a second query beside it, because 08 §10's decision that
  the trail is not ACL-filtered has exactly one place it can live. Exports go to CSV — with the
  formula neutralisation that uniform quoting does not give — to **SpreadsheetML 2003**, which is a
  real Excel format and is honestly not XLSX because a ZIP writer would end the streaming this lane
  exists for, and to PDF, which is lossy for Arabic and *counts and reports* every character its font
  could not encode. And an export runs under the **requester's** reach, with their roles read at the
  instant it runs rather than snapshotted when it was asked for — because a consumer's context has no
  user in it and `visibilityCondition` answers a subject-less caller with an empty predicate, which
  would have made every export a copy of the whole tenant. "Scheduling ready" ships the lane, the
  record, the idempotent claim and the audited run, and names the phase that closes the rest rather
  than adding a fifth declared-but-unbound contract.

- **Phase 16** — advanced document features. Twelve brief items that are three groups, and sorting
  them was the first decision of the phase: OCR, watermarks, thumbnails, compare and storage
  deduplication were built in Phases 3, 6 and 7, so what remained of them was discharging four named
  limit rows — three of which share one blocker and stay open, because `sharp` sits in the store
  linked into no workspace package and `@pdf-lib/fontkit` is absent from it entirely, both answered
  with a command rather than an assumption. The fourth is partly closed by an observation rather than
  a dependency: **rasterising a page was never what an image-only PDF needed**, because a scanned
  page already *is* a raster — a `/DCTDecode` XObject whose stream bytes are a JPEG — so it is lifted
  out and read with no decoding and nothing new in the lockfile. Templates and signatures appeared
  nowhere in the architecture, and the second is the item most likely to be got wrong: "digital
  signature" means at least four things, and [ADR-0017](./docs/architecture/adr/0017-electronic-signature-as-witnessed-attestation.md)
  argues all four before choosing a **21 CFR Part 11 §11.50 manifestation** — printed name, instant,
  meaning — bound under §11.70 to the revision's content digest and witnessed by the server with
  Phase 9's own construction, explicitly **not** an eIDAS qualified signature and never called one on
  any surface. `document:sign` is seeded to no role including the tenant administrator, which is
  08 §6's first deliberate row applied a second time. But the phase's centre of gravity is the five
  bulk operations, and its central safety property is that **a bulk operation is N single-object
  decisions that happen to have been asked for together, never one decision applied to N objects**:
  the tempting implementation resolves reach once and writes to a list the client supplied, which is
  the fetch-then-filter 08 §7 forbids, wearing a new hat and writing rather than reading. So reach is
  resolved *per object*, through the same `ACL_RESOLVER` that answers `AclGuard`, inside the
  transaction that writes that object — stronger than the guard, which resolves once beforehand —
  and two callers sending the same identifier list get different sets of applied rows. One
  transaction per object is what makes a legal hold refuse *its own document* while the batch
  completes, and what keeps each object's audit row committing with its own change; an operation
  writes **N + 1** rows and never an identifier list, because a document's timeline must not skip the
  day it was edited and "who ran the edit that touched four hundred documents" must still be
  answerable. Nothing is reimplemented — a bulk restore is `DefaultDocumentService.restore` called N
  times and a bulk approval is `WorkflowEngine.decide` called N times — so Phase 10's exact cascade
  and Phase 11's delegation authority survive untouched. Bulk export diverges from the two existing
  export mechanisms and says why: it moves bytes rather than rows, so it produces a manifest and one
  signed link per document rather than an archive, which keeps a release of five hundred documents
  writing five hundred `FILE_DOWNLOAD_ISSUED` rows instead of one and copies no bytes at all. And two
  claims older phases made became true: 18 §7's storm control finally has a storm to control —
  `bulk.operation-completed` is the second coalesced family after `retention.due`, addressed to the
  requester alone because a *summary* cannot pass every name through the ACL resolver the way a
  per-object notification does — and 19 §5's "per-tenant concurrency caps" stopped being false, with
  `perTenantConcurrency` declared per lane, absent by default, and enforced on the one lane a single
  tenant can flood.

Each report says what its phase deliberately left out.

The rules above are enforced rather than described: layer and module boundaries are lint rules
in `apps/api/eslint.config.mjs`, and the cross-product ban is the `boundaries` job in CI.

Each phase's report records what it left owing, in `docs/reports/`. The most recent is
[`phase-15-reporting.md`](./docs/reports/phase-15-reporting.md);
the original gate is
[`phase-0.5-architecture-compliance-report.md`](./docs/reports/phase-0.5-architecture-compliance-report.md).

- **Phase 17** — the integration platform, and the phase whose first decision was that its eleven
  brief items are four groups. **SSO, LDAP, Azure AD and Google Workspace are not four
  integrations**: 17 §2 had already decided the shape, and Entra ID and Google Workspace are OIDC
  providers differing in a discovery URL and a claim name — both columns — so building three
  adapters would have been building one adapter three times. LDAP is a wire protocol needing a
  dependency the lockfile cannot gain, and "Microsoft 365" is not authentication at all but a
  *content* integration; both are named rather than half-built. Verification is hand-written over
  `node:crypto` and contains **no cryptography** — Node imports a JWK and verifies RS256 and ES256
  natively — so what is written is four comparisons a reader can check by eye, which is why it is
  not the trade Phase 14 refused for CBOR and this phase refuses for XML-DSig. But the phase's
  centre of gravity is a caller that is not a person, and its central safety property is that
  **`RequestContext.userId` is the subject of every reach decision in this product**:
  `visibilityCondition` answers a subject-less caller with an *empty predicate*, which is every
  document in the tenant, so a machine token authenticating as nobody would have turned every list
  route into a full tenant dump with nothing logging an error and every `403` passing.
  [ADR-0018](./docs/architecture/adr/0018-machine-identity-as-a-delegated-subject.md) makes a key a
  **delegated subject** — bound to a person, narrowed by scopes that can only intersect, both read
  at authentication rather than snapshotted — so not one caller of `ACL_RESOLVER` changed and the
  suite proves it by giving two keys the same list request and different totals. A key nameable in
  an ACL entry was the refused alternative, on Phase 11's exact reasoning about delegation. Webhooks
  are their own delivery path and
  [ADR-0019](./docs/architecture/adr/0019-webhooks-are-not-notifications.md) argues why: Phase 12's
  central safety property is a per-person ACL walk and an endpoint is not a person, so
  `NotificationChannel.WEBHOOK` is a value nothing will ever use and 18 §3 now says so. The envelope
  carries identity and never content, the timestamp is inside the signed string so a replay window
  is enforceable, and a dead delivery keeps its bytes. The outbox routing table's **default**
  changed from nowhere to the webhook lane — the first consumer for which a dropped family is total
  rather than partial, and the defect that table has had twice. 13 §6's SIEM row is discharged for
  three phases at once, in both shapes, over a sequence that is gap-free by construction. And 17
  §6's SSRF row stopped being unfalsifiable: three of the phase's four capabilities are structurally
  "post this to wherever the customer says", so `OUTBOUND_HTTP_PORT` is the only outbound path, with
  an operator-owned allow-list that is **empty by default**, every resolved address checked, the
  connection pinned to the address that was checked, and no redirects at all.

- **Phase 18** — production readiness, and the phase whose sixteen brief items were mostly seams
  that already existed. `METRICS` and its label rule had been declared since Phase 0.5 with
  `grep -rn "provide: METRICS"` finding **nothing**, and the debt report said why — *"which backend
  a deployment scrapes is an operational decision, and binding one now would make it an
  architectural one"*. It binds behind a driver, the way `STORAGE_DRIVER` already does, and exports
  by **pull**, which is what keeps Phase 17's outbound boundary the only one; the label rule stopped
  being a comment and became a catalogue the exporter enforces, so the tenant id that would take a
  metrics backend down is unrepresentable rather than discouraged. Tracing got the different answer
  the same question deserves: **one span per request and none below it**, because a span per
  repository call is a span per row on the most-loaded route in the product. Three named-owner rows
  are discharged. Phase 15's evidence-CSV finding is fixed *without* the silent change it warned
  against — the rendering rule is now a **profile the manifest states**, so old bundles reproduce
  byte-for-byte and a differing digest has an explanation in the file rather than in somebody's
  memory. Phase 14's "key management service" row turned out not to be a request for an integration:
  [ADR-0020](./docs/architecture/adr/0020-key-management-and-rotation.md) argues that the
  deployment's secret store already *is* one, and what was owed is one key per purpose and a
  rotation each sealed value can survive — so `MFA_TOTP_SEALING_KEY` is its own secret and a stale
  row re-seals the next time its owner proves a code, which is the only moment the plaintext and a
  proof of it exist together. And Phase 12's SMTP refusal was answered rather than overruled: its
  objection was that an untested hand-rolled client is the larger risk, so the message building is
  pure and unit-tested and the session runs against transcripts of real servers over a loopback
  socket including a genuine STARTTLS upgrade. **The integrity sweep 17 §8 promised in Phase 0
  exists**: a nightly pass re-reads stored blobs, and a mismatch quarantines the blob through the
  same gate an infected one fails, writes the `INTEGRITY_MISMATCH` row 13 §2 has carried since the
  beginning with nothing writing it, and raises the incident. The images are real and CI builds all
  three, because a Dockerfile nothing builds is a placeholder that stays plausible until a release
  engineer runs it under pressure. Two claims were made honest rather than met: 19 §8's load harness
  exists and records **no numbers**, because a load test needs a target and this product has no
  deployment; and 20 §5's Sentry and span-tree rows described exporters no build has ever contained,
  so both variables are now refused at boot rather than accepted and ignored.
