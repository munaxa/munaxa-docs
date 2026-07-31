# ADR-0011 — Async work is dispatched through a transactional outbox

- **Status:** Accepted
- **Date:** 2026-07-31
- **Phase:** 0

## Context

Publishing a document must trigger preview rendering, OCR, search indexing and notifications. None
of these may run inside the request, and none may be lost.

Enqueuing to Redis inside the transaction is wrong twice: the job can be consumed before the
transaction commits (the worker sees no document), and a rollback leaves a phantom job. Enqueuing
after commit is wrong differently: a crash between commit and enqueue loses the work silently, and
"the document is published but never appeared in search" is the resulting bug — untraceable, and
discovered by a customer.

## Decision

1. A use case that needs async work inserts an **`outbox_message` row inside its own transaction**.
2. A **dispatcher** claims unsent rows (`FOR UPDATE SKIP LOCKED`), enqueues them to BullMQ and marks
   them processed.
3. Delivery is therefore **at-least-once**; every consumer is **idempotent**, keyed on a
   deterministic job key.
4. Event payloads are **versioned and additive**; a shipped payload shape is never changed
   ([rulebook §12](../../../../PLATFORM_ENGINEERING_STANDARDS.md#12-backward-compatibility)).
5. Events are **facts in the past tense** (`DocumentApproved`, `RevisionCheckedIn`), never commands.
6. Processed rows are deleted after 7 days; the audit trail, not the outbox, is the permanent
   record.

## Alternatives considered

1. **Enqueue directly inside the transaction** — the phantom-job and read-before-commit failures
   above. Rejected.
2. **Enqueue after commit** — silent loss on crash, exactly in the window where the system looks
   healthy. Rejected.
3. **Logical replication / CDC (e.g. Debezium)** — no application-side outbox, but adds a
   replication pipeline to operate and makes on-premise installs heavier. Rejected for now; the
   outbox is a table and a loop.
4. **Two-phase commit across Postgres and Redis** — operationally fragile, and Redis is not the
   system of record anyway. Rejected.

## Consequences

- One extra insert per event-emitting use case, and one small polling loop (with `LISTEN/NOTIFY` to
  keep latency low).
- **Every consumer must be idempotent** — this is a hard rule for every worker, tested explicitly.
- Ordering is not guaranteed across aggregates; consumers that need order use the aggregate's
  version, not arrival order.
- Outbox depth is a monitored signal: a growing outbox means the dispatcher or a worker pool is
  stuck, and it is visible before users notice.
