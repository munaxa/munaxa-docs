# ADR-0010 — Soft delete everywhere; permanent destruction only by retention policy

- **Status:** Accepted
- **Date:** 2026-07-31
- **Phase:** 0

## Context

Two requirements pull against each other. Users delete things by mistake, and a document management
system that loses a controlled document to a misclick is unusable. Regulators require that records
be destroyed on schedule, and that destruction be provable.

## Decision

1. **No user action ever destroys data.** "Delete" sets `deleted_at`/`deleted_by`; the row stays.
2. Deleted objects are visible in a **recycle bin** to holders of `document:restore`, and are
   restorable to the state they were deleted from — never to a higher one.
3. Deleting a folder cascades a soft delete over its subtree, stamped with a shared `cascade_id`, so
   restore reverses exactly that operation and nothing else.
4. **Permanent destruction happens only through retention**: a policy (trigger, period,
   disposition), optionally a human disposition review, executed by the retention worker, and
   audited as `PURGE_EXECUTED`.
5. **A legal hold blocks disposition and deletion absolutely**, regardless of policy or permission,
   until it is explicitly released by a `legal-hold:manage` holder.
6. The **audit trail is never soft-deleted and never purged with its subject**.
7. A document's retention policy is **copied onto the document** when it is first published, so
   later edits to the policy do not silently re-date existing records.
8. Purge decrements `file_object.ref_count`; blobs reach zero and are deleted from storage after a
   grace period. The **document number is never released**
   ([ADR-0004](./0004-numbering-assigned-at-approval.md)).

## Alternatives considered

1. **Hard delete with backups as the safety net** — a restore is an operational incident, takes
   hours, and cannot restore one document without restoring everything. Rejected.
2. **Soft delete with an administrator "purge now" button** — convenient, and the exact mechanism by
   which records under an unnoticed legal hold get destroyed. Rejected: purge is policy-driven, and
   the only manual step is *approving* a disposition the policy already scheduled.
3. **Retention computed live from the policy at disposition time** — means a policy edit silently
   re-dates history. Rejected in favour of freezing the policy onto the document.

## Consequences

- Every query filters `deleted_at IS NULL` by default, in the Prisma extension rather than by
  discipline.
- Every unique index on soft-deletable data is **partial** (`WHERE deleted_at IS NULL`), except
  document numbers, which must stay globally unique forever.
- Restore must revalidate uniqueness; a name collision is resolved by rename, never by overwrite.
- Storage is not reclaimed at delete time. Quota accounting must therefore distinguish live,
  deleted-but-retained, and derived bytes, and the administrator UI must show all three.
