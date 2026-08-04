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
and the product is built through **Phase 7**:

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

Search is Phase 8, and each report says what its phase deliberately left out.

The rules above are enforced rather than described: layer and module boundaries are lint rules
in `apps/api/eslint.config.mjs`, and the cross-product ban is the `boundaries` job in CI.

Each phase's report records what it left owing, in `docs/reports/`. The most recent is
[`phase-7-document-preview.md`](./docs/reports/phase-7-document-preview.md); the original gate is
[`phase-0.5-architecture-compliance-report.md`](./docs/reports/phase-0.5-architecture-compliance-report.md).
