import { describe, expect, it } from 'vitest';

import { DocumentStatus, type DocumentStatusKey } from '@edms/domain';

import {
  FROZEN_STATUSES,
  IMPLEMENTED_TRANSITIONS,
  LEGAL_TRANSITIONS,
  implementedTransitionsFrom,
  isFrozen,
  isLegalTransition,
} from './lifecycle';

/**
 * The state machine, asked directly.
 *
 * The table has been the product's single source of truth about what a document may become since
 * Phase 0 and has never had a spec of its own — every assertion about it was made through a service
 * against a database. That is the expensive way to ask a pure function a question, and it is why
 * Phase 6.0 could find `ARCHIVED` and `EXPIRED` unreachable without any test failing: nothing was
 * ever asked "what can this state actually do".
 *
 * The invariant in `implemented is a subset of legal` is the one worth having most. It is what stops
 * `GET /documents/{id}/transitions` offering the client a button whose only outcome is a 409.
 */

const ALL_STATUSES = Object.keys(LEGAL_TRANSITIONS) as DocumentStatusKey[];

describe('the legal transition table', () => {
  it('covers every status exactly once, in both tables', () => {
    expect(Object.keys(IMPLEMENTED_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('never offers an implemented transition the table calls illegal', () => {
    // The subset invariant, over every pair rather than the ones this phase touched.
    for (const from of ALL_STATUSES) {
      for (const to of implementedTransitionsFrom(from)) {
        expect(isLegalTransition(from, to), `${from} → ${to} is offered but not legal`).toBe(true);
      }
    }
  });

  it('leaves PURGED terminal', () => {
    expect(LEGAL_TRANSITIONS[DocumentStatus.PURGED]).toHaveLength(0);
    expect(implementedTransitionsFrom(DocumentStatus.PURGED)).toHaveLength(0);
  });
});

describe('archival — Phase 6.1', () => {
  it('is legal from the three states a record can be retired from', () => {
    expect(isLegalTransition(DocumentStatus.PUBLISHED, DocumentStatus.ARCHIVED)).toBe(true);
    expect(isLegalTransition(DocumentStatus.SUPERSEDED, DocumentStatus.ARCHIVED)).toBe(true);
    expect(isLegalTransition(DocumentStatus.EXPIRED, DocumentStatus.ARCHIVED)).toBe(true);
  });

  it('is offered from PUBLISHED and EXPIRED, which are the two a document can be in', () => {
    expect(implementedTransitionsFrom(DocumentStatus.PUBLISHED)).toContain(DocumentStatus.ARCHIVED);
    expect(implementedTransitionsFrom(DocumentStatus.EXPIRED)).toContain(DocumentStatus.ARCHIVED);
  });

  it('is refused from every state that has not been published', () => {
    // The invalid-archive case, stated over the whole set rather than one example: a draft, a
    // document in approval and a rejected one are all things somebody might try to archive.
    for (const from of [
      DocumentStatus.DRAFT,
      DocumentStatus.SUBMITTED,
      DocumentStatus.UNDER_REVIEW,
      DocumentStatus.CHANGES_REQUESTED,
      DocumentStatus.REJECTED,
      DocumentStatus.APPROVED,
      DocumentStatus.CHECKED_OUT,
      DocumentStatus.PURGED,
    ]) {
      expect(isLegalTransition(from, DocumentStatus.ARCHIVED), `${from} → ARCHIVED`).toBe(false);
    }
  });

  it('keeps the retention path legal: a deleted record may still be archived', () => {
    // `RetentionDispositionAdapter.archive` asks the legality of `DELETED` for a soft-deleted row,
    // so this pair is what makes the non-destructive disposition possible at all.
    expect(isLegalTransition(DocumentStatus.DELETED, DocumentStatus.ARCHIVED)).toBe(true);
  });

  it('freezes an archived document’s content', () => {
    expect(isFrozen(DocumentStatus.ARCHIVED)).toBe(true);
    expect(FROZEN_STATUSES.has(DocumentStatus.ARCHIVED)).toBe(true);
  });
});

describe('reinstatement — Phase 6.1', () => {
  it('returns to PUBLISHED, and that is the only return the table allows', () => {
    expect(isLegalTransition(DocumentStatus.ARCHIVED, DocumentStatus.PUBLISHED)).toBe(true);
    expect(implementedTransitionsFrom(DocumentStatus.ARCHIVED)).toContain(DocumentStatus.PUBLISHED);
    for (const to of [
      DocumentStatus.DRAFT,
      DocumentStatus.SUBMITTED,
      DocumentStatus.APPROVED,
      DocumentStatus.EXPIRED,
      DocumentStatus.SUPERSEDED,
      DocumentStatus.CHECKED_OUT,
    ]) {
      expect(isLegalTransition(DocumentStatus.ARCHIVED, to), `ARCHIVED → ${to}`).toBe(false);
    }
  });

  it('leaves the recycle bin’s route out of the archive intact', () => {
    // `ARCHIVED → DELETED` predates this phase and stays: archiving is not a dead end.
    expect(implementedTransitionsFrom(DocumentStatus.ARCHIVED)).toContain(DocumentStatus.DELETED);
  });
});

describe('expiry — Phase 6.1', () => {
  it('is reachable from PUBLISHED and from nowhere else', () => {
    expect(isLegalTransition(DocumentStatus.PUBLISHED, DocumentStatus.EXPIRED)).toBe(true);
    for (const from of ALL_STATUSES.filter((status) => status !== DocumentStatus.PUBLISHED)) {
      expect(isLegalTransition(from, DocumentStatus.EXPIRED), `${from} → EXPIRED`).toBe(false);
    }
  });

  it('is offered by the sweep’s table, which is what makes the state reachable at all', () => {
    // The regression guard for the defect Phase 6.0 found: before 6.1 this array was empty, so a
    // document could carry an expiry date that nothing would ever act on.
    expect(implementedTransitionsFrom(DocumentStatus.PUBLISHED)).toContain(DocumentStatus.EXPIRED);
  });

  it('is not a dead end — an expired record can be archived or revised', () => {
    const fromExpired = implementedTransitionsFrom(DocumentStatus.EXPIRED);
    expect(fromExpired).toContain(DocumentStatus.ARCHIVED);
    expect(fromExpired).toContain(DocumentStatus.CHECKED_OUT);
  });
});
