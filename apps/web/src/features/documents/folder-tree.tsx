'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { type ReactNode, useMemo } from 'react';

import { Badge, Panel } from '@munaxa/ui';
// `Library` is also a contract type in this file, and `FolderTree` is this module's own component —
// both icons are aliased so the names cannot collide.
import { FolderTree as FolderTreeIcon, Library as LibraryIcon, Star } from '@munaxa/icons';

import type { Folder, Library } from '@edms/contracts';

import { useTranslate } from '../../app/providers';

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
}: {
  readonly libraries: readonly Library[];
  /** Every folder of the selected library, in path order. Empty when no library is selected. */
  readonly folders: readonly Folder[];
  readonly selectedLibraryId: string | null;
  readonly selectedFolderId: string | null;
  /** Documents directly in each folder, where the server counted them. */
  readonly documentCounts?: Readonly<Record<string, number>> | undefined;
}): ReactNode {
  const translate = useTranslate();

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

  return (
    /*
      Three `Panel`s, not three `Card`s with hand-written headings — Phase 7.2.

      This rail had the record page's problem in miniature: each group announced itself with a
      `text-sm font-medium opacity-70` heading floating above a card, so the label read as *less*
      present than the links beneath it and nothing tied the two together. `Panel` gives each group
      the same header treatment every section of the record page now has — the display face at one
      size, with a rule under it — and makes each one a labelled region, which is what a navigation
      rail of three independent groups should have been all along.
    */
    <nav aria-label={translate('documents.nav.label')} className="flex flex-col gap-3">
      <Panel
        title={
          <span className="flex items-center gap-2">
            <LibraryIcon className="size-4 opacity-70" aria-hidden />
            {translate('documents.nav.libraries')}
          </span>
        }
      >
        <ul className="-mx-2 flex flex-col gap-0.5">
          {libraries.map((library) => (
            <li key={library.id}>
              <Link
                href={
                  `/documents?libraryId=${library.id}&folderId=${library.rootFolderId}` as Route
                }
                aria-current={library.id === selectedLibraryId ? 'true' : undefined}
                className="block truncate rounded px-2 py-1 hover:bg-accent aria-[current]:font-medium"
              >
                {library.name}
              </Link>
            </li>
          ))}
          {libraries.length === 0 && (
            <li className="px-2 py-1 text-sm opacity-70">
              {translate('documents.nav.noLibraries')}
            </li>
          )}
        </ul>
      </Panel>

      {selectedLibraryId !== null && (
        <Panel
          title={
            <span className="flex items-center gap-2">
              <FolderTreeIcon className="size-4 opacity-70" aria-hidden />
              {translate('documents.nav.folders')}
            </span>
          }
        >
          <ul className="-mx-2 flex flex-col gap-0.5">
            {nodes.map(({ folder, indent }) => (
              <li key={folder.id}>
                <Link
                  href={`/documents?libraryId=${selectedLibraryId}&folderId=${folder.id}` as Route}
                  aria-current={folder.id === selectedFolderId ? 'true' : undefined}
                  className="flex items-center gap-2 truncate rounded px-2 py-1 hover:bg-accent aria-[current]:font-medium"
                  style={{ paddingInlineStart: `${String(0.5 + indent * 0.75)}rem` }}
                >
                  <span className="flex-1 truncate">{folder.name}</span>
                  {documentCounts?.[folder.id] !== undefined && (
                    <Badge tone="muted">{String(documentCounts[folder.id])}</Badge>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel
        title={
          <span className="flex items-center gap-2">
            <Star className="size-4 opacity-70" aria-hidden />
            {translate('documents.nav.views')}
          </span>
        }
      >
        <ul className="-mx-2 flex flex-col gap-0.5">
          <li>
            <Link
              href="/documents?favorite=true"
              className="block rounded px-2 py-1 hover:bg-accent"
            >
              {translate('documents.nav.favorites')}
            </Link>
          </li>
          <li>
            <Link href="/documents/recent" className="block rounded px-2 py-1 hover:bg-accent">
              {translate('documents.nav.recent')}
            </Link>
          </li>
        </ul>
      </Panel>
    </nav>
  );
}
