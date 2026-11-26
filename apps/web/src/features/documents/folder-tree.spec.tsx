import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../test/a11y';
import { folder, library } from '../../test/fixtures';
import { FolderTree } from './folder-tree';
import { EXPANDED_STORAGE_KEY, LAST_LOCATION_COOKIE } from './last-location';

/**
 * The libraries tree — asked for 26 Nov 2026: "in documents I want the library as a tree, not a
 * drop-down list".
 *
 * Libraries are the top level of one `TreeView`, and the selected library's folders hang beneath
 * it. The root folder is not drawn as a second row: it *is* the library's row. Other libraries are
 * single rows whose link opens them, because the page reads only the selected library's folders.
 *
 * The assertions are about the **accessible** tree rather than the styling: the role, the level,
 * `aria-expanded` and `aria-current` are what a screen reader announces and what the styles key on.
 */

const QUALITY = library();
const HR = library({
  id: '019489f0-0000-7000-8000-000000000302',
  code: 'HR',
  name: 'Human Resources',
  rootFolderId: '019489f0-0000-7000-8000-000000000210',
});

const DEEP = [
  folder({ id: 'l0', parentId: null, name: 'Quality Management', path: 'a', isRoot: true }),
  folder({ id: 'l1', parentId: 'l0', name: 'Manuals', path: 'a.b' }),
  folder({ id: 'l2', parentId: 'l1', name: 'SOP', path: 'a.b.c' }),
  folder({ id: 'other', parentId: 'l0', name: 'Records', path: 'a.z' }),
  folder({ id: 'other-child', parentId: 'other', name: 'Reports', path: 'a.z.r' }),
];

const href = (libraryId: string, folderId: string): string =>
  `/documents?libraryId=${libraryId}&folderId=${folderId}`;

function rail({
  selectedFolderId = 'l2',
  selectedLibraryId = QUALITY.id,
  view = 'folder',
  folders = DEEP,
  libraries = [QUALITY, HR],
  folderPage,
  locale,
}: {
  readonly selectedFolderId?: string | null;
  readonly selectedLibraryId?: string | null;
  readonly view?: 'folder' | 'filtered' | 'empty';
  readonly folders?: ReturnType<typeof folder>[];
  readonly libraries?: ReturnType<typeof library>[];
  readonly folderPage?: {
    readonly shown: number;
    readonly total: number;
    readonly hasMore: boolean;
  };
  readonly locale?: 'ar';
} = {}): void {
  renderWithProviders(
    <FolderTree
      libraries={libraries}
      folders={selectedLibraryId === null ? [] : folders}
      selectedLibraryId={selectedLibraryId}
      selectedFolderId={selectedLibraryId === null ? null : selectedFolderId}
      documentCounts={{}}
      folderPage={folderPage}
      view={view}
    />,
    locale,
  );
}

/** The rows on screen, in order, by accessible name. */
const visible = (): string[] =>
  screen.getAllByRole('treeitem').map((item) => item.getAttribute('aria-label') ?? '');

const item = (name: string): HTMLElement => screen.getByRole('treeitem', { name });

/** Every destination the rail claims the reader is on. */
const current = (): string[] =>
  [...screen.queryAllByRole('treeitem'), ...screen.queryAllByRole('link')]
    .filter((anchor) => anchor.getAttribute('aria-current') !== null)
    .map((anchor) => anchor.getAttribute('aria-label') ?? anchor.textContent?.trim() ?? '');

const focusTree = (): HTMLElement => {
  const stop = screen
    .getAllByRole('treeitem')
    .find((candidate) => candidate.getAttribute('tabindex') === '0');
  if (!stop) throw new Error('the tree has no tab stop to focus');
  stop.focus();
  expect(document.activeElement).toBe(stop);
  return stop;
};

const clearMemory = (): void => {
  window.localStorage.clear();
  document.cookie = `${LAST_LOCATION_COOKIE}=; Path=/; Max-Age=0`;
};
beforeEach(clearMemory);
afterEach(clearMemory);

describe('the rail', () => {
  it('has two labelled regions, Libraries and Views, in one navigation landmark', () => {
    rail();
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Libraries' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Views' })).toBeTruthy();
  });

  it('no longer draws a library drop-down or a separate Folders group', () => {
    rail();
    expect(screen.queryByRole('button', { name: /Choose a library/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Folders' })).toBeNull();
    expect(screen.getAllByRole('tree')).toHaveLength(1);
  });

  it('keeps the views as plain links outside the tree', () => {
    rail();
    expect(visible()).not.toContain('Favourites');
    expect(screen.getByRole('link', { name: 'Favourites' }).getAttribute('href')).toBe(
      '/documents?favorite=true',
    );
    expect(screen.getByRole('link', { name: 'Recently opened' }).getAttribute('href')).toBe(
      '/documents/recent',
    );
  });

  it('says so when there is no library at all', () => {
    rail({ libraries: [], selectedLibraryId: null });
    expect(screen.getByText('No libraries have been set up yet.')).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.getByRole('region', { name: 'Views' })).toBeTruthy();
  });
});

describe('libraries and folders are one tree', () => {
  it('is a real tree, named Libraries', () => {
    rail();
    expect(screen.getByRole('tree', { name: 'Libraries' })).toBeTruthy();
  });

  it('puts every library at the top level, each linking to its top folder', () => {
    rail();
    expect(item(QUALITY.name).getAttribute('aria-level')).toBe('1');
    expect(item(HR.name).getAttribute('aria-level')).toBe('1');
    expect(item(QUALITY.name).getAttribute('href')).toBe(href(QUALITY.id, 'l0'));
    expect(item(HR.name).getAttribute('href')).toBe(href(HR.id, HR.rootFolderId));
  });

  it('hangs the selected library’s folders beneath it, from parentId', () => {
    rail();
    expect(item('Manuals').getAttribute('aria-level')).toBe('2');
    expect(item('SOP').getAttribute('aria-level')).toBe('3');
    expect(item('Records').getAttribute('aria-level')).toBe('2');
    expect(item('SOP').getAttribute('href')).toBe(href(QUALITY.id, 'l2'));
  });

  it('draws the root folder as the library row, not as a second row with the same place', () => {
    rail();
    expect(visible()).not.toContain('Quality Management');
  });

  it('shows the selected library open and the others closed and childless', () => {
    rail();
    expect(item(QUALITY.name).getAttribute('aria-expanded')).toBe('true');
    expect(item(HR.name).hasAttribute('aria-expanded')).toBe(false);
  });

  it('lists the libraries, all closed, when none is selected', () => {
    rail({ selectedLibraryId: null, view: 'empty' });
    expect(visible()).toStrictEqual([QUALITY.name, HR.name]);
    expect(current()).toStrictEqual([]);
  });

  it('makes each row link the treeitem itself, with one tab stop and no aria-selected', () => {
    rail();
    const sop = item('SOP');
    expect(sop.tagName).toBe('A');
    expect(sop.querySelector('a')).toBeNull();
    const stops = screen
      .getAllByRole('treeitem')
      .filter((row) => row.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    for (const row of screen.getAllByRole('treeitem')) {
      expect(row.hasAttribute('aria-selected')).toBe(false);
    }
  });

  it('takes depth from the tree, never from the folder’s own path or depth column', () => {
    rail({
      folders: [
        folder({ id: 'r', parentId: null, name: 'Root', path: 'a', depth: 9, isRoot: true }),
        folder({ id: 'k', parentId: 'r', name: 'Kid', path: 'a.b.c.d.e', depth: 1 }),
      ],
      selectedFolderId: 'k',
    });
    expect(item('Kid').getAttribute('aria-level')).toBe('2');
  });
});

describe('where the reader is', () => {
  it('marks the folder the reader is in, and nothing else', () => {
    rail();
    expect(current()).toStrictEqual(['SOP']);
  });

  it('marks the library when the reader is at its top folder', () => {
    rail({ selectedFolderId: 'l0' });
    expect(current()).toStrictEqual([QUALITY.name]);
  });

  it('marks nothing in the tree on a filtered view, and marks Favourites instead', () => {
    rail({ selectedFolderId: 'l0', view: 'filtered' });
    expect(current()).toStrictEqual(['Favourites']);
  });
});

describe('expansion', () => {
  it('opens the selection’s ancestors and nothing else', () => {
    rail();
    expect(visible()).toStrictEqual([QUALITY.name, 'Manuals', 'SOP', 'Records', HR.name]);
    expect(item('Records').getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the library’s first level on screen when only the library is known', () => {
    rail({ selectedFolderId: null });
    expect(visible()).toStrictEqual([QUALITY.name, 'Manuals', 'Records', HR.name]);
  });

  it('writes nothing about expansion into any href', () => {
    rail();
    for (const row of screen.getAllByRole('treeitem')) {
      expect(row.getAttribute('href')).not.toMatch(/expand/i);
    }
  });
});

describe('keyboard', () => {
  it('moves with the arrow keys, Home and End', async () => {
    const user = userEvent.setup();
    rail();
    focusTree();
    await user.keyboard('{Home}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(QUALITY.name);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Manuals');
    await user.keyboard('{End}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(HR.name);
  });

  it('collapses and expands a library with the horizontal keys', async () => {
    const user = userEvent.setup();
    rail();
    focusTree();
    await user.keyboard('{Home}{ArrowLeft}');
    expect(visible()).toStrictEqual([QUALITY.name, HR.name]);
    await user.keyboard('{ArrowRight}');
    expect(visible()).toContain('Manuals');
  });

  it('leaves Enter to the anchor', async () => {
    const user = userEvent.setup();
    rail();
    focusTree();
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

describe('coming back to Documents', () => {
  const UUID_FOLDERS = [
    folder({
      id: '019489f0-0000-7000-8000-000000000200',
      parentId: null,
      name: 'Top',
      isRoot: true,
    }),
    folder({
      id: '019489f0-0000-7000-8000-000000000201',
      parentId: '019489f0-0000-7000-8000-000000000200',
      name: 'Procedures',
    }),
  ];

  it('remembers the folder the reader is in', () => {
    rail({ folders: UUID_FOLDERS, selectedFolderId: '019489f0-0000-7000-8000-000000000201' });
    expect(document.cookie).toContain(
      `${LAST_LOCATION_COOKIE}=${QUALITY.id}.019489f0-0000-7000-8000-000000000201`,
    );
  });

  it('remembers nothing on a filtered view', () => {
    rail({
      folders: UUID_FOLDERS,
      selectedFolderId: '019489f0-0000-7000-8000-000000000200',
      view: 'filtered',
    });
    expect(document.cookie).not.toContain(LAST_LOCATION_COOKIE);
  });

  it('reopens the branches the reader had opened before leaving', () => {
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(['other']));
    rail();
    expect(visible()).toContain('Reports');
  });

  it('remembers a branch the reader opens', async () => {
    const user = userEvent.setup();
    rail();
    focusTree();
    await user.keyboard('{End}{ArrowUp}{ArrowRight}');
    expect(visible()).toContain('Reports');
    cleanup();
    rail();
    expect(visible()).toContain('Reports');
  });

  it('ignores a remembered value that is not a list of names', () => {
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, '{"not":"a list"}');
    rail();
    expect(visible()).toStrictEqual([QUALITY.name, 'Manuals', 'SOP', 'Records', HR.name]);
  });
});

describe('the rail says how much of the library it is holding', () => {
  const region = (name = 'Libraries'): string =>
    screen.getByRole('region', { name }).textContent ?? '';

  it('names both numbers when the page is not all of them', () => {
    rail({ folderPage: { shown: 100, total: 149, hasMore: true } });
    expect(region()).toContain('Showing 100 of 149 folders');
    expect(
      within(screen.getByRole('region', { name: 'Libraries' })).queryByRole('button', {
        name: /showing/i,
      }),
    ).toBeNull();
  });

  it('says nothing when the page is the whole library, or nothing was said about paging', () => {
    rail({ folderPage: { shown: 5, total: 5, hasMore: false } });
    expect(region()).not.toMatch(/showing/i);
    cleanup();
    rail();
    expect(region()).not.toMatch(/showing/i);
  });

  it('makes no incompleteness claim once recovery has caught the rail up', () => {
    rail({ folderPage: { shown: 101, total: 101, hasMore: true } });
    expect(region()).not.toMatch(/showing/i);
  });

  it('is a translated string in Arabic', () => {
    rail({ folderPage: { shown: 100, total: 149, hasMore: true }, locale: 'ar' });
    const text = region('المكتبات');
    expect(text).not.toMatch(/showing/i);
    expect(text).toContain('100');
    expect(text).toContain('149');
  });
});
