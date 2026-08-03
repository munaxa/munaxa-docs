/**
 * The audit actions Workflow writes.
 *
 * `WORKFLOW_PUBLISHED` is the catalogue's own name for it (`13-audit-architecture.md` §2, Workflow
 * group), and it is a separate action rather than a payload variant because publishing is the moment a
 * version becomes immutable and starts binding approvals — which is precisely the event a compliance
 * question asks about: "which rules was this document approved under, and when did they take effect".
 *
 * `WORKFLOW_CHANGED` covers the rest — a definition renamed, deactivated, a draft added or edited,
 * a version retired — following the catalogue's convention of one action per area with the operation in
 * the payload. The corresponding row is added to that document by this phase.
 */
export const WorkflowAudit = {
  /** A version became the rules new approvals bind to. */
  WORKFLOW_PUBLISHED: 'WORKFLOW_PUBLISHED',
  /** A definition or a draft version changed, or a version was retired. */
  WORKFLOW_CHANGED: 'WORKFLOW_CHANGED',
} as const;

export type WorkflowAuditAction = (typeof WorkflowAudit)[keyof typeof WorkflowAudit];
