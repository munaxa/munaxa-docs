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
  /** The tenant's own code for the type. What a workflow's `appliesTo` names it by. */
  readonly code: string;
  readonly name: string;
  /**
   * The approval process a document of this type goes through.
   *
   * Null means none is required, which is legitimate for a reference type — and it is why
   * submission refuses with a sentence rather than approving a document nobody looked at.
   */
  readonly workflowDefinitionId: string | null;
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
  /** A category's code, for the fact set a workflow condition is evaluated against. Null if gone. */
  category(id: string): Promise<{ readonly id: string; readonly code: string } | null>;
  categoryExists(id: string): Promise<boolean>;
  userExists(id: string): Promise<boolean>;
  departmentExists(id: string): Promise<boolean>;
}
