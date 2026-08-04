import { describe, expect, it } from 'vitest';

import { changedFields, isEmptyPatch } from './patch';

/**
 * Every administration update is a `PATCH` whose meaning is "change what I name". Naming a field that
 * did not change bumps the record's version — invalidating everybody else's `If-Match` — and writes an
 * audit event describing a change that did not happen.
 */
describe('working out what a form changed', () => {
  it('names only the fields whose value differs', () => {
    expect(
      changedFields({ code: 'QA', name: 'Quality' }, { code: 'QA', name: 'Quality Assurance' }),
    ).toEqual({ name: 'Quality Assurance' });
  });

  it('reports nothing when a record is opened and saved untouched', () => {
    expect(isEmptyPatch(changedFields({ code: 'QA' }, { code: 'QA' }))).toBe(true);
  });

  it('treats clearing an optional field as a change', () => {
    expect(changedFields({ description: 'old' }, { description: null })).toEqual({
      description: null,
    });
  });

  it('compares lists by content', () => {
    expect(isEmptyPatch(changedFields({ roleIds: ['a', 'b'] }, { roleIds: ['a', 'b'] }))).toBe(
      true,
    );
    expect(changedFields({ roleIds: ['a'] }, { roleIds: ['a', 'b'] })).toEqual({
      roleIds: ['a', 'b'],
    });
  });

  it('counts a reordering as a change', () => {
    // Correct for the cases that matter: the order of a numbering rule's segments and a workflow's
    // stages is exactly what they mean. Callers whose order is not meaningful sort before comparing.
    expect(changedFields({ segments: ['a', 'b'] }, { segments: ['b', 'a'] })).toEqual({
      segments: ['b', 'a'],
    });
  });

  it('compares nested objects rather than identities', () => {
    expect(
      isEmptyPatch(
        changedFields({ validation: { minLength: 1 } }, { validation: { minLength: 1 } }),
      ),
    ).toBe(true);
  });
});
