import type { DeletedFilter, SortDirection } from '@edms/contracts';
import type {
  DispositionKey,
  MetadataDataTypeKey,
  RetentionTriggerKey,
  RevisionLabelStyleKey,
  SequenceResetScopeKey,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import type { NumberSegment } from '../domain/numbering';

/**
 * The configuration this module owns.
 *
 * Six aggregates and the settings bag, behind one repository interface. One rather than six because
 * they are read and written together — a document type references four of the others, and every
 * delete has to ask the same question of the same tables ("what still points at this?"). Six
 * repositories would put the job of knowing which to ask into a service whose only interest is the
 * answer.
 */

export const CONFIGURATION_SERVICE = Symbol('ConfigurationService');
export const NUMBERING_ADMIN_SERVICE = Symbol('NumberingAdminService');
export const SETTINGS_ADMIN_SERVICE = Symbol('SettingsAdminService');
export const CONFIGURATION_REPOSITORY = Symbol('ConfigurationRepository');

/** The stamps every administered configuration row carries. */
interface Stamped {
  readonly id: string;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
  readonly version: number;
}

export interface ConfidentialityLevelRow extends Stamped {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly rank: number;
  readonly allowDownload: boolean;
  readonly allowPrint: boolean;
  readonly watermark: boolean;
  readonly requireReason: boolean;
  readonly documentTypeCount: number;
}

export interface RetentionPolicyRow extends Stamped {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly trigger: RetentionTriggerKey;
  readonly periodMonths: number;
  readonly disposition: DispositionKey;
  readonly reviewRequired: boolean;
  readonly documentTypeCount: number;
}

export interface CategoryRow extends Stamped {
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly path: string;
  readonly childCount: number;
}

/**
 * A choice field's options, and a field's validation rules.
 *
 * Type aliases rather than interfaces, and that is load-bearing rather than stylistic: both are
 * written into a `jsonb` column, and Prisma's `InputJsonValue` requires an index signature.
 * TypeScript gives an *implicit* index signature to an object type alias and withholds one from an
 * interface, so declaring these as interfaces would force a cast at every write — which is exactly
 * where a genuine shape mismatch would then be hidden.
 */
export type MetadataOption = {
  readonly value: string;
  readonly label: string;
};

export type MetadataValidation = {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
};

export interface MetadataFieldRow extends Stamped {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly dataType: MetadataDataTypeKey;
  readonly options: readonly MetadataOption[];
  readonly validation: MetadataValidation;
  readonly isSearchable: boolean;
  readonly documentTypeCount: number;
}

export interface TypeField {
  readonly metadataFieldId: string;
  readonly isRequired: boolean;
  readonly sortOrder: number;
  readonly defaultValue: string | null;
}

export interface DocumentTypeRow extends Stamped {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly numberingRuleId: string;
  readonly numberingRuleName: string;
  readonly workflowDefinitionId: string | null;
  readonly workflowDefinitionName: string | null;
  readonly retentionPolicyId: string | null;
  readonly retentionPolicyName: string | null;
  readonly defaultConfidentialityId: string;
  readonly defaultConfidentialityName: string;
  readonly revisionLabelStyle: RevisionLabelStyleKey;
  readonly isActive: boolean;
  /**
   * The attached fields, each carrying enough to *render* it.
   *
   * `options` and `description` are here rather than left to the field catalogue, and that is what
   * lets `/admin/fields` stop being a dependency of anything that fills in a document. A choice
   * field without its choices is a picker with nothing in it, and joining them on required a
   * second administrative read of every field in the tenant to recover two columns.
   *
   * `validation` is deliberately not here: the API enforces it, and no client renders it.
   */
  readonly fields: readonly (TypeField & {
    readonly key: string;
    readonly name: string;
    readonly dataType: MetadataDataTypeKey;
    readonly options: readonly MetadataOption[];
    readonly description: string | null;
  })[];
}

export interface NumberingRuleRow extends Stamped {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly separator: string;
  readonly segments: readonly NumberSegment[];
  readonly resetScope: readonly SequenceResetScopeKey[];
  readonly reserveOnSubmit: boolean;
  readonly strictGapless: boolean;
  /** Live series drawn from this rule. Non-zero freezes the padding. */
  readonly sequenceCount: number;
  readonly documentTypeCount: number;
}

export interface ConfigListRequest extends PageRequest {
  readonly search?: string | undefined;
  readonly sortBy?: string | undefined;
  readonly sortDirection: SortDirection;
  readonly deleted: DeletedFilter;
}

export interface RetentionListRequest extends ConfigListRequest {
  readonly trigger?: RetentionTriggerKey | undefined;
  readonly disposition?: DispositionKey | undefined;
}

export interface CategoryListRequest extends ConfigListRequest {
  readonly parentId?: string | undefined;
  readonly underId?: string | undefined;
}

export interface MetadataFieldListRequest extends ConfigListRequest {
  readonly dataType?: MetadataDataTypeKey | undefined;
}

export interface DocumentTypeListRequest extends ConfigListRequest {
  readonly isActive?: boolean | undefined;
  readonly workflowDefinitionId?: string | undefined;
  readonly retentionPolicyId?: string | undefined;
}

/** A node of a category subtree, as a move or a delete needs to see it. */
export interface SubtreeNode {
  readonly id: string;
  readonly path: string;
}

export interface ConfigurationRepository {
  // --- Confidentiality levels ---
  listConfidentiality(request: ConfigListRequest): Promise<Page<ConfidentialityLevelRow>>;
  findConfidentiality(id: string, includeDeleted: boolean): Promise<ConfidentialityLevelRow | null>;
  confidentialityCodeTaken(code: string, exceptId: string | null): Promise<boolean>;
  /** Rank is unique per tenant, because "more sensitive than" has to be a total order. */
  confidentialityRankTaken(rank: number, exceptId: string | null): Promise<boolean>;
  insertConfidentiality(input: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly description: string | null;
    readonly rank: number;
    readonly allowDownload: boolean;
    readonly allowPrint: boolean;
    readonly watermark: boolean;
    readonly requireReason: boolean;
  }): Promise<void>;
  updateConfidentiality(
    id: string,
    version: number,
    patch: Partial<{
      code: string;
      name: string;
      description: string | null;
      rank: number;
      allowDownload: boolean;
      allowPrint: boolean;
      watermark: boolean;
      requireReason: boolean;
    }>,
  ): Promise<void>;

  // --- Retention policies ---
  listRetention(request: RetentionListRequest): Promise<Page<RetentionPolicyRow>>;
  findRetention(id: string, includeDeleted: boolean): Promise<RetentionPolicyRow | null>;
  retentionCodeTaken(code: string, exceptId: string | null): Promise<boolean>;
  insertRetention(input: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly description: string | null;
    readonly trigger: RetentionTriggerKey;
    readonly periodMonths: number;
    readonly disposition: DispositionKey;
    readonly reviewRequired: boolean;
  }): Promise<void>;
  updateRetention(
    id: string,
    version: number,
    patch: Partial<{
      code: string;
      name: string;
      description: string | null;
      trigger: RetentionTriggerKey;
      periodMonths: number;
      disposition: DispositionKey;
      reviewRequired: boolean;
    }>,
  ): Promise<void>;

  // --- Categories ---
  listCategories(request: CategoryListRequest): Promise<Page<CategoryRow>>;
  findCategory(id: string, includeDeleted: boolean): Promise<CategoryRow | null>;
  categoryCodeTaken(code: string, exceptId: string | null): Promise<boolean>;
  /** Names are unique among live siblings, which is a different question from the code. */
  categorySiblingNameTaken(
    parentId: string | null,
    name: string,
    exceptId: string | null,
  ): Promise<boolean>;
  insertCategory(input: {
    readonly id: string;
    readonly parentId: string | null;
    readonly code: string;
    readonly name: string;
    readonly description: string | null;
    readonly path: string;
  }): Promise<void>;
  updateCategory(
    id: string,
    version: number,
    patch: Partial<{ code: string; name: string; description: string | null }>,
  ): Promise<void>;
  categorySubtree(path: string): Promise<readonly SubtreeNode[]>;
  moveCategory(input: {
    readonly id: string;
    readonly version: number;
    readonly parentId: string | null;
    readonly paths: readonly SubtreeNode[];
  }): Promise<void>;

  // --- Metadata fields ---
  listMetadataFields(request: MetadataFieldListRequest): Promise<Page<MetadataFieldRow>>;
  findMetadataField(id: string, includeDeleted: boolean): Promise<MetadataFieldRow | null>;
  metadataFieldKeyTaken(key: string, exceptId: string | null): Promise<boolean>;
  insertMetadataField(input: {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    readonly description: string | null;
    readonly dataType: MetadataDataTypeKey;
    readonly options: readonly MetadataOption[];
    readonly validation: MetadataValidation;
    readonly isSearchable: boolean;
  }): Promise<void>;
  updateMetadataField(
    id: string,
    version: number,
    patch: Partial<{
      name: string;
      description: string | null;
      options: readonly MetadataOption[];
      validation: MetadataValidation;
      isSearchable: boolean;
    }>,
  ): Promise<void>;

  // --- Document types ---
  listDocumentTypes(request: DocumentTypeListRequest): Promise<Page<DocumentTypeRow>>;
  findDocumentType(id: string, includeDeleted: boolean): Promise<DocumentTypeRow | null>;
  documentTypeCodeTaken(code: string, exceptId: string | null): Promise<boolean>;
  insertDocumentType(input: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly description: string | null;
    readonly numberingRuleId: string;
    readonly workflowDefinitionId: string | null;
    readonly retentionPolicyId: string | null;
    readonly defaultConfidentialityId: string;
    readonly revisionLabelStyle: RevisionLabelStyleKey;
    readonly isActive: boolean;
  }): Promise<void>;
  updateDocumentType(
    id: string,
    version: number,
    patch: Partial<{
      code: string;
      name: string;
      description: string | null;
      numberingRuleId: string;
      workflowDefinitionId: string | null;
      retentionPolicyId: string | null;
      defaultConfidentialityId: string;
      revisionLabelStyle: RevisionLabelStyleKey;
      isActive: boolean;
    }>,
  ): Promise<void>;
  replaceTypeFields(documentTypeId: string, fields: readonly TypeField[]): Promise<void>;

  // --- Numbering rules ---
  listNumberingRules(request: ConfigListRequest): Promise<Page<NumberingRuleRow>>;
  findNumberingRule(id: string, includeDeleted: boolean): Promise<NumberingRuleRow | null>;
  numberingRuleKeyTaken(key: string, exceptId: string | null): Promise<boolean>;
  insertNumberingRule(input: {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    readonly description: string | null;
    readonly separator: string;
    readonly segments: readonly NumberSegment[];
    readonly resetScope: readonly SequenceResetScopeKey[];
    readonly reserveOnSubmit: boolean;
    readonly strictGapless: boolean;
  }): Promise<void>;
  updateNumberingRule(
    id: string,
    version: number,
    patch: Partial<{
      key: string;
      name: string;
      description: string | null;
      separator: string;
      segments: readonly NumberSegment[];
      resetScope: readonly SequenceResetScopeKey[];
      reserveOnSubmit: boolean;
      strictGapless: boolean;
    }>,
  ): Promise<void>;

  // --- Shared ---
  /**
   * Which configuration kinds a resource may be soft-deleted or restored as.
   *
   * A string union rather than one method per table, because the delete and restore choreography is
   * identical for all six and only the table differs.
   */
  setDeleted(
    kind: ConfigurationKindKey,
    id: string,
    version: number,
    deleted: boolean,
  ): Promise<void>;
  /** What still points at a configuration row, by kind, so a refusal can name it. */
  dependentsOf(kind: ConfigurationKindKey, id: string): Promise<Readonly<Record<string, number>>>;
  /** Live identifiers among these, for validating a reference before it is written. */
  liveIds(kind: ConfigurationKindKey, ids: readonly string[]): Promise<readonly string[]>;
}

/** The six aggregates this module soft-deletes, as a discriminator. */
export const ConfigurationKind = {
  CONFIDENTIALITY: 'CONFIDENTIALITY',
  RETENTION: 'RETENTION',
  CATEGORY: 'CATEGORY',
  METADATA_FIELD: 'METADATA_FIELD',
  DOCUMENT_TYPE: 'DOCUMENT_TYPE',
  NUMBERING_RULE: 'NUMBERING_RULE',
  /** Not this module's, but referenced by a document type — validated the same way. */
  WORKFLOW_DEFINITION: 'WORKFLOW_DEFINITION',
} as const;

export type ConfigurationKindKey = (typeof ConfigurationKind)[keyof typeof ConfigurationKind];
