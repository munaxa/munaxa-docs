import type {
  CategoryId,
  ConfidentialityLevelId,
  DocumentTypeId,
  MetadataFieldId,
  NumberingRuleId,
  RetentionPolicyId,
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
 * Number issuance, called by the Document module when approval completes — never earlier.
 * Reservations exist so a number can be shown before it is committed, and released without
 * leaving a gap when an approval is refused.
 */
export interface NumberingService {
  reserve(
    documentTypeId: DocumentTypeId,
    scopeKey: string,
  ): Promise<{ reservationId: string; formatted: string }>;
  commit(reservationId: string): Promise<string>;
  release(reservationId: string, reason: string): Promise<void>;
  /** Renders a sample for the admin rule builder. Pure formatting; claims nothing. */
  preview(ruleId: NumberingRuleId, scopeKey: string): Promise<string>;
}
