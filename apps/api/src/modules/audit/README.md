# Audit module

**Answers:** What happened, when, by whom — provably?

| | |
| --- | --- |
| **Owns** | AuditEvent, the hash chain, evidence export |
| **Depends on** | — (written by every module through the audit port) |
| **Binds in core** | `AUDIT_WRITER` — it owns the chain, so it owns the only way to append to it. |

## Layers

```text
audit/
├── audit.module.ts   composition for this module
├── domain/                    entities, value objects, pure rules, events — no Nest, no Prisma
├── application/               use cases and the ports this module declares
├── infrastructure/            Prisma repositories and adapters implementing those ports
└── presentation/              controllers, DTOs, OpenAPI decorators, view mappers
```

The dependency rule points inward, and it is enforced by `eslint.config.mjs` at the app root,
not merely described here. Other modules call this one through its **application service** or
react to its **events** — never through its repositories or its Prisma models.

## Events published

| Type | Meaning |
| --- | --- |
| `audit.chain-verified` | A verification pass completed; carries the range and the count. |
| `audit.chain-broken` | A digest failed to recompute. Highest severity, immediate alert. |
| `audit.export-ready` | An evidence bundle is available for download. |

## The write path

Phase 1 implements writing. `AUDIT_WRITER` is bound to `ChainedAuditWriter` and exported
globally, because audit is a cross-cutting obligation rather than a dependency a module should
have to remember to import.

```text
use case ──▶ AuditWriter.write() ──▶ lockAndReadTail() ──▶ chainHash() ──▶ append()
                   │                  advisory lock,        pure, in            same
                   │                  same transaction      core/               transaction
                   └── refuses outright if there is no transaction to join
```

**`write()` joins the caller's transaction and will not open one.** The event and the change it
describes commit together or not at all. If there is no ambient transaction it throws rather
than quietly starting one — a rolled-back change must not leave a permanent record of something
that never happened.

**`writeStandalone()` is for events with nothing to commit alongside them** — a failed sign-in,
a denied read. These are exactly the events an attacker would prefer to leave none of, so they
get their own transaction rather than being dropped for lack of one.

### Why there is a sequence

The hash chain proves no record was *altered*. On its own it cannot prove that none was
*removed from the end*: truncate the last k events and what remains still chains perfectly. A
per-tenant, gap-free `sequence` makes that hole visible.

It is allocated as `tail + 1` under `pg_advisory_xact_lock(hashtext(tenant_id))`, not from a
PostgreSQL sequence — those gap on rollback, and a gap that might be an ordinary abort is a gap
that proves nothing. A unique index on `(tenant_id, sequence)` makes a fork impossible even if
the lock were bypassed. The lock is transaction-scoped, so it releases on commit or rollback
with nothing to remember, and it is keyed per tenant, so tenants never wait on each other.

`sequence` was missing from the Phase 0.5 schema, which is drift from
[13-audit-architecture.md](../../../../../docs/architecture/13-audit-architecture.md) §3 that
neither the compliance report nor the gate verification caught. The `audit_sequence` migration
adds it and backfills existing rows in occurrence order.

### Defence in depth

| Layer | Mechanism |
| --- | --- |
| Interface | No update, no delete — there is nowhere to add one |
| Grants | The application role holds `INSERT` and `SELECT` only |
| Trigger | `BEFORE UPDATE OR DELETE` raises unconditionally, owner included |
| Chain | Each digest covers the previous one |
| Sequence | Contiguous per tenant, so a removal leaves a hole |
| RLS | `FORCE`, so a context-less session cannot even see the rows to try |

The last two compose in a way worth knowing: an owner session with no tenant context sees
nothing, so a tampering `UPDATE` matches zero rows and the trigger never even fires.

## Tests

`pnpm test:integration` covers what only a database can answer: gap-free allocation under
twelve concurrent writers, per-tenant chain isolation, refusal of update and delete for the
owner role, and the refusal to write outside a transaction.

## Still to build

Reading the trail, the scheduled verification job with signed checkpoints, and evidence export
— all Phase 9, which owns that capability. `AuditService` in `application/ports.ts` is
deliberately still unbound, and the events above are not published yet.
