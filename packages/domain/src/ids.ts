/**
 * Branded identifier types.
 *
 * Every identifier in the product is a UUID v7 string. Branding them keeps a `FolderId`
 * from being passed where a `DocumentId` is expected, which the compiler cannot catch
 * when both are `string`.
 */

declare const brand: unique symbol;

export type Branded<TName extends string> = string & { readonly [brand]: TName };

export type TenantId = Branded<'TenantId'>;
export type UserId = Branded<'UserId'>;
export type RoleId = Branded<'RoleId'>;
export type CompanyId = Branded<'CompanyId'>;
export type EntityId = Branded<'EntityId'>;
export type BranchId = Branded<'BranchId'>;
export type DepartmentId = Branded<'DepartmentId'>;
export type LibraryId = Branded<'LibraryId'>;
export type FolderId = Branded<'FolderId'>;
export type DocumentId = Branded<'DocumentId'>;
export type RevisionId = Branded<'RevisionId'>;
export type FileObjectId = Branded<'FileObjectId'>;
export type UploadSessionId = Branded<'UploadSessionId'>;
export type WorkflowDefinitionId = Branded<'WorkflowDefinitionId'>;
export type WorkflowVersionId = Branded<'WorkflowVersionId'>;
export type WorkflowInstanceId = Branded<'WorkflowInstanceId'>;
export type WorkflowStageId = Branded<'WorkflowStageId'>;
export type ApprovalTaskId = Branded<'ApprovalTaskId'>;
export type DelegationId = Branded<'DelegationId'>;
export type DocumentTypeId = Branded<'DocumentTypeId'>;
export type CategoryId = Branded<'CategoryId'>;
export type MetadataFieldId = Branded<'MetadataFieldId'>;
export type NumberingRuleId = Branded<'NumberingRuleId'>;
export type RetentionPolicyId = Branded<'RetentionPolicyId'>;
export type ConfidentialityLevelId = Branded<'ConfidentialityLevelId'>;
export type LegalHoldId = Branded<'LegalHoldId'>;
export type AuditEventId = Branded<'AuditEventId'>;
export type NotificationMessageId = Branded<'NotificationMessageId'>;
export type OutboxMessageId = Branded<'OutboxMessageId'>;
export type PreviewArtifactId = Branded<'PreviewArtifactId'>;
export type ReportDefinitionId = Branded<'ReportDefinitionId'>;

/**
 * Any identifier, when a signature genuinely does not care which one it holds
 * (logging, audit envelopes, outbox rows).
 */
export type AnyId = Branded<string>;

/**
 * Reinterprets a string as a branded identifier. The value is *not* validated here:
 * validation belongs to the boundary that received it (a DTO, a repository mapper),
 * and doing it twice hides which layer is responsible.
 */
export function asId<TId extends AnyId>(value: string): TId {
  return value as TId;
}
