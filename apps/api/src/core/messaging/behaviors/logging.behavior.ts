import { Inject, Injectable } from '@nestjs/common';

import { LOGGER, type Logger } from '../../observability/logger';
import { METRICS, MetricName, type Metrics } from '../../observability/metrics';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { currentContext } from '../../tenancy/tenant-context';
import { type MessageEnvelope, type PipelineBehavior } from '../messages';

/**
 * One structured line per message, with its duration.
 *
 * It logs the message *name*, never the message body: a command payload can contain a
 * document title, a comment or a reason, and none of those belong in a log sink
 * (`docs/architecture/17-security-architecture.md` §7).
 *
 * **Phase 18 records the same duration as a histogram**, here rather than in a second behaviour.
 * The two signals are the same measurement read at two granularities — a line an operator greps
 * during an incident, and a distribution an alert fires on — and splitting them across two
 * behaviours would have meant two `elapsedMs` calls disagreeing about where the boundary was.
 * `message` and `kind` are labels because both are drawn from the handler catalogue, which is a
 * set fixed at compile time; the tenant and the user on the log line deliberately are not.
 */
@Injectable()
export class LoggingBehavior implements PipelineBehavior {
  readonly order = 10;

  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(METRICS) private readonly metrics: Metrics,
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
      const durationMs = this.clock.elapsedMs(startedAt);
      this.logger.info('Message handled', { ...bindings, durationMs });
      this.observe(envelope, durationMs, 'OK');
      return result;
    } catch (error) {
      const durationMs = this.clock.elapsedMs(startedAt);
      this.logger.warn('Message failed', {
        ...bindings,
        durationMs,
        error: error instanceof Error ? error.name : 'unknown',
      });
      this.observe(envelope, durationMs, 'FAILED');
      throw error;
    }
  }

  private observe(envelope: MessageEnvelope, durationMs: number, outcome: string): void {
    this.metrics.observe(MetricName.MESSAGE_DURATION, durationMs, {
      message: envelope.name,
      kind: envelope.kind,
      outcome,
    });
  }
}
