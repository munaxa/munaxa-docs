# ADR-0004 — Numbers are reserved at submission, assigned at approval, never reused

- **Status:** Accepted
- **Date:** 2026-07-31
- **Phase:** 0

## Context

The Phase 0 brief states two rules: numbers are assigned **only after approval**, and numbers are
**never reused**. Both are compliance requirements — a document number is an external identifier
that appears in printed copies, contracts and audit findings.

They conflict with a practical need: reviewers refer to the document *while* reviewing it, and
"the untitled draft from Tuesday" is not a reference.

## Decision

1. A **reservation** is drawn when the document is submitted for approval. It is displayed clearly
   marked *pending* and is not the document's number.
2. The number is **assigned** when the final approval stage completes, in the same transaction as
   the approval, the status change and the audit event.
3. A reservation that never becomes an assignment (rejection, withdrawal, expiry) is **voided**.
   Its value is retained and never returned to the pool.
4. Uniqueness on `document.document_number` deliberately **ignores `deleted_at`**, so a deleted or
   purged document's number can never be issued again.
5. Two tenant-level options exist for regimes this does not suit: `reserveOnSubmit: false` draws the
   number only at approval, and `strictGapless: true` additionally guarantees no gaps at the cost of
   no pending reference.

## Alternatives considered

1. **Number at creation** — simple, but burns numbers on abandoned drafts and violates the rule that
   only approved documents carry a number.
2. **Number at approval with no reservation** — satisfies both rules but leaves reviewers without a
   reference; adopted as the `reserveOnSubmit: false` option rather than the default.
3. **Reuse voided numbers to keep the series gapless** — rejected outright: a reused number makes
   every external reference ambiguous, which is exactly what the number exists to prevent. Tenants
   who must have a gapless series get it through `strictGapless`, which prevents gaps rather than
   filling them.

## Consequences

- Visible gaps in a series are normal and must be explained in the administrator UI, not treated as
  a defect.
- The `number_reservation` table retains voided values forever; it is small and append-mostly.
- Assignment is inside the approval transaction, so an approval cannot succeed with no number and a
  number cannot be issued without an approval.
- There is no correction path for a wrongly numbered document: it is superseded by a new document
  linked with `SUPERSEDES`, and the audit explains why.
