import { describe, expect, it } from 'vitest';

import { documentsView, suppliesDefaultFolderScope } from './documents-view';

/**
 * The invariant that makes the favourites defect unrepeatable.
 *
 * The defect was not a wrong line; it was two correct lines in two files that stopped agreeing.
 * `page.tsx` withheld the folder filter for `favorite=true` — rightly, because favourites are
 * collected across the tenant — while the screen went on naming the selected folder and counting its
 * subfolders. Each was defensible alone. Together they put "N documents · M folders" on a page where
 * N and M described different scopes.
 *
 * So the test that matters is not "does `favorite=true` return `filtered`". It is the *equivalence*:
 * the header may claim a folder exactly when a folder scope actually reaches the API. That is
 * asserted below across all eight combinations of the three keys that decide it, so a fourth
 * de-scoping filter added to one function and not the other fails here rather than on a page.
 */
const KEYS = ['folderId', 'underFolderId', 'favorite'] as const;

/** Every combination of the three keys being present or absent. */
const COMBINATIONS = Array.from({ length: 2 ** KEYS.length }, (_, mask) =>
  Object.fromEntries(
    KEYS.flatMap((key, index) =>
      (mask & (1 << index)) === 0 ? [] : [[key, key === 'favorite' ? 'true' : 'an-id']],
    ),
  ),
);

describe('documentsView', () => {
  it('is empty when no library exists, whatever the filters say', () => {
    for (const filters of COMBINATIONS) {
      expect(documentsView(filters, false)).toBe('empty');
    }
  });

  it('names a folder exactly when a folder scope reaches the API', () => {
    for (const filters of COMBINATIONS) {
      const view = documentsView(filters, true);

      /*
       * What the API is actually asked for: an explicit folder from the URL, or the default this
       * predicate supplies. If neither, the list spans the tenant.
       */
      const folderScopeReachesApi =
        filters['folderId'] !== undefined ||
        filters['underFolderId'] !== undefined ||
        suppliesDefaultFolderScope(filters);

      expect(
        view === 'folder',
        `filters ${JSON.stringify(filters)} produced view "${view}" but folder scope ${
          folderScopeReachesApi ? 'does' : 'does not'
        } reach the API`,
      ).toBe(folderScopeReachesApi);
    }
  });

  it('is filtered for favourites alone — the one view that leaves every folder', () => {
    expect(documentsView({ favorite: 'true' }, true)).toBe('filtered');
  });

  it('stays a folder view when a folder is named beside the favourite filter', () => {
    // `?folderId=X&favorite=true` is "the favourites in X" — still a folder's contents, so the
    // folder's name and subfolder count are still true of what is on screen.
    expect(documentsView({ favorite: 'true', folderId: 'an-id' }, true)).toBe('folder');
    expect(documentsView({ favorite: 'true', underFolderId: 'an-id' }, true)).toBe('folder');
  });

  it('stays a folder view for the filters that only narrow a folder', () => {
    // The dashboard's tiles link here. Each narrows the folder's contents rather than leaving it, so
    // the count beside the title still describes the rows on screen.
    for (const key of [
      'status',
      'ownerUserId',
      'documentTypeId',
      'categoryId',
      'confidentialityId',
    ])
      expect(documentsView({ [key]: 'a-value' }, true)).toBe('folder');
  });
});

describe('suppliesDefaultFolderScope', () => {
  it('supplies the library root when the URL names no folder and no favourite', () => {
    expect(suppliesDefaultFolderScope({})).toBe(true);
    expect(suppliesDefaultFolderScope({ status: 'DRAFT' })).toBe(true);
  });

  it('withholds it when the URL already names a folder', () => {
    expect(suppliesDefaultFolderScope({ folderId: 'an-id' })).toBe(false);
    expect(suppliesDefaultFolderScope({ underFolderId: 'an-id' })).toBe(false);
  });

  it('withholds it for favourites, which are collected across the tenant', () => {
    // Adding a folder here would silently narrow "my favourites" to "my favourites in whichever
    // folder happened to be selected" — the bug this predicate exists to prevent.
    expect(suppliesDefaultFolderScope({ favorite: 'true' })).toBe(false);
  });
});
