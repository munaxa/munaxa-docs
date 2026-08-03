import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import type { Folder, Library } from '@edms/contracts';
import { DomainError, ErrorCode, Permission } from '@edms/domain';

import {
  FOLDER_SORT_FIELDS,
  FoldersScreen,
} from '../../../../../../features/admin-libraries/folders-screen';
import { AdminForbidden } from '../../../../../../features/admin-shared';
import { adminAccess, adminGet, adminList, adminOptions } from '../../../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../../../lib/admin/list-state';

/**
 * The folder tree of one library.
 *
 * A nested route rather than a panel beside the libraries list, because the tree is the thing being
 * worked on: it has its own paging, its own search and its own shareable URL. The library is fetched
 * alongside so its name, code and root folder are known without deriving them from the folder rows.
 *
 * The list is filtered to this library by the query rather than by discarding rows here — the API's
 * `total` has to mean the number of folders in *this* library, or the pager lies.
 */
export default async function FoldersPage({
  params,
  searchParams,
}: {
  params: Promise<{ libraryId: string }>;
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.FOLDER_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const { libraryId } = await params;
  const library = await findLibrary(libraryId);
  if (library === null) {
    notFound();
  }

  const requested = readListState(await searchParams, FOLDER_SORT_FIELDS);
  const state = {
    ...requested,
    ...(requested.sortBy === null && { sortBy: 'path', sortDirection: 'asc' as const }),
    filters: { ...requested.filters, libraryId },
  };

  const [page, all] = await Promise.all([
    adminList<Folder>('/admin/folders', state),
    // A separate call for the parent picker: the page being viewed may be page four, and a parent
    // has to be choosable whether or not it happens to be on screen.
    adminOptions<Folder>('/admin/folders', 'path'),
  ]);

  return (
    <FoldersScreen
      library={library}
      rows={page.data}
      total={page.meta.total}
      state={state}
      folders={all.data
        .filter((folder) => folder.libraryId === libraryId)
        .map((folder) => ({
          value: folder.id,
          label: `${' '.repeat((folder.depth - 1) * 3)}${folder.name}`,
        }))}
    />
  );
}

async function findLibrary(id: string): Promise<Library | null> {
  try {
    return await adminGet<Library>(`/admin/libraries/${id}`);
  } catch (error) {
    // A link to a library that was removed, or one belonging to another tenant — which the API reports
    // the same way, deliberately. Both are honestly a missing page.
    if (error instanceof DomainError && error.code === ErrorCode.NOT_FOUND) {
      return null;
    }
    throw error;
  }
}
