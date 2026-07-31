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
