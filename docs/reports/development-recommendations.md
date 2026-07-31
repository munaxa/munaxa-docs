# Development Recommendations — Phase 0

**Purpose:** how to build phases 0.5 → 18 against this architecture without repeating known
mistakes.
**Audience:** whoever executes the next phase, human or AI.
**Status:** point-in-time report, 2026-07-31. Not edited afterwards.

## 1. Before Phase 0.5 starts

1. **Confirm the product root** — `edms/` or take over `docs/`
   ([ADR-0001](../architecture/adr/0001-product-root-placement.md)). It is a directory move today
   and a cross-cutting rename after packages, a Prisma schema and migrations exist.
2. **Confirm tenancy.** This design assumes multi-tenant SaaS with a single-organisation install as
   the same code with one tenant. If the product is single-organisation only, `tenant_id` and RLS
   still stay — removing them later is impossible, keeping them costs a column.
3. **Decide the identity source**: local accounts first with OIDC federation per tenant later, or
   federation from day one. It changes Phase 1's auth module, nothing else.
4. **Resolve D1 and D2** from the [technical debt report](./technical-debt.md) — the root Prisma
   scripts and the stray `ui/` folder. Both are small and both mislead the next reader.

## 2. Build order

The dependency direction in [02](../architecture/02-backend-architecture.md) is also the delivery
order. Building out of order means stubbing something that already exists.

```text
0.5  skeleton: apps, packages, modules, ports, DI, tenancy, health, CI
1    identity, organisation, RBAC + ACL resolver, audit spine, outbox
2    administration: types, fields, categories, confidentiality, settings
3    libraries, folders, permissions UI
4    storage + upload, documents (draft only), metadata
5    numbering
6    workflow engine, approval inbox
7    revisions: check-out/in, publish, supersede
8    preview + OCR
9    search
10   audit UI, evidence export
11+  retention, delegation, notifications, dashboards, reporting, integrations, hardening
```

Two rules about order. **Audit and the outbox come first**, in Phase 1, because retrofitting audit
onto twenty use cases is a rewrite. **Numbering comes before workflow**, because approval assigns
the number and a stub would be written and then thrown away.

## 3. Phase 0.5 specifically

Build: the workspace registration, the app skeletons, every module folder with its four layers,
every port interface with one adapter each, the tenancy stack end to end, the audit writer, the
outbox and dispatcher, config validation, health endpoints, the error filter, the CI pipeline, and
the isolation and boundary tests.

Do **not** build: any document, upload, approval, revision or workflow feature. The brief is
explicit and a skeleton with a real feature in it is not a skeleton.

The one thing to get exactly right: **the tenancy stack, with tests that prove isolation at each
layer independently** — including a test that connects as the application role with the guard and
extension bypassed and shows RLS alone still hides another tenant's rows. That test is the whole
value of Phase 0.5.

## 4. Rules for every phase

| Rule | Why |
| --- | --- |
| **Search before you create.** Say what you searched for and what you found | The platform already has the dropzone, file manager, data grid and approval flow ([repository analysis](./repository-analysis.md) §2) |
| **Never import `@school/*`** | Two products that import each other are one product |
| **Domain logic is a pure function first** | Lifecycle, numbering, ACL resolution and workflow evaluation are all testable with no database, and that is where the tests pay |
| **Every mutating endpoint carries a permission; every affordance reads `capabilities`** | The UI must never decide access |
| **Every state change writes audit in the same transaction** | An untraceable change is a compliance defect |
| **Every consumer is idempotent** | Delivery is at-least-once, always |
| **A new index names the query it serves, in the migration comment** | Indexes outlive the memory of why they exist |
| **Update the affected architecture document in the same commit**, and add an ADR when a real alternative was rejected | Documentation that lags is documentation that lies |
| **No placeholder, no TODO, no dead code** | [Rulebook §8](../../../PLATFORM_ENGINEERING_STANDARDS.md#8-code-quality-rules) |

## 5. Testing strategy

| Layer | What is tested | Where it pays |
| --- | --- | --- |
| Domain (pure) | Lifecycle transitions incl. every illegal one; number formatting per segment type; ACL resolution incl. deny precedence; workflow completion rules; retention date arithmetic | Highest value in the product — fast, deterministic, no fixtures |
| Application | Use cases against in-memory port doubles; transaction and audit assertions | Catches orchestration mistakes |
| Integration | Repositories against a real PostgreSQL; RLS isolation; number-sequence concurrency (100 parallel approvals, all distinct); outbox delivery | Catches everything the ORM hides |
| API | Contract tests per endpoint: permission enforcement, error shape, idempotency replay | Prevents silent contract drift |
| E2E | The controlled-document journey: create → submit → approve → number → publish → revise → supersede → archive | The one journey the product exists for |
| Non-functional | Load scenarios in `edms/infra/loadtest/`, measured per phase against [19](../architecture/19-performance-and-scalability.md) §1 | Regressions are caught in the phase that caused them |

Never delete or skip a failing test to go green. A failing test is information
([rulebook §10](../../../PLATFORM_ENGINEERING_STANDARDS.md#10-tests)).

## 6. For AI agents

1. Read, in order: the rulebook, this product's [architecture index](../architecture/README.md),
   the document for the area you are touching, then the code.
2. **Never invent a permission.** If it is not in `@edms/domain`, add it there first, and add it to
   the matrix in [08](../architecture/08-permission-model.md) in the same commit.
3. **Never write a UI primitive.** Compose from `@axa/platform`.
4. **Never bypass a guard, validator or lint rule** to make something pass.
5. Ask before choosing between two readings of an instruction that would produce materially
   different work; do not choose silently
   ([rulebook §1](../../../PLATFORM_ENGINEERING_STANDARDS.md#1-the-five-laws), law 5).
6. Report honestly: what was verified, what was not, and what remains.

## 7. Anti-patterns specific to this domain

| Anti-pattern | Why it kills EDMS projects |
| --- | --- |
| Treating a document as a file with a version column | Loses the identity, the approval binding and the number ([ADR-0003](../architecture/adr/0003-document-identity-revision-file-separation.md)) |
| Assigning numbers at creation | Burns numbers on abandoned drafts, and every user learns the numbers mean nothing |
| Hardcoding approval routes "for now" | "For now" becomes a release per customer |
| Fetch-then-filter for permissions | Leaks existence through counts and pagination, and is slow |
| Streaming files through the API | Couples file size to application capacity |
| Hard delete with backups as the safety net | A restore is an incident; a recycle bin is a click |
| Audit written after the fact, from logs | Gaps appear exactly where they matter |
| Rendering untrusted files in the API process | One crafted file, one breach |
| Building the workflow designer before the engine takes data | The designer ends up generating code |
| An exact count on every list page | The first thing to fall over at a million documents |
