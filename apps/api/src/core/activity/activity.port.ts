import type { AnyId, UserId } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * Activity — what has been happening, for a person to read.
 *
 * **This is a projection of the audit trail, not a second log.** There is deliberately no
 * `activity` table. Two records of what happened can disagree, and when they do, the one shown
 * to users and the one shown to auditors will be the pair that disagrees — which is the worst
 * possible place for a discrepancy in a product whose selling point is evidence.
 *
 * So the trail is the record, and this is a *view* of it: filtered to what the reader may see,
 * phrased for a person rather than for an investigator. The distinction that matters is the
 * audience, not the data.
 *
 * The consequence is a constraint worth stating: an activity feed can never show something the
 * audit trail does not contain. If a feature wants to surface an event, it writes an audit
 * event — and then it is evidence too.
 */
export const ACTIVITY_READER = Symbol('ActivityReader');

export interface ActivityEntry {
  readonly id: AnyId;
  readonly occurredAt: Date;
  readonly actorId: UserId | null;
  /** The audit action, e.g. `LOGIN_SUCCEEDED`. Rendered per locale by the client. */
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: AnyId;
  readonly outcome: string;
}

export interface ActivityReader {
  /** What happened to one thing — a document's history tab, a user's account activity. */
  forSubject(subjectId: AnyId, page: PageRequest): Promise<Page<ActivityEntry>>;
  /** What one person did. The reader must hold `audit:view` to ask about anybody else. */
  forActor(actorId: UserId, page: PageRequest): Promise<Page<ActivityEntry>>;
}
