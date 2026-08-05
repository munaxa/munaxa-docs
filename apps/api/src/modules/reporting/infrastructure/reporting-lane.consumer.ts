import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { QueueName, type TenantId, asId } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { QUEUE_CONSUMER, type JobEnvelope, type QueueConsumer } from '../../../ports/queue.port';
import { ReportExportService } from '../application/report-export.service';

/**
 * The `reporting.export` lane's consumer.
 *
 * It runs in the API process behind `queue.consumersEnabled`, which is where every consumer this
 * product has lives — the outbox dispatcher and workflow timers from Phase 4, preview and OCR from
 * Phase 7, the search index from Phase 8, the audit lane from Phase 9, retention from Phase 10,
 * delegation from Phase 11 and notifications from Phase 12. `apps/worker` composes none of the
 * domain modules, so moving one lane there would mean either composing them twice or having a flag
 * that means "consume everything" in one process and "consume some of it" in another. A deployment
 * that wants the work off the request path already has the switch.
 *
 * ## The context it establishes, and the one it deliberately does not
 *
 * It sets the **tenant** and nothing else: `userId` is null here, exactly as it is in every other
 * consumer, because a job envelope is not a person. The *subject* is established one layer in, by
 * `ReportExportService`, from the export row's `requested_by_id` and Identity's current answer
 * about their roles.
 *
 * That split is deliberate rather than incidental. A consumer that assembled the requester's
 * context would be a consumer that had to know a report is permission-scoped, and the next lane
 * added beside it would inherit the shape without the reason. Keeping the reconstitution in the
 * service means the property lives with the code that would be wrong without it — and its own
 * header says what goes wrong: `visibilityCondition` returns an *empty* predicate for a caller with
 * no user, so an export produced under this context would be an export of every row in the tenant.
 *
 * ## No schedule is declared here, and that is this phase's "scheduling ready"
 *
 * `SCHEDULE` gains no entry. What a scheduled report needs is a lane that accepts a job naming an
 * export, an export row that is its own record, an idempotent claim and an audited run — all of
 * which exist, and none of which is specific to being asked for by a person. A `report_schedule`
 * table with nothing writing it would be the fifth declared-but-unbound contract this product has
 * had to discharge, so the phase report names the seam and the phase that closes it instead.
 */
@Injectable()
export class ReportingLaneConsumer implements OnApplicationBootstrap {
  constructor(
    @Inject(QUEUE_CONSUMER) private readonly consumer: QueueConsumer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly exports: ReportExportService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.queue.consumersEnabled) {
      this.logger.info('The reporting export lane is not consumed by this process', {
        queues: [QueueName.REPORTING_EXPORT],
      });
      return;
    }
    await this.consumer.subscribe(QueueName.REPORTING_EXPORT, async (job) => {
      await this.handle(job);
    });
  }

  private async handle(job: JobEnvelope): Promise<void> {
    const payload = job.payload as Record<string, unknown>;
    if (payload['kind'] !== 'reporting.export') {
      // Unretryable: the payload will not grow a recognisable shape on a third attempt. Logged and
      // dropped, exactly as the audit, search and preview consumers treat a malformed job.
      this.logger.warn('Dropped a reporting lane job with an unrecognised shape', {
        jobId: job.jobId,
      });
      return;
    }
    const tenantId = asString(payload['tenantId']);
    const exportId = asString(payload['exportId']);
    if (tenantId === null || exportId === null) {
      this.logger.warn('Dropped a malformed report export job', { jobId: job.jobId });
      return;
    }
    await runWithContext(systemContext(tenantId, job.jobId), async () => {
      await this.exports.run(asId(exportId));
    });
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The tenant, and no subject.
 *
 * `userId: null` is correct here and load-bearing one layer in: it is what
 * `ReportExportService.produceAsRequester` replaces, and leaving it null past that point is the
 * failure its own header describes.
 */
function systemContext(tenantId: string, correlationId: string): RequestContext {
  return {
    tenantId: asId<TenantId>(tenantId),
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId,
    permissionVersion: 0,
    locale: 'en',
  };
}
