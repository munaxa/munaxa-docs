import type {
  ActorChannelKey,
  AnyId,
  AuditOutcomeKey,
  AuditSubjectTypeKey,
  TenantId,
  UserId,
} from '@edms/domain';

/**
 * Writing to the audit trail.
 *
 * The write joins the caller's ambient transaction, so the audit event and the change it
 * describes commit together: there is no window in which a document changed and the trail
 * does not say so (`docs/architecture/13-audit-architecture.md`).
 *
 * Audit outlives its subject. It is never soft-deleted and never purged with the document.
 */
export const AUDIT_WRITER = Symbol('AuditWriter');

export interface AuditEntry {
  readonly action: string;
  readonly subjectType: AuditSubjectTypeKey;
  readonly subjectId: AnyId;
  readonly outcome: AuditOutcomeKey;
  /** Minimised: enough to reconstruct what happened, never a document's content. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Required where a confidentiality level or a policy demands a stated reason. */
  readonly reason?: string;
  readonly onBehalfOfId?: UserId;
}

export interface AuditActor {
  readonly tenantId: TenantId;
  readonly userId: UserId | null;
  readonly channel: ActorChannelKey;
  readonly correlationId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /**
   * The API key the request arrived on — Phase 17, and null for every human request.
   *
   * A separate column rather than a payload field, for the reason 13 §4 gives about `reason`: the
   * chain's digest covers the row's fields, so a key identifier here is *attested* by the hash,
   * while the same value in a `jsonb` payload would be attested only as part of a blob the
   * verifier cannot address. "Which credential took this action" is precisely the question an
   * incident asks first, and it must not be answerable only by trusting the payload.
   */
  readonly apiClientId?: AnyId;
}

export interface AuditWriter {
  /** The normal path: inside the use case's unit of work, which it must already be in. */
  write(actor: AuditActor, entry: AuditEntry): Promise<void>;
  /**
   * For events with nothing to commit alongside them — a denied read, a failed login. Opens
   * its own transaction. Still chained, still append-only.
   */
  writeStandalone(actor: AuditActor, entry: AuditEntry): Promise<void>;
}
