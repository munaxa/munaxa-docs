import { Inject, Injectable } from '@nestjs/common';

import { DomainError, ErrorCode, isDomainError } from '@edms/domain';

import { LOGGER, type Logger } from '../../observability/logger';
import { type MessageEnvelope, type PipelineBehavior } from '../messages';

/**
 * Outermost behaviour: every message leaves the pipeline as a `DomainError` or a result.
 *
 * An adapter's own exception type — a Prisma error, an SDK error — must not travel upward:
 * it would leak schema and vendor detail into the HTTP layer, and the error filter would
 * have to know about both.
 */
@Injectable()
export class ExceptionBehavior implements PipelineBehavior {
  readonly order = 0;

  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  async handle(envelope: MessageEnvelope, next: () => Promise<unknown>): Promise<unknown> {
    try {
      return await next();
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      this.logger.error('Unhandled failure in message pipeline', {
        message: envelope.name,
        kind: envelope.kind,
        error: error instanceof Error ? error.stack : String(error),
      });
      throw new DomainError(ErrorCode.INTERNAL, 'The operation could not be completed.');
    }
  }
}
