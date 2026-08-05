/**
 * Search's audit vocabulary.
 *
 * `SEARCH_PERFORMED` is written **only** for a query that used `search:all` — the bypass of
 * the ACL predicate is what 12 §3 requires audited, and auditing every ordinary search would
 * hash-chain a row per keystroke of curiosity. The payload carries the query text and filters,
 * because "what did the auditor search for" is the question the row exists to answer.
 *
 * `SEARCH_REBUILD_REQUESTED` records the operator act; `search.rebuild-completed` (the domain
 * event) records the outcome. Two records for two facts — the same split as
 * `DOCUMENT_VIEWED`/`DOCUMENT_PRINTED` against their events.
 *
 * These actions follow the convention of `13-audit-architecture.md` §2, and this phase adds
 * the corresponding rows to that document.
 */
export const SearchAudit = {
  SEARCH_PERFORMED: 'SEARCH_PERFORMED',
  SEARCH_REBUILD_REQUESTED: 'SEARCH_REBUILD_REQUESTED',
} as const;

export type SearchAuditAction = (typeof SearchAudit)[keyof typeof SearchAudit];
