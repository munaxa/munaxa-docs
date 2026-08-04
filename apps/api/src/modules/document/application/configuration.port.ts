import type { RevisionLabelStyleKey } from '@edms/domain';

import type { FieldDefinition } from '../domain/metadata';

/**
 * The configuration a document is assembled from, in Document's own words.
 *
 * Phase 2 built all of it — document types, metadata fields, categories, confidentiality levels,
 * retention policies — and Phase 3 consumes it without duplicating a row of it. What this port
 * expresses is *which questions Document asks*, which is a much smaller surface than
 * Administration's own service: whether a type exists and what policy it carries, whether a
 * category exists, what a level's rank is, and whether an identifier names a person or a
 * department.
 *
 * Declared here and implemented against Administration's application service. A narrow port rather
 * than a direct dependency on that service for one reason worth stating: a document use case that
 * held `CONFIGURATION_SERVICE` could also *write* configuration, and the only thing stopping it
 * would be that nobody had thought to.
 */
export const DOCUMENT_CONFIGURATION = Symbol('DocumentConfiguration');

/** A document type, reduced to what creating a document under it needs. */
export interface DocumentTypePolicy {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly defaultConfidentialityId: string;
  readonly retentionPolicyId: string | null;
  readonly revisionLabelStyle: RevisionLabelStyleKey;
  /** In the order the type declares them, which is the order the form renders. */
  readonly fields: readonly FieldDefinition[];
}

export interface ConfidentialityView {
  readonly id: string;
  readonly name: string;
  /** Total order. "More sensitive than" only has an answer because this is unique per tenant. */
  readonly rank: number;
  readonly allowDownload: boolean;
  readonly allowPrint: boolean;
  readonly requireReason: boolean;
}

export interface DocumentConfiguration {
  documentType(id: string): Promise<DocumentTypePolicy | null>;
  confidentiality(id: string): Promise<ConfidentialityView | null>;
  categoryExists(id: string): Promise<boolean>;
  userExists(id: string): Promise<boolean>;
  departmentExists(id: string): Promise<boolean>;
}
