'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { Fragment, type ReactNode, useMemo, useState } from 'react';

import { Badge, Section, Separator, Stack, Surface, TreeView } from '@munaxa/ui';
// `Library` is also a contract type in this file, and `FolderTree` is this module's own component —
// both icons are aliased so the names cannot collide.
import { FolderTree as FolderTreeIcon, Library as LibraryIcon, Star } from '@munaxa/icons';

import type { Folder, Library } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import type { DocumentsView } from './documents-view';
import { folderTrail } from './folder-trail';

/**
 * A group's heading: its glyph, then its name.
 *
 * The icon is `aria-hidden`, so the region's accessible name is the words alone — which is what it
 * was when each group was a `Panel`, and what the tests assert. `size-4` is the platform's own icon
 * size, used here as it is in the rest of this product rather than scaled to the heading.
 */
function heading(icon: ReactNode, label: string): ReactNode {
  return (
    <span className="flex items-center gap-2">
      {icon}
      {label}
    </span>
  );
}

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
    readonly title: ReactNode;
    readonly body: ReactNode;
  }[] = [
    {
      id: 'libraries',
      title: heading(
        <LibraryIcon className="size-4" aria-hidden />,
        translate('documents.nav.libraries'),
      ),
      body: (
        <ul className="-mx-2 flex flex-col gap-0.5">
          {libraries.map((library) => (
            <li key={library.id}>
              <Link
                href={
                  `/documents?libraryId=${library.id}&folderId=${library.rootFolderId}` as Route
                }
                aria-current={inFolderView && library.id === selectedLibraryId ? 'true' : undefined}
                className="block truncate rounded px-2 py-1 hover:bg-accent aria-[current]:font-medium"
              >
                {library.name}
              </Link>
            </li>
          ))}
          {libraries.length === 0 && (
            <li className="px-2 py-1 text-sm">{translate('documents.nav.noLibraries')}</li>
          )}
        </ul>
      ),
    },
    ...(selectedLibraryId === null
      ? []
      : [
          {
            id: 'folders',
            title: heading(
              <FolderTreeIcon className="size-4" aria-hidden />,
              translate('documents.nav.folders'),
            ),
            body: (
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
                className="-mx-2 gap-0.5"
                renderItem={({ node, treeItemProps, depth }) => (
                  <Link
                    href={`/documents?libraryId=${selectedLibraryId}&folderId=${node.id}` as Route}
                    /*
                     * Spread *before* `aria-current`, so the two cannot fight: `treeItemProps`
                     * carries the role, the level, the position, the tab stop and the focus
                     * handler, and the line below is this component's own claim about where the
                     * reader is. `TreeView` never emits `aria-current`, and emits `aria-selected`
                     * only when given a `selectedId` — which is why one is not passed.
                     */
                    {...treeItemProps}
                    aria-current={inFolderView && node.id === selectedFolderId ? 'true' : undefined}
                    className={`flex flex-1 items-center gap-2 truncate rounded px-2 py-1 hover:bg-accent aria-[current]:font-medium${
                      // The head of the tree, given the weight of one — so the levels below it read
                      // *from* somewhere. `depth` comes from the tree rather than from a path split
                      // here; this is typography keyed on Platform's answer, not a second hierarchy.
                      depth === 0 ? ' font-medium' : ''
                    }`}
                  >
                    <span className="flex-1 truncate">{node.name}</span>
                    {documentCounts?.[node.id] !== undefined && (
                      <Badge tone="muted">{String(documentCounts[node.id])}</Badge>
                    )}
                  </Link>
                )}
              />
            ),
          },
        ]),
    {
      id: 'views',
      title: heading(<Star className="size-4" aria-hidden />, translate('documents.nav.views')),
      body: (
        <ul className="-mx-2 flex flex-col gap-0.5">
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
              className="block rounded px-2 py-1 hover:bg-accent aria-[current]:font-medium"
            >
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
            <Link href="/documents/recent" className="block rounded px-2 py-1 hover:bg-accent">
              {translate('documents.nav.recent')}
            </Link>
          </li>
        </ul>
      ),
    },
  ];

  return (
    /*
      One surface, three groups — Slice 4, unchanged by Slice 6.

      ## What this replaces, and why

      Phase 7.2 gave each group a `Panel`, which was the right move at the time: the groups had been
      bare headings at `text-sm font-medium opacity-70` floating above their links, so each label
      read as *less* present than the list under it. `Panel` fixed that and made each group a
      labelled region.

      It also made the rail three cards. On the screen that is this product's centrepiece, the left
      half was three bordered, rounded, elevated boxes stacked in a column — the look of an
      administration sidebar rather than a document structure, and the single most card-heavy element
      in the product.

      So the chrome collapses to **one** `Surface` and the grouping moves to what the type and the
      spacing already say: a heading per group, a rule between them, and room around both. The
      groups are still three labelled regions — `Section` claims `role="region"` with
      `aria-labelledby` exactly as `Panel` did, and its heading is an `h2` at the same level — so
      nothing an assistive technology relies on has moved. Only the boxes are gone.

      The separators are `decorative` by default, which is correct: `Section` already tells a screen
      reader where each group starts, so announcing the rules as well would say it twice.
    */
    <Surface
      as="nav"
      aria-label={translate('documents.nav.label')}
      tone="card"
      bordered
      radius="lg"
      padding={4}
    >
      <Stack gap={4}>
        {groups.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 && <Separator />}
            <Section title={group.title}>{group.body}</Section>
          </Fragment>
        ))}
      </Stack>
    </Surface>
  );
}
