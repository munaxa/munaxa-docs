/** Audit vocabulary (`docs/architecture/13-audit-architecture.md`). */
export const AuditOutcome = {
  SUCCESS: 'SUCCESS',
  DENIED: 'DENIED',
  FAILED: 'FAILED',
} as const;

export type AuditOutcomeKey = (typeof AuditOutcome)[keyof typeof AuditOutcome];

/** What an audit event is about. Kept coarse: the event type carries the detail. */
export const AuditSubjectType = {
  DOCUMENT: 'DOCUMENT',
  REVISION: 'REVISION',
  FOLDER: 'FOLDER',
  LIBRARY: 'LIBRARY',
  USER: 'USER',
  ROLE: 'ROLE',
  WORKFLOW: 'WORKFLOW',
  TASK: 'TASK',
  CONFIGURATION: 'CONFIGURATION',
  SESSION: 'SESSION',
  FILE: 'FILE',
  /** A search or an index operation — the Phase 8 additions: an audited `search:all` query, a rebuild. */
  SEARCH: 'SEARCH',
  /**
   * An evidence bundle — the Phase 9 addition.
   *
   * An export is not a `DOCUMENT`: it is an artefact *about* documents, with its own identifier,
   * its own retention and its own download. Filing `AUDIT_EXPORTED` under the document type would
   * put a row in the timeline of whichever document happened to be first in the range.
   */
  EXPORT: 'EXPORT',
  /**
   * A bulk operation — the Phase 16 addition, and for the same reason `EXPORT` was Phase 9's.
   *
   * An operation over four hundred documents is not a `DOCUMENT`. Filing it under the document
   * type would put it on the timeline of whichever document happened to be first in the batch,
   * and every other document's timeline would carry the per-object row with no way back to the
   * act that caused it. It has its own identifier, its own record and its own per-object
   * outcomes, so it is its own subject — which is also what makes "what did that import touch"
   * a query on one subject rather than a scan.
   */
  BULK_OPERATION: 'BULK_OPERATION',
  /**
   * A delegation — the Phase 11 addition, and for the same reason `EXPORT` was Phase 9's.
   *
   * A delegation is not a `USER`. Filing its four actions under the user type would put them on
   * *somebody's* user timeline, and there is no honest answer to whose: a delegation is an
   * arrangement between two people, and picking the delegator would hide from the delegate every
   * record of an authority they were given. It has its own identifier, its own life and its own
   * history screen, so it is its own subject — which is also what makes "everything decided under
   * this arrangement" a query on one subject.
   */
  DELEGATION: 'DELEGATION',
  /**
   * An integration — the Phase 17 addition: an API client, a webhook endpoint, an identity
   * provider, an audit sink.
   *
   * One subject type for four resources, unlike the three additions above, and the difference is
   * worth stating. `EXPORT`, `BULK_OPERATION` and `DELEGATION` each earned their own type because
   * each has a *timeline somebody reads* — "everything decided under this arrangement", "what did
   * that import touch". An integration's four resources have one audience and one question
   * between them: what did the administrator change about how this tenant connects to other
   * systems. `CONFIGURATION` was the near miss and is wrong for the opposite reason — it would put
   * "somebody minted an API key that can read every document this person can" in the same stream
   * as "somebody changed the digest hour", and the first is a security event.
   */
  INTEGRATION: 'INTEGRATION',
} as const;

export type AuditSubjectTypeKey = (typeof AuditSubjectType)[keyof typeof AuditSubjectType];

/** How the actor reached the system, so an API key action is distinguishable from a browser one. */
export const ActorChannel = {
  WEB: 'WEB',
  API: 'API',
  WORKER: 'WORKER',
  SYSTEM: 'SYSTEM',
} as const;

export type ActorChannelKey = (typeof ActorChannel)[keyof typeof ActorChannel];
