# Risk Assessment — Phase 0

**Purpose:** what can go wrong with this architecture, and what has been designed to stop it.
**Audience:** repository owner, architects, Phase 0.5 engineers.
**Status:** point-in-time report, 2026-07-31. Not edited afterwards.

Scoring: likelihood and impact are Low / Medium / High. "Residual" is what remains after the
mitigation that is actually designed in — not after mitigation we intend to think about later.

## Architectural risks

| # | Risk | L | I | Mitigation | Residual |
| --- | --- | --- | --- | --- | --- |
| A1 | **Cross-tenant data exposure.** One missing scope in one query exposes another customer's documents | Med | High | Five layers: signed claim, request context, guard, Prisma extension, RLS on a `NOBYPASSRLS` role. Migrations use a separate role ([ADR-0002](../architecture/adr/0002-multi-tenant-isolation-model.md)) | Low |
| A2 | **Search leaks existence.** The index says a document exists that the API would 404 | Med | High | ACL predicate inside the query; the index fingerprint is computed by the same pure resolver the API uses; every result re-checked at open ([12](../architecture/12-search-architecture.md)) | Low |
| A3 | **Permission model too complex to administer**, so administrators grant broadly to make things work | High | High | Effective-permission view showing *which node decided*; deny-wins is inspectable; roles carry capability, ACLs carry reach ([ADR-0005](../architecture/adr/0005-hierarchical-acl-with-deny-precedence.md)) | Med — needs UX validation in Phase 14 |
| A4 | **Number collision or reuse** breaks external references | Low | High | Row-locked sequence, uniqueness ignoring `deleted_at`, voided reservations retained, assignment inside the approval transaction ([ADR-0004](../architecture/adr/0004-numbering-assigned-at-approval.md)) | Low |
| A5 | **Workflow rules change under a running approval** | Med | High | Instances bind to an immutable definition **version** ([ADR-0006](../architecture/adr/0006-declarative-workflow-engine.md)) | Low |
| A6 | **Async work silently lost** — published document never indexed, never previewed, never notified | High | Med | Transactional outbox, idempotent consumers, dead-letter queue, outbox depth alerting ([ADR-0011](../architecture/adr/0011-transactional-outbox-for-async-work.md)) | Low |
| A7 | **Audit trail not trustworthy** — incomplete or alterable | Low | High | Same-transaction writes, insert-only grants, DB trigger, hash chain, external checkpoints, verification after restore ([ADR-0009](../architecture/adr/0009-append-only-hash-chained-audit.md)) | Low |
| A8 | **Postgres search outgrown sooner than expected** | Med | Med | Everything behind `SearchPort`; migration triggers defined and monitored from day one ([ADR-0008](../architecture/adr/0008-postgres-first-search.md)) | Low |
| A9 | **Module boundaries erode** into a distributed-in-one-process mess | High | Med | One module shape, inward dependency rule, no cross-module repository access, import-boundary lint in Phase 0.5 ([01](../architecture/01-monorepo-and-folder-structure.md)) | Med — enforced by lint plus review, and review is the weaker half |
| A10 | **Storage reference counting drifts**, leaking or prematurely deleting blobs | Med | Med | Transactional counting, grace period before deletion, reconciliation sweeper that reports rather than fixes ([11](../architecture/11-storage-architecture.md)) | Low |

## Security risks

| # | Risk | L | I | Mitigation | Residual |
| --- | --- | --- | --- | --- | --- |
| S1 | **Malware uploaded and served to other users** | High | High | Mandatory AV gate; unscanned content is unattachable and undownloadable, enforced in the use case and the schema; infected content quarantined and audited ([17](../architecture/17-security-architecture.md)) | Low |
| S2 | **Renderer exploited by a crafted file** | Med | High | Sandboxed workers, no DB credentials, no egress, resource caps, macros disabled, AV first ([14](../architecture/14-preview-architecture.md)) | Med — this is the largest remaining surface; a pen test on the preview pipeline is a Phase 14 deliverable |
| S3 | **Presigned URL shared beyond the recipient** | High | Med | Short TTL, single object, method- and size-bound, issuance audited. Confidentiality levels that forbid download serve watermarked previews only | Med — inherent to any download; mitigated by audit and watermark, not eliminated |
| S4 | **Privilege escalation via delegation** | Med | High | Authority checked at decision time, not creation; no re-delegation by default; both identities recorded; immediate revocation ([07](../architecture/07-workflow-architecture.md)) | Low |
| S5 | **Insider mass exfiltration** by a legitimate user | Med | High | Bulk-download baselining and alerting, per-user rate limits, full read audit, watermarking | Med — detectable, not preventable |
| S6 | **Retention destroys records under an unnoticed legal hold** | Low | High | Holds block disposition absolutely; purge is policy-driven with optional disposition review; every purge audited ([ADR-0010](../architecture/adr/0010-soft-delete-and-retention.md)) | Low |

## Delivery risks

| # | Risk | L | I | Mitigation | Residual |
| --- | --- | --- | --- | --- | --- |
| P1 | **Scope of Phase 0.5** creeping into business features | High | Med | The brief is explicit; the skeleton is ports, modules and DI with zero features. Review against it | Low |
| P2 | **Re-implementing School's tenancy incorrectly** because the code cannot be shared | Med | High | The design is documented layer by layer; Phase 0.5 must include isolation tests (a second tenant's row is invisible at every layer, including with RLS alone) | Med |
| P3 | **AI-generated screens inventing components or permissions** | High | Med | Platform components catalogued in the [repository analysis](./repository-analysis.md); permission catalogue is the only source; boot-time assertion for ungated routes | Med |
| P4 | **18 phases of drift** from this blueprint | High | Med | Every phase updates the affected document and adds an ADR when it decides between real alternatives; the index makes an unlisted document invisible | Med |
| P5 | **The `edms/` vs `docs/` naming decision reversed late** | Med | Low→High over time | [ADR-0001](../architecture/adr/0001-product-root-placement.md) flags it as the one decision to confirm before Phase 0.5. Cheap now, expensive after packages and migrations exist | Low if decided now |

## Compliance risks

| # | Risk | L | I | Mitigation | Residual |
| --- | --- | --- | --- | --- | --- |
| C1 | Cannot prove what an approver approved | Low | High | Immutable published revisions, metadata snapshot per revision, checksum on every blob, approval recorded against the revision ([10](../architecture/10-revision-architecture.md)) | Low |
| C2 | Cannot produce evidence for an audit within the window | Med | Med | Signed evidence export with checkpoint hashes and a manifest; audit search by actor, action, target, date ([13](../architecture/13-audit-architecture.md)) | Low |
| C3 | Personal-data deletion request conflicts with audit immutability | Med | Med | User identity anonymised in place; the actor id survives so the chain and the evidence remain intact ([17](../architecture/17-security-architecture.md)) | Med — needs legal review per jurisdiction before Phase 14 |
| C4 | Backup restored but audit chain broken | Low | High | Quarterly restore tests pass only when the chain verifies end to end ([20](../architecture/20-deployment-architecture.md)) | Low |

## The five to watch

1. **A3** — permission administrability. Technically sound and still the most likely thing to fail
   in practice, because the failure mode is a human granting too much.
2. **S2** — renderer sandboxing. Untrusted-file parsing is where document systems get breached.
3. **A9** — module boundary erosion, because it degrades silently over eighteen phases.
4. **P2** — re-implemented tenancy. The design is proven; the second implementation is not, until
   its isolation tests exist.
5. **S5** — insider exfiltration, which no design eliminates and which must therefore be detectable.
