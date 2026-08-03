import { Inject, Injectable } from '@nestjs/common';

import type { AnyId, UserId } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import type { ActivityEntry, ActivityReader } from '../../../core/activity/activity.port';
import {
  AUDIT_REPOSITORY,
  type AuditEventRecord,
  type AuditRepository,
} from '../application/ports';

/**
 * The activity feed, read from the audit trail.
 *
 * There is no second store and no projection job to fall behind: activity *is* the trail,
 * narrowed to what a person needs to see. The hash, the previous hash and the sequence are
 * dropped here — they are what makes the trail evidence, and they mean nothing on a screen —
 * and so is the payload, which is minimised for investigators rather than written for readers.
 *
 * Row-level security scopes every read, so a feed cannot show another tenant's activity even
 * if a caller asks for an identifier from one.
 */
@Injectable()
export class AuditActivityReader implements ActivityReader {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository) {}

  async forSubject(subjectId: AnyId, page: PageRequest): Promise<Page<ActivityEntry>> {
    const events = await this.audit.listForSubject(subjectId, page);
    return { data: events.data.map(toEntry), meta: events.meta };
  }

  async forActor(actorId: UserId, page: PageRequest): Promise<Page<ActivityEntry>> {
    const events = await this.audit.listForActor(actorId, page);
    return { data: events.data.map(toEntry), meta: events.meta };
  }
}

function toEntry(event: AuditEventRecord): ActivityEntry {
  return {
    id: event.id,
    occurredAt: event.occurredAt,
    actorId: event.actorId,
    action: event.action,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    outcome: event.outcome,
  };
}
