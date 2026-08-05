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
 * Four job shapes share the lane. **Outbox events** — every `document.*`, `revision.*` and
 * `preview.*` the dispatcher fans here — are not handled directly: each is translated to the
 * document it concerns and re-enqueued as a **projection job** whose id is the document plus
 * the current debounce bucket. Identical ids coalesce in the queue, so five changes to one
 * document inside the window project once (`12-search-architecture.md` §6) — and the
 * projection itself re-reads current truth, so the one run covers all five. **Rebuild jobs**
 * drive the shadow fill. **Scope reprojection jobs** are Phase 14's: an ACL change or a folder move
 * names a node rather than a document, and every entry beneath it has a stale `acl_subjects` until
 * it is rebuilt — one page per job, cursor in the job, so a grant on a company does not become one
 * transaction that enqueues a hundred thousand rows inside an administrator's request.
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
    if (payload['kind'] === 'search.reproject-scope') {
      return this.handleScopeReprojection(job, payload);
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

    // An ACL change or a folder move names a *scope*, not a document, and changes the answer for
    // every document beneath it. It fans out rather than resolving to one id — see
    // `enqueueScopeReprojection`.
    if (eventType === 'library.acl-changed' || eventType === 'library.folder-moved') {
      await this.enqueueScopeReprojection(job, tenantId, correlationId, eventType, eventPayload);
      return;
    }

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

  /**
   * An ACL change high on the tree, turned into work bounded by what it actually affects.
   *
   * **The decision this implements.** Three shapes were available: a targeted reprojection, a lane
   * message per document written by the producer, and a full rebuild. The producer cannot write one
   * message per document — an entry on a company would be a transaction that enqueues a hundred
   * thousand rows, inside the administrator's request. A rebuild is the wrong instrument twice over:
   * it exists for a mapping change and takes minutes, and Phase 8 built it to *never empty a live
   * index*, which is a guarantee about a different problem. So: a paginated walk of the affected
   * subtree, one page per job, each page enqueuing the next — the same resumable shape the rebuild
   * uses, over a subtree instead of a tenant, and with no state to keep because the cursor is in
   * the job.
   *
   * **What the index serves in the meantime.** The old entries, which is to say the previous
   * answer. That is a stale `acl_subjects`, and a stale `acl_subjects` is a search result somebody
   * may not see — or one they should not. The window is bounded by the subtree's size and the
   * debounce, and it is the *only* window in the product where the index and a direct read
   * disagree, so it is worth saying what closes it: a direct read never consults the index, so the
   * document page, the folder listing and the dashboard count are all correct from the instant the
   * transaction commits. Search catches up. A newly-denied caller can, until it does, see a title
   * and a snippet in a result list — and clicking it gets a `404`, because `AclGuard` asks the
   * resolver rather than the index.
   *
   * Widening that window is what a rebuild would have done, not narrowing it.
   */
  private async enqueueScopeReprojection(
    job: JobEnvelope,
    tenantId: string,
    correlationId: string,
    eventType: string,
    eventPayload: Record<string, unknown>,
  ): Promise<void> {
    const scopeType = asString(eventPayload['scopeType']) ?? 'FOLDER';
    const scopeId = asString(eventPayload['scopeId']) ?? asString(eventPayload['folderId']);
    if (scopeId === null) {
      this.logger.warn('Dropped a search.index scope event with no node', {
        jobId: job.jobId,
        eventType,
      });
      return;
    }
    await this.queue.enqueue(
      QueueName.SEARCH_INDEX,
      { kind: 'search.reproject-scope', tenantId, scopeType, scopeId, correlationId, cursor: null },
      // One job per node per debounce window: an administrator saving a matrix three times in ten
      // seconds reprojects the subtree once, and the projection re-reads current truth either way.
      {
        jobId: `search:reproject:${scopeId}:${String(
          Math.floor(this.clock.now().getTime() / Math.max(this.config.search.debounceMs, 1)),
        )}`,
        delayMs: Math.max(this.config.search.debounceMs, 1),
      },
    );
  }

  /** One page of a subtree, then the next — the cursor lives in the job, so nothing is resumed. */
  private async handleScopeReprojection(
    job: JobEnvelope,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const tenantId = asString(payload['tenantId']);
    const scopeId = asString(payload['scopeId']);
    const scopeType = asString(payload['scopeType']);
    if (tenantId === null || scopeId === null || scopeType === null) {
      this.logger.warn('Dropped a malformed scope reprojection job', { jobId: job.jobId });
      return;
    }
    const correlationId = asString(payload['correlationId']) ?? job.jobId;
    const cursor = asString(payload['cursor']);
    const batchSize = Math.max(this.config.search.rebuildBatchSize, 1);

    const ids = await runWithContext(systemContext(tenantId, correlationId), () =>
      this.source.findableIdsUnderScope(
        { type: scopeType, id: scopeId },
        cursor === null ? null : asId<DocumentId>(cursor),
        batchSize,
      ),
    );

    if (ids.length === 0 && cursor === null) {
      // The node narrowed to nothing — an organisation node, which this reader deliberately does
      // not resolve to libraries, or a subtree with no documents. Said out loud rather than
      // silently: a permission change that reached no index entry is worth being able to find in a
      // log when somebody asks why search still shows what it shows.
      this.logger.info('An ACL change reached no index entry through this node', {
        jobId: job.jobId,
        scopeType,
        scopeId,
      });
      return;
    }

    for (const documentId of ids) {
      await runWithContext(systemContext(tenantId, correlationId), () =>
        this.projection.project(documentId),
      );
    }

    if (ids.length === batchSize) {
      const last = ids[ids.length - 1];
      await this.queue.enqueue(
        QueueName.SEARCH_INDEX,
        {
          kind: 'search.reproject-scope',
          tenantId,
          scopeType,
          scopeId,
          correlationId,
          cursor: last === undefined ? null : String(last),
        },
        { jobId: `search:reproject:${scopeId}:${String(last)}` },
      );
    }
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
