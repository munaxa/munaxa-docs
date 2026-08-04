import type {
  CategoryId,
  ConfidentialityLevelId,
  DocumentId,
  DocumentTypeId,
  MetadataFieldId,
  NumberOriginKey,
  NumberReservationId,
  NumberingRuleId,
  RetentionPolicyId,
  WorkflowInstanceId,
} from '@edms/domain';

/**
 * Tenant configuration.
 *
 * Nothing here is hardcoded anywhere else in the product: a tenant that needs a new document
 * type, metadata field, number format, retention rule or confidentiality level configures it
 * and does not wait for a release (`docs/architecture/03-domain-model.md` §3).
 */
export const DOCUMENT_TYPE_REPOSITORY = Symbol('DocumentTypeRepository');
export const CATEGORY_REPOSITORY = Symbol('CategoryRepository');
export const METADATA_FIELD_REPOSITORY = Symbol('MetadataFieldRepository');
export const NUMBERING_RULE_REPOSITORY = Symbol('NumberingRuleRepository');
export const NUMBER_SEQUENCE_REPOSITORY = Symbol('NumberSequenceRepository');
export const RETENTION_POLICY_REPOSITORY = Symbol('RetentionPolicyRepository');
export const CONFIDENTIALITY_REPOSITORY = Symbol('ConfidentialityLevelRepository');
export const TENANT_SETTINGS_REPOSITORY = Symbol('TenantSettingsRepository');

export interface DocumentTypeRepository {
  findById(id: DocumentTypeId): Promise<unknown>;
  findByCode(code: string): Promise<unknown>;
  listAll(): Promise<readonly unknown[]>;
  save(documentType: unknown): Promise<void>;
}

export interface CategoryRepository {
  findById(id: CategoryId): Promise<unknown>;
  listSubtree(id: CategoryId): Promise<readonly unknown[]>;
  save(category: unknown): Promise<void>;
}

export interface MetadataFieldRepository {
  findById(id: MetadataFieldId): Promise<unknown>;
  listForDocumentType(documentTypeId: DocumentTypeId): Promise<readonly unknown[]>;
  save(field: unknown): Promise<void>;
}

export interface NumberingRuleRepository {
  findById(id: NumberingRuleId): Promise<unknown>;
  save(rule: unknown): Promise<void>;
}

/**
 * The sequence a document number is drawn from.
 *
 * `claimNext` takes a row lock for the microseconds it holds, and a claimed value is never
 * returned twice — not after a rollback, not after a rejection. A number is issued once and
 * never reused (`docs/architecture/09-numbering-architecture.md`).
 */
export interface NumberSequenceRepository {
  claimNext(ruleId: NumberingRuleId, scopeKey: string): Promise<bigint>;
  peek(ruleId: NumberingRuleId, scopeKey: string): Promise<bigint>;
}

export interface RetentionPolicyRepository {
  findById(id: RetentionPolicyId): Promise<unknown>;
  listAll(): Promise<readonly unknown[]>;
  save(policy: unknown): Promise<void>;
}

export interface ConfidentialityLevelRepository {
  findById(id: ConfidentialityLevelId): Promise<unknown>;
  listOrdered(): Promise<readonly unknown[]>;
}

export interface TenantSettingsRepository {
  get<TValue>(key: string): Promise<TValue | null>;
  /** Rejects a key outside the catalogue: a value nothing can read back is only clutter. */
  set<TValue>(key: string, value: TValue): Promise<void>;
  /**
   * Drops a tenant's override, returning the setting to the product's default.
   *
   * Removing the key rather than storing today's default: a stored copy would stop tracking the
   * product's opinion the day it changed, and nothing would say why this tenant was different.
   */
  remove(key: string): Promise<void>;
  /**
   * The whole stored bag, unresolved.
   *
   * Settings are always read together — one read serves a request, whatever it asks for — so
   * the reader resolves this against the catalogue once and caches the result.
   */
  readAll(): Promise<Readonly<Record<string, unknown>>>;
}

export const ADMINISTRATION_SERVICE = Symbol('AdministrationService');
export const NUMBERING_SERVICE = Symbol('NumberingService');

export interface AdministrationService {
  documentTypeFor(id: DocumentTypeId): Promise<unknown>;
  confidentialityRules(id: ConfidentialityLevelId): Promise<unknown>;
}

/**
 * The codes a document's own organisational context supplies, resolved by the caller — never
 * taken from anything a client sends. The Document module walks its library's scope chain and
 * its department's branch; Administration turns the codes into a scope key and a rendered number.
 */
export interface NumberingCodes {
  readonly companyCode?: string | undefined;
  readonly entityCode?: string | undefined;
  readonly branchCode?: string | undefined;
  readonly departmentCode?: string | undefined;
  readonly documentTypeCode?: string | undefined;
  readonly categoryCode?: string | undefined;
}

/** A value drawn from a sequence: the row, the text, and the series it came from. */
export interface IssuedNumber {
  readonly reservationId: NumberReservationId;
  readonly formatted: string;
  readonly sequenceValue: bigint;
  readonly scopeKey: string;
  readonly numberingRuleId: NumberingRuleId;
}

/** When a document type's rule draws its number — the caller's timing decision, as data. */
export interface NumberingPolicy {
  readonly numberingRuleId: NumberingRuleId;
  readonly reserveOnSubmit: boolean;
  readonly strictGapless: boolean;
}

/**
 * Number issuance, called by the Document module — reservation at submission, assignment when
 * approval completes, never earlier (`09-numbering-architecture.md` §2, ADR-0004).
 *
 * Every method joins the caller's ambient transaction, because assignment must commit with the
 * approval or not at all. The sequence row lock each draw takes is always the **last** lock of
 * its transaction — after the workflow instance's and the document's — so two approvals in one
 * series contend on the counter and never deadlock across it.
 *
 * The rendered text and the scope key are fixed at the moment the value is drawn. Committing a
 * reservation never re-renders it: the pending reference reviewers held is the number the
 * document receives, even when approval lands in a later year than the reservation (§2).
 *
 * Each mutation writes its own audit event — `NUMBER_RESERVED`, `NUMBER_ASSIGNED`,
 * `NUMBER_VOIDED` — inside the same transaction, which is how one approval leaves both its
 * approval entry and its numbering entry or neither.
 */
export interface NumberingService {
  /** The rule a document type numbers under. Null only for a type that no longer exists. */
  policyFor(documentTypeId: DocumentTypeId): Promise<NumberingPolicy | null>;
  reserve(input: {
    readonly numberingRuleId: NumberingRuleId;
    readonly codes: NumberingCodes;
    readonly documentId: DocumentId;
    readonly workflowInstanceId: WorkflowInstanceId;
  }): Promise<IssuedNumber>;
  /** Turns a reservation into the value assignment writes. Refuses one that is not claimable. */
  commit(reservationId: NumberReservationId, documentId: DocumentId): Promise<string>;
  /** Voids a reservation. The value is retained and never returns to the pool. */
  release(reservationId: NumberReservationId, reason: string): Promise<void>;
  /** The live pending reservation an approval holds, if any. */
  reservationForInstance(workflowInstanceId: WorkflowInstanceId): Promise<IssuedNumber | null>;
  /** The pending number shown on a document under review, or null. */
  pendingForDocument(documentId: DocumentId): Promise<string | null>;
  /**
   * Records a supplied number — manual assignment or legacy import (§3). Validates the text
   * against the rule's shape for this document's codes, fast-forwards the series the number
   * belongs to past its value, and claims a matching `HELD` value instead of colliding with it.
   */
  assignManual(input: {
    readonly numberingRuleId: NumberingRuleId;
    readonly codes: NumberingCodes;
    readonly documentId: DocumentId;
    readonly requested: string;
    readonly origin: NumberOriginKey;
  }): Promise<IssuedNumber>;
}
