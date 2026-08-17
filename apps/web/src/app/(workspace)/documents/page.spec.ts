import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Permission, type PermissionKey } from '@edms/domain';

/**
 * What the Documents page asks the API for, and what it does not.
 *
 * ## Why the assertion is the request set rather than the render
 *
 * The page fetched nine things in one `Promise.all`. Six of them — document types, categories,
 * confidentiality levels, users, departments and metadata fields — are administrative resources
 * behind `settings:manage`, `user:manage` and `org:manage`, and they exist for exactly two
 * dialogues: `UploadDialog` and `BulkMetadataDialog`. Nothing else on the screen reads them.
 *
 * A caller who cannot open either dialogue holds none of those permissions, so all six answered
 * 403 — and sharing a `Promise.all` with the libraries meant one refusal threw the whole server
 * render and the reader got the route's error boundary instead of the workspace. Measured against
 * the running stack, that was true of the auditor *and* the document controller; only a tenant
 * administrator could open the page at all.
 *
 * So the fix is which requests are made, and the test has to be about that. A render assertion
 * cannot see it: the page renders identically whether it asked for six datasets it then ignored or
 * never asked at all. These tests read the mock's call list, which is the thing that actually
 * changed.
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
  adminOptions: vi.fn<(path: string, sortBy: string) => Promise<{ data: unknown[] }>>(),
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

/** The six that exist only to fill a dialogue. */
const DIALOG_ONLY = [
  '/admin/document-types',
  '/admin/categories',
  '/admin/confidentiality-levels',
  '/admin/users',
  '/admin/departments',
  '/admin/fields',
];

/** Renders the page for a caller holding exactly these grants, and reports what it asked for. */
async function requestsFor(permissions: readonly PermissionKey[]): Promise<readonly string[]> {
  adminAccess.mockResolvedValue({ granted: true, permissions });
  adminOptions.mockImplementation((path: string) =>
    Promise.resolve({
      data:
        path === '/admin/libraries'
          ? [{ id: 'lib-1', name: 'Quality', rootFolderId: 'root-1' }]
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

describe('a caller who can open neither dialogue', () => {
  it('asks for none of the six administrative datasets', async () => {
    /*
     * The whole slice, in one assertion. Each of these answered 403 for this caller and took the
     * page down with it; now they are simply not requested, which is strictly less access than
     * before rather than more.
     */
    const requested = await requestsFor([...AUDITOR]);
    for (const path of DIALOG_ONLY) {
      expect(requested, `${path} must not be requested without a dialogue to fill`).not.toContain(
        path,
      );
    }
  });

  it('asks for exactly three things', async () => {
    // Named as a count as well as a set, so an added dependency has to be looked at rather than
    // silently joining the render-critical group.
    expect(await requestsFor([...AUDITOR])).toStrictEqual([
      '/admin/libraries',
      '/admin/folders',
      '/documents',
    ]);
  });
});

describe('the capability boundary', () => {
  it('fetches the dialogue data for a caller who may create', async () => {
    const requested = await requestsFor([Permission.DOCUMENT_VIEW, Permission.DOCUMENT_CREATE]);
    for (const path of DIALOG_ONLY) {
      expect(requested, `${path} is needed to fill the upload dialogue`).toContain(path);
    }
  });

  it('fetches it for a caller who may only bulk-edit', async () => {
    // `BulkMetadataDialog` takes the categories, so edit alone is enough to need the group.
    const requested = await requestsFor([Permission.DOCUMENT_VIEW, Permission.DOCUMENT_EDIT]);
    for (const path of DIALOG_ONLY) {
      expect(requested).toContain(path);
    }
  });

  it('does not fetch it for grants that open neither dialogue', async () => {
    // Download and restore are real capabilities and neither opens a dialogue that needs
    // configuration, so neither may drag the six back in.
    const requested = await requestsFor([
      Permission.DOCUMENT_VIEW,
      Permission.DOCUMENT_DOWNLOAD,
      Permission.DOCUMENT_RESTORE,
    ]);
    for (const path of DIALOG_ONLY) {
      expect(requested).not.toContain(path);
    }
  });
});

describe('refusals are not hidden', () => {
  it('still throws when a dialogue dataset a capable caller needs is refused', async () => {
    /*
     * The distinction this slice draws is between "cannot use the feature, so do not ask" and
     * "can use the feature and was refused". The second is a real authorization problem — the
     * document controller's, recorded as its own follow-up — and swallowing it into an empty
     * dropdown would be the page lying about what the tenant has configured.
     */
    adminAccess.mockResolvedValue({ granted: true, permissions: [...CONTROLLER] });
    adminOptions.mockImplementation((path: string) =>
      path === '/admin/document-types'
        ? Promise.reject(new Error('Forbidden'))
        : Promise.resolve({ data: [] }),
    );
    adminList.mockResolvedValue({ data: [], meta: { total: 0 } });

    await expect(DocumentsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('Forbidden');
  });
});
