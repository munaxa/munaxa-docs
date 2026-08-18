import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

/**
 * Every destination the rail draws, in document order — libraries, folders and views alike.
 *
 * Two roles rather than one, and that is Slice 6's doing: an explicit `role="treeitem"` on an
 * anchor **replaces** its implicit `link` role, so `getAllByRole('link')` now stops at the
 * libraries and the views and never sees a folder. The folders are still anchors, still carry an
 * `href` and still navigate — only the name ARIA gives them changed — so a query describing the
 * whole rail has to ask for both.
 *
 * Sorted by position rather than concatenated, because the assertions below are about *order*: the
 * library above its folders, the folders above the views.
 */
const anchors = (): HTMLElement[] =>
  [...screen.queryAllByRole('link'), ...screen.queryAllByRole('treeitem')].sort((a, b) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) === 0 ? 1 : -1,
  );

/** Every destination the rail currently claims the reader is on, by accessible name. */
const current = (): string[] =>
  anchors()
    .filter((anchor) => anchor.getAttribute('aria-current') !== null)
    .map((anchor) => anchor.textContent?.trim() ?? '');

/**
 * The library's own name, read from the fixture rather than repeated as a literal.
 *
 * The first draft of this file asserted "Quality Management" — the *root folder's* name — and the
 * library is called "Quality". The test failed on the difference and the component was right, which
 * is the correct way round; binding to the fixture stops the next reader having to know that.
 */
const LIBRARY = library().name;

describe('the three groups', () => {
  /*
   * Slice 4 collapsed three bordered `Panel`s into one `Surface`. The boxes were the only thing that
   * went: each group is still a labelled region, because `Section` claims `role="region"` with
   * `aria-labelledby` exactly as `Panel` did. These three assertions are what stop a future tidy-up
   * from taking the landmarks with the borders — a rail that looks grouped and is not grouped for a
   * screen reader would pass every screenshot in the suite.
   */
  it.each([
    ['Libraries', 'folder'],
    ['Folders', 'folder'],
    ['Views', 'folder'],
  ] as const)('exposes %s as a labelled region', (name, view) => {
    tree(view);
    expect(screen.getByRole('region', { name })).toBeTruthy();
  });

  it('is one navigation landmark, not three', () => {
    tree('folder');
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
  });

  it('keeps every visible link, in order, with its href', () => {
    /*
     * "Every link" used to mean every folder, because the rail drew them all. It is a tree now, so
     * the set is every *visible* one — the selection's ancestors are open and anything else is
     * behind a disclosure. That is the whole behavioural difference this slice introduces, and the
     * hrefs either side of the folders are unchanged, which is the half that must not move.
     */
    tree('folder', undefined, PROCEDURES.id);
    expect(
      anchors().map((anchor) => [anchor.textContent?.trim(), anchor.getAttribute('href')]),
    ).toStrictEqual([
      [library().name, `/documents?libraryId=${library().id}&folderId=${library().rootFolderId}`],
      ['Quality Management', `/documents?libraryId=${library().id}&folderId=${ROOT.id}`],
      ['Procedures', `/documents?libraryId=${library().id}&folderId=${PROCEDURES.id}`],
      ['Favourites', '/documents?favorite=true'],
      ['Recently opened', '/documents/recent'],
    ]);
  });

  it('drops the Folders group when no library is selected', () => {
    /*
     * Two different emptinesses, and this is the first: libraries exist but none is selected, so
     * there are no folders to show. The group goes and the rule that would have sat beside it goes
     * with it — which is why the groups are interleaved from an array rather than written out with
     * three separators, and what this asserts.
     */
    tree('empty');
    expect(screen.queryByRole('region', { name: 'Folders' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Libraries' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Views' })).toBeTruthy();
    // The library is still listed — it is selectable, just not selected.
    expect(screen.getByRole('link', { name: LIBRARY })).toBeTruthy();
  });

  it('says so when there is no library at all', () => {
    // The second emptiness: a tenant with nothing set up yet. Distinct from the case above, and the
    // only one that renders the message.
    renderWithProviders(
      <FolderTree
        libraries={[]}
        folders={[]}
        selectedLibraryId={null}
        selectedFolderId={null}
        documentCounts={{}}
        view="empty"
      />,
    );
    expect(screen.getByText('No libraries have been set up yet.')).toBeTruthy();
    // The views survive, and should: Favourites and Recently opened are answerable with no library
    // configured, so the only links left are those two.
    expect(screen.getAllByRole('link').map((link) => link.textContent?.trim())).toStrictEqual([
      'Favourites',
      'Recently opened',
    ]);
  });
});

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
    // A treeitem now rather than a link, and still an anchor with the folder's own href — the rail
    // being a tree must not have cost the reader the way out of a filtered view.
    const procedures = screen.getByRole('treeitem', { name: 'Procedures' });
    expect(procedures.getAttribute('href')).toBe(
      `/documents?libraryId=${library().id}&folderId=${PROCEDURES.id}`,
    );
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

/**
 * The folders are a Platform tree now — Slice 6.
 *
 * ## What these protect that the assertions above cannot
 *
 * Everything above would pass against the flat list this slice replaced. The rail rendered every
 * folder as a link, marked the current one, and read correctly in Arabic long before it was a tree.
 * So the tests here are about the things that only became true when `TreeView` took the hierarchy:
 * that the widget *is* a tree, that the anchor *is* the treeitem, that there is one tab stop rather
 * than one per folder, and that `parentId` decides the shape.
 *
 * Two of them are about what must **not** appear. `aria-selected` describes a selection control and
 * would arrive the moment somebody passed `selectedId`; `onActivate` would arrive the moment
 * somebody decided Enter needed help. Both are one-line mistakes that look like improvements, and
 * neither shows up in a screenshot.
 */

/*
 * Three levels down one branch, two down another.
 *
 * No folder here is called `Quality`, and that is deliberate rather than incidental: the library
 * fixture is, and a folder sharing its name would make "no library appears inside the tree" pass or
 * fail on a coincidence of strings instead of on what is in the tree.
 *
 * `Records` has a child so that it has a disclosure control — a leaf gets a spacer, and the branch
 * that must stay shut has to be one the reader could actually open.
 */
const DEEP = [
  folder({ id: 'l0', parentId: null, name: 'Quality Management', path: 'a', isRoot: true }),
  folder({ id: 'l1', parentId: 'l0', name: 'Manuals', path: 'a.b' }),
  folder({ id: 'l2', parentId: 'l1', name: 'SOP', path: 'a.b.c' }),
  // A sibling of the selection's parent — the branch that must stay shut until somebody opens it.
  folder({ id: 'other', parentId: 'l0', name: 'Records', path: 'a.z' }),
  folder({ id: 'other-child', parentId: 'other', name: 'Reports', path: 'a.z.r' }),
];

function deepTree(selectedFolderId: string | null, locale?: 'ar'): void {
  renderWithProviders(
    <FolderTree
      libraries={[library()]}
      folders={DEEP}
      selectedLibraryId={library().id}
      selectedFolderId={selectedFolderId}
      documentCounts={{}}
      view="folder"
    />,
    locale,
  );
}

/** The folder rows on screen, by accessible name, in visual order. */
const visible = (): string[] =>
  screen.getAllByRole('treeitem').map((item) => item.getAttribute('aria-label') ?? '');

/**
 * Put focus where a keyboard arriving at the tree puts it, and say which element that is.
 *
 * Not `user.tab()`. The rail's first stop is the *library* link one group above the folders, so a
 * tab from the document lands outside the tree and every arrow key afterwards is a page keystroke —
 * which is a green test asserting nothing. The tree has exactly one stop of its own (the assertion
 * above is what guarantees it), so this finds that stop and focuses it: the same element tabbing
 * would eventually reach, without depending on how many links happen to precede it.
 *
 * The return value is the point. Every caller asserts against it, so a change that moved the tab
 * stop off the tree — or off an anchor — fails here rather than passing quietly.
 */
const focusTree = (): HTMLElement => {
  const stop = screen
    .getAllByRole('treeitem')
    .find((item) => item.getAttribute('tabindex') === '0');
  if (!stop) throw new Error('the tree has no tab stop to focus');
  stop.focus();
  expect(document.activeElement).toBe(stop);
  return stop;
};

describe('the folders are a tree', () => {
  it('renders a real tree, named by the group it sits in', () => {
    deepTree('l2');
    expect(screen.getByRole('tree', { name: 'Folders' })).toBeTruthy();
  });

  it('makes each folder link the treeitem itself', () => {
    /*
     * The contract `TreeItemProps` exists for. A `role="treeitem"` wrapper around a focusable link
     * would look identical and be a different widget: two tab stops per row, and a screen reader
     * announcing the focused element with none of the level, position or expanded state that make a
     * tree a tree.
     */
    deepTree('l2');
    const sop = screen.getByRole('treeitem', { name: 'SOP' });
    expect(sop.tagName).toBe('A');
    expect(sop.getAttribute('href')).toBe(`/documents?libraryId=${library().id}&folderId=l2`);
    // Nothing nested either way round.
    expect(sop.querySelector('a')).toBeNull();
    expect(sop.querySelector('[role="treeitem"]')).toBeNull();
    expect(sop.parentElement?.getAttribute('role')).not.toBe('treeitem');
  });

  it('carries the tree ARIA the platform computes', () => {
    deepTree('l2');
    const sop = screen.getByRole('treeitem', { name: 'SOP' });
    expect(sop.getAttribute('aria-level')).toBe('3');
    expect(sop.getAttribute('aria-posinset')).toBe('1');
    expect(sop.getAttribute('aria-setsize')).toBe('1');
    // The root has two children in this fixture, so its own set is the two roots' worth of one.
    expect(screen.getByRole('treeitem', { name: 'Manuals' }).getAttribute('aria-setsize')).toBe(
      '2',
    );
  });

  it('takes its hierarchy from parentId, not from the path', () => {
    /*
     * The paths here are deliberately at odds with the parents: `Records` sits at `a.z`, one
     * separator deep, and is a child of the root exactly as `Manuals` at `a.b` is. A `path.split`
     * depth would agree with `parentId` by accident on this fixture — so the assertion that
     * distinguishes them is the *level*, which the tree computes by walking parents.
     */
    deepTree('l2');
    expect(
      screen.getByRole('treeitem', { name: 'Quality Management' }).getAttribute('aria-level'),
    ).toBe('1');
    expect(screen.getByRole('treeitem', { name: 'Manuals' }).getAttribute('aria-level')).toBe('2');
    expect(screen.getByRole('treeitem', { name: 'SOP' }).getAttribute('aria-level')).toBe('3');
    expect(screen.getByRole('treeitem', { name: 'Records' }).getAttribute('aria-level')).toBe('2');
  });

  it('gives the tree exactly one tab stop', () => {
    // The flat list gave a keyboard user one stop per folder. A tree gives one, and moves focus
    // within it with the arrow keys — which is the single largest thing this slice buys.
    deepTree('l2');
    const tabbable = screen
      .getAllByRole('treeitem')
      .filter((item) => item.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
  });

  it('never emits aria-selected', () => {
    /*
     * `TreeView` emits it only when handed a `selectedId`, and this rail must never hand one over:
     * `aria-selected` says "this is the value of this control" and `aria-current` says "this is the
     * page you are on". A navigation tree means the second. Passing `selectedId` would produce both
     * on the same element, and this is what fails if somebody does.
     */
    deepTree('l2');
    for (const item of screen.getAllByRole('treeitem')) {
      expect(item.hasAttribute('aria-selected')).toBe(false);
    }
  });

  it('keeps aria-current on the folder the reader is in', () => {
    deepTree('l2');
    expect(screen.getByRole('treeitem', { name: 'SOP' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('treeitem', { name: 'Manuals' }).hasAttribute('aria-current')).toBe(
      false,
    );
  });
});

describe('expansion', () => {
  it('opens the selected folder’s ancestors and nothing else', () => {
    /*
     * A deep link is the case this exists for: arriving at `SOP` three levels down must show it,
     * without the reader opening two branches by hand to find where they already are. `Records` is
     * the control — a sibling branch nobody asked for, which stays shut.
     */
    deepTree('l2');
    expect(visible()).toStrictEqual(['Quality Management', 'Manuals', 'SOP', 'Records']);
    // Closed rather than absent: `Records` has a child, so it announces a state, and the state is
    // shut. Its child is the row missing from the list above.
    expect(screen.getByRole('treeitem', { name: 'Records' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('does not open every branch when nothing is selected', () => {
    /*
     * `TreeView` expands everything when told nothing, which is right for a chart and wrong for a
     * rail — a hundred-folder library would arrive fully unfolded and be the flat list this slice
     * replaced. With no selection there is no trail, so only the roots show.
     */
    deepTree(null);
    expect(visible()).toStrictEqual(['Quality Management']);
  });

  it('reconstructs the same expansion on a fresh render of the same URL', () => {
    // What a refresh is: the component mounts again with the same `selectedFolderId` and derives
    // the chain from the folder rows, so nothing about expansion needs to be in the URL.
    deepTree('l2');
    const first = visible();
    cleanup();
    deepTree('l2');
    expect(visible()).toStrictEqual(first);
  });

  it('lets the reader open a branch nobody navigated to, and close it again', async () => {
    const user = userEvent.setup();
    deepTree('l2');
    expect(visible()).not.toContain('Reports');

    // The disclosure beside `Records`. It is `aria-hidden` by design — `aria-expanded` on the item
    // is the accessible control — so it is reached as a title rather than as a named button.
    await user.click(screen.getByTitle(/Records/));
    expect(screen.getByRole('treeitem', { name: 'Records' }).getAttribute('aria-expanded')).toBe(
      'true',
    );

    await user.click(screen.getByTitle(/Records/));
    expect(screen.getByRole('treeitem', { name: 'Records' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('writes nothing about expansion into any href', () => {
    // Expansion is where you can see; selection is where you are. Only the second belongs in a URL
    // somebody might share, so no folder link may carry an expansion parameter.
    deepTree('l2');
    for (const link of screen.getAllByRole('treeitem')) {
      expect(link.getAttribute('href')).not.toMatch(/expand/i);
    }
  });
});

describe('keyboard', () => {
  it('moves focus with the arrow keys rather than the tab key', async () => {
    const user = userEvent.setup();
    deepTree('l2');
    expect(focusTree().getAttribute('aria-label')).toBe('Quality Management');
    // Focus is on the tree's single stop; the arrows walk the visible items from there.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Manuals');
    await user.keyboard('{End}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Records');
    await user.keyboard('{Home}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Quality Management');
  });

  it('collapses and expands with the horizontal keys', async () => {
    const user = userEvent.setup();
    deepTree('l2');
    focusTree();
    await user.keyboard('{ArrowLeft}');
    // The root closed, so its whole subtree left the visible set.
    expect(visible()).toStrictEqual(['Quality Management']);
    await user.keyboard('{ArrowRight}');
    expect(visible()).toContain('Manuals');
  });

  it('activates the folder link itself, with no onActivate anywhere', async () => {
    /*
     * The reason `@munaxa/platform@1.6.1` exists. `TreeView` used to cancel Enter unconditionally,
     * so an anchor treeitem announced itself as a link and did nothing when a keyboard reached it —
     * and the workaround was for this component to pass `onActivate` and navigate programmatically,
     * building the same URL a second time.
     *
     * This asserts the fixed contract from the consumer's side: the keystroke is not cancelled, so
     * the browser performs the anchor's own activation. If somebody adds `onActivate` to make
     * navigation "work", `TreeView` starts cancelling Enter again and this fails.
     */
    const user = userEvent.setup();
    deepTree('l2');

    // The keystroke has to reach a folder anchor for this to mean anything, so the element under
    // test is named before it is pressed.
    const focused = focusTree();
    expect(focused.tagName).toBe('A');
    expect(focused.getAttribute('role')).toBe('treeitem');
    expect(focused.getAttribute('href')).toBe(`/documents?libraryId=${library().id}&folderId=l0`);

    /*
     * Listened for on `document`, in the bubble phase, so it runs *after* React's own handler on
     * the tree — a listener on the item itself sees the event at target, before `TreeView` has had
     * the chance to cancel it, and would report `false` however broken the tree was.
     */
    let prevented: boolean | null = null;
    const record = (event: KeyboardEvent): void => {
      prevented = event.defaultPrevented;
    };
    document.addEventListener('keydown', record);
    try {
      await user.keyboard('{Enter}');
    } finally {
      document.removeEventListener('keydown', record);
    }
    expect(prevented).toBe(false);
  });
});

describe('libraries and views stay flat', () => {
  it('puts no library or view inside the tree', () => {
    /*
     * Only the folders became a tree. A library is a sibling destination and a view is a saved
     * question; neither has a hierarchy, and wrapping them in one would announce a structure that
     * does not exist.
     */
    deepTree('l2');
    const inTree = screen.getAllByRole('treeitem').map((item) => item.getAttribute('aria-label'));
    expect(inTree).not.toContain(library().name);
    expect(inTree).not.toContain('Favourites');
    expect(inTree).not.toContain('Recently opened');
    // They are still links, and still exactly where they were.
    expect(screen.getByRole('link', { name: library().name }).getAttribute('href')).toContain(
      '/documents?libraryId=',
    );
    expect(screen.getByRole('link', { name: 'Favourites' }).getAttribute('href')).toBe(
      '/documents?favorite=true',
    );
    expect(screen.getByRole('link', { name: 'Recently opened' }).getAttribute('href')).toBe(
      '/documents/recent',
    );
  });

  it('leaves exactly one tree on the rail', () => {
    deepTree('l2');
    expect(screen.getAllByRole('tree')).toHaveLength(1);
  });
});

/**
 * What the rail is *not* showing — Slice 7.
 *
 * `/documents` fetches folders one page at a time, at the API's maximum of a hundred, and the
 * `meta.hasMore` that came back with them went straight in the bin. A library of a hundred and
 * forty-nine folders drew a hundred of them and looked complete — measured on the running stack,
 * where forty-eight of the root's own children were absent with nothing on screen to say so.
 *
 * The notice is keyed on `hasMore` rather than on whether the reader's own folder fell outside the
 * page, because the list is incomplete either way.
 */

function pagedTree(
  folderPage: { readonly shown: number; readonly total: number; readonly hasMore: boolean },
  locale?: 'ar',
): void {
  renderWithProviders(
    <FolderTree
      libraries={[library()]}
      folders={DEEP}
      selectedLibraryId={library().id}
      selectedFolderId="l2"
      documentCounts={{}}
      folderPage={folderPage}
      view="folder"
    />,
    locale,
  );
}

/**
 * The Folders region's text, which is where a notice about folders has to be to be found.
 *
 * Named by the catalogue rather than by the English literal, so the Arabic cases below read the
 * same region rather than a differently-labelled one.
 */
const foldersRegion = (name: string | RegExp = 'Folders'): string =>
  screen.getByRole('region', { name }).textContent ?? '';

describe('the rail says how much of the library it is holding', () => {
  it('names both numbers when the page is not all of them', () => {
    // Both, because only one of them is a fact about the screen: what the reader can see and reach,
    // against what exists. A bare "some folders are hidden" would say neither.
    pagedTree({ shown: 100, total: 149, hasMore: true });
    expect(foldersRegion()).toContain('Showing 100 of 149 folders');
  });

  it('says nothing at all when the page is the whole library', () => {
    pagedTree({ shown: 5, total: 5, hasMore: false });
    expect(foldersRegion()).not.toMatch(/showing/i);
  });

  it('says nothing when the component was told nothing about paging', () => {
    // The prop is optional, and absent means "no claim" — the only honest default for a fixture
    // that has nothing to say about how its folders were fetched.
    deepTree('l2');
    expect(foldersRegion()).not.toMatch(/showing/i);
  });

  it('makes no incompleteness claim once recovery has caught the rail up', () => {
    /*
     * The one arithmetic that would read as a contradiction. `hasMore` describes the *initial*
     * page, and recovering a chain can bring a rail of a hundred up to a library's whole
     * hundred-and-one — at which point "101 of 101 folders" is not an incompleteness notice.
     */
    pagedTree({ shown: 101, total: 101, hasMore: true });
    expect(foldersRegion()).not.toMatch(/showing/i);
  });

  it('sits inside the Folders region rather than loose on the rail', () => {
    // So it is reached with the thing it describes, by a screen reader walking regions as much as
    // by an eye.
    pagedTree({ shown: 100, total: 149, hasMore: true });
    const region = screen.getByRole('region', { name: 'Folders' });
    expect(region.textContent).toContain('Showing 100 of 149 folders');
    // And it is text, not a control: there is nothing yet to press, and a dead button would be a
    // worse claim than a sentence.
    expect(within(region).queryByRole('button', { name: /showing/i })).toBeNull();
  });

  it('is a translated string, not an assembled one', () => {
    /*
     * Arabic selects between six plural categories, so a sentence built by concatenating a number
     * onto a translated fragment is a sentence no translator ever saw. The catalogue owns the whole
     * message; this asserts the Arabic form appears rather than the English one leaking through.
     */
    pagedTree({ shown: 100, total: 149, hasMore: true }, 'ar');
    const text = foldersRegion('المجلدات');
    expect(text).not.toMatch(/showing/i);
    expect(text).toContain('مجلد');
    expect(text).toContain('100');
    expect(text).toContain('149');
  });

  it('agrees with the dual, which carries no numeral', () => {
    // The catalogue's own rule for standalone counted nouns — `صفان`, `مجلدان` — followed rather
    // than re-decided here. Two folders in the library, one on the rail.
    pagedTree({ shown: 1, total: 2, hasMore: true }, 'ar');
    expect(foldersRegion('المجلدات')).toContain('مجلدين');
  });
});

/**
 * The Slice 6 contract, frozen.
 *
 * Every line below is a one-line change somebody could make in good faith, and each one would
 * quietly undo something the tree was rebuilt to get. None of them shows up in a screenshot, and
 * none of them fails a render test, so they are asserted against the rendered ARIA instead.
 */
describe('the accepted TreeView contract', () => {
  it('leaves Enter to the anchor, so no onActivate is needed or wanted', async () => {
    // Passing `onActivate` makes `@munaxa/platform` cancel Enter again — the defect `1.6.1` fixed.
    const user = userEvent.setup();
    deepTree('l2');
    const focused = focusTree();
    expect(focused.tagName).toBe('A');

    let prevented: boolean | null = null;
    const record = (event: KeyboardEvent): void => {
      prevented = event.defaultPrevented;
    };
    document.addEventListener('keydown', record);
    try {
      await user.keyboard('{Enter}');
    } finally {
      document.removeEventListener('keydown', record);
    }
    expect(prevented).toBe(false);
  });

  it('emits aria-current and never aria-selected, on every row', () => {
    // Passing `selectedId` would produce both on one element: `aria-selected` describes a selection
    // control's value, `aria-current` describes the page you are on. This rail means the second.
    deepTree('l2');
    for (const item of screen.getAllByRole('treeitem')) {
      expect(item.hasAttribute('aria-selected')).toBe(false);
    }
    expect(screen.getByRole('treeitem', { name: 'SOP' }).getAttribute('aria-current')).toBe('true');
  });

  it('keeps expansion controlled, so a hundred folders do not arrive unfolded', () => {
    // Dropping the `expanded` prop returns `TreeView` to its uncontrolled default, which expands
    // everything — the flat list this replaced.
    deepTree('l2');
    expect(visible()).toStrictEqual(['Quality Management', 'Manuals', 'SOP', 'Records']);
    expect(visible()).not.toContain('Reports');
  });

  it('takes depth from the tree, never from the folder’s own path or depth column', () => {
    /*
     * The rail used to indent by `path.split('.').length - 1`. `Folder` still carries both `path`
     * and a server-side `depth`, and either would be an easy thing to reach for again — so the
     * fixture sets `depth` to a value that disagrees with the parent chain, and the assertion is
     * that `aria-level` follows the chain.
     */
    renderWithProviders(
      <FolderTree
        libraries={[library()]}
        folders={[
          folder({ id: 'r', parentId: null, name: 'Root', path: 'a', depth: 9, isRoot: true }),
          folder({ id: 'k', parentId: 'r', name: 'Kid', path: 'a.b.c.d.e', depth: 1 }),
        ]}
        selectedLibraryId={library().id}
        selectedFolderId="k"
        documentCounts={{}}
        view="folder"
      />,
    );
    expect(screen.getByRole('treeitem', { name: 'Root' }).getAttribute('aria-level')).toBe('1');
    expect(screen.getByRole('treeitem', { name: 'Kid' }).getAttribute('aria-level')).toBe('2');
  });

  it('renders one tree, and the folders are the only thing in it', () => {
    // A Docs-local hierarchy — a nested `<ul>`, a second `role="tree"`, libraries folded in —
    // fails here.
    deepTree('l2');
    expect(screen.getAllByRole('tree')).toHaveLength(1);
    const inTree = screen.getAllByRole('treeitem').map((item) => item.getAttribute('aria-label'));
    expect(inTree).not.toContain(library().name);
    expect(inTree).not.toContain('Favourites');
    for (const item of screen.getAllByRole('treeitem')) {
      expect(item.querySelector('ul')).toBeNull();
    }
  });
});
