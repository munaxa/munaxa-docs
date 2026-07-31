# Munaxa Docs — Architecture (Phase 0)

> **Munaxa Docs** is a multi-tenant **Enterprise Document Management System (EDMS)**: document
> control, approval workflows, revision management, retention, auditability and compliance.
> It is **not** a file repository.

**Purpose:** the binding architectural blueprint produced in Phase 0.
**Audience:** every engineer and AI agent building any later phase.

Nothing here is implementation code. It is design, diagrams and strategy. Phases 0.5 → 18 conform
to it, or supersede a decision with an [ADR](./adr/). Where this set and
[`PLATFORM_ENGINEERING_STANDARDS.md`](../../../PLATFORM_ENGINEERING_STANDARDS.md) disagree, the
rulebook governs.

## The ten decisions that shape everything else

1. **A document is not a file.** Identity, revision and stored bytes are three separate records
   ([10](./10-revision-architecture.md), [ADR-0003](./adr/0003-document-identity-revision-file-separation.md)).
2. **A document number is issued once, at approval, and is never reused**
   ([09](./09-numbering-architecture.md)).
3. **The document number never changes; revisions increment beneath it**
   ([10](./10-revision-architecture.md)).
4. **Approval is configuration, not code.** Workflow definitions are versioned data
   ([07](./07-workflow-architecture.md)).
5. **Permission is inherited down the scope tree and can be overridden at any node; deny wins**
   ([08](./08-permission-model.md)).
6. **Every state change is audited, append-only, hash-chained** ([13](./13-audit-architecture.md)).
7. **Nothing is hard-deleted by a user.** Soft delete, recycle bin, purge only by retention policy
   ([05](./05-database-design.md), [ADR-0010](./adr/0010-soft-delete-and-retention.md)).
8. **Storage, search, OCR, preview and notification are ports.** The provider behind each is
   replaceable without touching a use case ([02](./02-backend-architecture.md)).
9. **Tenant isolation is enforced in four layers plus RLS** ([ADR-0002](./adr/0002-multi-tenant-isolation-model.md), [17](./17-security-architecture.md)).
10. **Async work is dispatched from a transactional outbox**, so a committed change is never lost
    and never emitted twice ([ADR-0011](./adr/0011-transactional-outbox-for-async-work.md)).

## Index

| # | Document | Scope |
| --- | --- | --- |
| 00 | [System Architecture](./00-system-architecture.md) | C4 context and containers |
| 01 | [Monorepo & Folder Structure](./01-monorepo-and-folder-structure.md) | Apps, packages, placement rules |
| 02 | [Backend Architecture](./02-backend-architecture.md) | Clean Architecture layers, modules, ports, DI |
| 03 | [Domain Model](./03-domain-model.md) | Bounded contexts, aggregates, ubiquitous language |
| 04 | [Domain Relationships & ERD](./04-domain-relationships-and-erd.md) | Every relationship and its cardinality |
| 05 | [Database Design](./05-database-design.md) | Tables, keys, indexes, constraints, soft delete |
| 06 | [Document Lifecycle](./06-document-lifecycle.md) | Legal and illegal state transitions |
| 07 | [Workflow Architecture](./07-workflow-architecture.md) | The configurable approval engine |
| 08 | [Permission Model](./08-permission-model.md) | RBAC, inheritance, overrides, permission matrix |
| 09 | [Numbering Architecture](./09-numbering-architecture.md) | Configurable, gapless, never-reused numbers |
| 10 | [Revision Architecture](./10-revision-architecture.md) | Check-out/in, compare, restore |
| 11 | [Storage Architecture](./11-storage-architecture.md) | Provider-agnostic blob storage |
| 12 | [Search Architecture](./12-search-architecture.md) | Metadata, full text, OCR |
| 13 | [Audit Architecture](./13-audit-architecture.md) | Append-only, hash-chained |
| 14 | [Preview Architecture](./14-preview-architecture.md) | Independent renderer plugins |
| 15 | [API Architecture](./15-api-architecture.md) | REST conventions, versioning, errors |
| 16 | [Frontend Architecture](./16-frontend-architecture.md) | App Router, feature modules, state |
| 17 | [Security Architecture](./17-security-architecture.md) | AuthN/Z, uploads, encryption, OWASP |
| 18 | [Notification Architecture](./18-notification-architecture.md) | Email, in-app, digests |
| 19 | [Performance & Scalability](./19-performance-and-scalability.md) | Enterprise scale targets |
| 20 | [Deployment Architecture](./20-deployment-architecture.md) | Environments, CI/CD, backup, DR |
| 21 | [SaaS Commercial Architecture](./21-saas-commercial-architecture.md) | Plans, entitlements, metering, provisioning, operator console |

## Related

- [Phase 0 reports](../reports/) — repository analysis, technical debt, risk, recommendations.
- [Engineering standards](../../../PLATFORM_ENGINEERING_STANDARDS.md) — the mandatory rulebook.
- [Shared platform](../../../platform/README.md) — the UI layer this product consumes.
- [School architecture](../../../school/docs/architecture/README.md) — a **reference for patterns
  only**. Munaxa Docs never imports School code.
