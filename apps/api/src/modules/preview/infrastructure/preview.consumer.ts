import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { QueueName, type TenantId, asId } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { runWithContext } from '../../../core/tenancy/tenant-context';
import { QUEUE_CONSUMER, type QueueConsumer } from '../../../ports/queue.port';
import { PreviewOcrService } from '../application/ocr.service';
import { PreviewRenderService } from '../application/render.service';

/**
 * The fast lane's consumer — 14 §2's diagram, finally consuming.
 *
 * The outbox dispatcher routes `document.created`, `revision.created`, `revision.published`
 * and `revision.restored` onto `documents.preview`; this receives them and calls one use case.
 * The event types map to one fact — a revision with content exists — so the handler treats
 * them identically and lets the render's own idempotency absorb the overlap: a restore fires
 * `revision.created` *and* `revision.restored` for the same revision (the Phase 6 report's §6
 * cost table says so), and the second delivery finds the work done.
 *
 * The same two obligations as `WorkflowTimerConsumer`, for the same reasons: it establishes
 * its own context (a job has no request behind it; the system acts alone and the audit trail
 * says so), and idempotency lives in the database — the render-state row and
 * `uq_preview_artifact` — never in the delivery.
 *
 * Where this runs: the API process, the position Phase 4 took and recorded. `apps/worker` is
 * the intended home and is still a skeleton; a consumer is a thin wrapper around a use case,
 * and moving it is a deployment change, not a code one.
 */
@Injectable()
export class PreviewConsumer implements OnApplicationBootstrap {
  constructor(
    @Inject(QUEUE_CONSUMER) private readonly queue: QueueConsumer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly renders: PreviewRenderService,
    private readonly ocr: PreviewOcrService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.queue.consumersEnabled) {
      this.logger.info('Preview lanes are not consumed by this process', {
        queues: [QueueName.DOCUMENTS_PREVIEW, QueueName.DOCUMENTS_OCR],
      });
      return;
    }

    await this.queue.subscribe<OutboxJob>(QueueName.DOCUMENTS_PREVIEW, async (job) => {
      const facts = renderFactsOf(job.payload);
      if (facts === null) {
        // Not retryable: the payload will not grow the missing field on a fifth attempt. The
        // outbox row remains the durable record of the event either way.
        this.logger.error('A preview job carried an unusable payload', {
          jobId: job.jobId,
          eventType: job.payload.eventType ?? 'unknown',
        });
        return;
      }
      await runWithContext(systemContext(facts.tenantId, facts.correlationId ?? job.jobId), () =>
        this.renders.ensureRendered(facts),
      );
    });

    await this.queue.subscribe<OcrJob>(QueueName.DOCUMENTS_OCR, async (job) => {
      const payload = job.payload;
      if (
        typeof payload.tenantId !== 'string' ||
        typeof payload.revisionId !== 'string' ||
        typeof payload.fileObjectId !== 'string'
      ) {
        this.logger.error('An OCR job carried an unusable payload', { jobId: job.jobId });
        return;
      }
      const { revisionId, fileObjectId } = payload;
      await runWithContext(
        systemContext(payload.tenantId, payload.correlationId ?? job.jobId),
        () => this.ocr.extractText({ revisionId, fileObjectId }),
      );
    });
  }
}

/** The envelope the outbox dispatcher enqueues. `payload` is the domain event's own. */
interface OutboxJob {
  readonly eventId?: string;
  readonly tenantId?: string;
  readonly eventType?: string;
  readonly payload?: Record<string, unknown>;
  readonly correlationId?: string;
}

interface OcrJob {
  readonly revisionId?: string;
  readonly fileObjectId?: string;
  readonly tenantId?: string;
  readonly correlationId?: string;
}

const RENDERING_EVENTS = new Set([
  'document.created',
  'revision.created',
  'revision.published',
  'revision.restored',
]);

function renderFactsOf(job: OutboxJob): {
  revisionId: string;
  fileObjectId: string;
  tenantId: string;
  correlationId?: string;
} | null {
  if (
    typeof job.tenantId !== 'string' ||
    typeof job.eventType !== 'string' ||
    !RENDERING_EVENTS.has(job.eventType) ||
    typeof job.payload !== 'object' ||
    job.payload === null
  ) {
    return null;
  }
  const revisionId = job.payload['revisionId'];
  const fileObjectId = job.payload['fileObjectId'];
  if (typeof revisionId !== 'string' || typeof fileObjectId !== 'string') {
    return null;
  }
  return {
    revisionId,
    fileObjectId,
    tenantId: job.tenantId,
    ...(typeof job.correlationId === 'string' && { correlationId: job.correlationId }),
  };
}

function systemContext(tenantId: string, correlationId: string) {
  return {
    tenantId: asId<TenantId>(tenantId),
    // The system acted alone; every actor column is nullable for exactly this case.
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId,
    permissionVersion: 0,
    locale: 'en' as const,
  };
}
