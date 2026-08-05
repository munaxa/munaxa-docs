/**
 * The audit action a bulk operation writes — one, and the argument for it.
 *
 * `13-audit-architecture.md` §2 names one action per *area* with the operation in the payload, and
 * that is what this is: five kinds under one action, distinguished by `payload.kind`, exactly as
 * `DOCUMENT_CHANGED` carries `CREATED`/`UPDATED`/`DELETED`. Five separate actions would put
 * `BULK_RESTORED` beside `RESTORED` in a filter and make "every restore last quarter" a question
 * with two right answers.
 *
 * **It is added rather than reused, and that is the decision.** The alternative was to write no
 * operation-level row at all and let the per-object rows be the record — which is defensible, and
 * is wrong for one reason: the per-object rows are indistinguishable from four hundred people
 * each restoring one document. "One person restored four hundred documents in ninety seconds" is a
 * different fact from "four hundred documents were restored", and it is the one an investigation
 * starts from.
 *
 * The counterpart is that the per-object rows are **not** suppressed. A bulk restore writes the
 * same `DOCUMENT_CHANGED` row on each document's own timeline that a single restore writes,
 * because the document timeline is the trail's primary query and a document whose history skipped
 * the day it was restored would be the compliance defect. So a bulk operation over N objects
 * writes N + 1 rows, the cost is linear, and the report states what it measured.
 */
export const BulkAudit = {
  /**
   * Somebody performed one act over many objects. The payload carries the kind, the parameters
   * and the tally — never the identifier list, which is `bulk_operation_item` (13 §3).
   */
  BULK_OPERATION: 'BULK_OPERATION',
} as const;

export type BulkAuditAction = (typeof BulkAudit)[keyof typeof BulkAudit];
