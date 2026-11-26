'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { Fragment, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Badge, Overline, Separator, TreeView } from '@munaxa/ui';
// `Folder` is also a contract type in this file — the icon is aliased so the names cannot collide.
import { Clock, Folder as FolderIcon, Library as LibraryIcon, Star } from '@munaxa/icons';

import type { Folder, Library } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import type { DocumentsView } from './documents-view';
import { folderTrail } from './folder-trail';
import { readExpanded, writeExpanded, writeLastLocation } from './last-location';

/**
 * One labelled group of the rail — Docs v2.
 *
 * Small capitals above the group rather than a display-size heading with a glyph: the rail is a
 * column of mostly-text rows, and the approved design lets the rows carry the weight. It is still a
 * named region with an `h2`, so a screen reader walking regions or headings finds the same three
 * groups it always did, by the same names.
 */
function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5">
      <Overline as="h2" id={id} className="ps-2">
        {title}
      </Overline>
      {children}
    </section>
  );
}

/**
 * Where a row in the rail is the current place: the accent surface and a brand bar on its leading
 * edge, the same treatment the workspace rail gives the current page. Keyed on `aria-current`, so
 * the style cannot disagree with what assistive technology is told.
 */
const RAIL_ROW =
  'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current]:bg-accent aria-[current]:font-semibold aria-[current]:text-foreground aria-[current]:shadow-[inset_2px_0_0_var(--primary)] rtl:aria-[current]:shadow-[inset_-2px_0_0_var(--primary)]';

/**
 * One row of the libraries tree: a library or a folder, as `TreeView` needs it.
 *
 * Libraries and folders share one tree now (asked for 26 Nov 2026: "the library as a tree, not a
 * dropdown"). A library is a top-level node and the selected library's folders hang beneath it, so
 * the reader sees where they are as one hierarchy instead of a menu above a separate folder list.
 *
 * `folderId` is the folder the row opens. For a library that is its root folder: the root folder is
 * the library's top, it is created with it and named after it by default, so drawing it as a second
 * node under the library would show the same name twice. The library row *is* the root.
 */
type RailNode = {
  readonly id: string;
  readonly label: string;
  readonly parentId: string | null;
  readonly kind: 'library' | 'folder';
  readonly libraryId: string;
  readonly folderId: string;
};

/** The node id a library takes in the tree. Prefixed so it cannot collide with a folder id. */
const libraryNodeId = (libraryId: string): string => `library:${libraryId}`;

/**
 * Library and folder navigation — the left-hand side of the workspace.
 *
 * ## Libraries and folders are one tree, and the tree is Platform's
 *
 * `TreeView` is the APG `tree` pattern, and it owns everything structural: the hierarchy from
 * `parentId`, the depth, the indentation, the disclosure controls, one tab stop with roving focus,
 * the arrow keys, Home and End, typeahead, and the direction mirroring that makes the horizontal
 * keys mean "outward" and "inward" rather than left and right. None of that is reimplemented here.
 *
 * Every library is a top-level node. The page reads the folders of the selected library only, so
 * that library is the one with children; any other library is a single row whose link opens it,
 * and once open its folders appear beneath it. Fetching every library's folders on every page load
 * would cost one request per library for branches the reader mostly never opens.
 *
 * ## What stays here
 *
 * The navigation. Every row is still a real `<Link>` to the URL it always had, and the link *is*
 * the treeitem — `treeItemProps` goes onto the anchor rather than onto a wrapper around it, which
 * is what keeps one tab stop per row and lets a middle click, a context menu and the status bar
 * all behave as they do for any other link.
 *
 * **No `onActivate`.** `TreeView` cancels Enter only when something is listening for it
 * (`@munaxa/platform@1.6.1`), so an anchor keeps its own activation — Enter follows the href
 * through Next's router exactly as a click does.
 *
 * **No `selectedId`.** That would emit `aria-selected`, which describes a selection *control* — a
 * listbox's value. This rail is navigation: `aria-current` is the right answer, it is this
 * component's to set, and the two must not both appear on one item.
 */
export function FolderTree({
  libraries,
  folders,
  selectedLibraryId,
  selectedFolderId,
  documentCounts,
  folderPage,
  view,
}: {
  readonly libraries: readonly Library[];
  /** Every folder of the selected library. Empty when no library is selected. */
  readonly folders: readonly Folder[];
  readonly selectedLibraryId: string | null;
  readonly selectedFolderId: string | null;
  /** Documents directly in each folder, where the server counted them. */
  readonly documentCounts?: Readonly<Record<string, number>> | undefined;
  /**
   * How much of the library's structure this is — Slice 7.
   *
   * Optional, so the component still renders from a fixture that has nothing to say about paging —
   * an absent value means "no claim", which is the only honest default.
   */
  readonly folderPage?:
    | {
        readonly shown: number;
        readonly total: number;
        readonly hasMore: boolean;
      }
    | undefined;
  /**
   * Which question the page is answering — the same value the header reads.
   *
   * On a filtered view `selectedFolderId` is the library's root, so the rail must not mark it (or
   * the library) as where the reader is. Passed in rather than re-derived from the filters here.
   */
  readonly view: DocumentsView;
}): ReactNode {
  const translate = useTranslate();

  /** On a filtered view the list belongs to no folder and no library, so nothing is current. */
  const inFolderView = view === 'folder';

  const selectedLibrary = libraries.find((library) => library.id === selectedLibraryId) ?? null;

  /**
   * The selected library's root folder, as the folder list knows it.
   *
   * The flag first and the library's pointer second: the two agree on a real tenant, and reading
   * the flag keeps a folder list that disagrees with its library from drawing the root twice.
   */
  const rootFolderId =
    folders.find((folder) => folder.isRoot)?.id ?? selectedLibrary?.rootFolderId ?? null;

  /** A folder id as the tree knows it: the root folder is its library's node. */
  const nodeIdOf = useMemo(
    () =>
      (folderId: string): string =>
        selectedLibrary !== null && folderId === rootFolderId
          ? libraryNodeId(selectedLibrary.id)
          : folderId,
    [selectedLibrary, rootFolderId],
  );

  /** The adapter, and the whole of it: libraries at the top, the selected library's folders below. */
  const nodes = useMemo<RailNode[]>(
    () => [
      ...libraries.map((library) => ({
        id: libraryNodeId(library.id),
        label: library.name,
        parentId: null,
        kind: 'library' as const,
        libraryId: library.id,
        folderId:
          library.id === selectedLibrary?.id && rootFolderId !== null
            ? rootFolderId
            : library.rootFolderId,
      })),
      ...folders
        .filter((folder) => folder.id !== rootFolderId)
        .map((folder) => ({
          id: folder.id,
          label: folder.name,
          parentId: folder.parentId === null ? null : nodeIdOf(folder.parentId),
          kind: 'folder' as const,
          libraryId: selectedLibraryId ?? folder.libraryId,
          folderId: folder.id,
        })),
    ],
    [libraries, folders, selectedLibrary, selectedLibraryId, rootFolderId, nodeIdOf],
  );

  /**
   * The chain from the library down to the folder the URL names — the selected library's node
   * first, then every folder on the way.
   *
   * `folderTrail` already walks it for the breadcrumb, so this is the same answer read twice rather
   * than a second traversal written to a different set of rules. Derived on *every* view: on a
   * filtered view the selection is the root, so this opens the library and keeps its folders on
   * screen — they are how a reader leaves a filtered view.
   */
  const ancestors = useMemo(
    () => [
      ...(selectedLibrary === null ? [] : [libraryNodeId(selectedLibrary.id)]),
      ...folderTrail(folders, selectedFolderId).map((folder) => nodeIdOf(folder.id)),
    ],
    [folders, selectedFolderId, selectedLibrary, nodeIdOf],
  );

  /**
   * Which branches are open — ancestors of the selection, plus whatever the reader opened.
   *
   * `TreeView` expands everything when told nothing, which is wrong for a rail. Seeded from the
   * ancestors and then owned by the reader. Nothing about expansion is written to the URL: it is
   * where you can see, not where you are.
   */
  const [expanded, setExpanded] = useState<readonly string[]>(ancestors);

  /*
   * Re-seed when the selection moves. Navigating re-renders this component rather than remounting
   * it, so a union with the new ancestors keeps a deep link followed within the session visible and
   * a branch the reader opened by hand open.
   */
  const trailKey = ancestors.join('>');
  const [seenTrail, setSeenTrail] = useState(trailKey);
  if (trailKey !== seenTrail) {
    setSeenTrail(trailKey);
    setExpanded((open) => [...new Set([...open, ...ancestors])]);
  }

  /*
   * Coming back to Documents — asked for 26 Nov 2026.
   *
   * Leaving for another tab unmounts the rail, so the branches the reader opened by hand were lost
   * and `/documents` reopened the first library. Two small memories fix both halves: the folder the
   * reader is in goes into a cookie the page reads on a bare `/documents`, and the open branches go
   * into this browser's storage and are merged back in once on mount. Read in an effect, not during
   * render, so the server's markup and the first client render still agree.
   */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const remembered = readExpanded();
    if (remembered.length > 0) {
      setExpanded((open) => [...new Set([...open, ...remembered])]);
    }
  }, []);
  useEffect(() => {
    if (restored.current) writeExpanded(expanded);
  }, [expanded]);
  useEffect(() => {
    if (inFolderView && selectedLibraryId !== null && selectedFolderId !== null) {
      writeLastLocation({ libraryId: selectedLibraryId, folderId: selectedFolderId });
    }
  }, [inFolderView, selectedLibraryId, selectedFolderId]);

  const groups: readonly {
    readonly id: string;
    readonly title: string;
    readonly body: ReactNode;
  }[] = [
    {
      id: 'libraries',
      title: translate('documents.nav.libraries'),
      body:
        libraries.length === 0 ? (
          <p className="px-2 text-sm">{translate('documents.nav.noLibraries')}</p>
        ) : (
          <>
            <TreeView<RailNode>
              nodes={nodes}
              expanded={[...expanded]}
              onExpandedChange={setExpanded}
              aria-label={translate('documents.nav.libraries')}
              className="gap-px"
              renderItem={({ node, treeItemProps, hasChildren, toggle }) => {
                const isLibrary = node.kind === 'library';
                const Icon = isLibrary ? LibraryIcon : FolderIcon;
                const count = documentCounts?.[node.folderId];
                return (
                  <Link
                    href={
                      `/documents?libraryId=${node.libraryId}&folderId=${node.folderId}` as Route
                    }
                    /*
                     * Spread *before* `aria-current`, so the two cannot fight: `treeItemProps`
                     * carries the role, the level, the position, the tab stop and the focus handler;
                     * the line below is this component's own claim about where the reader is.
                     */
                    {...treeItemProps}
                    aria-current={
                      inFolderView &&
                      node.libraryId === selectedLibraryId &&
                      node.folderId === selectedFolderId
                        ? 'true'
                        : undefined
                    }
                    className={`${RAIL_ROW} min-w-0 flex-1${isLibrary ? ' font-semibold' : ''}`}
                    /*
                     * Double-click opens or closes a branch. The single click still navigates; the
                     * chevron and the arrow keys remain the ways to expand without navigating.
                     */
                    {...(hasChildren && {
                      onDoubleClick: (event: { preventDefault: () => void }) => {
                        event.preventDefault();
                        toggle();
                      },
                    })}
                  >
                    <Icon className="size-3.5 shrink-0 opacity-75" aria-hidden />
                    <span className="flex-1 truncate">{node.label}</span>
                    {count !== undefined && <Badge tone="muted">{String(count)}</Badge>}
                  </Link>
                );
              }}
            />
            {/*
              What the tree is not showing — Slice 7. Rendered on `hasMore`, the server's word for
              "the first page is not all of them"; the `shown < total` guard keeps a recovered chain
              from reading "101 of 101" as an incompleteness notice.
            */}
            {folderPage !== undefined &&
              folderPage.hasMore &&
              folderPage.shown < folderPage.total && (
                <p className="text-muted-foreground px-2 text-xs">
                  {translate('documents.nav.foldersTruncated', {
                    count: folderPage.total,
                    shown: folderPage.shown,
                  })}
                </p>
              )}
          </>
        ),
    },
    {
      id: 'views',
      title: translate('documents.nav.views'),
      body: (
        <ul className="flex flex-col gap-px">
          <li>
            <Link
              href="/documents?favorite=true"
              /*
               * `filtered` is favourites, and only favourites — `documents-view.ts` says so and its
               * own comment records that a second de-scoping filter would have to name itself
               * before this line could stay honest. Until then this is the entry that view means.
               *
               * The same `aria-current` the folders above use, rather than a colour or a weight:
               * the two groups already expose "you are here" this way, and a third mechanism for
               * the same fact would be one screen readers do not hear.
               */
              aria-current={view === 'filtered' ? 'true' : undefined}
              className={RAIL_ROW}
            >
              <Star className="size-3.5 shrink-0 opacity-75" aria-hidden />
              {translate('documents.nav.favorites')}
            </Link>
          </li>
          <li>
            {/*
                No `aria-current`, and not an oversight: `/documents/recent` is its own route with its
                own screen, and that screen does not render this rail. There is no state in which this
                link is on screen *and* current, so marking it would be describing a page this
                component never appears on.
              */}
            <Link href="/documents/recent" className={RAIL_ROW}>
              <Clock className="size-3.5 shrink-0 opacity-75" aria-hidden />
              {translate('documents.nav.recent')}
            </Link>
          </li>
        </ul>
      ),
    },
  ];

  return (
    /*
      The rail — Docs v2.

      A full-height column at the start of the screen, on a half-card wash (painted by the library's
      frame, so the rail stays a plain list wherever else it is used) and separated
      from the list by one border, rather than a card floating in the page's padding. Slice 4 had
      already collapsed three cards into one surface; the approved design takes the last step and
      makes the rail part of the frame. The groups (Libraries, Views) are named regions with `h2`s —
      see `Group` — and a rule separates them.
    */
    <nav aria-label={translate('documents.nav.label')} className="flex flex-col gap-4.5 px-3 py-4">
      {groups.map((group) => (
        <Fragment key={group.id}>
          {group.id === 'views' && <Separator className="mx-2 w-auto" />}
          <Group title={group.title}>{group.body}</Group>
        </Fragment>
      ))}
    </nav>
  );
}
