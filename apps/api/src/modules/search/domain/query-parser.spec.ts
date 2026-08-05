import { describe, expect, it } from 'vitest';

import { parseSearchQuery } from './query-parser';

describe('parseSearchQuery', () => {
  it('splits fields from free text', () => {
    const parsed = parseSearchQuery('number:QMS-* status:PUBLISHED pump maintenance');
    expect(parsed.text).toBe('pump maintenance');
    expect(parsed.filters).toEqual({ number: ['QMS-*'], status: ['PUBLISHED'] });
  });

  it('maps the documented aliases onto engine filter keys', () => {
    const parsed = parseSearchQuery('type:PROC approver:me author:me updated:>2026-01-01');
    expect(parsed.filters).toEqual({
      typeCode: ['PROC'],
      approver: ['me'],
      owner: ['me'],
      updated: ['>2026-01-01'],
    });
  });

  it('collects repeated fields as alternatives', () => {
    const parsed = parseSearchQuery('status:DRAFT status:PUBLISHED');
    expect(parsed.filters).toEqual({ status: ['DRAFT', 'PUBLISHED'] });
  });

  it('keeps an unknown field as text rather than refusing', () => {
    const parsed = parseSearchQuery('re:union procedure');
    expect(parsed.text).toBe('re:union procedure');
    expect(parsed.filters).toEqual({});
  });

  it('keeps quoted phrases whole, including after a field colon', () => {
    const parsed = parseSearchQuery('published:"2026-01-01" "pressure vessel"');
    expect(parsed.filters).toEqual({ published: ['2026-01-01'] });
    expect(parsed.text).toBe('"pressure vessel"');
  });

  it('drops a field with an empty value', () => {
    expect(parseSearchQuery('status: pump').filters).toEqual({});
  });

  it('parses an all-fields query to empty text', () => {
    expect(parseSearchQuery('status:PUBLISHED').text).toBe('');
  });
});
