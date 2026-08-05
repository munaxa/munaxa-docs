/**
 * What a webhook receiver actually gets — Phase 17.
 *
 * ## The envelope is a notification, not a copy of the record
 *
 * The single most tempting mistake here is to put the document in the payload. It is what makes
 * an integration easy to write, and it is wrong for three reasons that compound:
 *
 * **It is a disclosure with no permission behind it.** An outbound webhook has no subject, so
 * there is nothing to resolve the endpoint's reach against — see `application/ports.ts`. A payload
 * carrying a document's title, its confidentiality level and its author is that content leaving
 * the tenant on the strength of a URL somebody typed. 18 §8's first prohibition —
 * *"notifications must never carry document content"* — is written about people and applies with
 * more force to a system, because a person at least had to be a recipient.
 *
 * **It goes stale in the worst direction.** A delivery retried for a day carries the state the
 * document had a day ago. A receiver acting on it acts on the past, and a receiver that read the
 * document instead would have acted on the present.
 *
 * **It is unbounded.** A payload sized by whatever the aggregate happens to hold is a payload that
 * grows when a later phase adds a column.
 *
 * So the envelope carries **identity, type and time** — enough to say *what happened to which
 * object, when* — and the receiver calls back through the ordinary API with its own credential and
 * gets exactly what that credential may see. That is the same reasoning 18 §8 gives for a
 * notification's deep link: *"every link resolves through normal authorisation"*. Here it is
 * stronger, because the callback is an API key with a subject and scopes, so a webhook can never
 * disclose more than an ordinary request by the same integration would.
 *
 * The outbox row's own payload is deliberately **not** forwarded. Its shape is each module's
 * internal business and has never been a contract; forwarding it would freeze every module's event
 * payload into a public API by accident, which is the kind of commitment nobody notices making.
 */

export interface WebhookEnvelope {
  /** The delivery, so a receiver can de-duplicate independently of us. */
  readonly id: string;
  /** The outbox event. Stable across retries and across endpoints — the idempotency key. */
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  /** Which tenant this is about, because one receiver may serve several. */
  readonly tenantId: string;
  readonly subject: {
    readonly type: string;
    readonly id: string;
  };
  /** Echoed from the request that caused the event, so a receiver can join our logs to theirs. */
  readonly correlationId: string;
  /** How many times this delivery has been attempted, this one included. Starts at 1. */
  readonly attempt: number;
}

export function buildEnvelope(input: {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly attempt: number;
}): WebhookEnvelope {
  return {
    id: input.deliveryId,
    eventId: input.eventId,
    type: input.eventType,
    occurredAt: input.occurredAt.toISOString(),
    tenantId: input.tenantId,
    subject: { type: input.aggregateType, id: input.aggregateId },
    correlationId: input.correlationId,
    attempt: input.attempt,
  };
}

/**
 * The bytes.
 *
 * Serialised **once**, when the delivery row is written, and stored. Every retry sends the stored
 * string rather than re-serialising the envelope, which is what makes a signature reproducible: a
 * receiver verifies a digest over exact bytes, and `JSON.stringify` is not guaranteed to produce
 * the same string twice across releases.
 *
 * `attempt` is the one field that would want to change per attempt and deliberately does not — it
 * is baked at 1 in the stored payload and the *header* carries the live count. A receiver
 * comparing the two learns nothing useful, and a payload that changed per attempt would have a
 * different signature each time for the same event, which is worse to debug than a stale integer.
 */
export function serialiseEnvelope(envelope: WebhookEnvelope): string {
  return JSON.stringify(envelope);
}
