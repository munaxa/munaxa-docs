# Munaxa Docs

Product root for **Munaxa Docs**, the Enterprise Document Management System (EDMS).

**The product is built through Phase 18: documents are created, submitted, approved, numbered,
published, revised, previewed, found, audited, deleted, delegated, reported on, done to many at
once, started from a controlled template, signed — and now reachable by another system.** Phase 0 designed the architecture and Phase 0.5 built the structure that implements it;
Phases 1 through 3 added authentication, the whole of Administration, per-tenant infrastructure and
the document library; Phase 4 added the approval engine — and with it the first background work this
product has ever run; Phase 5 gave an approved document its permanent number; Phase 6 added revision
control; Phase 7 the preview pipeline; Phase 8 search; Phase 9 the read half of the audit trail;
Phase 10 soft delete and retention; Phase 11 delegation; Phase 12 notifications — the framework
Phase 1 built with no producers, finally called; Phase 13 the dashboard; Phase 14 the ACL model made
real; Phase 15 enterprise reporting; Phase 16 the advanced features — five bulk operations whose
central rule is that each is N single-object decisions rather than one decision applied to N objects,
controlled templates, and electronic signatures that are a witnessed Part 11 attestation and are
never called qualified; Phase 17 the integration platform — a caller that is not a person,
outbound webhooks, federated sign-in and a SIEM stream; and Phase 18 production readiness — the
ports Phase 0.5 declared and bound to nothing, finally bound; the rolling integrity verifier 17 §8
promised in Phase 0; SMTP for the deployment a customer installs on their own server; and the
images, the runbooks and the security suite a release needs.

Read the most recent report before starting:
[Phase 5.1 — UI foundation completion](./docs/reports/phase-5.1-ui-foundation-completion.md), which
finishes the platform design system adoption and adds the stylesheet regression guard that makes
the Phase 19 defect impossible to repeat silently. Before it,
[Phase 19 — shared platform compliance and integration audit](./docs/reports/phase-19-shared-platform-compliance.md)
audits the eighteen phases rather than adding a nineteenth — note that its `SkipLink` finding is
corrected by Phase 5.1 §1.1. The last building phase is
[Phase 18 — production readiness](./docs/reports/phase-18-production-readiness.md).
The original gate is the [Phase 0.5 architecture compliance report](./docs/reports/phase-0.5-architecture-compliance-report.md)
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

The API's sixteen modules all share one shape; the map is
[`apps/api/src/modules/README.md`](./apps/api/src/modules/README.md).

## Running it

```bash
pnpm install                      # needs a read:packages token for @munaxa/* (see .npmrc)
pnpm docker:up                    # Postgres, Redis, MinIO — roles and RLS applied at first start
cp .env.example .env              # then fill in JWT_ACCESS_SECRET
pnpm prisma:generate
pnpm build && pnpm test
```

Building the images, migrating every tenant, releasing, restoring and recovering are
[`docs/operations/`](./docs/operations/README.md) — runbooks rather than architecture, added in
Phase 18 because 20 §§4, 6 and 7 had been pointing at procedures nobody had written down.

Redis is no longer optional. Phase 4 is the first phase with background work — the outbox dispatcher
and the workflow engine's deadline timers — and `QUEUE_CONSUMERS_ENABLED` says which processes run
it. It defaults to true, because a deployment where nothing consumes a lane is a deployment where
approval deadlines silently never fire. As of Phase 12 every declared lane has a consumer, and a
deployment that disables them everywhere is one where nobody is told anything.

Mail is configured but not required. `MAIL_DRIVER=NONE` is the default and the correct setting for
a development machine: in-app notifications are unaffected because the row *is* the delivery, and
every refused email is recorded rather than dropped. There are now two real drivers — `RESEND` for
the hosted service, and `SMTP` from Phase 18 for the deployment a customer installs on their own
server.

Telemetry leaves the process only if you say so. `METRICS_DRIVER=NONE` is the default and costs a
method call that returns; `PROMETHEUS` serves `GET /api/metrics` for a scraper to pull, behind its
own token. `SENTRY_DSN` and `OTEL_EXPORTER_OTLP_ENDPOINT` are **refused at boot** — this build
contains neither exporter, and a variable that is accepted and ignored is one an operator trusts
until the incident it was set for.

Full reasoning: [`docs/architecture/01-monorepo-and-folder-structure.md`](./docs/architecture/01-monorepo-and-folder-structure.md).
