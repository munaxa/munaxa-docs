import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../test/a11y';
import { folder, library } from '../../test/fixtures';
import { documentsView } from './documents-view';
import { FolderTree } from './folder-tree';

/**
 * What the rail claims about where the reader is — Slice 3.
 *
 * Slice 2 taught the heading, the counts and the breadcrumb to say "Favourites" on
 * `/documents?favorite=true`. The rail was not told, so it went on marking the library's root
 * folder as current — `selectedFolderId` is that root on every filtered view. The page then said
 * three things at once: the header said Favourites, the breadcrumb said Favourites, and the
 * navigation said the reader was sitting in the root folder.
 *
 * The assertions below are about the **accessible** current state rather than the styling that
 * follows it. `aria-current` is what a screen reader announces and what
 * `aria-[current]:font-medium` is keyed on, so asserting the attribute covers both; asserting the
 * class would cover only the half a sighted reader sees.
 */

const ROOT = folder({
  id: 'root-id',
  parentId: null,
  name: 'Quality Management',
  path: '/root',
  isRoot: true,
});
const PROCEDURES = folder({
  id: 'procedures-id',
  parentId: 'root-id',
  name: 'Procedures',
  path: '/root.procedures',
});

function tree(
  view: 'folder' | 'filtered' | 'empty',
  locale?: 'ar',
  selectedFolderId: string | null = ROOT.id,
): void {
  renderWithProviders(
    <FolderTree
      libraries={[library()]}
      folders={view === 'empty' ? [] : [ROOT, PROCEDURES]}
      selectedLibraryId={view === 'empty' ? null : library().id}
      selectedFolderId={view === 'empty' ? null : selectedFolderId}
      documentCounts={{}}
      view={view}
    />,
    locale,
  );
}

/** Every link the rail currently claims the reader is on, by accessible name. */
const current = (): string[] =>
  screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') !== null)
    .map((link) => link.textContent?.trim() ?? '');

/**
 * The library's own name, read from the fixture rather than repeated as a literal.
 *
 * The first draft of this file asserted "Quality Management" — the *root folder's* name — and the
 * library is called "Quality". The test failed on the difference and the component was right, which
 * is the correct way round; binding to the fixture stops the next reader having to know that.
 */
const LIBRARY = library().name;

describe('folder view', () => {
  it('marks the folder the reader is in, and no view', () => {
    tree('folder', undefined, PROCEDURES.id);
    // The library is current too — the reader is genuinely inside it — but Favourites is not.
    expect(current()).toStrictEqual([LIBRARY, 'Procedures']);
    expect(current()).not.toContain('Favourites');
  });

  it('keeps the folder current when a filter only narrows it', () => {
    /*
     * The dashboard's tiles link to `/documents?ownerUserId=…&status=DRAFT`. Those filters narrow a
     * folder's contents rather than leaving it, so the rail must go on saying which folder — and
     * the view is resolved through `documentsView` here rather than hard-coded, so this asserts the
     * whole chain the URL travels rather than a value this test chose.
     */
    const view = documentsView({ status: 'DRAFT', ownerUserId: 'a-user' }, true);
    expect(view).toBe('folder');
    tree(view, undefined, PROCEDURES.id);
    expect(current()).toContain('Procedures');
  });
});

describe('filtered view', () => {
  it('marks Favourites and releases the folder the list does not belong to', () => {
    tree('filtered');
    /*
     * The whole defect, in one assertion. `selectedFolderId` is still the root — the screen needs it
     * to know which library's folders to draw — but the rail no longer reports it as where the
     * reader is, because the list on screen belongs to no folder at all.
     */
    expect(current()).toStrictEqual(['Favourites']);
  });

  it('does not mark the library either', () => {
    // "You are in Quality" is the same false statement one level up from the folder.
    tree('filtered');
    expect(current()).not.toContain(LIBRARY);
  });

  it('still shows the folders, because they are how the reader leaves this view', () => {
    tree('filtered');
    expect(screen.getByRole('link', { name: 'Procedures' })).toBeTruthy();
  });
});

describe('empty view', () => {
  it('claims nothing when there is no library to be in', () => {
    tree('empty');
    expect(current()).toStrictEqual([]);
  });
});

describe('Arabic', () => {
  it('marks the favourites entry in the Arabic rail too', () => {
    tree('filtered', 'ar');
    // `المفضلة` is the catalogue's existing string for Favourites — no new Arabic is introduced by
    // this slice, and the active state is the same `aria-current` in both directions.
    expect(current()).toStrictEqual(['المفضلة']);
  });

  it('marks the folder in the Arabic rail on a folder view', () => {
    tree('folder', 'ar', PROCEDURES.id);
    // Folder names are user data and stay Latin here, which is the mixed-direction case the RTL
    // rail actually has to render.
    expect(current()).toStrictEqual([LIBRARY, 'Procedures']);
    // And the Arabic favourites entry stays unmarked on a folder view.
    expect(current()).not.toContain('المفضلة');
  });
});
