import { describe, expect, it } from 'vitest';

import { decodeSearchCursor, encodeSearchCursor } from './search-cursor';

describe('search cursor', () => {
  it('round-trips every sort shape', () => {
    for (const cursor of [
      { sort: 'RELEVANCE', value: 0.42, documentId: 'doc-1' },
      { sort: 'RECENT', value: '2026-08-01T00:00:00.000Z', documentId: 'doc-2' },
      { sort: 'NUMBER', value: null, documentId: 'doc-3' },
      { sort: 'TITLE', value: 'Quality Manual', documentId: 'doc-4' },
    ] as const) {
      const decoded = decodeSearchCursor(encodeSearchCursor(cursor), cursor.sort);
      expect(decoded).toEqual({ ok: true, cursor });
    }
  });

  it('refuses a cursor minted under another sort order', () => {
    const encoded = encodeSearchCursor({ sort: 'RELEVANCE', value: 1, documentId: 'doc' });
    expect(decodeSearchCursor(encoded, 'RECENT')).toEqual({ ok: false, reason: 'SORT_MISMATCH' });
  });

  it('refuses garbage, truncation and shape-alikes', () => {
    expect(decodeSearchCursor('not-base64-json', 'RECENT').ok).toBe(false);
    expect(
      decodeSearchCursor(Buffer.from('{"sort":"RECENT"}').toString('base64url'), 'RECENT').ok,
    ).toBe(false);
    expect(
      decodeSearchCursor(
        Buffer.from('{"sort":"NOPE","value":1,"documentId":"x"}').toString('base64url'),
        'RECENT',
      ).ok,
    ).toBe(false);
    expect(decodeSearchCursor(Buffer.from('[1,2,3]').toString('base64url'), 'RECENT').ok).toBe(
      false,
    );
  });
});
