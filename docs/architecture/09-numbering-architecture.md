# 09 — Numbering Architecture

**Purpose:** how a controlled document number is configured, reserved, issued and protected.
**Audience:** backend engineers; document controllers configuring rules.

A document number is an **external identifier**. It appears in printed copies, contracts, audits and
other systems. Therefore: it is issued once, it never changes, and it is never reused — not after
rejection, not after deletion, not after a tenant reorganises
([ADR-0004](./adr/0004-numbering-assigned-at-approval.md)).

## 1. Rule shape

A `NumberingRule` is an ordered list of segments plus a reset scope. Everything is configuration.

```jsonc
{
  "key": "quality-procedure",
  "separator": "-",
  "segments": [
    { "type": "LITERAL",    "value": "QMS" },
    { "type": "ENTITY",     "source": "code" },
    { "type": "BRANCH",     "source": "code",  "optional": true },
    { "type": "DEPARTMENT", "source": "code" },
    { "type": "DOC_TYPE",   "source": "code" },
    { "type": "YEAR",       "format": "YYYY" },
    { "type": "SEQUENCE",   "padding": 4 },
    { "type": "SUFFIX",     "source": "metadata", "field": "market", "optional": true }
  ],
  "resetScope": ["ENTITY", "DOC_TYPE", "YEAR"],
  "sample": "QMS-JO-AMM-QA-PROC-2026-0042"
}
```

| Segment type | Value from |
| --- | --- |
| `LITERAL` | A fixed prefix/suffix string |
| `COMPANY` / `ENTITY` / `BRANCH` / `DEPARTMENT` | The document's org context, by `code` or `abbreviation` |
| `DOC_TYPE` / `CATEGORY` | The document's classification code |
| `YEAR` / `MONTH` | The **assignment** date, not the creation date, in the tenant's timezone and calendar |
| `SEQUENCE` | The counter, zero-padded |
| `METADATA` | Any metadata field value, validated as number-safe |
| `CUSTOM_PREFIX` / `SUFFIX` | Tenant-configured affixes |

`resetScope` names the segments that form the counter key: the sequence restarts when any of them
changes. `["ENTITY","DOC_TYPE","YEAR"]` gives every entity its own per-type yearly series.

### Validation on save

- Exactly one `SEQUENCE` segment.
- Every referenced source resolves for the types the rule serves; an `optional` segment that
  resolves empty is dropped along with its separator, and this must not make two different
  documents collide — the validator refuses a rule where that is possible.
- Padding is fixed; widening padding mid-series is refused (it would create two textual forms of
  one number). A new series is created instead.
- Changing a rule affects only documents numbered afterwards. Existing numbers are never
  recomputed — a re-render of an existing number is a bug, not a feature.

## 2. Sequences and reservation

```mermaid
sequenceDiagram
    participant S as Submit
    participant R as Numbering service
    participant DB as PostgreSQL
    participant A as Approval complete

    S->>R: reserve(document)
    R->>DB: BEGIN; SELECT next_value FROM number_sequence WHERE … FOR UPDATE
    R->>DB: UPDATE next_value = next_value + 1
    R->>DB: INSERT number_reservation (value, formatted, state=RESERVED, expires_at)
    R->>DB: COMMIT
    Note over R: the number is now visible as "pending" on the document, not final

    A->>R: assign(document, reservation)
    R->>DB: UPDATE number_reservation SET state='ASSIGNED', document_id=…
    R->>DB: UPDATE document SET document_number=…, numbered_at=now()
    Note over A,DB: same transaction as the approval and its audit event
```

- The lock is a **single row** held for microseconds. Throughput is thousands per second per series,
  and two series never block each other.
- A reservation not assigned (rejection, withdrawal, expiry) moves to `state = 'VOIDED'`. **The
  value is not returned to the pool.** A gap in the visible series is acceptable; a reused number
  is not.
- `uq (tenant_id, formatted)` on reservations and `uq (tenant_id, document_number)` on documents —
  the latter deliberately **ignoring** `deleted_at` — make reuse impossible even under a logic bug.

### Why reserve at submission

Reviewers routinely need to refer to the document under review. Reserving at submission gives them
a stable reference; assigning at approval keeps the rule that only approved documents *hold* a
number. The document shows the reserved number clearly marked *pending* until approval. A tenant
that dislikes pending numbers sets `reserveOnSubmit: false`, and the number is drawn at approval
instead — the same code path with the reservation and assignment in one transaction.

### Gapless mode

Some regimes require a gapless series. `strictGapless: true` on the rule changes the policy:
reservation happens **only** at approval, and a voided reservation cannot occur. The cost is that
the number is unknown during review; that is the trade-off the regime demands, and it is a tenant
choice rather than a product-wide one.

## 3. Reserved and manual numbers

| Case | Handling |
| --- | --- |
| Legacy import | A number may be supplied on import, validated against the rule's shape, and the sequence fast-forwarded past it. Recorded as `origin = 'IMPORTED'` |
| Manually reserved block | A controller may reserve a range for an offline process; reserved values are marked `HELD` and cannot be drawn automatically |
| Correction of a wrong number | Not possible. The document is superseded by a new document that references it via `SUPERSEDES`, and the audit explains why |

## 4. Interaction with revisions

The number identifies the **document**, not the revision. `QMS-JO-AMM-QA-PROC-2026-0042` stays
identical through `Original → R1 → R2`. The revision label is displayed beside it, never inside it
([10](./10-revision-architecture.md)).

## 5. Guarantees and their tests

| Guarantee | Enforced by | Test |
| --- | --- | --- |
| Unique per tenant | `uq (tenant_id, document_number)` | Concurrency test: 100 parallel approvals in one series, all distinct |
| Never reused | Uniqueness ignores `deleted_at`; voided reservations retained | Delete, purge, re-create — old number refused |
| Never changed | No update path exists; the column is written once and asserted immutable in the repository | Attempted update fails at the domain boundary |
| Only after approval | Assignment lives inside the approval transaction; `ck_document_numbered_when_published` | Rejected document has no number |
| Format matches the rule at assignment time | Formatter is pure and unit-tested per segment type | Golden-sample tests per rule |
| Rule change does not affect history | Numbers are stored, not computed | Change rule, assert existing numbers unchanged |

## Phase 5 — what was built

Phase 2 built §1 in full — the rule, its save-time validation, the sequence table and the admin
screen — and drew nothing. Phase 5 built §2 and §3: `number_reservation`, the issuance service in
Administration, Document's one write path onto `document_number`, and the binding of the engine's
`DOCUMENT_NUMBER_ALLOCATOR` seam. Binding it made every completed approval numbered with no change
to the engine's completion path, which was the test Phase 4 set for itself.

Four decisions the design left open were taken, and each is worth a sentence:

**The claim is one statement, not `SELECT … FOR UPDATE` then `UPDATE`.** The counter is claimed by
an upsert whose conflict arm increments — `INSERT … ON CONFLICT DO UPDATE SET next_value =
next_value + 1 RETURNING next_value - 1`. It takes exactly the row lock §2 describes and holds it
for the microseconds until commit, creates the series on first use, and closes the read-then-write
window that two statements would reopen. Lock order is fixed across every path — the workflow
instance first, the document next, the sequence row always last — so two approvals in one series
contend on the counter for the shortest possible tail of their transactions and cannot deadlock
across it.

**A reservation's text and series are fixed when the value is drawn.** `YEAR`/`MONTH` render from
the drawing instant in the tenant's timezone (`locale.timezone`, the clock the working calendar
already reads). A reservation drawn in December and approved in January keeps its December text and
its December series: the pending reference reviewers held is the number the document receives, and
the value was spent from the old year's counter, which is where the gap belongs. Assignment stamps
`numbered_at`; it never re-renders.

**A reservation lives exactly as long as its approval, so there is no `expires_at`.** The Phase 0
sketch carried one. Every path that ends an instance — rejection, return, withdrawal, cancellation —
voids the reservation in the same transaction, and an instance cannot end any other way, so a
reservation cannot leak and a sweeper would have nothing to sweep. The reservation also carries
`(numbering_rule_id, scope_key)` directly rather than the sketch's `sequence_id`: it is the series'
identity, not the counter row, that a reservation belongs to.

**A manual number fast-forwards the series its own text names.** `…-2019-0154` moves 2019's counter
past 154 — never backwards, by `GREATEST` — so an import cannot spend the live series and a later
automatic draw cannot collide with it. A supplied value that matches a `HELD` reservation claims it;
one that matches anything else is refused by the same `uq (tenant_id, formatted)` that protects the
automatic path. Manual assignment sits behind `numbering:manage` — recording a number by hand is a
document controller's act on the numbering system, the same authority that configures the rules —
and is refused while a document is in approval, because the workflow owns numbering then.

One validator rule was tightened while building §3: a `MONTHLY` reset now requires a `YEAR` segment
as well as a `MONTH`. A monthly counter restarts every month of every year, and a number whose text
carries only the month renders identically in March of two consecutive years — the same text for
two documents, which `uq (tenant_id, formatted)` would refuse at issuance a year after the rule was
saved. Refusing the rule at save time is the same courtesy the padding rule extends.

Every mutation writes its own audit event — `NUMBER_RESERVED`, `NUMBER_ASSIGNED`, `NUMBER_VOIDED`
([13 §2](./13-audit-architecture.md)) — inside the issuing transaction, and assignment publishes
`document.number-assigned` through the outbox. The §5 table above is now enforced end to end and
asserted by the integration suite against a real PostgreSQL, including the hundred parallel draws,
the voided-value-never-reused rule, the delete-and-recreate refusal and gapless mode.

## Phase 6 — the number through the revision cycle

§4 became testable when Phase 6 made a document's second approval reachable, and the seam gained
its deliberate branch: a numbered document re-entering approval is its next revision being
approved, so `reserveForSubmission` reserves nothing and `assignAtApproval` returns the number the
document already holds — no counter moves, no reservation is drawn, and `QMS-…-0042` reads
identically through `Original → R1 → R2` with the revision label displayed beside it, never inside
it. The integration suite asserts the number unchanged across a full revise-approve-publish cycle.
Publication is where `ck_document_numbered_when_published` finally fires in anger: an approved
document under a definition with `assignNumber: false` is legitimately approved and unnumbered,
and publish refuses it with a sentence pointing at manual assignment rather than letting the
constraint answer first.
