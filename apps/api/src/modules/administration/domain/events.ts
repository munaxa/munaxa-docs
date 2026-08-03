import { type DomainEventDraft, defineEvent } from '@edms/domain';

/**
 * Administration's domain events.
 *
 * An event is a fact in the past tense, its payload shape never changes once shipped, and
 * delivery is at least once — so every handler is idempotent on `eventId`
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The payloads are deliberately thin: an event carries identifiers and the facts a consumer
 * cannot derive, never a copy of the aggregate. A fat event becomes a second schema that
 * nobody migrates.
 */
export const ADMINISTRATION_AGGREGATE = 'administration';

/** Affects future documents only; documents already created keep their frozen policy. */
export const DOCUMENT_TYPE_CHANGED = 'administration.document-type-changed' as const;

export interface DocumentTypeChangedPayload {
  readonly documentTypeId: string;
  readonly changedFields: readonly string[];
}

export const documentTypeChangedEvent = defineEvent<
  typeof DOCUMENT_TYPE_CHANGED,
  DocumentTypeChangedPayload
>(DOCUMENT_TYPE_CHANGED, 1, ADMINISTRATION_AGGREGATE);

/** Never renumbers anything that exists. */
export const NUMBERING_RULE_CHANGED = 'administration.numbering-rule-changed' as const;

export interface NumberingRuleChangedPayload {
  readonly numberingRuleId: string;
  readonly affectsDocumentTypeIds: readonly string[];
}

export const numberingRuleChangedEvent = defineEvent<
  typeof NUMBERING_RULE_CHANGED,
  NumberingRuleChangedPayload
>(NUMBERING_RULE_CHANGED, 1, ADMINISTRATION_AGGREGATE);

/** Invalidates configuration caches for the tenant. */
export const SETTINGS_CHANGED = 'administration.settings-changed' as const;

export interface SettingsChangedPayload {
  readonly keys: readonly string[];
}

export const settingsChangedEvent = defineEvent<typeof SETTINGS_CHANGED, SettingsChangedPayload>(
  SETTINGS_CHANGED,
  1,
  ADMINISTRATION_AGGREGATE,
);

/** Every event type this module publishes, for the outbox's routing table. */
export const ADMINISTRATION_EVENT_TYPES: readonly string[] = Object.freeze([
  DOCUMENT_TYPE_CHANGED,
  NUMBERING_RULE_CHANGED,
  SETTINGS_CHANGED,
]);

export type AdministrationEvent = DomainEventDraft;
