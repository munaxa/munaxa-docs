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
and the product is built through **Phase 11**:

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

Notifications are Phase 12, and each report says what its phase deliberately left out.

The rules above are enforced rather than described: layer and module boundaries are lint rules
in `apps/api/eslint.config.mjs`, and the cross-product ban is the `boundaries` job in CI.

Each phase's report records what it left owing, in `docs/reports/`. The most recent is
[`phase-11-delegation.md`](./docs/reports/phase-11-delegation.md);
the original gate is
[`phase-0.5-architecture-compliance-report.md`](./docs/reports/phase-0.5-architecture-compliance-report.md).
