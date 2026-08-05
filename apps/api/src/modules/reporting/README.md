# Reporting module

**Answers:** What is the state of the whole?

| | |
| --- | --- |
| **Owns** | The report catalogue, ReportDefinition, ReportExport, the `reporting.export` lane |
| **Depends on** | Document, Workflow, Storage, Identity, Organization, Retention, Audit |
| **Binds in core** | Nothing in core. |

## Layers

```text
reporting/
├── reporting.module.ts   composition for this module
├── domain/                    the catalogue, the parameter parser, the three writers — no Nest, no Prisma
├── application/               use cases and the ports this module declares
├── infrastructure/            Prisma repositories for **this module's two tables**, and the lane consumer
└── presentation/              controllers, DTOs, OpenAPI decorators, view mappers
```

The dependency rule points inward, and it is enforced by `eslint.config.mjs` at the app root,
not merely described here. Other modules call this one through its **application service** or
react to its **events** — never through its repositories or its Prisma models.

## The two rules a report obeys

Stated here and enforced in `domain/report-catalogue.ts`, which is where a report is added.

**1. A report never widens the audience of the surface it summarises.** A catalogue entry's
`permissions` is a *conjunction*: every one must be held, resolved through `ACL_RESOLVER` against
the tenant node before a row is read. `report:view` is on every report and alone on almost none —
the deleted report also needs `document:restore` (ADR-0010 §2's gate on the recycle bin), the
expired report `retention:manage`, the audit report `audit:view` (08 §10), users `user:manage`,
departments `org:manage`. A report that reached a row its own screen refuses would be a second
door, and the door would be the quiet one.

**2. A report's rows are scoped by the caller's reach wherever its subject has reach.** That is
not implemented here: the source ports are implemented by the module that owns the table, over the
*same* predicate its own list is built from — `PrismaDocumentRepository.whereFor`, and the
`visibilityFilter` regions Phase 14 put inside it. The total obeys it too, so a row the caller
cannot reach is absent from the page **and** from `meta.total`.

## Why this module has an `infrastructure/` and the dashboard does not

Phase 13 kept "the dashboard owns no data" true by giving that module nothing to own data *with*.
This module genuinely owns two tables, so the rule is narrower and still structural:
**`infrastructure/` reaches `report_definition` and `report_export` and nothing else.** A
`document.findMany` here would be a second definition of what a document population is, and the
report — a file somebody prints and circulates — would be the copy people believed.

`application/ports.ts` records the two readings that were rejected: materialised read models of its
own (a second invalidation story, for figures more staleness-sensitive than a search index), and
reading the search index (which holds documents and nothing else, so seven of the ten reports could
not be answered from it).

## Events published

| Type | Meaning |
| --- | --- |
| `reporting.export-ready` | A queued export finished and is available for download. |

## Audit actions written

| Action | When |
| --- | --- |
| `REPORT_EXPORTED` | Twice per export: when it is requested, with the parameters, and when it completes or fails. |

Running a report writes nothing — a read is not an act 13 §2 has a row for, and
`domain/audit-actions.ts` records why. Taking a completed export is `FILE_DOWNLOAD_ISSUED`, written
by Storage's own `createDownloadUrl`, which this module goes through rather than around.

## Phase 15 status

Built. `REPORTING_SERVICE` and `REPORT_DEFINITION_REPOSITORY` are bound, ten reports are served,
and exports are queued on the `reporting.export` lane and produced **under the requester's own
reach** — see `application/report-export.service.ts`, whose header explains why that is the single
most important line in this module.

What is deliberately not built: a `report_schedule` table. "Scheduling ready" is the lane, the
export record, the idempotent claim and the audited run — all of which exist and none of which is
specific to being asked for by a person. See `docs/reports/phase-15-reporting.md` for the phase this
is owed to.
