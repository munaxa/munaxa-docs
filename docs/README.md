# Munaxa Docs — documentation index

**Purpose:** the entry point to every Munaxa Docs document.
**Audience:** everyone building or reviewing Munaxa Docs, human or AI.

This product's documents live here. Repository-wide rules live in
[`PLATFORM_ENGINEERING_STANDARDS.md`](../../PLATFORM_ENGINEERING_STANDARDS.md); the repository-wide
index is [`docs/README.md`](../../docs/README.md). Where they disagree, the rulebook governs.

```text
edms/docs/
├── README.md            THIS INDEX
├── architecture/        the binding Phase 0 blueprint (00–20) + adr/
└── reports/             point-in-time Phase 0 findings — evidence, not guidance
```

## 1. Architecture — the binding blueprint

Every later phase conforms to these or supersedes them with an ADR. Index:
[`architecture/README.md`](./architecture/README.md).

| # | Document | Scope |
| --- | --- | --- |
| 00 | [System Architecture](./architecture/00-system-architecture.md) | C4 context and containers; the system at a glance |
| 01 | [Monorepo & Folder Structure](./architecture/01-monorepo-and-folder-structure.md) | Where every file goes, and why |
| 02 | [Backend Architecture](./architecture/02-backend-architecture.md) | Clean Architecture layers, modules, ports, DI |
| 03 | [Domain Model](./architecture/03-domain-model.md) | Bounded contexts, aggregates, ubiquitous language |
| 04 | [Domain Relationships & ERD](./architecture/04-domain-relationships-and-erd.md) | Every relationship, with cardinality |
| 05 | [Database Design](./architecture/05-database-design.md) | Tables, keys, indexes, constraints, tenancy, soft delete |
| 06 | [Document Lifecycle](./architecture/06-document-lifecycle.md) | States, legal transitions, illegal transitions |
| 07 | [Workflow Architecture](./architecture/07-workflow-architecture.md) | The configurable approval engine |
| 08 | [Permission Model](./architecture/08-permission-model.md) | RBAC, inheritance, overrides, the permission matrix |
| 09 | [Numbering Architecture](./architecture/09-numbering-architecture.md) | Configurable, gapless, never-reused document numbers |
| 10 | [Revision Architecture](./architecture/10-revision-architecture.md) | Identity vs revision vs file; check-out/in, compare, restore |
| 11 | [Storage Architecture](./architecture/11-storage-architecture.md) | Provider-agnostic blob storage, dedupe, lifecycle |
| 12 | [Search Architecture](./architecture/12-search-architecture.md) | Metadata + full text + OCR, permission-filtered |
| 13 | [Audit Architecture](./architecture/13-audit-architecture.md) | Append-only, hash-chained, complete |
| 14 | [Preview Architecture](./architecture/14-preview-architecture.md) | Independent renderer plugins, derivative artefacts |
| 15 | [API Architecture](./architecture/15-api-architecture.md) | REST conventions, versioning, errors, pagination |
| 16 | [Frontend Architecture](./architecture/16-frontend-architecture.md) | App Router structure, feature modules, state, caching |
| 17 | [Security Architecture](./architecture/17-security-architecture.md) | AuthN/Z, uploads, encryption, OWASP posture |
| 18 | [Notification Architecture](./architecture/18-notification-architecture.md) | Email, in-app, digests, future push |
| 19 | [Performance & Scalability](./architecture/19-performance-and-scalability.md) | Millions of documents, thousands of users |
| 20 | [Deployment Architecture](./architecture/20-deployment-architecture.md) | Environments, topology, CI/CD, backup and DR |

### Decision records

Immutable. Supersede, never edit. [`architecture/adr/`](./architecture/adr/).

| ADR | Decision |
| --- | --- |
| [0001](./architecture/adr/0001-product-root-placement.md) | The product root is `edms/`, not `docs/` |
| [0002](./architecture/adr/0002-multi-tenant-isolation-model.md) | Shared database, row-level tenant isolation, RLS backstop |
| [0003](./architecture/adr/0003-document-identity-revision-file-separation.md) | Document, revision and file are three separate things |
| [0004](./architecture/adr/0004-numbering-assigned-at-approval.md) | Numbers are reserved at submission, assigned at approval, never reused |
| [0005](./architecture/adr/0005-hierarchical-acl-with-deny-precedence.md) | Inherited ACLs on the scope tree, explicit deny wins |
| [0006](./architecture/adr/0006-declarative-workflow-engine.md) | Workflow definitions are versioned data, not code |
| [0007](./architecture/adr/0007-storage-port-and-content-addressing.md) | One storage port; blobs are content-addressed and deduplicated |
| [0008](./architecture/adr/0008-postgres-first-search.md) | PostgreSQL full-text first, behind a search port |
| [0009](./architecture/adr/0009-append-only-hash-chained-audit.md) | Audit is append-only and hash-chained |
| [0010](./architecture/adr/0010-soft-delete-and-retention.md) | Soft delete everywhere, purge only by retention policy |
| [0011](./architecture/adr/0011-transactional-outbox-for-async-work.md) | Async work is dispatched through a transactional outbox |

## 2. Phase 0 reports

Point-in-time evidence produced during Phase 0. **Historical, never edited afterwards.**

| Document | Purpose |
| --- | --- |
| [Repository analysis](./reports/repository-analysis.md) | What exists in this repository, what Munaxa Docs reuses, what it must not duplicate |
| [Technical debt report](./reports/technical-debt.md) | Defects and drift found during the analysis, with owners |
| [Risk assessment](./reports/risk-assessment.md) | What can go wrong, likelihood, impact, mitigation |
| [Development recommendations](./reports/development-recommendations.md) | How to build phases 0.5 → 18 without repeating known mistakes |

## Maintaining this index

Adding a document means adding a row here in the same commit, and a row in the repository index
[`docs/README.md`](../../docs/README.md) if it matters outside this product. A document not linked
from an index is invisible.
