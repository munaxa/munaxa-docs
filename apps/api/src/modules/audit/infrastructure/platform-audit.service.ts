import { uuidv7 } from '@edms/utils';
import { AuditService } from '@munaxa/audit';
import type { AuditRepositoryPort } from '@munaxa/interfaces';
import { unsafeId } from '@munaxa/types';
import type { CorrelationId, SecurityEvent, TenantId as PlatformTenantId } from '@munaxa/types';
import { AuditOutcome, type DocsAuditAction } from '@edms/domain';

import type { AuditActor, AuditEntry } from '../../../core/audit/audit-writer.port';
import { DOCS_CANONICAL_V3, type DocsAuditFields } from '../../../core/audit/platform-canonical';

/**
 * An `AuditService` bound to one instant.
 *
 * ## Why this is a factory rather than a provider
 *
 * `AuditService` reads its clock once per write and uses that value for two things: the record's
 * `recordedAt`, and the argument it hands `generateId`. This product needs both to equal the
 * event's `occurredAt` — the moment somebody acted — and not the moment the append ran.
 *
 * For a synchronous write those are microseconds apart and it would be tempting not to care. For a
 * buffered read they are not: a view recorded at 09:30 is flushed seconds or minutes later, and a
 * singleton service would mint that record's UUID v7 from the flush instant. The identifier would
 * then sort by *when the batch went out* rather than by when the document was read, which is the
 * one property `13-audit-architecture.md` §5 asks the buffer to preserve. It would also put a
 * `recordedAt` in the sealed record that disagrees with the `occurred_at` in its own row.
 *
 * Binding the instant at construction removes the question. The service is a plain object with no
 * I/O in its constructor, so one per append costs nothing measurable against the round trip it is
 * about to make, and there is no shared mutable "current instant" to get wrong under concurrency.
 *
 * ## What the Platform now owns
 *
 * Sealing, in full: the canonical material, the SHA-256 over it, the chain linkage, the sequence
 * advance, and the format stamp. This module supplies three things the Platform cannot know — the
 * historical canonical format, the identifier strategy, and the instant — and nothing else.
 */
export function createDocsAuditService(
  repository: AuditRepositoryPort<DocsAuditAction>,
  occurredAt: Date,
): AuditService<DocsAuditAction> {
  const at = occurredAt.getTime();
  return new AuditService<DocsAuditAction>({
    repository,
    clock: { now: () => at },
    // Pinned rather than left to default, so a Platform release that changes its own current
    // format cannot silently change what this product's digests mean. Moving to a v4 will be a
    // deliberate edit here, next to a migration that stamps the new version on new rows.
    canonicalFormat: DOCS_CANONICAL_V3,
    /**
     * The identifier strategy this product has used since Phase 1, unchanged.
     *
     * UUID v7 minted from the event's own instant, so identifiers sort in the order things
     * happened. It matters that the Platform calls this *before* hashing: all three Docs formats
     * cover the event id, so an id derived from the digest — the Platform's own default — would
     * be circular. That ordering is exactly what Platform 2.3.0 added.
     */
    generateId: () => uuidv7(at),
  });
}

/**
 * The event the sealer hashes.
 *
 * Every field the digest covers comes from here, which is why the row is built from the sealed
 * record afterwards rather than assembled in parallel: there is one description of the act, and
 * both the hash and the row are derived from it.
 */
export function toPlatformEvent(
  actor: AuditActor,
  entry: AuditEntry,
  occurredAt: Date,
): SecurityEvent<Readonly<Record<string, unknown>>, DocsAuditAction> {
  const docs: DocsAuditFields = {
    outcome: entry.outcome,
    reason: entry.reason ?? null,
    // Phase 17, and covered by the v3 format: which credential took the action, attested rather
    // than merely recorded.
    apiClientId: actor.apiClientId ?? null,
    payload: entry.payload,
  };
  return {
    name: entry.action,
    occurredAt: occurredAt.getTime(),
    tenantId: unsafeId<PlatformTenantId>(actor.tenantId),
    correlationId: unsafeId<CorrelationId>(actor.correlationId),
    // The Platform-shaped projection, for a Platform-shaped query. The digest reads
    // `docs.outcome`, which is the token this product has always written and hashed.
    outcome: entry.outcome === AuditOutcome.SUCCESS ? 'success' : 'denied',
    severity: 'info',
    ...(actor.userId === null
      ? {}
      : {
          actor: {
            id: actor.userId,
            kind: 'user',
            ...(entry.onBehalfOfId === undefined ? {} : { onBehalfOf: entry.onBehalfOfId }),
          },
        }),
    target: { id: entry.subjectId, type: entry.subjectType },
    source: {
      component: actor.channel,
      ...(actor.ipAddress === null ? {} : { ipAddress: actor.ipAddress }),
      ...(actor.userAgent === null ? {} : { userAgent: actor.userAgent }),
    },
    payload: { docs },
  };
}
