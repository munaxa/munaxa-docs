import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MetadataDataType, Permission, type PermissionKey } from '@edms/domain';

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
const { adminAccess, adminOptions, adminList } = vi.hoisted(() => ({
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
      (path: string, state: unknown) => Promise<{ data: unknown[]; meta: { total: number } }>
    >(),
}));

vi.mock('../../../lib/admin/api', () => ({ adminAccess, adminOptions, adminList }));

// Neither is rendered — the page is called as a function and its element inspected not at all — but
// mocking them keeps the client component and the platform out of a node test entirely.
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

/** Renders the page for a caller holding exactly these grants, and reports what it asked for. */
async function requestsFor(
  permissions: readonly PermissionKey[],
  documentTypes: readonly unknown[] = [typeWith()],
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
  adminList.mockResolvedValue({ data: [], meta: { total: 0 } });

  await DocumentsPage({ searchParams: Promise.resolve({}) });

  return [
    ...adminOptions.mock.calls.map(([path]) => path),
    ...adminList.mock.calls.map(([path]) => path),
  ];
}

/** The seeded roles, by the tenant-wide grants that decide this page's behaviour. */
const AUDITOR = [Permission.DOCUMENT_VIEW, Permission.LIBRARY_VIEW] as const;
const CONTROLLER = [...AUDITOR, Permission.DOCUMENT_CREATE, Permission.DOCUMENT_EDIT] as const;

beforeEach(() => {
  adminAccess.mockReset();
  adminOptions.mockReset();
  adminList.mockReset();
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
    adminList.mockResolvedValue({ data: [], meta: { total: 0 } });

    await expect(DocumentsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('Forbidden');
  });
});
