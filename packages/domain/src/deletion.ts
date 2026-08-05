/**
 * What a delete reaches, and what only a purge reaches.
 *
 * Before Phase 10 there was no single answer to this. Phase 3's document delete gave back the
 * reference on the *latest* revision and left every earlier one counted; Phase 2's folder delete
 * cascaded over folders and stopped at the documents inside them; Phase 6 created revisions that
 * nothing ever detached. Three modules each decided locally, and the three decisions did not
 * compose — a document with four revisions gave back one reference, so its blobs could never reach
 * zero and retention could never reclaim them.
 *
 * This table is the answer, in one place, for the same reason the permission catalogue and the
 * queue catalogue are: a rule that is not here does not exist, and a relation absent from it is a
 * relation nobody decided about. It is pure data so the API, the purge and the integration suite
 * read the *same* table — the suite asserts row counts per relation after a delete and after a
 * purge directly from these rows, which is what stops the table drifting into documentation.
 *
 * Read a row as: when the document at the root of the cascade is soft-deleted, this relation gets
 * `onDelete`; when it is purged, it gets `onPurge`.
 */

export const DeletionEffect = {
  /**
   * The row is soft-deleted with its root, stamped with the root's cascade identifier — and any
   * blob reference it holds is given back with it, taken again by the restore.
   *
   * Reversible: a restore brings back exactly the rows one cascade took, never everything
   * currently deleted underneath — which would resurrect what somebody removed deliberately
   * beforehand (`05-database-design.md` §4).
   */
  CASCADED: 'CASCADED',
  /**
   * The row stays, and the reference it holds on a blob is given back.
   *
   * The row is what proves the document had this content; the reference is what stops storage
   * reclaiming bytes somebody may still restore. Only the second is released at delete time.
   */
  DEREFERENCED: 'DEREFERENCED',
  /** Untouched by both. The row outlives the document, deliberately, and the `why` says so. */
  RETAINED: 'RETAINED',
  /** Untouched by a delete; removed by a purge. Nothing reversible depends on it. */
  REMOVED_ON_PURGE: 'REMOVED_ON_PURGE',
} as const;

export type DeletionEffectKey = (typeof DeletionEffect)[keyof typeof DeletionEffect];

export interface DeletionRule {
  /** The table, as the schema names it. The integration suite counts rows in exactly this. */
  readonly relation: string;
  /** The column that ties a row of this relation to the document at the root of the cascade. */
  readonly via: string;
  readonly onDelete: DeletionEffectKey;
  readonly onPurge: DeletionEffectKey;
  /** Why this relation is treated this way, in the words the decision was taken in. */
  readonly why: string;
}

/**
 * Every relation a document's deletion reaches, and the three it deliberately does not.
 *
 * The order is the order a purge performs them in, and that is not cosmetic: references are given
 * back before the rows holding them go, and the document row is last, because a foreign key from a
 * child to a parent that is already gone is a purge that fails halfway with rows removed.
 */
export const DOCUMENT_DELETION_RULES: readonly DeletionRule[] = Object.freeze([
  {
    relation: 'document_revision',
    via: 'document_id',
    onDelete: DeletionEffect.CASCADED,
    onPurge: DeletionEffect.REMOVED_ON_PURGE,
    why: 'A revision has no meaning without the document it is a revision of, and its reference on a blob is what stops that blob reaching zero. Phase 3 released the latest revision only, so a document with four revisions gave back one — this row is what closes that.',
  },
  {
    relation: 'document_metadata_value',
    via: 'document_id',
    onDelete: DeletionEffect.RETAINED,
    onPurge: DeletionEffect.REMOVED_ON_PURGE,
    why: 'Values are attributes of the document row rather than rows a reader can reach on their own: they are only ever read through the document, which is already filtered. Removal at purge rides the foreign key, which cascades from the document row.',
  },
  {
    relation: 'document_favorite',
    via: 'document_id',
    onDelete: DeletionEffect.RETAINED,
    onPurge: DeletionEffect.REMOVED_ON_PURGE,
    why: "One person's bookmark. It disappears from their list because the list joins live documents, and it comes back with a restore because the row was never touched.",
  },
  {
    relation: 'document_view',
    via: 'document_id',
    onDelete: DeletionEffect.RETAINED,
    onPurge: DeletionEffect.REMOVED_ON_PURGE,
    why: 'The recents list, same as favourites. It is not evidence — the audit trail is what records that somebody read a document, and that is never removed.',
  },
  {
    relation: 'preview_artifact',
    via: 'revision_id',
    onDelete: DeletionEffect.RETAINED,
    onPurge: DeletionEffect.DEREFERENCED,
    why: 'Derived and regenerable. A restored document must show the preview it had rather than re-render it, so the artefacts survive a delete; a purge gives back their references — so the derived blobs reach zero with the originals — and the rows go with their revisions.',
  },
  {
    relation: 'preview_render',
    via: 'revision_id',
    onDelete: DeletionEffect.RETAINED,
    onPurge: DeletionEffect.REMOVED_ON_PURGE,
    why: "The render ledger rides its revision's foreign key, which cascades. It holds no reference of its own.",
  },
  {
    relation: 'ocr_result',
    via: 'revision_id',
    onDelete: DeletionEffect.RETAINED,
    onPurge: DeletionEffect.REMOVED_ON_PURGE,
    why: 'Same as the render ledger: removed with its revision by the foreign key, holding no reference of its own.',
  },
  {
    relation: 'document_lock',
    via: 'document_id',
    onDelete: DeletionEffect.RETAINED,
    onPurge: DeletionEffect.REMOVED_ON_PURGE,
    why: 'Lock history answers "who had this checked out, and how did it end". A delete does not end that history; a purge removes the document it was history of, and the acts themselves stay in the audit trail.',
  },
  {
    relation: 'search_index_entry',
    via: 'document_id',
    onDelete: DeletionEffect.REMOVED_ON_PURGE,
    onPurge: DeletionEffect.REMOVED_ON_PURGE,
    why: 'A read model, never authoritative. The projection removes the entry when a document stops being findable, which a soft delete already makes true — so both delete and purge reach it through the outbox rather than through the cascade.',
  },
  {
    relation: 'retention_schedule',
    via: 'document_id',
    onDelete: DeletionEffect.RETAINED,
    onPurge: DeletionEffect.REMOVED_ON_PURGE,
    why: 'The schedule is what says when the deleted document may be disposed of, so a delete must not touch it. After the purge it has done its work: the tombstone and the PURGE_EXECUTED event carry the evidence, and a row pointing at a removed document would block the removal at its foreign key.',
  },
  {
    relation: 'legal_hold',
    via: 'document_id',
    onDelete: DeletionEffect.RETAINED,
    onPurge: DeletionEffect.REMOVED_ON_PURGE,
    why: 'A purge cannot run while a live hold exists, so only released holds can be present — and their placement and release are already in the immutable trail, which is where hold history belongs.',
  },
  {
    relation: 'workflow_instance',
    via: 'document_id',
    onDelete: DeletionEffect.RETAINED,
    onPurge: DeletionEffect.REMOVED_ON_PURGE,
    why: 'Destroying the record destroys its operational rows; SUBMITTED, APPROVED and every decision are already in the audit trail, which refuses deletion and is the approval evidence. Keeping the instances would keep stage names, comments and metadata of a record the policy said to destroy.',
  },
  {
    relation: 'number_reservation',
    via: 'document_id',
    onDelete: DeletionEffect.RETAINED,
    onPurge: DeletionEffect.RETAINED,
    why: 'A number is never re-issued, even after a purge (ADR-0004), and this row is the mechanism: the formatted value stays unique forever. The purge sets its document pointer to null — the row outlives its parent, and the tombstone is what still ties the number to what it named.',
  },
  {
    relation: 'audit_event',
    via: 'subject_id',
    onDelete: DeletionEffect.RETAINED,
    onPurge: DeletionEffect.RETAINED,
    why: 'Audit outlives its subject (13 §1). The table refuses DELETE to every role including the owner, so a purge that tried would fail loudly rather than quietly succeed — which is why the document number is copied to a tombstone the purge does not reach.',
  },
  {
    relation: 'document',
    via: 'id',
    onDelete: DeletionEffect.CASCADED,
    onPurge: DeletionEffect.REMOVED_ON_PURGE,
    why: 'The root. Its number stays reserved forever — held by the reservation and the tombstone once the row is gone — which is why `uq_document_number` is the one unique index in the schema that is not partial on `deleted_at`.',
  },
]);

const RULE_BY_RELATION: ReadonlyMap<string, DeletionRule> = new Map(
  DOCUMENT_DELETION_RULES.map((rule) => [rule.relation, rule]),
);

export function deletionRuleFor(relation: string): DeletionRule | null {
  return RULE_BY_RELATION.get(relation) ?? null;
}

/** The relations a purge removes rows from, in the order it must remove them. */
export const PURGED_RELATIONS: readonly string[] = Object.freeze(
  DOCUMENT_DELETION_RULES.filter((rule) => rule.onPurge === DeletionEffect.REMOVED_ON_PURGE).map(
    (rule) => rule.relation,
  ),
);

/** The relations that survive a purge, and are therefore what a purged document still has. */
export const PURGE_SURVIVING_RELATIONS: readonly string[] = Object.freeze(
  DOCUMENT_DELETION_RULES.filter((rule) => rule.onPurge === DeletionEffect.RETAINED).map(
    (rule) => rule.relation,
  ),
);
