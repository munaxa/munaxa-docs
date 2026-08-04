import type { WorkflowDefinitionBody } from '@edms/contracts';
import type { WorkflowVersionId, WorkflowVersionStateKey } from '@edms/domain';

/**
 * Reading the rules an approval runs under.
 *
 * Separate from `WORKFLOW_ADMIN_REPOSITORY` even though both read `workflow_version`, and the
 * separation is the same one Phase 2 drew between the write side and the read side of the scope
 * tree: the administration repository can create a draft, edit one, publish and deprecate, and an
 * engine holding it could publish a version in the middle of the transaction that binds an approval
 * to one. This can read two things and nothing else.
 *
 * It is also the narrower contract in a second sense that matters at runtime. The engine wants a
 * *parsed* definition body — stages, participants, conditions, completion policy, already validated
 * against `@edms/contracts` — rather than the `jsonb` blob the administration side edits. Parsing
 * happens once, in the adapter, so the engine never holds an unvalidated shape and never has to ask
 * whether the row it read is well-formed.
 */
export const WORKFLOW_VERSION_READER = Symbol('WorkflowVersionReader');

/** Named so a refusal can say which of the two missing things it is. */
export const APPROVAL_TASK_DEFINITION_MISSING = 'no published version';

export interface PublishedWorkflowVersion {
  readonly id: WorkflowVersionId;
  readonly definitionId: string;
  readonly version: number;
  readonly state: WorkflowVersionStateKey;
  readonly definition: WorkflowDefinitionBody;
}

export interface WorkflowVersionReader {
  /**
   * The version a new approval binds to: the definition's current `PUBLISHED` one.
   *
   * Null when the definition has only drafts, which is a configuration state a submission refuses
   * with a sentence rather than a stack trace — an administrator authored a workflow and did not
   * publish it, and the author of the document is the wrong person to discover that.
   */
  publishedVersionFor(definitionId: string): Promise<PublishedWorkflowVersion | null>;

  /**
   * Any version by identifier, including a deprecated one.
   *
   * Deprecated is deliberately readable: retiring a version stops *new* approvals and leaves
   * running ones alone, so an instance started before the retirement has to keep reading the rules
   * it started under — which is the whole point of binding to a version (§1).
   */
  versionById(id: WorkflowVersionId): Promise<PublishedWorkflowVersion | null>;
}
