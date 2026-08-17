import type { ReactNode } from 'react';

import type {
  Category,
  ConfidentialityLevel,
  Department,
  DocumentSummary,
  DocumentType,
  Folder,
  Library,
  MetadataField,
  User,
} from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../features/admin-shared';
import {
  documentsView,
  suppliesDefaultFolderScope,
} from '../../../features/documents/documents-view';
import { LibraryScreen } from '../../../features/documents/library-screen';
import { adminAccess, adminList, adminOptions } from '../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../lib/admin/list-state';
import { DOCUMENT_FILTER_KEYS, DOCUMENT_SORT_FIELDS } from '../../../lib/admin/list-keys';

/**
 * The document library.
 *
 * Everything it needs is fetched here, on the server, before the screen renders — which is what
 * makes the first paint the right page rather than an empty grid that fills in
 * (`16-frontend-architecture.md` §3). The URL is the only input: which library, which folder,
 * whether to include subfolders, which filters and which page.
 *
 * The configuration lists — types, categories, levels, people, departments — are fetched alongside
 * because the upload dialogue needs them the moment it opens, and fetching them on open would put a
 * spinner between "drop a file" and "say what it is".
 *
 * **Alongside, but only for somebody who can open a dialogue.** Those lists are administrative
 * resources, and a caller who may read documents but not configure the tenant is refused all six.
 * Sharing one `Promise.all` with the libraries turned that refusal into the route's error boundary,
 * so the workspace was unopenable for the auditor and for the document controller alike. The
 * capability decides the dependency now; see the note above the two groups below.
 */
export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.DOCUMENT_VIEW);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(await searchParams, DOCUMENT_SORT_FIELDS, DOCUMENT_FILTER_KEYS);

  /**
   * What this caller may actually do, resolved once and used twice — for the dialogues below, and
   * for whether their configuration is worth fetching at all.
   *
   * Read from `access.permissions`, which is the answer the API already gave; nothing here computes
   * a second permission model.
   */
  const canCreate = access.permissions.includes(Permission.DOCUMENT_CREATE);
  const canBulk = {
    edit: access.permissions.includes(Permission.DOCUMENT_EDIT),
    restore: access.permissions.includes(Permission.DOCUMENT_RESTORE),
    download: access.permissions.includes(Permission.DOCUMENT_DOWNLOAD),
  };

  /**
   * Whether either dialogue this page can open is reachable for this caller.
   *
   * The six lists below exist for `UploadDialog` and `BulkMetadataDialog` and for nothing else —
   * not the tree, not the breadcrumb, not the header, not the counts, not the list, not the
   * toolbar. `fields` does not even reach the browser; it assembles `documentTypes[].fields` for
   * the metadata section inside the upload dialogue.
   */
  const needsDialogData = canCreate || canBulk.edit;

  /**
   * Two groups, because a failure means two different things.
   *
   * **Render-critical**, and deliberately still fail-fast: without the libraries there is no
   * workspace to draw, and a thrown read is the honest answer — the error boundary rather than a
   * page pretending the tenant has none.
   *
   * **Dialogue-only**, and requested only when a dialogue can be opened. Every one of the six is an
   * administrative resource: `/admin/document-types`, `/admin/categories`,
   * `/admin/confidentiality-levels` and `/admin/fields` require `settings:manage`, `/admin/users`
   * requires `user:manage`, `/admin/departments` requires `org:manage`. A reader holds none of
   * them, so all six answered 403 — and because they sat in the same `Promise.all` as the
   * libraries, one refusal took the whole workspace down with it. The document controller failed
   * the same way, which is why this was never a purely auditor-shaped problem.
   *
   * The fix is the dependency, not the authorization. Nothing here is granted, widened or
   * softened: a caller who cannot open the dialogue simply stops asking for the data that fills it,
   * which is strictly less access than before. A caller who *can* open it asks exactly as it always
   * did, and a 403 they receive is still thrown rather than swallowed — see the note on the
   * document controller in `docs/reports`.
   */
  const libraries = await adminOptions<Library>('/admin/libraries', 'name');

  const [types, categories, levels, users, departments, fields] = needsDialogData
    ? await Promise.all([
        adminOptions<DocumentType>('/admin/document-types', 'name'),
        adminOptions<Category>('/admin/categories', 'path'),
        adminOptions<ConfidentialityLevel>('/admin/confidentiality-levels', 'name'),
        adminOptions<User>('/admin/users', 'displayName'),
        adminOptions<Department>('/admin/departments', 'path'),
        adminOptions<MetadataField>('/admin/fields', 'name'),
      ])
    : [
        { data: [] as DocumentType[] },
        { data: [] as Category[] },
        { data: [] as ConfidentialityLevel[] },
        { data: [] as User[] },
        { data: [] as Department[] },
        { data: [] as MetadataField[] },
      ];

  // The library the URL names, or the first one. A landing page that showed nothing until somebody
  // picked a library would be a landing page nobody's first visit works on.
  const selectedLibraryId =
    typeof state.filters.libraryId === 'string'
      ? state.filters.libraryId
      : (libraries.data[0]?.id ?? null);
  const selectedLibrary =
    libraries.data.find((library) => library.id === selectedLibraryId) ?? null;
  const selectedFolderId =
    typeof state.filters.folderId === 'string'
      ? state.filters.folderId
      : typeof state.filters.underFolderId === 'string'
        ? state.filters.underFolderId
        : (selectedLibrary?.rootFolderId ?? null);

  const folders =
    selectedLibraryId === null
      ? { data: [] as Folder[] }
      : await adminList<Folder>('/admin/folders', {
          page: 1,
          // The API's maximum, and it has to be: `MAX_PAGE_SIZE` is 100 and the pagination schema
          // *rejects* anything above it. This asked for 200 from the day it was written, so every
          // request 422'd and the screen threw before rendering — a page nobody could open. Found by
          // Phase 6.6's browser suite, which is the first thing in this repository to load it.
          pageSize: 100,
          sortBy: 'path',
          sortDirection: 'asc',
          search: '',
          deleted: 'live',
          filters: { libraryId: selectedLibraryId },
        });

  const documents = await adminList<DocumentSummary>('/documents', {
    ...state,
    filters: {
      ...state.filters,
      // The URL may say only which library; a list with no folder filter at all is the whole
      // tenant, which is not what a library page means.
      //
      // The condition is `suppliesDefaultFolderScope` rather than the three comparisons that used
      // to be written here. Identical filters — the same booleans, extracted and named — but now
      // the screen's header reads the *same* predicate to decide whether it may name a folder.
      // Written twice, the two drifted, and the favourites view ended up counting one folder's
      // subfolders beside a tenant-wide document total.
      ...(suppliesDefaultFolderScope(state.filters) &&
        selectedFolderId !== null && { folderId: selectedFolderId }),
    },
  });

  const fieldsById = new Map(fields.data.map((field) => [field.id, field]));

  return (
    <LibraryScreen
      rows={documents.data}
      total={documents.meta.total}
      state={state}
      libraries={libraries.data}
      folders={folders.data}
      selectedLibraryId={selectedLibraryId}
      selectedFolderId={selectedFolderId}
      selectedFolderName={
        folders.data.find((folder) => folder.id === selectedFolderId)?.name ??
        selectedLibrary?.name ??
        ''
      }
      // Resolved here, on the server, from the same URL the query above was built from — so the
      // header cannot describe a scope the list was never asked for.
      view={documentsView(state.filters, selectedLibraryId !== null)}
      documentTypes={types.data
        .filter((type) => type.isActive)
        .map((type) => ({
          value: type.id,
          label: type.name,
          // Assembled here rather than in the client, because the field definitions and the type's
          // own list of them are two server reads and joining them on the client would be a third
          // round trip for something the page already has.
          fields: type.fields.flatMap((entry) => {
            const definition = fieldsById.get(entry.metadataFieldId);
            return definition === undefined
              ? []
              : [
                  {
                    id: definition.id,
                    key: definition.key,
                    name: definition.name,
                    dataType: definition.dataType,
                    isRequired: entry.isRequired,
                    options: definition.options.map((option) => ({
                      value: option.value,
                      label: option.label,
                    })),
                    description: definition.description,
                    defaultValue: entry.defaultValue,
                  },
                ];
          }),
        }))}
      categories={categories.data.map((category) => ({
        value: category.id,
        label: category.name,
      }))}
      confidentialityLevels={levels.data.map((level) => ({ value: level.id, label: level.name }))}
      users={users.data.map((user) => ({ value: user.id, label: user.displayName }))}
      departments={departments.data.map((department) => ({
        value: department.id,
        label: department.name,
      }))}
      canCreate={canCreate}
      // 16 §5's *"bulk actions gated by `capabilities`"*, resolved on the server from the caller's
      // own grants. The tenant-wide floor only: whether they reach a *particular* document is the
      // API's per-object answer, and the result dialogue is where they learn it.
      //
      // Computed above rather than here, because the same two answers now decide whether the
      // dialogues' configuration is fetched at all. One resolution, two uses.
      canBulk={canBulk}
    />
  );
}
