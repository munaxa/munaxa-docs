import type {
  ApprovalTaskId,
  DocumentId,
  RevisionId,
  TaskDecisionKey,
  UserId,
  WorkflowDefinitionId,
  WorkflowInstanceId,
  WorkflowInstanceStatusKey,
  WorkflowVersionId,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * Approval is configuration, not code: definitions are versioned data, and an instance binds
 * to a **version**, so editing a definition never mutates a running approval
 * (`docs/architecture/adr/0006-declarative-workflow-engine.md`).
 */
export const WORKFLOW_DEFINITION_REPOSITORY = Symbol('WorkflowDefinitionRepository');
export const WORKFLOW_INSTANCE_REPOSITORY = Symbol('WorkflowInstanceRepository');
export const APPROVAL_TASK_REPOSITORY = Symbol('ApprovalTaskRepository');

export interface WorkflowDefinitionRepository {
  findById(id: WorkflowDefinitionId): Promise<unknown>;
  /** The version an instance binds to. A published version is immutable. */
  findVersion(id: WorkflowVersionId): Promise<unknown>;
  findPublishedVersion(definitionId: WorkflowDefinitionId): Promise<unknown>;
  save(definition: unknown): Promise<void>;
}

export interface WorkflowInstanceRecord {
  readonly id: WorkflowInstanceId;
  readonly documentId: DocumentId;
  readonly revisionId: RevisionId;
  readonly workflowVersionId: WorkflowVersionId;
  readonly status: WorkflowInstanceStatusKey;
  readonly currentStageIndex: number;
}

export interface WorkflowInstanceRepository {
  findById(id: WorkflowInstanceId): Promise<WorkflowInstanceRecord | null>;
  findRunningForDocument(documentId: DocumentId): Promise<WorkflowInstanceRecord | null>;
  save(instance: WorkflowInstanceRecord): Promise<void>;
}

export interface ApprovalTaskRecord {
  readonly id: ApprovalTaskId;
  readonly instanceId: WorkflowInstanceId;
  readonly assigneeId: UserId;
  /** Set when the decision was taken under a delegation; the audit records both people. */
  readonly onBehalfOfId: UserId | null;
  readonly decision: TaskDecisionKey | null;
  readonly dueAt: Date | null;
}

export interface ApprovalTaskRepository {
  findById(id: ApprovalTaskId): Promise<ApprovalTaskRecord | null>;
  /** The approval inbox, served by a partial index on undecided tasks. */
  listPendingFor(assigneeId: UserId, page: PageRequest): Promise<Page<ApprovalTaskRecord>>;
  /**
   * Records a decision only if the task is still undecided; zero rows affected means someone
   * decided first, which is a conflict rather than an overwrite.
   */
  decideIfPending(id: ApprovalTaskId, decision: TaskDecisionKey, comment: string): Promise<boolean>;
}

export const WORKFLOW_SERVICE = Symbol('WorkflowService');
export const APPROVAL_SERVICE = Symbol('ApprovalService');

export interface WorkflowService {
  /** Resolves the definition version and approvers for a document, before submission. */
  resolveFor(
    documentId: DocumentId,
  ): Promise<{ versionId: WorkflowVersionId; approverIds: readonly UserId[] } | null>;
  instanceFor(documentId: DocumentId): Promise<WorkflowInstanceRecord | null>;
}

export interface ApprovalService {
  inboxFor(userId: UserId, page: PageRequest): Promise<Page<ApprovalTaskRecord>>;
}
