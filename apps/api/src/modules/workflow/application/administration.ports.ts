import type { DeletedFilter, SortDirection } from '@edms/contracts';
import type { WorkflowVersionStateKey } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * Administering workflow definitions.
 *
 * Phase 2 builds the definitions and their versions — the data the engine will read. It does not build
 * the engine: nothing here starts an instance, resolves a participant or decides a task, and the
 * validator deliberately stops short of asking whether a resolver yields anybody, because that is a
 * question about a particular document at a particular moment.
 *
 * The shape of the definition body is `@edms/contracts`' `workflowDefinitionBodySchema`, stored as
 * validated `jsonb`. It is deliberately not modelled as rows: `07-workflow-architecture.md` §7 says the
 * future graphical designer is a UI over the same JSON, and a normalised stage table would make that a
 * migration rather than a screen.
 */

export const WORKFLOW_ADMIN_SERVICE = Symbol('WorkflowAdminService');
export const WORKFLOW_ADMIN_REPOSITORY = Symbol('WorkflowAdminRepository');

export interface WorkflowVersionRow {
  readonly id: string;
  readonly version: number;
  readonly state: WorkflowVersionStateKey;
  /** Stages, participants, conditions and completion policy, as stored. */
  readonly definition: unknown;
  readonly publishedAt: Date | null;
  readonly publishedBy: string | null;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  /** Approvals bound to this version. Non-zero is why it can never be edited or removed. */
  readonly instanceCount: number;
}

export interface WorkflowDefinitionRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly publishedVersion: number | null;
  readonly latestVersion: number;
  readonly versions: readonly WorkflowVersionRow[];
  readonly documentTypeCount: number;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
  readonly recordVersion: number;
}

export interface WorkflowListRequest extends PageRequest {
  readonly search?: string | undefined;
  readonly sortBy?: string | undefined;
  readonly sortDirection: SortDirection;
  readonly deleted: DeletedFilter;
  readonly isActive?: boolean | undefined;
  readonly state?: WorkflowVersionStateKey | undefined;
}

export interface WorkflowAdminRepository {
  list(request: WorkflowListRequest): Promise<Page<WorkflowDefinitionRow>>;
  find(id: string, includeDeleted: boolean): Promise<WorkflowDefinitionRow | null>;
  keyTaken(key: string, exceptId: string | null): Promise<boolean>;
  /**
   * Creates a definition and its first draft version together.
   *
   * A definition with no version is a name with no behaviour — nothing can be attached to it and
   * nothing can run — so the two are one fact and one transaction.
   */
  insertWithFirstVersion(input: {
    readonly definitionId: string;
    readonly versionId: string;
    readonly key: string;
    readonly name: string;
    readonly description: string | null;
    readonly definition: unknown;
  }): Promise<void>;
  update(
    id: string,
    recordVersion: number,
    patch: {
      readonly name?: string;
      readonly description?: string | null;
      readonly isActive?: boolean;
    },
  ): Promise<void>;
  setDeleted(id: string, recordVersion: number, deleted: boolean): Promise<void>;

  // --- Versions ---
  findVersion(definitionId: string, versionId: string): Promise<WorkflowVersionRow | null>;
  /**
   * Adds a draft version, numbered `max + 1` for the definition.
   *
   * Allocated inside the caller's transaction rather than from a sequence: a gap in version numbers is
   * harmless but confusing, and a sequence would gap on every rolled-back attempt.
   */
  insertVersion(input: {
    readonly definitionId: string;
    readonly versionId: string;
    readonly definition: unknown;
  }): Promise<number>;
  /** Replaces a draft's body. Refused for anything else by the service, and by the state check here. */
  updateDraft(versionId: string, definition: unknown): Promise<void>;
  publish(versionId: string, at: Date, by: string | null): Promise<void>;
  /** Marks the previously published version deprecated, so exactly one is live at a time. */
  deprecateOthers(definitionId: string, exceptVersionId: string): Promise<void>;
  deprecate(versionId: string): Promise<void>;
  /** Live document types attached to this definition — what blocks removing it. */
  countAttachedTypes(definitionId: string): Promise<number>;
}
