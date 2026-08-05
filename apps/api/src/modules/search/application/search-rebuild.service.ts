import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, AuditSubjectType, type DocumentId, QueueName, asId } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { QUEUE_PORT, type QueuePort } from '../../../ports/queue.port';
import { INDEX_PORT, type IndexPort } from '../../../ports/search.port';
import { SearchAudit } from '../domain/audit-actions';
import { indexRebuildCompletedEvent } from '../domain/events';
import {
  SEARCH_REBUILD_REPOSITORY,
  SEARCH_SOURCE,
  type SearchRebuildRecord,
  type SearchRebuildRepository,
  type SearchSource,
} from './ports';
import { SearchProjectionService } from './search-projection.service';

/**
 * The full rebuild (`12-search-architecture.md` §6): safe against a live index, resumable,
 * and readable throughout.
 *
 * The shape is shadow-table-and-swap, never a truncate of the live index. `request()` is the
 * audited operator act — it records the run and enqueues the work; the queue's consumer calls
 * `run()`, which fills the build target batch by batch, each batch its own transaction with
 * the cursor advanced inside it. A crash therefore loses at most one batch, and the retry —
 * BullMQ redelivers the same deterministic job — resumes from the cursor instead of starting
 * over. Readers keep answering from the live index until `completeRebuild()` swaps, and a
 * change that lands mid-fill reaches the build target through the projection's dual-write.
 *
 * One run per tenant at a time: `uq_search_rebuild_running` decides the race, not this class.
 * Requesting while a run is `RUNNING` re-enqueues the same job — which is how an operator
 * resumes a run whose delivery attempts were exhausted — rather than refusing or forking.
 */
@Injectable()
export class SearchRebuildService {
  constructor(
    @Inject(SEARCH_REBUILD_REPOSITORY) private readonly rebuilds: SearchRebuildRepository,
    @Inject(SEARCH_SOURCE) private readonly source: SearchSource,
    @Inject(INDEX_PORT) private readonly index: IndexPort,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly projection: SearchProjectionService,
    private readonly writer: AdministeredWriter,
  ) {}

  /** The operator act: one audited row, one queued job. Returns the run to poll. */
  async request(): Promise<SearchRebuildRecord> {
    const record = await this.writer.write<SearchRebuildRecord>(async () => {
      const running = await this.rebuilds.findRunning();
      const id = running?.id ?? this.writer.clock.nextId();
      if (running === null) {
        await this.rebuilds.start(id, this.writer.clock.now());
      }
      const state = await this.rebuilds.findById(id);
      if (state === null) {
        throw new Error('The rebuild row vanished inside its own transaction.');
      }
      return {
        result: state,
        change: {
          action: SearchAudit.SEARCH_REBUILD_REQUESTED,
          subjectType: AuditSubjectType.SEARCH,
          subjectId: asId<AnyId>(id),
          operation: AdministrativeOperation.CREATED,
          after: { resumed: running !== null },
        },
      };
    });
    // After the transaction committed: the job names the run, so a redelivered request for
    // the same run is one job. The tenant rides in the payload because the consumer has no
    // ambient context of its own.
    const context = requireContext();
    await this.queue.enqueue(
      QueueName.SEARCH_INDEX,
      {
        kind: 'search.rebuild',
        rebuildId: record.id,
        tenantId: context.tenantId,
        correlationId: context.correlationId,
      },
      { jobId: `search:rebuild:${record.id}` },
    );
    return record;
  }

  /** The queue's side: fill the build target from the cursor, then swap. */
  async run(rebuildId: string): Promise<void> {
    const batchSize = this.config.search.rebuildBatchSize;

    for (;;) {
      const finished = await this.unitOfWork.run(async () => {
        const state = await this.rebuilds.findById(rebuildId);
        if (state === null || state.state !== 'RUNNING') {
          // Completed by an earlier delivery, or an operator's decision — either way, done.
          return true;
        }
        if (state.cursorDocumentId === null && state.documentsIndexed === 0) {
          // A genuine start (or a crash before the first batch committed): empty the target.
          await this.index.beginRebuild();
        }
        const ids = await this.source.findableIdsAfter(
          state.cursorDocumentId === null ? null : asId<DocumentId>(state.cursorDocumentId),
          batchSize,
        );
        if (ids.length === 0) {
          return true;
        }
        const documents = [];
        for (const id of ids) {
          const facts = await this.source.factsFor(id);
          if (facts !== null) {
            documents.push(await this.projection.indexDocumentFrom(facts));
          }
        }
        await this.index.rebuildUpsert(documents);
        const last = ids[ids.length - 1];
        if (last !== undefined) {
          await this.rebuilds.advance(rebuildId, last, documents.length);
        }
        return ids.length < batchSize;
      });
      if (finished) {
        break;
      }
    }

    await this.unitOfWork.run(async () => {
      const state = await this.rebuilds.findById(rebuildId);
      if (state === null || state.state !== 'RUNNING') {
        return;
      }
      await this.index.completeRebuild();
      const completedAt = this.writer.clock.now();
      await this.rebuilds.complete(rebuildId, completedAt);
      await this.outbox.publish([
        indexRebuildCompletedEvent(asId(rebuildId), {
          documentsIndexed: state.documentsIndexed,
          durationMs: completedAt.getTime() - state.startedAt.getTime(),
        }),
      ]);
    });
  }
}
