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

| Need                        | Package                |
| --------------------------- | ---------------------- |
| Components, patterns, hooks | `@munaxa/ui`           |
| Design tokens               | `@munaxa/tokens`       |
| Themes                      | `@munaxa/theme`        |
| Icons                       | `@munaxa/icons`        |
| Typography                  | `@munaxa/typography`   |
| Shared helpers              | `@munaxa/utils`        |

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
└── infra/          # compose stack, database roles, RLS
```

> A mobile client is named in the Phase 0 design and is not built: no phase before 17 needs
> one, and an empty app would only be a directory to maintain.

## Status

The architecture is designed, the phase specifications are written (see `docs/` and `prompts/`),
and the product is built through **Phase 14**:

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

Each report says what its phase deliberately left out.

The rules above are enforced rather than described: layer and module boundaries are lint rules
in `apps/api/eslint.config.mjs`, and the cross-product ban is the `boundaries` job in CI.

Each phase's report records what it left owing, in `docs/reports/`. The most recent is
[`phase-14-security.md`](./docs/reports/phase-14-security.md);
the original gate is
[`phase-0.5-architecture-compliance-report.md`](./docs/reports/phase-0.5-architecture-compliance-report.md).
