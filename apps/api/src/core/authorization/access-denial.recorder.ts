import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  ActorChannel,
  AuditOutcome,
  type AuditSubjectTypeKey,
  AuditSubjectType,
  type PermissionKey,
  ScopeType,
  type ScopeTypeKey,
} from '@edms/domain';

import { AUDIT_WRITER, type AuditWriter } from '../audit/audit-writer.port';
import { LOGGER, type Logger } from '../observability/logger';
import { METRICS, MetricName, type Metrics } from '../observability/metrics';
import { currentContext } from '../tenancy/tenant-context';
import { AuthorizationAudit } from './audit-actions';

/**
 * Records a refusal in the trail — `08-permission-model.md` §7's last row.
 *
 * One recorder, two call sites, for the reason every other cross-cutting obligation in this
 * product has one implementation: a refusal recorded differently in two places is a compliance
 * report that has to know which code path denied it.
 *
 * ## Why it is safe to record a denial that may name a nonexistent object
 *
 * §7's rule is "every denied attempt on an **existing** object", and the distinction is a security
 * one: a trail that separated "denied" from "absent" would answer, for anyone who later reads it,
 * the existence question the `404` is written to withhold.
 *
 * Today that distinction cannot arise. `PrismaAclResolver` decides from the caller's role grants
 * without consulting the object at all (08 §9), so a refusal is a fact about the *caller* and
 * carries no information about whether the identifier names anything. When the ACL walk arrives
 * and decisions become object-dependent, the condition starts to matter — and it matters *here*,
 * in the one place refusals are recorded, rather than in each guard.
 *
 * ## Why it never fails the request
 *
 * The caller is already being refused. Turning an audit-write failure into a different error —
 * or into a success — would change the outcome of an authorisation decision because of a
 * bookkeeping problem, which is the wrong direction in both cases. It is logged at error instead,
 * because 13 §7 forbids dropping an event *silently*, not loudly.
 */
@Injectable()
export class AccessDenialRecorder {
  constructor(
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  async record(input: {
    readonly scopeType: ScopeTypeKey;
    readonly subjectId: AnyId;
    readonly permission: PermissionKey;
    /** Why the resolver said no — `DENY`, `CLOSED_BY_DEFAULT`, `STATE`, `CONFIDENTIALITY`. */
    readonly reason: string;
  }): Promise<void> {
    // Recorded before the trail is touched, so a refusal is counted even when the audit write
    // fails — the two are independent evidence and the metric is the one 17 §9's "repeated
    // ACCESS_DENIED by one actor" alert fires on. **The actor is deliberately not a label**: an
    // alert names the permission and the reason, and *who* is a question the trail answers with a
    // row rather than the metrics backend with a series per user.
    this.metrics.increment(MetricName.ACCESS_DENIED, {
      permission: input.permission,
      reason: input.reason,
    });
    const context = currentContext();
    if (context === null) {
      // No tenant, no chain to append to. Reachable only for a refusal outside a request, which
      // nothing currently produces; logging rather than throwing keeps the refusal a refusal.
      this.logger.error('A denied access could not be audited: no request context');
      return;
    }
    try {
      // `writeStandalone`, because a refusal has nothing committing alongside it — this is the
      // caller Phase 1 wrote that method for.
      await this.audit.writeStandalone(
        {
          tenantId: context.tenantId,
          userId: context.userId,
          channel: context.channel ?? ActorChannel.WEB,
          ...(context.apiClientId !== undefined && { apiClientId: context.apiClientId }),
          correlationId: context.correlationId,
          ipAddress: null,
          userAgent: null,
        },
        {
          action: AuthorizationAudit.ACCESS_DENIED,
          subjectType: subjectTypeFor(input.scopeType),
          subjectId: input.subjectId,
          outcome: AuditOutcome.DENIED,
          payload: {
            permission: input.permission,
            scopeType: input.scopeType,
            decision: input.reason,
          },
        },
      );
    } catch (error) {
      this.logger.error('A denied access could not be audited', {
        permission: input.permission,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}

/**
 * The audit subject type a scope node is recorded under.
 *
 * The scope tree's upper nodes — tenant, company, entity, department — have no audit subject type
 * of their own, and inventing four would add rows to 13 §2 for the sake of a refusal's filing.
 * They are configuration to an investigation, and `CONFIGURATION` is what the catalogue already
 * calls that.
 */
function subjectTypeFor(scopeType: ScopeTypeKey): AuditSubjectTypeKey {
  switch (scopeType) {
    case ScopeType.DOCUMENT:
      return AuditSubjectType.DOCUMENT;
    case ScopeType.FOLDER:
      return AuditSubjectType.FOLDER;
    case ScopeType.LIBRARY:
      return AuditSubjectType.LIBRARY;
    default:
      return AuditSubjectType.CONFIGURATION;
  }
}
