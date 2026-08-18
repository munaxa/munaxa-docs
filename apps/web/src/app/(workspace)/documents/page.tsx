import type { ReactNode } from 'react';

import type {
  CategoryOption,
  ConfidentialityOption,
  DepartmentOption,
  DocumentSummary,
  DocumentTypeOption,
  Folder,
  Library,
  PersonOption,
} from '@edms/contracts';
import { MetadataDataType, Permission } from '@edms/domain';

import { AdminForbidden } from '../../../features/admin-shared';
import {
  documentsView,
  suppliesDefaultFolderScope,
} from '../../../features/documents/documents-view';
import { recoverSelectedFolderChain } from '../../../features/documents/folder-recovery';
import { LibraryScreen } from '../../../features/documents/library-screen';
import { adminAccess, adminList, adminOptions, adminRead } from '../../../lib/admin/api';
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
   * Which dialogue this caller can open, which is what decides what is worth fetching.
   *
   * The two are not the same dependency and used to be treated as one. `UploadDialog` renders a
   * type picker, a category picker, a confidentiality picker and the selected type's metadata
   * fields; `BulkMetadataDialog` renders **one** control, and it is the category. So a caller who
   * may bulk-edit but not create needs the categories and nothing else — asking for the rest was
   * fetching a tenant's classification vocabulary to fill in a form that has no field for it.
   */
  const opensUpload = canCreate;
  const opensBulkMetadata = canBulk.edit;

  /**
   * Render-critical, and deliberately still fail-fast.
   *
   * Without the libraries there is no workspace to draw, and a thrown read is the honest answer —
   * the error boundary rather than a page pretending the tenant has none.
   */
  const libraries = await adminOptions<Library>('/admin/libraries', 'name');

  /**
   * The filing vocabulary, from the operational read model rather than the administrative one.
   *
   * These used to be `/admin/document-types`, `/admin/categories` and
   * `/admin/confidentiality-levels`, all behind `settings:manage` — the key that *defines* the
   * vocabulary, held by the tenant administrator alone. A document controller holds
   * `document:create` and could therefore open a dialogue it could not fill, so every one of those
   * requests answered 403 and the workspace was unopenable for it. Measured, not inferred.
   *
   * `/configuration/*` answers the question this page is actually asking — *what may I file this
   * as* — on `configuration:view`, and returns a picker's worth of each: no numbering rule, no
   * retention schedule, and no confidentiality *handling policy*. The administrative routes are
   * untouched and still require `settings:manage`.
   *
   * **`/admin/fields` is gone entirely.** It was never rendered; it existed so the server could
   * join `options` and `description` onto the type's fields. Both now travel on the type, so the
   * tenant's whole metadata catalogue — including fields attached to nothing, and the
   * tenant-authored validation patterns — is no longer a dependency of this page or of anything
   * else in Documents.
   *
   * A 403 here is still thrown rather than swallowed. The distinction this page draws is between
   * "cannot use the feature, so do not ask" and "can use the feature and was refused"; the second
   * is a real authorization problem and an empty dropdown would be the page lying about what the
   * tenant has configured.
   */
  const [types, categories, levels] = await Promise.all([
    opensUpload
      ? adminOptions<DocumentTypeOption>('/configuration/document-types', 'name', {
          // A *new* document may only be filed as a live type. The properties form asks without
          // this filter, because a document may already carry one that has since been retired.
          isActive: 'true',
        })
      : Promise.resolve({ data: [] as DocumentTypeOption[] }),
    opensUpload || opensBulkMetadata
      ? adminOptions<CategoryOption>('/configuration/categories', 'path')
      : Promise.resolve({ data: [] as CategoryOption[] }),
    opensUpload
      ? adminOptions<ConfidentialityOption>('/configuration/confidentiality-levels', 'name')
      : Promise.resolve({ data: [] as ConfidentialityOption[] }),
  ]);

  /**
   * People and departments, and only when a field actually asks for one.
   *
   * These fill the `USER` and `DEPARTMENT` branches of the metadata form and nothing else on this
   * screen — not an owner picker, which is what they looked like from the outside. A tenant whose
   * document types define no such field has no use for either list, so this asks the types it just
   * loaded rather than asking the caller's capabilities: the capability says a dialogue can open,
   * the *configuration* says whether the dialogue has a control that needs a directory.
   *
   * Which means the common case reaches `/directory` not at all, and the narrowest read in the
   * product stays unread until a tenant configures something that needs it.
   */
  const fieldTypes = new Set(
    types.data.flatMap((type) => type.fields.map((field) => field.dataType)),
  );

  const [users, departments] = await Promise.all([
    fieldTypes.has(MetadataDataType.USER)
      ? adminOptions<PersonOption>('/directory/people', 'displayName')
      : Promise.resolve({ data: [] as PersonOption[] }),
    fieldTypes.has(MetadataDataType.DEPARTMENT)
      ? adminOptions<DepartmentOption>('/directory/departments', 'path')
      : Promise.resolve({ data: [] as DepartmentOption[] }),
  ]);

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

  const folderPage =
    selectedLibraryId === null
      ? { data: [] as Folder[], meta: { page: 1, pageSize: 100, total: 0, hasMore: false } }
      : await adminList<Folder>('/admin/folders', {
          page: 1,
          // The API's maximum, and it has to be: `MAX_PAGE_SIZE` is 100 and the pagination schema
          // *rejects* anything above it. This asked for 200 from the day it was written, so every
          // request 422'd and the screen threw before rendering — a page nobody could open. Found by
          // Phase 6.6's browser suite, which is the first thing in this repository to load it.
          pageSize: 100,
          /**
           * Load-bearing, and not merely a nicety — Slice 7.
           *
           * `TreeView` builds the hierarchy from `parentId` and promotes any row whose parent is
           * missing from the list to a **root**. Whether that ever fires depends entirely on
           * whether this page is closed under the ancestor relation, and a materialised path is
           * what makes it so: an ancestor's path is a proper prefix of its descendant's, and a
           * proper prefix sorts first, so every row's parent is also in the hundred.
           *
           * Measured against the running stack on a 149-folder library: `sortBy=path` gave **0**
           * rows with a missing parent; `sortBy=name` gave **100 out of 100**, every one of which
           * `TreeView` would have announced at `aria-level="1"`. Sorting this list by anything but
           * the path turns a truncated tree into a false one.
           *
           * `page.spec.ts` fails if this changes.
           */
          sortBy: 'path',
          sortDirection: 'asc',
          search: '',
          deleted: 'live',
          filters: { libraryId: selectedLibraryId },
        });

  /**
   * The folder the URL names, even when the hundred above does not contain it — Slice 7.
   *
   * A library with more than a hundred folders returns a prefix of its structure, and a deep link
   * to anything past the cut used to produce a page headed with the *library's* name, a breadcrumb
   * collapsed to `Documents`, a rail of one row and no `aria-current` — over a document list that
   * was correctly scoped to the folder all along. `recoverSelectedFolderChain` reads that folder
   * and whatever ancestors are needed to attach it, through the same guarded endpoint, and hands
   * the rest of the screen a folder set in which the selection exists.
   *
   * `adminRead` rather than `adminGet`: a refusal here is a *result*. `adminGet` throws, which
   * would turn a page that renders today into the route's error boundary — a regression dressed as
   * a fix. The guards are untouched either way; `AclGuard` still decides, and its answer is simply
   * carried rather than raised.
   *
   * Zero requests when the folder is already held, which is every library under a hundred folders
   * and — because the page is closed under the ancestor relation — usually one request when it is
   * not.
   */
  const folders = await recoverSelectedFolderChain({
    selectedFolderId,
    libraryId: selectedLibraryId,
    folders: folderPage.data,
    read: (id) => adminRead<Folder>(`/admin/folders/${id}`),
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

  return (
    <LibraryScreen
      rows={documents.data}
      total={documents.meta.total}
      state={state}
      libraries={libraries.data}
      folders={folders.folders}
      selectedLibraryId={selectedLibraryId}
      selectedFolderId={selectedFolderId}
      /**
       * The folder's own name, or nothing — Slice 7.
       *
       * This used to read `folder?.name ?? selectedLibrary?.name ?? ''`, and that middle term was
       * the defect. A folder past the hundred-row cut is *unknown*, not *the library*, and naming
       * the library instead put a confident false statement in the one element a screen reader
       * reaches first and a reader's eye lands on. `LibraryScreen` already falls back to the
       * route's own title on an empty string, which is the honest answer to "which folder is
       * this" when the answer could not be established.
       *
       * It is now empty only when the folder genuinely could not be read — refused, absent, or in
       * another library. A folder whose *ancestors* could not be recovered still has its name
       * here, because that name was read legitimately and the heading is the one thing the page
       * can still say truthfully about it.
       */
      selectedFolderName={folders.selected?.name ?? ''}
      /**
       * What the rail is holding against what the library has.
       *
       * `meta.hasMore` was fetched and discarded from the day this page was written, so a library
       * of a thousand folders showed a hundred and claimed nothing. The rail says so now.
       * `shown` counts the folders actually handed to the tree — the page plus anything recovered
       * — rather than the page size, so the sentence describes what is on screen.
       */
      folderPage={{
        shown: folders.folders.length,
        total: folderPage.meta.total,
        hasMore: folderPage.meta.hasMore,
      }}
      // Resolved here, on the server, from the same URL the query above was built from — so the
      // header cannot describe a scope the list was never asked for.
      view={documentsView(state.filters, selectedLibraryId !== null)}
      documentTypes={types.data.map((type) => ({
        value: type.id,
        label: type.name,
        // A rename rather than a join. This used to look up each field in a `Map` built from the
        // whole tenant's metadata catalogue — a second administrative read, fetched purely to
        // recover two columns — and drop any field the catalogue page did not happen to include.
        // The type carries them now, so there is nothing to look up and nothing to silently drop.
        fields: type.fields.map((field) => ({
          id: field.metadataFieldId,
          key: field.key,
          name: field.name,
          dataType: field.dataType,
          isRequired: field.isRequired,
          options: field.options.map((option) => ({ value: option.value, label: option.label })),
          description: field.description,
          defaultValue: field.defaultValue,
        })),
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
