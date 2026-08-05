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
