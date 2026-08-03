import { Inject, Injectable } from '@nestjs/common';

import { AuditOutcome } from '@edms/domain';

import { LOGGER, type Logger } from '../../observability/logger';
import { currentContext } from '../../tenancy/tenant-context';
import { type MessageEnvelope, type PipelineBehavior } from '../messages';

/**
 * Records that a command was attempted and how it ended.
 *
 * This is the *envelope* of the audit trail, not its content: the business event — what
 * changed, from what, to what — is written by the use case inside its own transaction, where
 * it is atomic with the change (`docs/architecture/13-audit-architecture.md`). This layer
 * exists so that a command which fails before reaching its transaction still leaves a trace,
 * which is precisely the case an attacker would prefer to leave none.
 *
 * Queries are not audited here; read auditing is per-resource and belongs to the resource's
 * use case, where confidentiality rules decide whether a read is an event at all.
 */
@Injectable()
export class AuditBehavior implements PipelineBehavior {
  readonly order = 30;

  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  async handle(envelope: MessageEnvelope, next: () => Promise<unknown>): Promise<unknown> {
    if (envelope.kind !== 'command') {
      return next();
    }
    const context = currentContext();
    try {
      const result = await next();
      this.logger.debug('Command completed', {
        command: envelope.name,
        outcome: AuditOutcome.SUCCESS,
        correlationId: context?.correlationId ?? null,
      });
      return result;
    } catch (error) {
      this.logger.info('Command rejected', {
        command: envelope.name,
        outcome: AuditOutcome.FAILED,
        correlationId: context?.correlationId ?? null,
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw error;
    }
  }
}
