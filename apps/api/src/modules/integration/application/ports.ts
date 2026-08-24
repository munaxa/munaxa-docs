import type { AnyId, TenantId, WebhookDeliveryStateKey } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * The integration module's contracts — Phase 17.
 *
 * ## Why a webhook is not a notification, argued rather than assumed
 *
 * `NotificationChannel.WEBHOOK` has been in the schema since Phase 12 with no adapter behind it,
 * and 18 §3's table says *"Webhook | Phase 17 | Per-tenant outbound webhooks for integration,
 * signed, retried, and audited"*. The obvious reading is that this phase writes a
 * `NotificationPort` adapter for that channel and is done. It does not, and the reason is the
 * safety property Phase 12 built the notification module around:
 *
 * > **No recipient list derived from a document reaches a renderer without every name in it
 * > passing the ACL resolver** (18 §8, `RecipientVisibilityService`).
 *
 * That property is about **people**. A notification is addressed to a person, and the question it
 * answers — may *this human* be told that this document exists — is a permission question with a
 * subject. A webhook is addressed to a **system**, and the question has no subject to ask about:
 * an endpoint is not a user, holds no roles, appears in no ACL entry, and there is no honest
 * answer to "may `https://hooks.acme.example/edms` see this document".
 *
 * Riding the notification path would therefore mean one of two things, and both are bad. Either
 * the endpoint is given a subject to be resolved against — which is inventing a person so that a
 * check has something to check, and whatever answer it gives is fiction. Or the ACL walk is
 * skipped for this one channel — which puts a `if (channel !== WEBHOOK)` inside the one code path
 * whose entire purpose is that it has no exceptions.
 *
 * The rest follows and confirms it. A notification has a recipient's *preferences*, quiet hours, a
 * digest frequency, a locale and a rendered template; none of those mean anything for an endpoint.
 * A webhook has a signature, a replay window, a retry schedule an administrator can see and a
 * dead-letter state; none of those mean anything for a person.
 *
 * **So `NotificationChannel.WEBHOOK` is a value nothing will ever use**, and this phase says so in
 * 18 §3 rather than leaving a reader to infer it. It is not removed: it is in a PostgreSQL enum
 * that `notification_preference.channels` is an array of, and dropping a value from an enum a
 * column depends on is a migration with no benefit at the end of it.
 *
 * ## What a webhook subscriber wants from the outbox, and why that mattered here
 *
 * *Every* event family. The prefix table in `prisma-outbox.dispatcher.ts` has now silently dropped
 * a family twice — `delegation.*` from Phase 11 until Phase 12 found it, and `library.*` until
 * Phase 14 — and for every consumer before this one the failure was *partial*: the search index
 * missed some re-projections, the notification lane missed some messages. For a webhook
 * subscriber the failure mode is **total**: an integration built on "tell me when anything
 * happens" that silently receives nothing from one family is an integration whose author has no
 * way to discover the gap, because absence is indistinguishable from quiet.
 *
 * That is why `routesFor`'s **default** changed in this phase rather than a line being added to
 * it. An event type matching no branch now routes to the webhook lane instead of nowhere, so the
 * next phase that adds an event family gets webhooks for free and cannot repeat the defect.
 */

export const WEBHOOK_REPOSITORY = Symbol('WebhookRepository');
export const WEBHOOK_SERVICE = Symbol('WebhookService');
export const WEBHOOK_DELIVERY_SERVICE = Symbol('WebhookDeliveryService');
export const AUDIT_SINK_REPOSITORY = Symbol('AuditSinkRepository');
export const AUDIT_SINK_SERVICE = Symbol('AuditSinkService');

/**
 * The chain, as a stream source — declared here and implemented by the Audit module.
 *
 * Phase 13's shape, and for its reason: a module may call downward and publish upward, never
 * sideways into another module's repositories. `AUDIT_REPOSITORY` is exported by `AuditModule` and
 * injecting it here would be exactly that sideways reach, with the extra cost that this module
 * would then hold a handle able to `append` to the hash chain.
 *
 * The interface is narrow on purpose: one method, read-only, keyset by sequence. It is the same
 * `sliceBySequence` the verifier and the evidence exporter walk the chain with, so a sink can
 * never see a different trail from the one an evidence bundle attests.
 */
export const AUDIT_STREAM_SOURCE = Symbol('AuditStreamSource');

/** One row, as a stream carries it. Flat, and carrying its own digest. */
export interface StreamSourceEvent {
  readonly id: string;
  readonly sequence: bigint;
  readonly occurredAt: Date;
  readonly actorId: string | null;
  readonly onBehalfOfId: string | null;
  readonly apiClientId: string | null;
  readonly channel: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcome: string;
  readonly correlationId: string;
  readonly reason: string | null;
  readonly hash: string;
  readonly previousHash: string;
  readonly chainHashVersion: number;
}

export interface AuditStreamSource {
  /** A contiguous window of this tenant's chain, in written order. Never ACL-filtered — 08 §10. */
  sliceBySequence(afterSequence: bigint, limit: number): Promise<readonly StreamSourceEvent[]>;
}

export interface WebhookEndpointRecord {
  readonly id: AnyId;
  readonly name: string;
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly enabled: boolean;
  readonly failureCount: number;
  readonly disabledAt: Date | null;
  readonly disabledReason: string | null;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
  readonly version: number;
}

/** The endpoint plus its signing key — for the deliverer alone, never for a read path. */
export interface WebhookEndpointCredential extends WebhookEndpointRecord {
  readonly secret: string;
}

export interface WebhookDeliveryRecord {
  readonly id: AnyId;
  readonly endpointId: AnyId;
  readonly eventId: AnyId;
  readonly eventType: string;
  readonly state: WebhookDeliveryStateKey;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly responseStatus: number | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
}

/** A delivery with the bytes to send. Read only by the deliverer. */
export interface PendingDelivery extends WebhookDeliveryRecord {
  readonly payload: string;
}

export interface WebhookRepository {
  listEndpoints(page: PageRequest): Promise<Page<WebhookEndpointRecord>>;
  findEndpoint(id: AnyId): Promise<WebhookEndpointRecord | null>;
  /** The signing key included. Separate from `findEndpoint` so a read path cannot reach it. */
  findEndpointCredential(id: AnyId): Promise<WebhookEndpointCredential | null>;
  /** Every live, enabled endpoint — the fan-out's source. */
  activeEndpoints(): Promise<readonly WebhookEndpointRecord[]>;
  createEndpoint(input: {
    readonly id: AnyId;
    readonly name: string;
    readonly url: string;
    readonly secret: string;
    readonly eventTypes: readonly string[];
    readonly enabled: boolean;
  }): Promise<WebhookEndpointRecord>;
  updateEndpoint(
    id: AnyId,
    expectedVersion: number,
    patch: {
      readonly name?: string;
      readonly url?: string;
      readonly secret?: string;
      readonly eventTypes?: readonly string[];
      readonly enabled?: boolean;
    },
  ): Promise<WebhookEndpointRecord>;
  deleteEndpoint(id: AnyId, at: Date): Promise<void>;

  /**
   * Records a delivery, or does nothing if this event has already been recorded for this endpoint.
   *
   * The outbox is at-least-once, so the same event arrives twice whenever a dispatcher crashes
   * between enqueue and mark-processed. Without this the second arrival is a second `POST` to
   * somebody else's server, which for an event meaning "a document was published" is a duplicate
   * they have to de-duplicate themselves. The unique index does the work; this reports whether it
   * fired.
   */
  recordDelivery(input: {
    readonly id: AnyId;
    readonly endpointId: AnyId;
    readonly eventId: AnyId;
    readonly eventType: string;
    readonly payload: string;
    readonly nextAttemptAt: Date;
  }): Promise<{ readonly created: boolean; readonly id: AnyId }>;

  findDelivery(id: AnyId): Promise<PendingDelivery | null>;
  /**
   * Claims one attempt at a delivery, answering it only to the caller that took it.
   *
   * `claimDue` selects; this is what claims. Two workers can meet the same due row — the sweep
   * runs every minute and `fanOut` attempts its own rows outside the transaction that wrote them
   * — and only the one whose update matched may send.
   */
  claimAttempt(id: AnyId, now: Date, leaseUntil: Date): Promise<PendingDelivery | null>;
  /** The retry sweep's claim: due, unsettled, oldest first. */
  claimDue(now: Date, limit: number): Promise<readonly PendingDelivery[]>;
  settleDelivered(id: AnyId, at: Date, status: number): Promise<void>;
  settleRetrying(
    id: AnyId,
    nextAttemptAt: Date,
    status: number | null,
    error: string,
  ): Promise<void>;
  settleDead(id: AnyId, status: number | null, error: string): Promise<void>;
  /** Consecutive failures, and the success that resets them. Both on the endpoint. */
  recordEndpointOutcome(
    endpointId: AnyId,
    outcome: { readonly succeeded: boolean; readonly at: Date; readonly disableReason?: string },
  ): Promise<void>;
  listDeliveries(
    endpointId: AnyId,
    state: WebhookDeliveryStateKey | null,
    page: PageRequest,
  ): Promise<Page<WebhookDeliveryRecord>>;
}

/**
 * The fan-out, called by the outbox lane consumer.
 *
 * One call per outbox event; it decides which endpoints subscribe, writes a delivery row for each
 * and attempts each. The write comes **first and commits**, which is what makes the attempt
 * losable without losing the event — the exact reasoning ADR-0011 gives for the outbox itself,
 * applied one layer out.
 */
export interface WebhookDeliveryService {
  fanOut(event: {
    readonly eventId: AnyId;
    readonly tenantId: TenantId;
    readonly eventType: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly occurredAt: Date;
    readonly payload: unknown;
    readonly correlationId: string;
  }): Promise<number>;
  /** One sweep of the retries whose backoff has elapsed. Returns how many it settled. */
  retryDue(now: Date): Promise<number>;
}

// --- Audit sink -------------------------------------------------------------------------

export interface AuditSinkRecord {
  readonly id: AnyId;
  readonly kind: 'PULL' | 'PUSH';
  readonly name: string;
  readonly endpointUrl: string | null;
  readonly actions: readonly string[];
  readonly lastStreamedSequence: bigint;
  readonly lastStreamedAt: Date | null;
  readonly lastError: string | null;
  readonly enabled: boolean;
  readonly version: number;
}

export interface AuditSinkCredential extends AuditSinkRecord {
  readonly secret: string | null;
}

export interface AuditSinkRepository {
  find(): Promise<AuditSinkRecord | null>;
  findCredential(): Promise<AuditSinkCredential | null>;
  upsert(input: {
    readonly id: AnyId;
    readonly kind: 'PULL' | 'PUSH';
    readonly name: string;
    readonly endpointUrl: string | null;
    readonly secret: string | null;
    readonly actions: readonly string[];
    readonly enabled: boolean;
  }): Promise<AuditSinkRecord>;
  /** Advances the cursor. Monotonic: the repository refuses a value below the stored one. */
  advance(id: AnyId, sequence: bigint, at: Date): Promise<void>;
  recordError(id: AnyId, error: string): Promise<void>;
  remove(id: AnyId, at: Date): Promise<void>;
}
