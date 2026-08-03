import type { DomainEvent } from '@edms/domain';

/**
 * The three kinds of message the application handles, and the pipeline they travel through.
 *
 * Why a mediator at all: cross-cutting concerns — validation, logging, audit, transactions,
 * error translation — otherwise get copy-pasted into every use case, and the copies drift.
 * Here they are declared once as behaviours and applied in a fixed order to every message.
 */

/** A request that changes state. Commands are named as imperatives: `SubmitDocument`. */
export abstract class Command<TResult = void> {
  /** Phantom: carries the result type so `send()` infers it. Never read at runtime. */
  declare readonly __result?: TResult;
}

/** A request that reads state. A query that writes is a defect, not a shortcut. */
export abstract class Query<TResult> {
  declare readonly __result?: TResult;
}

export type MessageResult<TMessage> =
  TMessage extends Command<infer TResult>
    ? TResult
    : TMessage extends Query<infer TResult>
      ? TResult
      : never;

export interface CommandHandler<TCommand extends Command<unknown>> {
  execute(command: TCommand): Promise<MessageResult<TCommand>>;
}

export interface QueryHandler<TQuery extends Query<unknown>> {
  execute(query: TQuery): Promise<MessageResult<TQuery>>;
}

export interface EventHandler<TEvent extends DomainEvent = DomainEvent> {
  /** At-least-once delivery: every handler must be idempotent on `event.eventId`. */
  handle(event: TEvent): Promise<void>;
}

export type MessageKind = 'command' | 'query' | 'event';

export interface MessageEnvelope {
  readonly kind: MessageKind;
  readonly name: string;
  readonly message: unknown;
}

/**
 * One step of the pipeline. `next()` runs the rest of it; a behaviour that does not call it
 * short-circuits the message, which is exactly what an idempotency replay wants to do.
 */
export interface PipelineBehavior {
  /** Lower runs first, on the way in — and therefore last on the way out. */
  readonly order: number;
  handle(envelope: MessageEnvelope, next: () => Promise<unknown>): Promise<unknown>;
}

export const PIPELINE_BEHAVIOR = Symbol('PipelineBehavior');
