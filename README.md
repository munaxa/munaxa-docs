# Munaxa Docs

Product root for **Munaxa Docs**, the Enterprise Document Management System (EDMS).

**Phase 0.5 is complete: the technical skeleton exists and there are no business features.**
Phase 0 designed the architecture; Phase 0.5 built the structure that implements it — apps,
packages, layers, ports, dependency injection, the message pipeline, the API and frontend
foundations, the database foundation and the test and DevOps foundations. No upload, no
approval, no workflow, no revision, no document. Phase 1 starts from here.

Read the gate before starting: [Phase 0.5 architecture compliance report](./docs/reports/phase-0.5-architecture-compliance-report.md)
and the [technical debt it records](./docs/reports/phase-0.5-technical-debt.md).

This is now an **independent repository**. It owns its own API, apps, database, migrations,
infrastructure and CI, and depends on no other product — see
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the rules that bind it.

> **On ADR-0001.** That ADR chose `edms/` over `docs/` to avoid colliding with the old
> monorepo's documentation index. The separation settles the question: this repository *is*
> the product, its architecture lives at [`docs/`](./docs/README.md), and the Phase
> specifications live at [`prompts/`](./prompts). The ADR is kept for the record.

## What this product is

An enterprise document control system: controlled documents, approval workflows, revision control,
document numbering, retention, full auditability and compliance evidence. It is **not** a file
share and not a drive clone. A file is an artefact; a *document* is a controlled business record
with an identity, a number, a lifecycle, an owner and an audit history.

## Start here

| Read | For |
| --- | --- |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | **Mandatory.** The dependency rules and what this repo may not own |
| [`docs/README.md`](./docs/README.md) | The Munaxa Docs documentation index |
| [`docs/architecture/README.md`](./docs/architecture/README.md) | The binding Phase 0 blueprint |
| [`docs/reports/repository-analysis.md`](./docs/reports/repository-analysis.md) | What already exists and must be reused |

## What already exists for you

Munaxa Docs is a peer product of School and Work. It consumes the shared platform and copies
nothing from School — [products must never import another product](./ARCHITECTURE.md).

| You need | Where it comes from |
| --- | --- |
| Components, layouts, app shell | `@munaxa/ui` |
| Design tokens | `@munaxa/tokens` |
| Icons | `@munaxa/icons` |
| Theme registry | `@munaxa/theme` |
| The Docs theme | `@import '@munaxa/theme/css/docs';` |

The Docs palette is already authored inside
[munaxa-platform](https://github.com/tam2om/munaxa-platform). Starting this product requires no
platform change — and no colour written here.

## Shape

```text
munaxa-docs/
├── apps/
│   ├── api/          @edms/api      NestJS 11 — modular monolith, Clean Architecture
│   ├── web/          @edms/web      Next.js 15 App Router — the document workspace
│   └── worker/       @edms/worker   background jobs: preview, OCR, index, retention, escalation
├── packages/
│   ├── domain/       @edms/domain    permissions, roles, enums, pure rules — no I/O
│   ├── contracts/    @edms/contracts shared request/response schemas
│   ├── i18n/         @edms/i18n      EN + AR catalogues
│   └── utils/        @edms/utils     pure helpers
├── prisma/           schema.prisma — tenant, audit, outbox, idempotency
├── infra/            compose stack, database roles, RLS, audit immutability
└── docs/             the design set
```

The API's fifteen modules all share one shape; the map is
[`apps/api/src/modules/README.md`](./apps/api/src/modules/README.md).

## Running it

```bash
pnpm install                      # needs a read:packages token for @munaxa/* (see .npmrc)
pnpm docker:up                    # Postgres, Redis, MinIO — roles and RLS applied at first start
cp .env.example .env              # then fill in JWT_ACCESS_SECRET
pnpm prisma:generate
pnpm build && pnpm test
```

Full reasoning: [`docs/architecture/01-monorepo-and-folder-structure.md`](./docs/architecture/01-monorepo-and-folder-structure.md).
