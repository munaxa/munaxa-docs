// Each catalogue below `satisfies Record<string, DocsAuditAction>`: the audit writer is typed to
// the union of all thirteen modules' catalogues, and that assertion is what keeps them in step.
import type { DocsAuditAction } from '@edms/domain';

/**
 * The audit actions Organisation writes.
 *
 * Named constants rather than string literals at the call site, because these strings are read by
 * compliance reports and evidence exports years after they are written: a typo is not a bug that
 * surfaces, it is a gap in an audit trail nobody notices.
 *
 * The name comes from the Administration group of the catalogue in
 * `docs/architecture/13-audit-architecture.md` §2. One action covers the whole scope tree, which is
 * how that catalogue is built — grouped by area, with `before`/`after` and an `operation` in the
 * payload saying what actually happened. A separate action per node type and per verb would give
 * twenty strings that every report would have to learn, to express what one string and a payload
 * already express.
 */
export const OrganizationAudit = {
  /** A company, entity, branch or department was created, edited, moved, deleted or restored. */
  ORG_CHANGED: 'ORG_CHANGED',
} as const satisfies Record<string, DocsAuditAction>;

export type OrganizationAuditAction = (typeof OrganizationAudit)[keyof typeof OrganizationAudit];
