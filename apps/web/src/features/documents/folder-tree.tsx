'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { Fragment, type ReactNode, useId, useMemo, useState } from 'react';

import {
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Overline,
  Separator,
  TreeView,
} from '@munaxa/ui';
// `Folder` is also a contract type in this file — the icon is aliased so the names cannot collide.
import { ChevronDown, Clock, Folder as FolderIcon, Star } from '@munaxa/icons';

import type { Folder, Library } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import type { DocumentsView } from './documents-view';
import { folderTrail } from './folder-trail';

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
 * A folder as `TreeView` needs it: the row it already had, plus the name under the key the tree
 * reads.
 *
 * Spread rather than mapped into a second model, so `renderItem` still receives the `Folder` this
 * product's code already knows — `childCount`, `isRoot`, `libraryName` and the rest are all still
 * there if a later slice needs them.
 */
type FolderNode = Folder & { readonly label: string };

/**
 * Library and folder navigation — the left-hand side of the workspace.
 *
 * ## The folders are a tree, and the tree is Platform's
 *
 * They used to be a flat list that *looked* nested: the rows were sorted by materialised path, the
 * depth was `path.split('.').length - 1`, and the indentation was a `paddingInlineStart` computed
 * from it. That drew a hierarchy without being one. Nothing collapsed, every folder in the page was
 * always on screen, and a keyboard user tabbed through all of them one stop at a time — a hundred
 * tab stops in a library with a hundred folders, none of them announcing a level, a position or a
 * parent.
 *
 * `TreeView` is the APG `tree` pattern, and it owns everything structural now: the hierarchy from
 * `parentId`, the depth, the indentation, the disclosure controls, one tab stop with roving focus,
 * the arrow keys, Home and End, typeahead, and the direction mirroring that makes the horizontal
 * keys mean "outward" and "inward" rather than left and right. None of that is reimplemented here;
 * Slice 5 extracted it into the platform precisely so it would not have to be.
 *
 * ## What stays here
 *
 * The navigation. Every folder is still a real `<Link>` to the URL it always had, and the link
 * *is* the treeitem — `treeItemProps` goes onto the anchor rather than onto a wrapper around it,
 * which is what keeps one tab stop per row and lets a middle click, a context menu and the status
 * bar all behave as they do for any other link.
 *
 * **No `onActivate`.** `TreeView` cancels Enter only when something is listening for it
 * (`@munaxa/platform@1.6.1`), so an anchor keeps its own activation — Enter follows the href
 * through Next's router exactly as a click does. Passing a handler here would mean building the
 * same URL a second time and navigating by a different mechanism than the click, which is two
 * definitions of one destination.
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
   * The rail draws the folders it was handed and, until this existed, said nothing about the ones
   * it was not: `/documents` fetches a page of a hundred and the API's `meta.hasMore` went straight
   * in the bin. A library of a thousand folders showed a hundred and looked complete.
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
   * The rail took none of this, so it answered "which folder is current" from `selectedFolderId`
   * alone. That identifier is the library's root on a filtered view, which is how the page came to
   * say "Favourites" at the top while the rail marked the root folder as where the reader was.
   *
   * Passed in rather than re-derived from the filters here. Two components inferring the same thing
   * from the same URL is exactly how the Slice 2 defect happened, one layer up.
   */
  readonly view: DocumentsView;
}): ReactNode {
  const translate = useTranslate();

  /**
   * Whether a folder is the reader's current location at all.
   *
   * On a filtered view the list belongs to no folder, so nothing in the two panels above may claim
   * to be current — not the folder, and not the library either, because "you are in Quality
   * Management" is the same false statement one level up.
   */
  const inFolderView = view === 'folder';

  /** The adapter, and the whole of it. `parentId` travels untouched; the tree reads it. */
  const nodes = useMemo<FolderNode[]>(
    () => folders.map((folder) => ({ ...folder, label: folder.name })),
    [folders],
  );

  /**
   * The chain from the library's root down to the folder the URL names.
   *
   * `folderTrail` already walks it for the breadcrumb, so this is the same answer read twice rather
   * than a second traversal written to a different set of rules — and its cycle guard and its
   * "stop where the chain breaks" behaviour come along for free. A library beyond the API's
   * hundred-folder page can genuinely be missing an ancestor; a partial trail expands what it can
   * establish, which is the same graceful degradation the breadcrumb already shows.
   *
   * Derived on *every* view rather than only in `folder`, and deliberately: `selectedFolderId` is
   * the library's root on a filtered view, so this opens the root and keeps its children on screen.
   * They are how a reader leaves a filtered view, and hiding them would strand them there.
   */
  const ancestors = useMemo(
    () => folderTrail(folders, selectedFolderId).map((folder) => folder.id),
    [folders, selectedFolderId],
  );

  /**
   * Which branches are open — ancestors of the selection, plus whatever the reader opened.
   *
   * `TreeView` expands everything when told nothing, which is right for a chart and wrong for a
   * rail: a library of a hundred folders would arrive fully unfolded, the disclosure controls would
   * all point down, and the tree would be the flat list it replaced. So the expansion is controlled
   * here — but only the *set*; the walking, the toggling and the keyboard remain the tree's.
   *
   * Seeded from the ancestors and then owned by the reader, so a deep link arrives with its folder
   * visible and a refresh reconstructs the same chain from the URL alone. Nothing about expansion
   * is written to the URL: it is where you can see, not where you are, and a shared link should
   * carry the second without the first.
   */
  const [expanded, setExpanded] = useState<readonly string[]>(ancestors);

  /*
   * Re-seed when the selection moves.
   *
   * Navigating between folders re-renders this component rather than remounting it, so
   * `useState`'s initial value is read once and never again — a deep link followed *within* the
   * session would otherwise arrive with its ancestors shut. Adjusting state during render is
   * React's own answer to "a prop changed and some state derives from it", and it is a union rather
   * than a replacement so a branch the reader opened by hand survives the move.
   */
  const trailKey = ancestors.join('>');
  const [seenTrail, setSeenTrail] = useState(trailKey);
  if (trailKey !== seenTrail) {
    setSeenTrail(trailKey);
    setExpanded((open) => [...new Set([...open, ...ancestors])]);
  }

  /**
   * The rail's three groups, assembled before rendering so the rules between them can be placed.
   *
   * A list rather than three literals in the markup because the middle group is conditional: with no
   * library there are no folders, and a separator either side of a group that is not there is two
   * rules with nothing between them. Interleaving from an array makes "a rule between each pair"
   * true by construction instead of by three hand-written conditions.
   */
  const groups: readonly {
    readonly id: string;
    readonly title: string;
    readonly body: ReactNode;
  }[] = [
    {
      id: 'libraries',
      title: translate('documents.nav.library'),
      body:
        libraries.length === 0 ? (
          <p className="px-2 text-sm">{translate('documents.nav.noLibraries')}</p>
        ) : (
          <LibraryPicker
            libraries={libraries}
            selectedLibraryId={selectedLibraryId}
            current={inFolderView}
          />
        ),
    },
    ...(selectedLibraryId === null
      ? []
      : [
          {
            id: 'folders',
            title: translate('documents.nav.folders'),
            body: (
              <>
                <TreeView<FolderNode>
                  nodes={nodes}
                  expanded={[...expanded]}
                  onExpandedChange={setExpanded}
                  /*
                   * The tree's own accessible name, reusing the group's word rather than inventing a
                   * string. `Section` names the region; this names the widget inside it, and a screen
                   * reader announcing "Folders, tree" is exactly what the rail means.
                   */
                  aria-label={translate('documents.nav.folders')}
                  className="gap-px"
                  renderItem={({ node, treeItemProps, depth, hasChildren, toggle }) => (
                    <Link
                      href={
                        `/documents?libraryId=${selectedLibraryId}&folderId=${node.id}` as Route
                      }
                      /*
                       * Spread *before* `aria-current`, so the two cannot fight: `treeItemProps`
                       * carries the role, the level, the position, the tab stop and the focus
                       * handler, and the line below is this component's own claim about where the
                       * reader is. `TreeView` never emits `aria-current`, and emits `aria-selected`
                       * only when given a `selectedId` — which is why one is not passed.
                       */
                      {...treeItemProps}
                      aria-current={
                        inFolderView && node.id === selectedFolderId ? 'true' : undefined
                      }
                      className={`${RAIL_ROW} min-w-0 flex-1${
                        // The head of the tree, given the weight of one — so the levels below it read
                        // *from* somewhere. `depth` comes from the tree rather than from a path split
                        // here; this is typography keyed on Platform's answer, not a second hierarchy.
                        depth === 0 ? ' font-semibold' : ''
                      }`}
                      /*
                       * Double-click opens or closes a branch — Docs v2, asked for in review. The
                       * single click still navigates; the browser fires it first, so a double-click
                       * on a folder lands on that folder *and* flips it, which is what both halves of
                       * the gesture mean. The chevron and the arrow keys remain the ways to expand
                       * without navigating.
                       */
                      {...(hasChildren && {
                        onDoubleClick: (event: { preventDefault: () => void }) => {
                          event.preventDefault();
                          toggle();
                        },
                      })}
                    >
                      <FolderIcon className="size-3.5 shrink-0 opacity-75" aria-hidden />
                      <span className="flex-1 truncate">{node.name}</span>
                      {documentCounts?.[node.id] !== undefined && (
                        <Badge tone="muted">{String(documentCounts[node.id])}</Badge>
                      )}
                    </Link>
                  )}
                />
                {/*
                  What the rail is not showing.

                  Rendered on `hasMore` — the server's word for "the first page is not all of
                  them" — and not on whether the reader's own folder happened to fall outside it,
                  because the list is incomplete either way. The extra `shown < total` guard is for
                  the one arithmetic that would otherwise read as a contradiction: recovering a
                  chain can bring a rail of a hundred up to the library's whole hundred-and-one, and
                  "101 of 101" is not an incompleteness notice.

                  A plain sentence rather than a control, because there is nothing yet to press:
                  loading the rest is a lazy-loading problem with its own design, and a button that
                  did nothing would be a worse claim than the sentence. It sits inside the
                  `Folders` region, so it is reached with the thing it describes.
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
        ]),
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
      makes the rail part of the frame. The three groups are still three named regions with `h2`s —
      see `Group` — so nothing an assistive technology relies on has moved.

      The separator stays between Folders and Views only: Library is a single control, and a rule
      under one dropdown separates it from nothing.
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

/**
 * The library picker — Docs v2's dropdown, built so every library is still a link.
 *
 * The design draws a select. A native `<select>` that navigates on change is a context change on
 * input (WCAG 3.2.2), and it would have turned five links a reader could middle-click into a widget
 * they cannot. So it is a menu button that *looks* like the select, whose items are the same links
 * to the same URLs the rail always had — the platform's own recipe for navigation in a menu
 * (`DropdownMenuItem asChild` around a link).
 *
 * The trigger's name says what it is and what is chosen; the current library carries
 * `aria-current` inside the menu as it did in the list.
 */
function LibraryPicker({
  libraries,
  selectedLibraryId,
  current,
}: {
  readonly libraries: readonly Library[];
  readonly selectedLibraryId: string | null;
  readonly current: boolean;
}): ReactNode {
  const translate = useTranslate();
  const selected = libraries.find((library) => library.id === selectedLibraryId) ?? null;
  const name = selected?.name ?? translate('documents.nav.libraries');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={translate('documents.nav.libraryPicker', { name })}
        className="border-border bg-card hover:border-primary-200 focus-visible:ring-ring flex h-[34px] w-full items-center gap-2 rounded-lg border px-2.5 text-start text-[13px] font-medium focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="flex-1 truncate">{name}</span>
        <ChevronDown className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        {libraries.map((library) => (
          <DropdownMenuItem key={library.id} asChild>
            <Link
              href={`/documents?libraryId=${library.id}&folderId=${library.rootFolderId}` as Route}
              aria-current={current && library.id === selectedLibraryId ? 'true' : undefined}
              className="aria-[current]:font-semibold"
            >
              {library.name}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
