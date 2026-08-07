'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { type ReactNode, useMemo } from 'react';

import { Badge, Card } from '@munaxa/ui';

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
    <nav aria-label={translate('documents.nav.label')} className="flex flex-col gap-4">
      <Card>
        <h2 className="text-sm font-medium opacity-70">{translate('documents.nav.libraries')}</h2>
        <ul className="mt-2 flex flex-col gap-1">
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
      </Card>

      {selectedLibraryId !== null && (
        <Card>
          <h2 className="text-sm font-medium opacity-70">{translate('documents.nav.folders')}</h2>
          <ul className="mt-2 flex flex-col gap-1">
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
        </Card>
      )}

      <Card>
        <h2 className="text-sm font-medium opacity-70">{translate('documents.nav.views')}</h2>
        <ul className="mt-2 flex flex-col gap-1">
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
      </Card>
    </nav>
  );
}
