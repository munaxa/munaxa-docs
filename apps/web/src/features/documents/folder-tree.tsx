'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { Fragment, type ReactNode, useMemo } from 'react';

import { Badge, Section, Separator, Stack, Surface } from '@munaxa/ui';
// `Library` is also a contract type in this file, and `FolderTree` is this module's own component —
// both icons are aliased so the names cannot collide.
import { FolderTree as FolderTreeIcon, Library as LibraryIcon, Star } from '@munaxa/icons';

import type { Folder, Library } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import type { DocumentsView } from './documents-view';

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
 * Library and folder navigation — the left-hand side of the workspace.
 *
 * The tree is rendered from the folders' **materialised paths**, not from a recursive fetch. One
 * flat list arrives, sorted by path, and nesting is derived from it: a folder's depth is how many
 * separators its path has, and its children are the folders whose path starts with its own. That is
 * the same arithmetic the ACL resolver walks (ADR-0014), and doing it here means a library of two
 * hundred folders is one request rather than one per expanded node.
 *
 * **Every destination is a link, and every link is the URL.** Selecting a folder navigates rather
 * than setting state, so a filtered view of a folder is shareable, survives a reload and works with
 * the browser's own back button — which is the rule the frontend architecture states and the one a
 * tree is most often built in violation of.
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
  /** Every folder of the selected library, in path order. Empty when no library is selected. */
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

  const nodes = useMemo(
    () =>
      [...folders]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((folder) => ({
          folder,
          // The root sits at depth zero however deep its path is, so the tree is indented relative
          // to what is shown rather than to the database's numbering.
          indent: folder.path.split('.').length - 1,
        })),
    [folders],
  );

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
              <ul className="-mx-2 flex flex-col gap-0.5">
                {nodes.map(({ folder, indent }) => (
                  <li key={folder.id}>
                    <Link
                      href={
                        `/documents?libraryId=${selectedLibraryId}&folderId=${folder.id}` as Route
                      }
                      aria-current={
                        inFolderView && folder.id === selectedFolderId ? 'true' : undefined
                      }
                      className={`flex items-center gap-2 truncate rounded px-2 py-1 hover:bg-accent aria-[current]:font-medium${
                        // The head of the tree, given the weight of one — so the indentation below
                        // it reads *from* somewhere. Typography rather than a connector line: the
                        // rule this slice works under is that whitespace, type and indentation
                        // carry the hierarchy, and a guide-line system is the tree component's job
                        // rather than this composition's.
                        indent === 0 ? ' font-medium' : ''
                      }`}
                      /*
                       * A whole spacing step per level, not three quarters of one.
                       *
                       * Twelve pixels was not enough to order two rows whose names are different
                       * lengths — a short name at depth two and a long one at depth one read as
                       * the same level. Sixteen is the scale's own step and separates three levels
                       * legibly.
                       *
                       * `paddingInlineStart`, so the indentation grows away from the reading edge
                       * in both directions rather than always to the left.
                       */
                      style={{ paddingInlineStart: `${String(0.5 + indent)}rem` }}
                    >
                      <span className="flex-1 truncate">{folder.name}</span>
                      {documentCounts?.[folder.id] !== undefined && (
                        <Badge tone="muted">{String(documentCounts[folder.id])}</Badge>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
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
      One surface, three groups — Slice 4.

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
