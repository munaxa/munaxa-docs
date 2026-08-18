import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Folder } from '@edms/contracts';

import { renderWithProviders } from '../../test/a11y';
import { documentSummary, folder, library, listState } from '../../test/fixtures';
import type { DocumentsView } from './documents-view';
import { LibraryScreen } from './library-screen';

/**
 * What the header claims, per view — Slice 2.
 *
 * The defect this file pins down was not visible in any screenshot, because every baseline showed
 * the one view that happened to be correct. On `/documents?favorite=true` the heading named a
 * folder, the breadcrumb walked to it, and the counts read "N documents · M folders" — where N was
 * every favourite in the tenant and M was the subfolder count of a folder the reader was not
 * looking at. Two numbers, two scopes, one sentence.
 *
 * So each view is rendered and its heading, its counts and its breadcrumb are read back. The
 * assertions are about *scope*, not wording: whether the header may say "folders" at all is the
 * question, and it is answerable only by rendering the screen the URL would actually produce.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/documents',
  useSearchParams: () => new URLSearchParams(),
}));

const ROOT = folder({
  id: 'root-id',
  parentId: null,
  name: 'Quality Management',
  libraryName: 'Quality Management',
  isRoot: true,
  depth: 1,
  childCount: 3,
});
const QUALITY = folder({
  id: 'quality-id',
  parentId: 'root-id',
  name: 'Quality',
  libraryName: 'Quality Management',
  depth: 2,
  childCount: 2,
});
const SOP = folder({
  id: 'sop-id',
  parentId: 'quality-id',
  name: 'SOP',
  libraryName: 'Quality Management',
  depth: 3,
  childCount: 0,
});

function render({
  view,
  folders = [ROOT, QUALITY, SOP],
  selectedFolderId = SOP.id,
  selectedFolderName = 'SOP',
  selectedLibraryId = library().id,
  total = 18,
}: {
  view: DocumentsView;
  folders?: readonly Folder[];
  selectedFolderId?: string | null;
  selectedFolderName?: string;
  selectedLibraryId?: string | null;
  total?: number;
}): void {
  renderWithProviders(
    <LibraryScreen
      rows={[documentSummary()]}
      total={total}
      view={view}
      state={listState()}
      libraries={[library()]}
      folders={folders}
      // Complete by construction: this fixture's folders are the library's folders, so the
      // rail has nothing to disclaim.
      folderPage={{ shown: folders.length, total: folders.length, hasMore: false }}
      selectedLibraryId={selectedLibraryId}
      selectedFolderId={selectedFolderId}
      selectedFolderName={selectedFolderName}
      documentTypes={[]}
      categories={[]}
      confidentialityLevels={[]}
      users={[]}
      departments={[]}
      canCreate
      canBulk={{ edit: true, restore: true, download: true }}
    />,
  );
}

/** The page's one `h1`. `Panel` renders `h2`, so this is unambiguous. */
const heading = (): string => screen.getByRole('heading', { level: 1 }).textContent ?? '';

/**
 * The breadcrumb's items, in order, as a reader reads them.
 *
 * The empties are dropped because `Breadcrumb` renders its separators as `<li>` too — they carry a
 * chevron and no text, and counting them as crumbs would make this helper assert the platform's
 * punctuation rather than this screen's trail.
 */
const crumbs = (): string[] =>
  [...screen.getByRole('navigation', { name: /breadcrumb/i }).querySelectorAll('li')]
    .map((node) => node.textContent?.trim() ?? '')
    .filter((text) => text !== '');

describe('folder view', () => {
  it('names the folder in the heading, not the route', () => {
    render({ view: 'folder' });
    // "Documents" was the heading on every folder of every library. For anyone navigating by
    // heading, the page never said where they were.
    expect(heading()).toBe('SOP');
  });

  it('counts documents and subfolders at the folder it names', () => {
    render({ view: 'folder' });
    // 18 from `meta.total`, 0 from SOP's own `childCount` — both true of this folder.
    expect(screen.getByText('18 documents · 0 folders')).toBeTruthy();
  });

  it('walks the full ancestry, library first', () => {
    render({ view: 'folder' });
    expect(crumbs()).toStrictEqual(['Documents', 'Quality Management', 'Quality', 'SOP']);
  });

  it('does not repeat the library as its own root folder', () => {
    // Selecting the root shows the library once, not "Quality Management › Quality Management".
    render({ view: 'folder', selectedFolderId: ROOT.id, selectedFolderName: 'Quality Management' });
    expect(crumbs()).toStrictEqual(['Documents', 'Quality Management']);
    expect(heading()).toBe('Quality Management');
  });

  it('keeps the generic description when the folder is not in the fetched page', () => {
    /*
     * Folders are fetched a hundred at a time, so the selected one can be missing from the list
     * this screen was handed — after Slice 7 that means it was refused or is genuinely gone, since
     * anything readable is recovered before the screen renders. The counts go rather than reading
     * "0 folders", which would be a claim where the truth is an absence.
     */
    render({
      view: 'folder',
      folders: [],
      selectedFolderId: 'absent-id',
      selectedFolderName: '',
    });
    expect(crumbs()).toStrictEqual(['Documents']);
    expect(
      screen.getByText('Everything filed in this organisation, and where it sits.'),
    ).toBeTruthy();
  });

  it('does not name the library when the folder could not be established', () => {
    /*
     * **The defect Slice 7 removes, stated as the thing that must never come back.**
     *
     * `page.tsx` resolved `folder?.name ?? selectedLibrary?.name ?? ''`, so a folder past the
     * hundred-row cut produced a page headed with the *library's* name — a confident false
     * statement in the one element a screen reader reaches first, over a document list that was
     * correctly scoped to the folder all along.
     *
     * Unknown is now unknown: the heading falls back to the route's own title, which claims
     * nothing about which folder this is. Restoring the `?? selectedLibrary?.name` term fails here.
     */
    render({
      view: 'folder',
      folders: [],
      selectedFolderId: 'absent-id',
      selectedFolderName: '',
    });
    expect(heading()).toBe('Documents');
    expect(heading()).not.toBe(library().name);
    expect(heading()).not.toBe('Quality Management');
  });

  it('names a recovered folder even when its ancestors could not be', () => {
    /*
     * The partial-ACL case, which is the one that decides whether "no false fallback" was worth
     * writing. `AclGuard` said yes to this folder and no to its parent, so `page.tsx` has the
     * folder's own name and no chain to place it on: the heading is the folder, and the breadcrumb
     * stops rather than inventing the route to it.
     */
    render({
      view: 'folder',
      folders: [],
      selectedFolderId: 'off-page-id',
      selectedFolderName: 'Department 133',
    });
    expect(heading()).toBe('Department 133');
    expect(crumbs()).toStrictEqual(['Documents']);
  });

  it('reads exactly like an on-page folder once the chain has been recovered', () => {
    /*
     * The whole point of the recovery, from the screen's side: it hands `LibraryScreen` a folder
     * set in which the selection exists, and everything downstream — heading, trail, counts —
     * works unchanged. Nothing in this file knows the folders arrived by two different routes.
     */
    render({ view: 'folder', folders: [ROOT, QUALITY, SOP], selectedFolderId: SOP.id });
    expect(heading()).toBe('SOP');
    expect(crumbs()).toStrictEqual(['Documents', 'Quality Management', 'Quality', 'SOP']);
    expect(screen.getByText('18 documents · 0 folders')).toBeTruthy();
  });
});

describe('filtered view — the favourites defect', () => {
  it('names the view rather than a folder it is not showing', () => {
    render({ view: 'filtered' });
    expect(heading()).toBe('Favourites');
    // The tree still lists SOP, and should — the folders exist whatever the list is showing. What
    // must not happen is the *heading* naming one, so that is what is asserted.
    expect(crumbs()).not.toContain('SOP');
  });

  it('counts only what is true of a tenant-wide list', () => {
    render({ view: 'filtered' });
    /*
     * `getByText` with a string matches an element whose whole normalised text is that string, so
     * this passing is itself the proof that nothing follows the document count. The defect rendered
     * "18 documents · 0 folders" here, pairing every favourite in the tenant with the subfolder
     * count of one folder; that string would not satisfy this assertion.
     */
    expect(screen.getByText('18 documents')).toBeTruthy();
    // Said again from the other side, so the intent survives a future edit to the line above.
    expect(screen.queryByText(/^18 documents · /)).toBeNull();
  });

  it('does not walk a folder ancestry it is not inside', () => {
    render({ view: 'filtered' });
    expect(crumbs()).toStrictEqual(['Documents', 'Favourites']);
  });
});

describe('empty view', () => {
  it('falls back to the route name when no library exists', () => {
    render({
      view: 'empty',
      folders: [],
      selectedFolderId: null,
      selectedFolderName: '',
      selectedLibraryId: null,
      total: 0,
    });
    expect(heading()).toBe('Documents');
    expect(crumbs()).toStrictEqual(['Documents']);
    expect(
      screen.getByText('Everything filed in this organisation, and where it sits.'),
    ).toBeTruthy();
  });
});
