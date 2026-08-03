import { Inject, Injectable } from '@nestjs/common';

import { LOGGER, type Logger } from '../../observability/logger';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { currentContext } from '../../tenancy/tenant-context';
import { type MessageEnvelope, type PipelineBehavior } from '../messages';

/**
 * One structured line per message, with its duration.
 *
 * It logs the message *name*, never the message body: a command payload can contain a
 * document title, a comment or a reason, and none of those belong in a log sink
 * (`docs/architecture/17-security-architecture.md` §7).
 */
@Injectable()
export class LoggingBehavior implements PipelineBehavior {
  readonly order = 10;

  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
  ) {}

  async handle(envelope: MessageEnvelope, next: () => Promise<unknown>): Promise<unknown> {
    const startedAt = this.clock.timestamp();
    const context = currentContext();
    const bindings = {
      message: envelope.name,
      kind: envelope.kind,
      correlationId: context?.correlationId ?? null,
      tenantId: context?.tenantId ?? null,
      userId: context?.userId ?? null,
    };

    try {
      const result = await next();
      this.logger.info('Message handled', {
        ...bindings,
        durationMs: this.clock.elapsedMs(startedAt),
      });
      return result;
    } catch (error) {
      this.logger.warn('Message failed', {
        ...bindings,
        durationMs: this.clock.elapsedMs(startedAt),
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw error;
    }
  }
}
