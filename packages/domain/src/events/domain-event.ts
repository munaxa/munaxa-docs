import type { AnyId, TenantId, UserId } from '../ids';

/**
 * The envelope every domain event travels in — through the outbox, onto a queue, into a
 * handler (`docs/architecture/02-backend-architecture.md` §6).
 *
 * Three rules hold for every event in the product:
 *
 * 1. An event is a **fact in the past tense** (`DocumentApproved`), never a command.
 * 2. A shipped payload shape **never changes**. Fields are added, never removed or
 *    repurposed; a genuinely different shape is a new `version`.
 * 3. Delivery is **at least once**, so every handler is idempotent on `eventId`.
 */
export interface DomainEvent<TType extends string = string, TPayload = unknown> {
  /** Stable identity of this occurrence; the idempotency key every handler dedupes on. */
  readonly eventId: AnyId;
  /** `<aggregate>.<fact>`, e.g. `document.approved`. */
  readonly type: TType;
  /** Payload contract version. Starts at 1 and only ever increases. */
  readonly version: number;
  readonly tenantId: TenantId;
  readonly aggregateType: string;
  readonly aggregateId: AnyId;
  /** When the fact became true, not when it was dispatched. */
  readonly occurredAt: Date;
  /** The user whose action caused it; absent when the system acted alone. */
  readonly actorId: UserId | null;
  /** Ties the event to the request that produced it, across API, worker and logs. */
  readonly correlationId: string;
  readonly payload: TPayload;
}

/** What a module's domain layer returns; the envelope's transport fields are added on write. */
export type DomainEventDraft<TType extends string = string, TPayload = unknown> = Pick<
  DomainEvent<TType, TPayload>,
  'type' | 'version' | 'aggregateType' | 'aggregateId' | 'payload'
>;

/** Anything that accumulates events while its invariants are enforced. */
export interface EventfulAggregate {
  pullDomainEvents(): readonly DomainEventDraft[];
}

export function defineEvent<TType extends string, TPayload>(
  type: TType,
  version: number,
  aggregateType: string,
): (aggregateId: AnyId, payload: TPayload) => DomainEventDraft<TType, TPayload> {
  return (aggregateId, payload) => ({ type, version, aggregateType, aggregateId, payload });
}
