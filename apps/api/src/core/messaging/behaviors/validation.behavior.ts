import { Injectable } from '@nestjs/common';
import { ZodError, type ZodType } from 'zod';

import { ValidationError } from '../../errors/application-errors';
import { type MessageEnvelope, type PipelineBehavior } from '../messages';

export const MESSAGE_SCHEMA = Symbol('MessageSchema');

/** A message that carries its own schema. Validation then needs no registry to maintain. */
export interface SelfValidating {
  readonly [MESSAGE_SCHEMA]: ZodType;
}

function isSelfValidating(message: unknown): message is SelfValidating {
  return (
    typeof message === 'object' &&
    message !== null &&
    MESSAGE_SCHEMA in (message.constructor as object)
  );
}

/**
 * Validates a message before any handler sees it.
 *
 * This is the *second* validation, and deliberately so: the HTTP DTO validates the wire
 * shape, and this validates the message a handler receives regardless of who constructed it
 * — a controller, a queue consumer, a scheduled job. The transport-level check protects the
 * parser; this one protects the invariant.
 */
@Injectable()
export class ValidationBehavior implements PipelineBehavior {
  readonly order = 20;

  async handle(envelope: MessageEnvelope, next: () => Promise<unknown>): Promise<unknown> {
    const constructor = (envelope.message as object | null)?.constructor as
      (SelfValidating & { new (...args: never[]): unknown }) | undefined;

    if (constructor && isSelfValidating(envelope.message)) {
      const schema = constructor[MESSAGE_SCHEMA];
      try {
        schema.parse(envelope.message);
      } catch (error) {
        if (error instanceof ZodError) {
          throw new ValidationError(
            `${envelope.name} is not valid.`,
            error.issues.map((issue) => ({
              field: issue.path.join('.'),
              message: issue.message,
            })),
          );
        }
        throw error;
      }
    }
    return next();
  }
}
