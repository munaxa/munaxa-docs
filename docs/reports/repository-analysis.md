# Repository Analysis — Phase 0

**Purpose:** what this repository already contains, what Munaxa Docs reuses, and what it must not
duplicate.
**Audience:** anyone starting Phase 0.5.
**Status:** point-in-time report, 2026-07-31. Historical evidence — not edited afterwards.

## 1. Method

Read: the root `README.md`, `PLATFORM_ENGINEERING_STANDARDS.md`, `docs/README.md`,
`pnpm-workspace.yaml`, root `package.json`, `turbo.json`, `docker-compose.yml`, `render.yaml`,
`work/README.md`; the platform's architecture index and component tree; School's architecture set
(00, 02, 03, 06), its API module list, its packages, its Prisma schema size and its permission
catalogue.

Searched for existing implementations before designing anything: file/upload components, workflow
and approval components, data grids, permission catalogues, storage adapters, queue infrastructure,
search infrastructure, audit implementations.

## 2. What exists

### The workspace

pnpm 10 workspace + Turborepo, Node ≥ 22, TypeScript 5.7, Prettier as the sole formatter, husky +
lint-staged, shared ESLint and TypeScript configs in `tooling/`. Root scripts (`build`, `lint`,
`typecheck`, `test`, `validate`, `format`) fan out through turbo. Members today: `tooling/*`,
`platform`, `school/apps/api`, `school/apps/admin`, `school/munaxademo`, `school/landing`,
`school/packages/*`.

### The platform (`@axa/platform`) — frozen, and directly reusable

Tokens, typography, themes, icons, and a large UI layer: `ui/components` (including `data-grid`,
`files`, `flow`, `forms`, `feedback`, `navigation`, `date`, `board`), `ui/layouts`, `ui/patterns`,
`ui/shell`, `ui/hooks`, `ui/charts`.

Components that map directly onto EDMS screens, found by search rather than assumed:

| Platform component | Munaxa Docs use |
| --- | --- |
| `components/files/dropzone.tsx` | Upload UI — **do not write a second dropzone** |
| `components/files/file-manager.tsx` | Folder browser shell |
| `components/flow/approval-flow.tsx`, `flow/workflow.tsx` | Workflow progress and definition visualisation |
| `components/data-grid/` (with virtual rows) | Every document list |
| `ui/shell/` (app shell, sidebar, top bar, navigation drawer) | The workspace shell |
| `ui/layouts/` (workspace, split, resizable, panel) | Record workspace with a preview pane |
| `ui/patterns/` (stepper, progress, stat-card, dashboard) | Approval steps, dashboards |

**The `docs` theme already exists** (`platform/themes/docs/`: `brand.ts`, `palette.css`,
`index.css`). Starting this product requires **no platform change** — which is the outcome the
rulebook wants.

### School — a pattern reference, never a dependency

NestJS 11 + Prisma 6 + PostgreSQL API with ~35 modules; Next.js 15 + React 19 admin; packages for
`domain` (permission catalogue, roles, tenant), `contracts`, `i18n`, `utils`; a 6 077-line Prisma
schema; Flutter mobile app.

Patterns worth copying **by reading, not by importing**:

- Multi-tenant isolation: JWT claim → `AsyncLocalStorage` → guard → Prisma middleware → RLS on a
  restricted `NOBYPASSRLS` role, with the role provisioned in `school/infra/postgres/app-role.sql`.
- API conventions: `/api/v1`, RFC 7807-style errors, `Idempotency-Key`, allow-listed filters,
  Swagger from decorators, `packages/contracts` as the shared source of truth.
- The permission catalogue shape (`resource:action` constants in `packages/domain`), grown
  phase-by-phase with comments explaining each group.
- ADR practice and a documentation index that every document is registered in.

### Infrastructure already proven here

`docker-compose.yml` provides PostgreSQL 16 (with the restricted app role provisioned at init),
Redis 7, LocalStack S3 and MailHog. `render.yaml` shows the staging blueprint pattern. School's API
already depends on `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, so presigned
direct-to-storage upload is a proven path in this repository.

## 3. What Munaxa Docs reuses vs. builds

| Capability | Decision | Why |
| --- | --- | --- |
| UI components, tokens, icons, theme, shell | **Reuse** `@axa/platform` | Repository law; the `docs` theme exists |
| Workspace tooling (pnpm, turbo, ESLint, TS configs, prettier, husky) | **Reuse** | Register the new packages, change nothing else |
| Local dev stack shape (Postgres, Redis, S3, mail) | **Reuse the pattern**, add product-specific compose fragments | Same shape, own services |
| Tenant isolation, API conventions, permission-catalogue shape, ADR practice | **Copy the pattern, write the code** | Products may never import one another |
| Domain model, database, workflow engine, numbering, revisions, storage service, search, audit, preview | **Build in `edms/`** | This is the product |
| School's document/PDF generation module (`school/apps/api/src/documents`) | **Not reused** | It generates PDFs from templates; it is not document control. Different problem, same word |

## 4. Gaps this product must build for itself

No queue infrastructure exists in this repository yet (Redis is in compose but nothing consumes it —
no BullMQ dependency in any app). No search infrastructure. No storage abstraction — School calls
the S3 SDK directly. No append-only audit implementation. No renderer/preview pipeline. Each is a
first for the repository, and each is designed in the architecture set accordingly.

## 5. Architectural observations

1. **The platform is genuinely product-agnostic.** Nothing in `platform/ui` names a school concept;
   the EDMS is its second real consumer, which is exactly when promotion decisions become honest.
2. **No duplicated domain logic to inherit.** Because products cannot import each other, there is no
   shared business layer to untangle — the cost is re-implementing tenancy and API scaffolding, and
   that cost was accepted deliberately when the rule was written.
3. **The `docs` theme predates the product.** It was authored so the design system had a third
   consumer to be designed against; it now has a real one.
4. **The root workspace has one School-specific leak**: the root `package.json` `prisma.schema` key
   and the `prisma:*` scripts point at School. Adding a second Prisma product makes that ambiguous —
   recorded in [technical debt](./technical-debt.md).
5. **A stray tracked file exists at `ui/components/files/index.ts`** — a duplicate of the platform's
   `files` barrel outside any workspace member. Also recorded in technical debt.

## 6. Duplication risks for Phase 0.5

| Risk | Guard |
| --- | --- |
| Writing a dropzone, file manager, data grid or approval-flow component | They exist in `@axa/platform` — §2 lists the paths |
| Copying `@school/domain`'s permission constants | Different catalogue; write the EDMS one, same *shape* |
| Copying School's tenancy code file-by-file | Prohibited as an import; re-implement from the documented design |
| A second theme or palette for "documents" | `platform/themes/docs/` is authoritative |
| A second toast, dialog, table or button | Always wrong ([rulebook §6](../../../PLATFORM_ENGINEERING_STANDARDS.md#6-reuse-and-duplication)) |

## 7. Searches performed

`export function|export const` across `platform/ui` and `school/apps` for: dropzone, file manager,
data grid, workflow, approval, stepper, tree; `bullmq|ioredis|meilisearch|@elastic|nodemailer|resend`
in every app manifest (only `firebase-admin` and `pdfkit` matched — no queue, no search, no mail
abstraction); `permissions.ts` in `school/packages/domain`; the whole `platform/themes/` tree for
`docs`. Findings are as recorded above; where a search found nothing, the gap is listed in §4.
