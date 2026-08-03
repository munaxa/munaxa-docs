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

/** What resets a sequence, and therefore what its scope key is built from. */
export const SequenceResetScope = {
  NEVER: 'NEVER',
  YEARLY: 'YEARLY',
  MONTHLY: 'MONTHLY',
  PER_DEPARTMENT: 'PER_DEPARTMENT',
  PER_DOCUMENT_TYPE: 'PER_DOCUMENT_TYPE',
} as const;

export type SequenceResetScopeKey = (typeof SequenceResetScope)[keyof typeof SequenceResetScope];

export const RevisionLabelStyle = {
  NUMERIC: 'NUMERIC',
  ALPHABETIC: 'ALPHABETIC',
  MAJOR_MINOR: 'MAJOR_MINOR',
} as const;

export type RevisionLabelStyleKey = (typeof RevisionLabelStyle)[keyof typeof RevisionLabelStyle];

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
