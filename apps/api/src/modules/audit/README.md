# Audit module

**Answers:** What happened, when, by whom — provably?

| | |
| --- | --- |
| **Owns** | AuditEvent, the hash chain, the read path, verification, evidence export |
| **Depends on** | Storage (bytes for a bundle, signed URLs), Library (through `ACL_RESOLVER`) |
| **Binds in core** | `AUDIT_WRITER` and `READ_AUDIT_BUFFER` — it owns the chain, so it owns the only two ways to append to it. |

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

## Activity is a view of this, not a second log

`ACTIVITY_READER` is bound here, over the same rows. There is deliberately no `activity` table.

Two records of what happened can disagree, and when they do it is the pair shown to users and
the pair shown to auditors that disagrees — the worst possible place for a discrepancy in a
product whose selling point is evidence. So the trail is the record and activity is a *view* of
it: the hash, the previous hash and the sequence dropped because they mean nothing on a screen,
the payload dropped because it is minimised for investigators rather than written for readers.

The constraint that follows is worth stating plainly: **an activity feed can never show
something the audit trail does not contain.** A feature that wants to surface an event writes
an audit event — and then it is evidence too.

## The read path — Phase 9

Everything that *reads* the chain, and the two things reading it forced the write path to admit.

```text
timeline ──▶ ACL_RESOLVER.resolve(subject) ──▶ listForSubject()   one decision, whole page
search   ──▶ audit:view ─────────────────────▶ search()          crosses subjects; the grant is the filter
verify   ──▶ checkpoint.latest() ──▶ sliceBySequence() ──▶ verifyChain() ──▶ checkpoint.write()
export   ──▶ collect + verify ──▶ StoragePort.put (streamed) ──▶ signed manifest
```

### The timeline is filtered at the subject, not per row

An audit row carries `(subject_type, subject_id)` and no scope chain, and a `SEARCH` row carries the
*actor's own user id* — the first subject in the product that is not a domain object. There is
nothing on a row to push a predicate against.

So the decision is resolved once, at the subject, before the query: a timeline names one object,
whether the caller may see it is one question, and it goes to `ACL_RESOLVER` — the same port and
binding Phase 8 bound for search. Every row on the page is about that object, so one decision covers
the page exactly.

A per-row lookup would have been wrong even where it worked. **Audit outlives its subject**: a
purged document's trail remains, deliberately. Resolving each row's object would silently hide the
history of a thing that no longer exists, which is the history that matters most.

### Two digests, and a manifest that says which

`chain_hash_version` is on every row. Phase 1's digest covered nine fields; Phase 9's covers every
column but the hashes. Old rows are **not** rehashed — the table refuses `UPDATE` to every role,
which is the property the design exists for — so verification dispatches on the row's own version
and an evidence bundle's manifest states, per version in its range, exactly which columns that
version's hash attests. A bundle that listed every column beside a v1 hash would overclaim, and an
evidence bundle that overclaims is worse than none.

### Checkpoints live where the chain does not

Object storage, signed with a key held in neither the database nor the bucket. A checkpoint beside
the events it attests would be rewritten by the same access that rewrote them. The signature is also
what makes *resuming* safe: a pass starts from the last checkpoint, and the store refuses one whose
signature does not recompute — so the resume point is an authenticated claim rather than a marker an
attacker could move past rows they had altered.

### Read auditing is buffered

`READ_AUDIT_BUFFER` — 13 §5's requirement, true of the code since Phase 9. A flush takes the
per-tenant lock once and chains the whole batch under it, so a hundred views cost one lock. The
instant recorded is when somebody looked, not when the flush ran. Nothing is dropped: a failed flush
retains and retries, and past the hard bound `record` writes synchronously, which is Phase 1's
behaviour — slower, never lossy. A **print** is not buffered; 13 exempts `VIEWED` and nothing else.

### The lane, and the schedule

`AuditLaneConsumer` drains `audit.export` and declares `audit.verify-chain` as a *named* cron
schedule in the broker, so every instance that boots declares the same one and there is one firing
rather than one per instance. It runs in the API process behind `queue.consumersEnabled`, which is
where every consumer since Phase 4 lives.

### The chain as a stream — Phase 17

13 §6's SIEM row, and this module supplies its source rather than owning it.
`AUDIT_STREAM_SOURCE` is declared by `modules/integration/` and implemented here by
`AuditStreamSourceAdapter`, which is Phase 13's shape and for its reason: `AuditModule` exports
`AUDIT_REPOSITORY`, so a sink injecting it directly would compile — and would hold a handle able to
`append` to the hash chain. A module that can write the trail is a module that can be made to write
a false one.

The adapter is `sliceBySequence` and nothing else: the **same** method the daily verifier and the
evidence exporter walk the chain with, so a sink can never see a different trail from the one a
bundle attests. Deliberately not `search`, whose offset paging would answer differently depending on
when it was asked — and the whole reason a SIEM wants this is that `sequence` is gap-free, so a
consumer that has stored N and receives N+2 *knows* it missed one.

`ip_address` and `user_agent` are absent from the stream, exactly as they are from the audit wire
contract. A SIEM that needs them has the evidence bundle.

### The chain digest widened again — Phase 17

`CHAIN_HASH_V3` adds `api_client_id`, by the same versioned mechanism Phase 9 used to add seven
fields in v2 and for the same reason: the table refuses `UPDATE` to every role including the owner,
so rows already written cannot be rehashed and must keep verifying against the field set they were
written under. `attestedFields(3)` reports it, so an evidence bundle's manifest never claims to
attest a column the digest did not cover.

The column exists because "which credential took this action" is the first question an incident
asks, and a value only a `jsonb` payload carried would be attested as part of a blob the verifier
cannot address — which is precisely 13 §4's argument for `reason` being a column.

## Still to build

Monthly range partitions and cold-storage tiering (13 §6): deferred with a stated trigger — Phase 10's
retention, or the first tenant past tens of millions of rows. Delivery of the `audit.chain-broken`
alert is Phase 12's; the events above are published to the outbox and routed nowhere until it exists.
