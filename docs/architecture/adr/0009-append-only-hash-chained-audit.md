# ADR-0009 — Audit is append-only, transactional and hash-chained

- **Status:** Accepted
- **Date:** 2026-07-31
- **Phase:** 0

## Context

The audit trail is the product's compliance deliverable. Its value depends entirely on two
properties: **completeness** (nothing happened that is not recorded) and **integrity** (nothing
recorded was altered). An audit trail that can be edited by an administrator proves nothing.

## Decision

1. Audit events are written **in the same transaction** as the change they record. An audit failure
   fails the operation.
2. The application role holds **`INSERT` and `SELECT` only** on `audit_event`; a
   `BEFORE UPDATE OR DELETE` trigger raises unconditionally, so no role can quietly alter a row.
3. Events are **hash-chained per tenant**: each record stores `prevHash` and a SHA-256 over its
   canonical serialisation including that hash, with a gap-free per-tenant `sequence`.
4. A daily verifier walks the chain and writes a **signed checkpoint to a store outside the
   database**, so database access alone is not enough to rewrite history undetected.
5. **Audit outlives its subject**: purging a document does not purge its trail, and the document
   number is preserved in the trail so it stays meaningful.
6. Reads (`VIEWED`) are audited too — buffered and batched, still chained — because "who has read
   the current procedure" is a compliance question.

## Alternatives considered

1. **Audit written asynchronously from events** — cheaper on the hot path, but a crash between
   commit and emit leaves an unrecorded change. Rejected for the synchronous path; used only for
   buffered read events, where the loss window is explicit and alerted.
2. **Application-only immutability (no grants, no trigger)** — one migration or one console session
   defeats it. Rejected.
3. **External append-only log (e.g. a managed audit service)** — strong, but adds a hard dependency
   for every write and complicates on-premise installs. The external **checkpoint** captures most of
   the benefit at a fraction of the coupling.
4. **Blockchain-style anchoring** — the checkpoint mechanism can be extended to anchor externally if
   a customer requires it; not built now.

## Consequences

- Every write path costs one extra insert and a short per-tenant advisory lock.
- The chain must be verified after any restore; a restore that does not verify is not complete
  ([20](../20-deployment-architecture.md)).
- `audit_event` is partitioned monthly and retained for the tenant's compliance period (default
  7 years) — it will be the largest table in the system.
- Audit payloads must never contain secrets, tokens or file content, since the trail is retained
  longest and read most widely.
