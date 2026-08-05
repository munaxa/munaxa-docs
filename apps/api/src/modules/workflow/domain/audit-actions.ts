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

  // -------------------------------------------------------------------------------------
  // Phase 4 — the engine's own actions.
  //
  // The catalogue in `13-audit-architecture.md` §2 names these individually rather than folding
  // them into one `WORKFLOW_CHANGED` with the operation in the payload, and the exception is
  // deliberate: everything above is somebody *configuring* approvals, and everything below is
  // somebody *deciding*. A compliance question asks "who approved this document and when" far
  // more often than it asks anything else in this product, and it must not have to filter a
  // stream that also contains every workflow rename.
  // -------------------------------------------------------------------------------------

  /** A document was handed to its workflow. Records which version it bound to. */
  SUBMITTED: 'SUBMITTED',
  /** Tasks exist for a stage's approvers, and who they resolved to. */
  STAGE_ACTIVATED: 'STAGE_ACTIVATED',
  /** An approver agreed. Carries the actor, the person acted for, and the revision decided on. */
  APPROVED: 'APPROVED',
  /** An approver refused. The comment is required and is in the payload. */
  REJECTED: 'REJECTED',
  /** An approver sent it back to its author, with what they want changed. */
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  /** A deadline passed and the task went to somebody else, per the stage's rule. */
  ESCALATED: 'ESCALATED',
  /**
   * The engine decided a task itself, under a stage the definition marked non-controlling.
   *
   * Its own action rather than an `APPROVED` with a flag, because an approval nobody made is the
   * one entry in this trail that an auditor will want to find by searching for it.
   */
  AUTO_APPROVED: 'AUTO_APPROVED',
  /** An approval ended without a decision: withdrawn by its author, or cancelled administratively. */
  WITHDRAWN: 'WITHDRAWN',
  /** Timers stopped, or started again. Held approvals are a question an administrator asks. */
  WORKFLOW_PAUSED: 'WORKFLOW_PAUSED',
  /**
   * A deadline or a reminder arrived.
   *
   * Written even when it changed nothing — a `NOTIFY_ONLY` deadline, or a duplicate delivery of a
   * job that had already fired. That is the point of it: "the deadline passed and the engine did
   * what the definition said" is a fact, and a trail that only recorded the firings which caused a
   * state change could not distinguish a stage nobody chased from one the engine never noticed.
   * The payload says which effect it had.
   */
  TIMER_FIRED: 'TIMER_FIRED',
  /**
   * A decision taken under a delegation — `13-audit-architecture.md` §2's Delegation group.
   *
   * Written by the engine rather than by Identity, and that is deliberate rather than a boundary
   * slip: the *act* being recorded is a decision on an approval task, and it is written in the
   * same transaction as that decision through `AdministeredWriter.record`. Identity owns the
   * delegation and writes the other three of the group's four actions; this one belongs to
   * whoever writes the decision, because an event in a different transaction from the act it
   * describes is the one thing 13 §1 forbids.
   *
   * Its subject is the **delegation**, not the task, so "everything done under this arrangement"
   * is a trail query on one subject.
   */
  DELEGATION_USED: 'DELEGATION_USED',
} as const;

export type WorkflowAuditAction = (typeof WorkflowAudit)[keyof typeof WorkflowAudit];
