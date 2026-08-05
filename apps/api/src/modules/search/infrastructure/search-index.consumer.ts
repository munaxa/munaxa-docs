import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { type DocumentId, QueueName, type TenantId, asId } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { runWithContext } from '../../../core/tenancy/tenant-context';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import {
  QUEUE_CONSUMER,
  QUEUE_PORT,
  type JobEnvelope,
  type QueueConsumer,
  type QueuePort,
} from '../../../ports/queue.port';
import {
  SEARCH_SOURCE,
  type SearchProjection,
  type SearchSource,
  SEARCH_PROJECTION,
} from '../application/ports';
import { SearchRebuildService } from '../application/search-rebuild.service';

/**
 * The `search.index` lane's first consumer since the lane was declared in Phase 0.5.
 *
 * Three job shapes share the lane. **Outbox events** — every `document.*`, `revision.*` and
 * `preview.*` the dispatcher fans here — are not handled directly: each is translated to the
 * document it concerns and re-enqueued as a **projection job** whose id is the document plus
 * the current debounce bucket. Identical ids coalesce in the queue, so five changes to one
 * document inside the window project once (`12-search-architecture.md` §6) — and the
 * projection itself re-reads current truth, so the one run covers all five. **Rebuild jobs**
 * drive the shadow fill.
 *
 * The precedents are `PreviewConsumer` and `WorkflowTimerConsumer`, followed exactly: the
 * consumer lives in the module that owns the use case, is gated on
 * `queue.consumersEnabled`, establishes its own system context — the system acted alone, so
 * `userId` is null — and treats a malformed payload as unretryable: logged and dropped,
 * because the payload will not grow the missing field on a fifth attempt. Idempotency lives
 * in the database (the projection upserts current truth), never in the delivery.
 */
@Injectable()
export class SearchIndexConsumer implements OnApplicationBootstrap {
  constructor(
    @Inject(QUEUE_CONSUMER) private readonly consumer: QueueConsumer,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(SEARCH_PROJECTION) private readonly projection: SearchProjection,
    @Inject(SEARCH_SOURCE) private readonly source: SearchSource,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly rebuilds: SearchRebuildService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.queue.consumersEnabled) {
      this.logger.info('The search index lane is not consumed by this process', {
        queues: [QueueName.SEARCH_INDEX],
      });
      return;
    }
    await this.consumer.subscribe(QueueName.SEARCH_INDEX, async (job) => {
      await this.handle(job);
    });
  }

  private async handle(job: JobEnvelope): Promise<void> {
    const payload = job.payload as Record<string, unknown>;

    if (payload['kind'] === 'search.project') {
      return this.handleProjection(job, payload);
    }
    if (payload['kind'] === 'search.rebuild') {
      return this.handleRebuild(job, payload);
    }
    return this.handleEvent(job, payload);
  }

  /** An outbox event: find its document, then coalesce into one projection job per window. */
  private async handleEvent(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    const eventType = asString(payload['eventType']);
    const eventPayload = (payload['payload'] ?? {}) as Record<string, unknown>;
    if (tenantId === null || eventType === null) {
      this.logger.warn('Dropped a search.index job with no tenant or event type', {
        jobId: job.jobId,
      });
      return;
    }
    const correlationId = asString(payload['correlationId']) ?? job.jobId;

    const documentId = await this.documentFor(tenantId, correlationId, eventType, eventPayload);
    if (documentId === null) {
      // Either a payload shape this consumer does not understand — unretryable, logged — or a
      // preview event whose revision no longer resolves, which the next document event covers.
      this.logger.warn('Dropped a search.index event with no resolvable document', {
        jobId: job.jobId,
        eventType,
      });
      return;
    }

    const debounce = Math.max(this.config.search.debounceMs, 1);
    const bucket = Math.floor(this.clock.now().getTime() / debounce);
    await this.queue.enqueue(
      QueueName.SEARCH_INDEX,
      {
        kind: 'search.project',
        tenantId,
        documentId,
        correlationId,
      },
      {
        // The id carries the debounce bucket: same document, same window, one job. The delay
        // pushes execution past the window's end, so the run sees every change the window
        // coalesced.
        jobId: `search:project:${documentId}:${String(bucket)}`,
        delayMs: debounce,
      },
    );
  }

  private async handleProjection(
    job: JobEnvelope,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    const documentId = asString(payload['documentId']);
    if (tenantId === null || documentId === null) {
      this.logger.warn('Dropped a malformed search projection job', { jobId: job.jobId });
      return;
    }
    const correlationId = asString(payload['correlationId']) ?? job.jobId;
    await runWithContext(systemContext(tenantId, correlationId), () =>
      this.projection.project(asId<DocumentId>(documentId)),
    );
  }

  private async handleRebuild(job: JobEnvelope, payload: Record<string, unknown>): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    const rebuildId = asString(payload['rebuildId']);
    if (tenantId === null || rebuildId === null) {
      this.logger.warn('Dropped a malformed search rebuild job', { jobId: job.jobId });
      return;
    }
    const correlationId = asString(payload['correlationId']) ?? job.jobId;
    await runWithContext(systemContext(tenantId, correlationId), () =>
      this.rebuilds.run(rebuildId),
    );
  }

  /** Which document an event concerns. Preview events name a revision; the rest carry it. */
  private async documentFor(
    tenantId: string,
    correlationId: string,
    eventType: string,
    eventPayload: Record<string, unknown>,
  ): Promise<string | null> {
    const direct = asString(eventPayload['documentId']);
    if (direct !== null) {
      return direct;
    }
    const revisionId = asString(eventPayload['revisionId']);
    if (revisionId === null || !eventType.startsWith('preview.')) {
      return null;
    }
    return runWithContext(systemContext(tenantId, correlationId), async () =>
      this.source.documentIdForRevision(asId(revisionId)),
    );
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
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
