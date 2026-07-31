# Munaxa Docs

Product root for **Munaxa Docs**, the Enterprise Document Management System (EDMS).

**Nothing is implemented here yet.** Phase 0 designed the architecture; this folder currently holds
that design only. Phase 0.5 builds the technical skeleton against it.

> **Why `edms/` and not `docs/`?** The repository's documentation index already owns
> [`docs/`](../docs/README.md). See
> [ADR-0001](./docs/architecture/adr/0001-product-root-placement.md) — this is the one Phase 0
> decision worth confirming before Phase 0.5 creates code under it.

## What this product is

An enterprise document control system: controlled documents, approval workflows, revision control,
document numbering, retention, full auditability and compliance evidence. It is **not** a file
share and not a drive clone. A file is an artefact; a *document* is a controlled business record
with an identity, a number, a lifecycle, an owner and an audit history.

## Start here

| Read | For |
| --- | --- |
| [`../PLATFORM_ENGINEERING_STANDARDS.md`](../PLATFORM_ENGINEERING_STANDARDS.md) | **Mandatory.** How work is done in this repository |
| [`docs/README.md`](./docs/README.md) | The Munaxa Docs documentation index |
| [`docs/architecture/README.md`](./docs/architecture/README.md) | The binding Phase 0 blueprint |
| [`docs/reports/repository-analysis.md`](./docs/reports/repository-analysis.md) | What already exists and must be reused |

## What already exists for you

Munaxa Docs is a peer product of School and Work. It consumes the shared platform and copies
nothing from School — [products must never import another product](../PLATFORM_ENGINEERING_STANDARDS.md#4-dependency-rules).

| You need | Where it comes from |
| --- | --- |
| Components, layouts, app shell | `@axa/platform` |
| Design tokens | `@axa/platform/tokens` |
| Icons | `@axa/platform/icons` |
| Theme registry | `@axa/platform/themes` |
| The Docs theme | `@import '@axa/platform/css/themes/docs';` |

The Docs palette is already authored — [`platform/themes/docs/`](../platform/themes/docs). Starting
this product requires no platform change.

## Planned shape (Phase 0.5)

```text
edms/
├── apps/
│   ├── api/          @edms/api      NestJS 11 — modular monolith, Clean Architecture
│   ├── web/          @edms/web      Next.js 15 App Router — the document workspace
│   └── worker/       @edms/worker   background jobs: preview, OCR, index, retention, escalation
├── packages/
│   ├── domain/       @edms/domain   permissions, roles, enums, pure rules — no I/O
│   ├── contracts/    @edms/contracts shared request/response schemas
│   ├── i18n/         @edms/i18n     EN + AR catalogues
│   └── utils/        @edms/utils    pure helpers
├── prisma/           schema, migrations, seed
├── infra/            compose fragments, storage and search bootstrap
└── docs/             this design set
```

Full reasoning: [`docs/architecture/01-monorepo-and-folder-structure.md`](./docs/architecture/01-monorepo-and-folder-structure.md).
