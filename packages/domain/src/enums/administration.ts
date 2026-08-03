/** Tenant-configurable administration vocabulary (`docs/architecture/03-domain-model.md` §3). */
export const MetadataDataType = {
  TEXT: 'TEXT',
  LONG_TEXT: 'LONG_TEXT',
  NUMBER: 'NUMBER',
  DATE: 'DATE',
  BOOLEAN: 'BOOLEAN',
  SELECT: 'SELECT',
  MULTI_SELECT: 'MULTI_SELECT',
  USER: 'USER',
  DEPARTMENT: 'DEPARTMENT',
} as const;

export type MetadataDataTypeKey = (typeof MetadataDataType)[keyof typeof MetadataDataType];

/** The parts a document number is assembled from (`09-numbering-architecture.md`). */
export const NumberSegmentKind = {
  LITERAL: 'LITERAL',
  COMPANY_CODE: 'COMPANY_CODE',
  ENTITY_CODE: 'ENTITY_CODE',
  BRANCH_CODE: 'BRANCH_CODE',
  DEPARTMENT_CODE: 'DEPARTMENT_CODE',
  DOCUMENT_TYPE_CODE: 'DOCUMENT_TYPE_CODE',
  CATEGORY_CODE: 'CATEGORY_CODE',
  YEAR: 'YEAR',
  MONTH: 'MONTH',
  SEQUENCE: 'SEQUENCE',
} as const;

export type NumberSegmentKindKey = (typeof NumberSegmentKind)[keyof typeof NumberSegmentKind];

/**
 * What resets a sequence, and therefore what its scope key is built from.
 *
 * A rule carries a **set** of these, not one: `[YEARLY, PER_ENTITY, PER_DOCUMENT_TYPE]` is the
 * `["ENTITY","DOC_TYPE","YEAR"]` reset scope of `09-numbering-architecture.md` §1 — every entity
 * gets its own per-type yearly series. `NEVER` is the empty set said out loud, so a rule that
 * never resets is expressible without an empty array nobody can tell from a missing one.
 */
export const SequenceResetScope = {
  NEVER: 'NEVER',
  YEARLY: 'YEARLY',
  MONTHLY: 'MONTHLY',
  PER_COMPANY: 'PER_COMPANY',
  PER_ENTITY: 'PER_ENTITY',
  PER_BRANCH: 'PER_BRANCH',
  PER_DEPARTMENT: 'PER_DEPARTMENT',
  PER_DOCUMENT_TYPE: 'PER_DOCUMENT_TYPE',
  PER_CATEGORY: 'PER_CATEGORY',
} as const;

export type SequenceResetScopeKey = (typeof SequenceResetScope)[keyof typeof SequenceResetScope];

export const ALL_SEQUENCE_RESET_SCOPES: readonly SequenceResetScopeKey[] = Object.freeze(
  Object.values(SequenceResetScope),
);

export const ALL_NUMBER_SEGMENT_KINDS: readonly NumberSegmentKindKey[] = Object.freeze(
  Object.values(NumberSegmentKind),
);

/**
 * Which scope node a segment draws its code from.
 *
 * Kept beside the segment kinds because the two are read together: a formatter given a segment
 * needs to know what to look up, and a validator needs to know whether the document's context
 * can supply it.
 */
export const SEGMENT_SCOPE_SOURCE: Readonly<Partial<Record<NumberSegmentKindKey, string>>> =
  Object.freeze({
    [NumberSegmentKind.COMPANY_CODE]: 'company',
    [NumberSegmentKind.ENTITY_CODE]: 'entity',
    [NumberSegmentKind.BRANCH_CODE]: 'branch',
    [NumberSegmentKind.DEPARTMENT_CODE]: 'department',
    [NumberSegmentKind.DOCUMENT_TYPE_CODE]: 'documentType',
    [NumberSegmentKind.CATEGORY_CODE]: 'category',
  });

export const RevisionLabelStyle = {
  NUMERIC: 'NUMERIC',
  ALPHABETIC: 'ALPHABETIC',
  MAJOR_MINOR: 'MAJOR_MINOR',
} as const;

export type RevisionLabelStyleKey = (typeof RevisionLabelStyle)[keyof typeof RevisionLabelStyle];

export const ALL_REVISION_LABEL_STYLES: readonly RevisionLabelStyleKey[] = Object.freeze(
  Object.values(RevisionLabelStyle),
);

export const ALL_METADATA_DATA_TYPES: readonly MetadataDataTypeKey[] = Object.freeze(
  Object.values(MetadataDataType),
);

/**
 * Data types whose meaning depends on a fixed option list.
 *
 * A `SELECT` with no options is a field nobody can fill in, and a `TEXT` with options is a
 * constraint the product would silently ignore — so the validator needs to know which is which
 * rather than each caller deciding.
 */
export function requiresOptions(dataType: MetadataDataTypeKey): boolean {
  return dataType === MetadataDataType.SELECT || dataType === MetadataDataType.MULTI_SELECT;
}

/** A tenant's own state. A suspended tenant is read-only, everywhere. */
export const TenantStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
} as const;

export type TenantStatusKey = (typeof TenantStatus)[keyof typeof TenantStatus];

export const UserStatus = {
  INVITED: 'INVITED',
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
} as const;

export type UserStatusKey = (typeof UserStatus)[keyof typeof UserStatus];
