import { Inject, Injectable } from '@nestjs/common';

import { type DocumentId, WorkflowInstanceStatus } from '@edms/domain';
import type { Page } from '@edms/utils';

import { AdministeredWriter } from '../../../core/persistence';
import {
  APPROVAL_QUERY_REPOSITORY,
  type ApprovalInboxRequest,
  type ApprovalInboxRow,
  type ApprovalQueryRepository,
  type WorkflowInstanceView,
} from './ports';

/**
 * The approval read side: an inbox, and a document's approval history.
 *
 * Separate from the engine, and read-only, for the reason `02-backend-architecture.md` §5 gives:
 * repositories are aggregate-scoped and load what an invariant needs, while screens are served by
 * query services. The engine loads an instance with every stage and every task because it is about
 * to change all three; a dashboard listing forty tasks would be loading forty aggregates to render
 * forty rows.
 *
 * The one shape worth noticing is that "workflow history" and "approval timeline" are the same
 * object. A timeline is one instance rendered forwards, a history is the list of them, and serving
 * them from two endpoints would be two projections of one aggregate to keep in step.
 */
@Injectable()
export class ApprovalService {
  constructor(
    @Inject(APPROVAL_QUERY_REPOSITORY) private readonly queries: ApprovalQueryRepository,
    private readonly writer: AdministeredWriter,
  ) {}

  /** "What needs my attention." Served by the partial index on undecided tasks. */
  inbox(request: ApprovalInboxRequest): Promise<Page<ApprovalInboxRow>> {
    return this.writer.read(() => this.queries.inbox(request));
  }

  /**
   * A document's approvals: the live one, and everything before it.
   *
   * The split is by status rather than by a flag on the row, because "current" is not a property an
   * instance carries — it is a question about which of a document's attempts has not ended, and the
   * unique index that keeps there being at most one is the same fact expressed as a constraint.
   */
  async forDocument(documentId: DocumentId): Promise<{
    readonly current: WorkflowInstanceView | null;
    readonly history: readonly WorkflowInstanceView[];
  }> {
    const instances = await this.writer.read(() => this.queries.instancesForDocument(documentId));
    const live = instances.find(
      (view) =>
        view.instance.status === WorkflowInstanceStatus.RUNNING ||
        view.instance.status === WorkflowInstanceStatus.PAUSED,
    );
    return {
      current: live ?? null,
      history: instances.filter((view) => view !== live),
    };
  }

  instance(id: string): Promise<WorkflowInstanceView | null> {
    return this.writer.read(() => this.queries.instance(id as never));
  }
}
