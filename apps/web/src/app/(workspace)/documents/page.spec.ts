import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MetadataDataType, Permission, type PermissionKey } from '@edms/domain';

import { MAXIMUM_FOLDER_DEPTH } from '../../../features/documents/folder-recovery';

/**
 * What the Documents page asks the API for, and what it does not.
 *
 * ## Why the assertion is the request set rather than the render
 *
 * The page fetched nine things in one `Promise.all`. Six of them — document types, categories,
 * confidentiality levels, users, departments and metadata fields — were administrative resources
 * behind `settings:manage`, `user:manage` and `org:manage`, and they exist for exactly two
 * dialogues: `UploadDialog` and `BulkMetadataDialog`.
 *
 * A caller who cannot open either dialogue holds none of those permissions, so all six answered
 * 403 — and sharing a `Promise.all` with the libraries meant one refusal threw the whole server
 * render and the reader got the route's error boundary instead of the workspace. Measured against
 * the running stack, that was true of the auditor *and* the document controller; only a tenant
 * administrator could open the page at all.
 *
 * Two phases fixed it, and both are asserted here because a regression in either restores the same
 * dead page. The first made the *dependency* conditional: do not ask for what you cannot use. The
 * second replaced the administrative reads with the operational ones — `/configuration/*` on
 * `configuration:view` and `/directory/*` on `directory:view` — so a caller who *can* use them is
 * no longer refused.
 *
 * A render assertion cannot see any of this: the page draws identically whether it asked for six
 * datasets it then ignored, asked the wrong endpoint, or never asked at all. These tests read the
 * mock's call list, which is the thing that actually changed.
 */

/**
 * Hoisted because `vi.mock`'s factory is lifted above everything else in the file, and typed
 * because the assertions read `mock.calls` — an untyped `vi.fn()` makes every recorded argument
 * `any`, which is the one thing a test about *which paths were requested* cannot afford.
 */
const { adminAccess, adminOptions, adminList, adminRead } = vi.hoisted(() => ({
  adminAccess:
    vi.fn<
      (
        permission: PermissionKey,
      ) => Promise<{ readonly granted: boolean; readonly permissions: readonly PermissionKey[] }>
    >(),
  adminOptions:
    vi.fn<
      (
        path: string,
        sortBy: string,
        filters?: Readonly<Record<string, string>>,
      ) => Promise<{ data: unknown[] }>
    >(),
  adminList:
    vi.fn<
      (
        path: string,
        state: unknown,
      ) => Promise<{ data: unknown[]; meta: { total: number; hasMore: boolean } }>
    >(),
  /**
   * Slice 7's single-folder read, and it is mocked here for the same reason the others are: the
   * assertions in this file are about *which requests happen*, and a recovery that quietly issued
   * one on every page load would be invisible to a render test and expensive in production.
   */
  adminRead:
    vi.fn<(path: string) => Promise<{ ok: true; value: unknown } | { ok: false; code: string }>>(),
}));

vi.mock('../../../lib/admin/api', () => ({ adminAccess, adminOptions, adminList, adminRead }));

// Neither is rendered — the page is called as a function and the element it returns is inspected
// rather than mounted — but mocking them keeps the client component and the platform out of a node
// test entirely.
vi.mock('../../../features/documents/library-screen', () => ({ LibraryScreen: () => null }));
vi.mock('../../../features/admin-shared', () => ({ AdminForbidden: () => null }));

const { default: DocumentsPage } = await import('./page');

/**
 * The administrative endpoints this page must never touch again.
 *
 * Named individually rather than as a prefix, because the point is not "no `/admin`" — the
 * libraries and folders are still administered reads and still required. It is these six, each of
 * which returns more than a picker needs and demands a management key to get it.
 */
const ADMINISTRATIVE = [
  '/admin/document-types',
  '/admin/categories',
  '/admin/confidentiality-levels',
  '/admin/users',
  '/admin/departments',
  '/admin/fields',
];

/** A document type carrying whichever metadata field data types the test needs. */
function typeWith(...dataTypes: readonly string[]) {
  return {
    id: 'type-1',
    code: 'SOP',
    name: 'Procedure',
    isActive: true,
    defaultConfidentialityId: 'conf-1',
    fields: dataTypes.map((dataType, index) => ({
      metadataFieldId: `field-${String(index)}`,
      key: `f${String(index)}`,
      name: `Field ${String(index)}`,
      dataType,
      isRequired: false,
      sortOrder: index,
      defaultValue: null,
      options: [],
      description: null,
    })),
  };
}

/**
 * The library's root folder, present in the fetched page.
 *
 * The fixture used to be an empty folder list, which is a state the product cannot produce: a
 * library is created with a root, and `sortBy: 'path'` puts it first. It matters now that Slice 7
 * reads a folder the page does not contain — an empty page would make every one of these tests
 * exercise the recovery path and hide the fact that the common one issues no request at all.
 */
const ROOT_FOLDER = {
  id: 'root-1',
  libraryId: 'lib-1',
  libraryName: 'Quality',
  parentId: null,
  name: 'Quality Management',
  path: 'root-1',
  depth: 1,
  isRoot: true,
  childCount: 0,
};

/**
 * What the page handed the screen.
 *
 * Slice 7's visible fix is a *value* this page resolves and passes down — which folder the heading
 * names — so the request-set tests can also assert the one conclusion those requests were made to
 * reach. The page is called as a function and returns an element; nothing mounts it, so the props
 * are read off the element rather than recorded by a rendering mock.
 */
let handedOver: Record<string, unknown> = {};

function propsOf(element: unknown): Record<string, unknown> {
  const props = (element as { props?: unknown } | null)?.props;
  return typeof props === 'object' && props !== null ? (props as Record<string, unknown>) : {};
}

/** Renders the page for a caller holding exactly these grants, and reports what it asked for. */
async function requestsFor(
  permissions: readonly PermissionKey[],
  documentTypes: readonly unknown[] = [typeWith()],
  searchParams: Readonly<Record<string, string>> = {},
  /** Folders reachable by identifier. Anything not named here answers as `NOT_FOUND`. */
  readable: Readonly<Record<string, unknown>> = {},
): Promise<readonly string[]> {
  adminAccess.mockResolvedValue({ granted: true, permissions });
  adminOptions.mockImplementation((path: string) =>
    Promise.resolve({
      data:
        path === '/admin/libraries'
          ? [{ id: 'lib-1', name: 'Quality', rootFolderId: 'root-1' }]
          : path === '/configuration/document-types'
            ? [...documentTypes]
            : [],
    }),
  );
  adminList.mockImplementation((path: string) =>
    Promise.resolve(
      path === '/admin/folders'
        ? { data: [ROOT_FOLDER], meta: { total: 1, hasMore: false } }
        : { data: [], meta: { total: 0, hasMore: false } },
    ),
  );
  adminRead.mockImplementation((path: string) => {
    const found = readable[path.replace('/admin/folders/', '')];
    return Promise.resolve(
      found === undefined
        ? { ok: false as const, code: 'NOT_FOUND' }
        : { ok: true as const, value: found },
    );
  });

  handedOver = propsOf(await DocumentsPage({ searchParams: Promise.resolve(searchParams) }));

  return [
    ...adminOptions.mock.calls.map(([path]) => path),
    ...adminList.mock.calls.map(([path]) => path),
    // Counted with the rest, so "asks for exactly three things" is a statement about every request
    // the page makes rather than about the two functions it happened to be written against.
    ...adminRead.mock.calls.map(([path]) => path),
  ];
}

/** The seeded roles, by the tenant-wide grants that decide this page's behaviour. */
const AUDITOR = [Permission.DOCUMENT_VIEW, Permission.LIBRARY_VIEW] as const;
const CONTROLLER = [...AUDITOR, Permission.DOCUMENT_CREATE, Permission.DOCUMENT_EDIT] as const;

beforeEach(() => {
  adminAccess.mockReset();
  adminOptions.mockReset();
  adminList.mockReset();
  adminRead.mockReset();
  handedOver = {};
});

describe('render-critical data is always requested', () => {
  it.each([
    ['auditor', AUDITOR],
    ['controller', CONTROLLER],
  ])('asks for the libraries, the folders and the documents as %s', async (_name, permissions) => {
    const requested = await requestsFor([...permissions]);
    expect(requested).toContain('/admin/libraries');
    expect(requested).toContain('/admin/folders');
    expect(requested).toContain('/documents');
  });
});

describe('the administrative endpoints are no longer a dependency of anybody', () => {
  it.each([
    ['auditor', AUDITOR],
    ['controller', CONTROLLER],
  ])('is not requested for %s', async (_name, permissions) => {
    /*
     * The security half of this phase, in one assertion. Each of these returns more than the screen
     * consumes — the numbering rule and retention schedule on a type, the confidentiality *handling
     * policy*, an operations view of every account, a headcount per organisational unit — and each
     * demands a management key to get it. The narrow read models exist so none of them is ever
     * asked for again.
     */
    const requested = await requestsFor([...permissions], [typeWith(MetadataDataType.USER)]);
    for (const path of ADMINISTRATIVE) {
      expect(
        requested,
        `${path} must not be a dependency of the documents workspace`,
      ).not.toContain(path);
    }
  });

  it('never asks for the metadata field catalogue, whoever the caller is', async () => {
    // `/admin/fields` was fetched purely to join `options` and `description` onto a type's fields.
    // Both travel on the type now, so the tenant's whole field catalogue — including fields
    // attached to no type, and the tenant-authored validation patterns — stopped being reachable
    // from this page at all.
    for (const permissions of [AUDITOR, CONTROLLER]) {
      expect(await requestsFor([...permissions])).not.toContain('/admin/fields');
      adminOptions.mockReset();
      adminList.mockReset();
      adminRead.mockReset();
    }
  });
});

describe('a caller who can open neither dialogue', () => {
  it('asks for exactly three things', async () => {
    // Named as a count as well as a set, so an added dependency has to be looked at rather than
    // silently joining the render-critical group.
    expect(await requestsFor([...AUDITOR])).toStrictEqual([
      '/admin/libraries',
      '/admin/folders',
      '/documents',
    ]);
  });

  it('touches neither read model', async () => {
    const requested = await requestsFor([...AUDITOR]);
    expect(requested.filter((path) => path.startsWith('/configuration'))).toEqual([]);
    expect(requested.filter((path) => path.startsWith('/directory'))).toEqual([]);
  });
});

describe('the upload dialogue, which needs the whole filing vocabulary', () => {
  it('is given it for a caller who may create', async () => {
    const requested = await requestsFor([Permission.DOCUMENT_VIEW, Permission.DOCUMENT_CREATE]);
    expect(requested).toContain('/configuration/document-types');
    expect(requested).toContain('/configuration/categories');
    expect(requested).toContain('/configuration/confidentiality-levels');
  });

  it('asks only for the types a new document may actually be filed as', async () => {
    await requestsFor([Permission.DOCUMENT_VIEW, Permission.DOCUMENT_CREATE]);
    const call = adminOptions.mock.calls.find(([path]) => path === '/configuration/document-types');
    expect(call?.[2]).toEqual({ isActive: 'true' });
  });
});

describe('the bulk metadata dialogue, which renders one control', () => {
  it('is given the categories and nothing else', async () => {
    /*
     * `BulkMetadataDialog` takes `categories` and no other dataset — its whole form is one category
     * picker. Fetching the types, the levels and a directory for it was fetching a tenant's
     * classification vocabulary to fill in controls the dialogue does not have.
     */
    const requested = await requestsFor([Permission.DOCUMENT_VIEW, Permission.DOCUMENT_EDIT]);
    expect(requested).toContain('/configuration/categories');
    expect(requested).not.toContain('/configuration/document-types');
    expect(requested).not.toContain('/configuration/confidentiality-levels');
    expect(requested).not.toContain('/directory/people');
    expect(requested).not.toContain('/directory/departments');
  });
});

describe('capabilities that open no dialogue', () => {
  it('drag nothing back in', async () => {
    // Download and restore are real capabilities and neither opens a dialogue that needs
    // configuration, so neither may reintroduce a dependency.
    const requested = await requestsFor([
      Permission.DOCUMENT_VIEW,
      Permission.DOCUMENT_DOWNLOAD,
      Permission.DOCUMENT_RESTORE,
    ]);
    expect(requested).toStrictEqual(['/admin/libraries', '/admin/folders', '/documents']);
  });
});

describe('the directory is read only when a field asks for one', () => {
  const CREATOR = [Permission.DOCUMENT_VIEW, Permission.DOCUMENT_CREATE] as const;

  it('is untouched when no document type defines a USER or DEPARTMENT field', async () => {
    /*
     * The narrowest read in the product, and the point is that most tenants never trigger it. The
     * capability says a dialogue can open; the *configuration* says whether that dialogue has a
     * control needing a list of people. Asking on capability alone was reading the staff list to
     * render a form with no field for it.
     */
    const requested = await requestsFor([...CREATOR], [typeWith(MetadataDataType.TEXT)]);
    expect(requested).not.toContain('/directory/people');
    expect(requested).not.toContain('/directory/departments');
  });

  it('reads people when a type defines a USER field, and still not departments', async () => {
    const requested = await requestsFor([...CREATOR], [typeWith(MetadataDataType.USER)]);
    expect(requested).toContain('/directory/people');
    expect(requested).not.toContain('/directory/departments');
  });

  it('reads departments when a type defines a DEPARTMENT field, and still not people', async () => {
    const requested = await requestsFor([...CREATOR], [typeWith(MetadataDataType.DEPARTMENT)]);
    expect(requested).toContain('/directory/departments');
    expect(requested).not.toContain('/directory/people');
  });

  it('reads both when a type defines both', async () => {
    const requested = await requestsFor(
      [...CREATOR],
      [typeWith(MetadataDataType.USER, MetadataDataType.DEPARTMENT)],
    );
    expect(requested).toContain('/directory/people');
    expect(requested).toContain('/directory/departments');
  });

  it('looks across every type, not only the first', async () => {
    // A tenant with twelve types and one `USER` field on the last of them still needs the list.
    const requested = await requestsFor(
      [...CREATOR],
      [typeWith(MetadataDataType.TEXT), typeWith(MetadataDataType.USER)],
    );
    expect(requested).toContain('/directory/people');
  });
});

describe('the folder page is asked for in path order, and that is load-bearing', () => {
  /**
   * The invariant this file exists to protect, after the request set itself.
   *
   * `TreeView` builds its hierarchy from `parentId` and promotes any row whose parent is missing
   * from the list to a **root** — `aria-level="1"`. Whether that ever fires is decided entirely by
   * whether the fetched page is closed under the ancestor relation, and only a materialised path
   * makes it so: an ancestor's path is a proper prefix of its descendant's, and a proper prefix
   * sorts first.
   *
   * Measured against the running stack on a 149-folder library: `sortBy=path` returned **0** rows
   * with a missing parent, `sortBy=name` returned **100 of 100**. Changing this one literal turns a
   * truncated tree into a false one, and no screenshot and no render test would show it.
   */
  it('asks with sortBy=path, ascending, at the API maximum, for the first page', async () => {
    await requestsFor([...CONTROLLER]);

    const folderCall = adminList.mock.calls.find(([path]) => path === '/admin/folders');
    expect(folderCall, 'the folder page was never requested').toBeDefined();
    expect(folderCall?.[1]).toMatchObject({
      page: 1,
      // `MAX_PAGE_SIZE`, and the schema rejects anything above it rather than clamping.
      pageSize: 100,
      sortBy: 'path',
      sortDirection: 'asc',
      deleted: 'live',
    });
  });

  it('scopes the folder page to the selected library and nothing else', async () => {
    await requestsFor([...CONTROLLER]);

    const folderCall = adminList.mock.calls.find(([path]) => path === '/admin/folders');
    expect(folderCall?.[1]).toMatchObject({ filters: { libraryId: 'lib-1' } });
  });
});

describe('a folder outside the fetched page', () => {
  /** The page as a caller sees it: which folder the URL named, and which reads it took. */
  async function open(
    folderId: string,
    readable: Readonly<Record<string, unknown>> = {},
  ): Promise<{ readonly requested: readonly string[]; readonly reads: readonly string[] }> {
    // The auditor, so the request set is the render-critical three and the recovery is the only
    // thing that can add to it.
    const requested = await requestsFor(
      [...AUDITOR],
      [typeWith()],
      { libraryId: 'lib-1', folderId },
      readable,
    );
    return { requested, reads: adminRead.mock.calls.map(([path]) => path) };
  }

  it('reads nothing when the folder is already on the page', async () => {
    /*
     * Case A, and the one that decides whether this slice costs anything. Every library under a
     * hundred folders takes this path on every page load, so a recovery that "just checked" would
     * add a request to all of them.
     */
    const { requested, reads } = await open('root-1');

    expect(reads).toStrictEqual([]);
    expect(requested).toStrictEqual(['/admin/libraries', '/admin/folders', '/documents']);
  });

  it('reads exactly one folder when its parent is already on the page', async () => {
    // Case C, and the shape the running stack actually produces: because the page is ordered by
    // path it is closed under the ancestor relation, so a dropped folder's parent is still in it.
    const { reads } = await open('off-page', {
      'off-page': { ...ROOT_FOLDER, id: 'off-page', parentId: 'root-1', name: 'Department 133' },
    });

    expect(reads).toStrictEqual(['/admin/folders/off-page']);
  });

  it('walks upward while ancestors are also missing', async () => {
    // Case D.
    const { reads } = await open('leaf', {
      leaf: { ...ROOT_FOLDER, id: 'leaf', parentId: 'branch', name: 'SOP' },
      branch: { ...ROOT_FOLDER, id: 'branch', parentId: 'root-1', name: 'Manuals' },
    });

    expect(reads).toStrictEqual(['/admin/folders/leaf', '/admin/folders/branch']);
  });

  it('stops at a refusal rather than trying another route to the same folder', async () => {
    // Case E. `adminRead` reports the refusal; nothing here retries it, and no other endpoint is
    // asked for the ancestor `AclGuard` declined.
    const { requested, reads } = await open('reachable', {
      reachable: { ...ROOT_FOLDER, id: 'reachable', parentId: 'secret', name: 'Reachable' },
    });

    expect(reads).toStrictEqual(['/admin/folders/reachable', '/admin/folders/secret']);
    expect(requested.filter((path) => path.startsWith('/admin/folders/'))).toHaveLength(2);
    // Every other dependency is exactly what it was; recovery adds requests to no other endpoint.
    expect(requested.filter((path) => !path.startsWith('/admin/folders/'))).toStrictEqual([
      '/admin/libraries',
      '/admin/folders',
      '/documents',
    ]);
  });

  it('renders rather than throwing when the folder itself cannot be read', async () => {
    /*
     * The existing semantics, preserved. Today no read happens and the page renders with the wrong
     * heading; a `adminGet` here would have turned that into the route's error boundary — a
     * regression dressed as a fix. `adminRead` carries the refusal instead, and `page.tsx` heads
     * the page with nothing rather than with the library's name.
     */
    const { reads } = await open('vanished');

    expect(reads).toStrictEqual(['/admin/folders/vanished']);
  });

  it('cannot loop on a cycle in parentId', async () => {
    // Case G. Server data, so it cannot be assumed away.
    const { reads } = await open('a', {
      a: { ...ROOT_FOLDER, id: 'a', parentId: 'c' },
      b: { ...ROOT_FOLDER, id: 'b', parentId: 'a' },
      c: { ...ROOT_FOLDER, id: 'c', parentId: 'b' },
    });

    expect(reads).toStrictEqual(['/admin/folders/a', '/admin/folders/c', '/admin/folders/b']);
  });

  /** What the screen was handed, which is where the visible half of this slice lands. */
  const handed = (): Record<string, unknown> => handedOver;

  it('names the folder it recovered, not the library it is in', async () => {
    /*
     * **The defect, stated as the thing that must never come back.**
     *
     * `selectedFolderName` resolved `folder?.name ?? selectedLibrary?.name ?? ''`, so a folder past
     * the hundred-row cut produced a page headed with the *library's* name — over a document list
     * that was correctly scoped to the folder all along. Restoring that middle term fails here.
     */
    await open('off-page', {
      'off-page': { ...ROOT_FOLDER, id: 'off-page', parentId: 'root-1', name: 'Department 133' },
    });

    expect(handed()['selectedFolderName']).toBe('Department 133');
    expect(handed()['selectedFolderName']).not.toBe('Quality');
  });

  it('names nothing at all when the folder could not be read', async () => {
    // Unknown is unknown. `LibraryScreen` falls back to the route's own title on an empty string,
    // which claims nothing about which folder this is — the honest answer.
    await open('vanished');

    expect(handed()['selectedFolderName']).toBe('');
  });

  it('keeps the folder’s name when only an ancestor was refused', async () => {
    // `AclGuard` said yes to the folder and no to its parent. The name was read legitimately and
    // is the one thing the page can still say truthfully.
    await open('reachable', {
      reachable: { ...ROOT_FOLDER, id: 'reachable', parentId: 'secret', name: 'Reachable' },
    });

    expect(handed()['selectedFolderName']).toBe('Reachable');
  });

  it('merges the recovered chain into the folders the tree is drawn from', async () => {
    await open('leaf', {
      leaf: { ...ROOT_FOLDER, id: 'leaf', parentId: 'branch', name: 'SOP' },
      branch: { ...ROOT_FOLDER, id: 'branch', parentId: 'root-1', name: 'Manuals' },
    });

    const folders = handed()['folders'] as { id: string }[];
    expect(folders.map((entry) => entry.id)).toStrictEqual(['root-1', 'branch', 'leaf']);
  });

  it('merges nothing when the chain never reached the folders it was joining', async () => {
    /*
     * A folder whose parent was refused has no place in the tree: `TreeView` promotes a parentless
     * node to a root, so merging it would announce a folder three levels down at `aria-level="1"`
     * — the missing ancestor fabricated as an absence.
     */
    await open('reachable', {
      reachable: { ...ROOT_FOLDER, id: 'reachable', parentId: 'secret', name: 'Reachable' },
    });

    const folders = handed()['folders'] as { id: string }[];
    expect(folders.map((entry) => entry.id)).toStrictEqual(['root-1']);
  });

  it('reports the page against the library’s own total', async () => {
    // `meta.hasMore` and `meta.total` were fetched and discarded from the day this page was
    // written. `shown` counts what the tree actually received, so the sentence describes the rail.
    adminList.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/admin/folders'
          ? { data: [ROOT_FOLDER], meta: { total: 149, hasMore: true } }
          : { data: [], meta: { total: 0, hasMore: false } },
      ),
    );
    adminAccess.mockResolvedValue({ granted: true, permissions: [...AUDITOR] });
    adminOptions.mockResolvedValue({
      data: [{ id: 'lib-1', name: 'Quality', rootFolderId: 'root-1' }],
    });
    adminRead.mockResolvedValue({ ok: false, code: 'NOT_FOUND' });
    const element = await DocumentsPage({ searchParams: Promise.resolve({ libraryId: 'lib-1' }) });

    expect(propsOf(element)['folderPage']).toStrictEqual({ shown: 1, total: 149, hasMore: true });
  });

  it('never exceeds the depth the API itself enforces on the tree', async () => {
    // Case H. `MAXIMUM_FOLDER_DEPTH` is 32, and it bounds the requests as well as the depth.
    const chain: Record<string, unknown> = {};
    for (let index = 0; index < 200; index += 1) {
      chain[`n${String(index)}`] = {
        ...ROOT_FOLDER,
        id: `n${String(index)}`,
        parentId: `n${String(index + 1)}`,
      };
    }
    const { reads } = await open('n0', chain);

    expect(reads).toHaveLength(MAXIMUM_FOLDER_DEPTH);
  });
});

describe('refusals are not hidden', () => {
  it('still throws when a read a capable caller needs is refused', async () => {
    /*
     * The distinction this design draws is between "cannot use the feature, so do not ask" and
     * "can use the feature and was refused". The second is a real authorization problem, and
     * swallowing it into an empty dropdown would be the page lying about what the tenant has
     * configured.
     */
    adminAccess.mockResolvedValue({ granted: true, permissions: [...CONTROLLER] });
    adminOptions.mockImplementation((path: string) =>
      path === '/configuration/document-types'
        ? Promise.reject(new Error('Forbidden'))
        : Promise.resolve({ data: [] }),
    );
    adminList.mockResolvedValue({ data: [], meta: { total: 0, hasMore: false } });

    await expect(DocumentsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('Forbidden');
  });
});
