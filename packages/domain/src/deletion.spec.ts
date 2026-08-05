import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_DELETION_RULES,
  DeletionEffect,
  PURGED_RELATIONS,
  PURGE_SURVIVING_RELATIONS,
  deletionRuleFor,
} from './deletion';

describe('the document deletion rules', () => {
  it('names each relation exactly once', () => {
    const relations = DOCUMENT_DELETION_RULES.map((rule) => rule.relation);
    expect(new Set(relations).size).toBe(relations.length);
  });

  it('states a reason for every rule', () => {
    for (const rule of DOCUMENT_DELETION_RULES) {
      expect(rule.why.length).toBeGreaterThan(40);
    }
  });

  it('never releases a reference at delete time that a restore could not take back', () => {
    // `DEREFERENCED` at delete would mean a restore has to re-take the reference, and the only
    // relation that does so is the document's own revisions — which are `CASCADED`, so the
    // reference travels with the cascade rather than on its own.
    const dereferencedOnDelete = DOCUMENT_DELETION_RULES.filter(
      (rule) => rule.onDelete === DeletionEffect.DEREFERENCED,
    );
    expect(dereferencedOnDelete).toEqual([]);
  });

  it('purges the document row last, so no child outlives its parent by accident', () => {
    const last = DOCUMENT_DELETION_RULES.at(-1);
    expect(last?.relation).toBe('document');
  });

  it('keeps only the audit trail and the number reservation', () => {
    // Everything else — workflow instances included — goes with the record. The approval evidence
    // is the audit trail, which refuses deletion; keeping the operational rows would keep stage
    // names and comments of a record the policy said to destroy.
    expect([...PURGE_SURVIVING_RELATIONS].sort()).toEqual(['audit_event', 'number_reservation']);
  });

  it('lists the relations a purge removes, in cascade order', () => {
    expect(PURGED_RELATIONS.at(-1)).toBe('document');
    expect(PURGED_RELATIONS).toContain('document_revision');
    expect(PURGED_RELATIONS).not.toContain('audit_event');
  });

  it('answers for a relation, and says so for one it does not know', () => {
    expect(deletionRuleFor('document_revision')?.onDelete).toBe(DeletionEffect.CASCADED);
    expect(deletionRuleFor('not_a_table')).toBeNull();
  });
});
