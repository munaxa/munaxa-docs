import { DomainError, ErrorCode, Permission, type PermissionKey } from '@edms/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the document permissions workspace asks the API for — Slice 12.
 *
 * ## The two defects this file pins down
 *
 * **Three administrative reads that threw.** The entries table captioned its subjects by fetching
 * `/admin/users`, `/admin/roles` and `/admin/departments` — `user:manage`, `role:manage` and
 * `org:manage`. The seeded document controller holds `document:permission:manage` and none of those
 * three, so all three answered 403 through `adminOptions`, which throws, and this route was the
 * error boundary for the one role the permissions controller's own docstring names as an intended
 * user. Same shape as `/search` before Slice 10, on a screen where it matters more.
 *
 * **One render-critical read that did not throw.** The explicit ACL was fetched with `adminRead`,
 * so a refusal became `ok: false` and the screen rendered `entries: []` — stating that a document
 * has *no* explicit permissions when in fact nobody had been able to ask. On this screen that is
 * the most expensive thing to be wrong about, and it is now `adminGet`.
 *
 * ## Why the assertions are the request set
 *
 * A render test cannot see any of this. The page draws identically whether it asked for three
 * catalogues it had no right to, asked and was refused, or never asked. These tests read the mock's
 * call list, which is the thing that changed — and grants are a parameter, because the original
 * defect is exactly what a suite of superuser tests cannot notice.
 */

const { adminAccess, adminGet, adminRead } = vi.hoisted(() => ({
  adminAccess:
    vi.fn<
      (
        permission: PermissionKey,
      ) => Promise<{ readonly granted: boolean; readonly permissions: readonly PermissionKey[] }>
    >(),
  adminGet: vi.fn<(path: string) => Promise<unknown>>(),
  adminRead: vi.fn<(path: string) => Promise<unknown>>(),
}));

/**
 * `adminOptions` is deliberately **not** provided.
 *
 * It is the wrapper that threw, and every one of the three reads this slice removed went through
 * it. A page that reached for it again would fail to import here rather than quietly restoring an
 * administrative dependency nobody asked for.
 */
vi.mock('../../../../../lib/admin/api', () => ({ adminAccess, adminGet, adminRead }));
vi.mock('../../../../../features/permissions/permissions-screen', () => ({
  PermissionsScreen: () => null,
}));
vi.mock('../../../../../features/admin-shared', () => ({ AdminForbidden: () => null }));

const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);
vi.mock('next/navigation', () => ({ notFound }));

const { default: DocumentPermissionsPage } = await import('./page');

const DOCUMENT = '019489f0-0000-7000-8000-000000000001';

/** The seeded grants that decide this page's behaviour, from `role-seed.ts`. */
const AUDITOR = [Permission.DOCUMENT_VIEW, Permission.SEARCH_ALL] as const;
const CONTROLLER = [
  Permission.DOCUMENT_VIEW,
  Permission.DOCUMENT_PERMISSION_MANAGE,
  Permission.CONFIGURATION_VIEW,
  Permission.DIRECTORY_VIEW,
] as const;
const TENANT_ADMIN = [
  ...CONTROLLER,
  Permission.USER_MANAGE,
  Permission.ROLE_MANAGE,
  Permission.ORG_MANAGE,
  Permission.SETTINGS_MANAGE,
] as const;

/** Everything a permission-management user must never be made to depend on. */
const FORBIDDEN_DEPENDENCIES = [
  '/admin/users',
  '/admin/roles',
  '/admin/departments',
  '/admin/entities',
  '/admin/companies',
];

const ENTRIES = [
  {
    id: '019489f0-0000-7000-8000-0000000000e1',
    scopeType: 'DOCUMENT',
    scopeId: DOCUMENT,
    subjectType: 'ROLE',
    subjectId: '019489f0-0000-7000-8000-0000000000r1',
    permission: Permission.DOCUMENT_VIEW,
    effect: 'ALLOW',
    createdAt: '2026-08-17T00:00:00.000Z',
    createdBy: null,
    subjectName: 'Document controller',
  },
  {
    id: '019489f0-0000-7000-8000-0000000000e2',
    scopeType: 'DOCUMENT',
    scopeId: DOCUMENT,
    subjectType: 'USER',
    subjectId: '019489f0-0000-7000-8000-0000000000u9',
    permission: Permission.DOCUMENT_DELETE,
    effect: 'DENY',
    createdAt: '2026-08-17T00:00:00.000Z',
    createdBy: null,
    // No `subjectName`: the account has since been deleted, which is a state the product can be in.
  },
];

const EXPLICIT = {
  entries: ENTRIES,
  chain: [{ type: 'LIBRARY', id: 'lib-1', name: 'Quality', breaksInheritance: false }],
  inheritanceBroken: false,
  folderId: 'fol-1',
  folderInheritsAcl: true,
};

function optionsFor(path: string): unknown {
  if (path.startsWith('/directory/people')) {
    return { data: [{ id: 'u-1', displayName: 'Ada Lovelace' }], meta: { total: 1 } };
  }
  if (path.startsWith('/acl/roles')) {
    return { data: [{ id: 'r-1', name: 'Document controller' }], meta: { total: 1 } };
  }
  return { data: [{ id: 'd-1', code: 'QA', name: 'Quality Assurance', path: 'Acme/QA' }] };
}

/** Renders the page for a caller holding exactly these grants, and reports what it asked for. */
async function requestsFor(
  permissions: readonly PermissionKey[],
  {
    params = {},
    refuse = [],
  }: { params?: Readonly<Record<string, string>>; refuse?: readonly string[] } = {},
): Promise<{
  readonly got: readonly string[];
  readonly read: readonly string[];
  readonly props: Record<string, unknown>;
}> {
  adminAccess.mockResolvedValue({
    granted: permissions.includes(Permission.DOCUMENT_PERMISSION_MANAGE),
    permissions,
  });
  const refused = (path: string) => refuse.some((prefix) => path.startsWith(prefix));

  adminGet.mockImplementation((path: string) => {
    if (refused(path)) {
      return Promise.reject(new DomainError(ErrorCode.FORBIDDEN, 'Forbidden'));
    }
    if (path.startsWith('/documents/')) {
      return Promise.resolve({ id: DOCUMENT, title: 'Quality Manual' });
    }
    if (path.includes('/effective')) {
      return Promise.resolve({ permissions: [], chain: [], inheritanceBroken: false });
    }
    return Promise.resolve(EXPLICIT);
  });

  adminRead.mockImplementation((path: string) =>
    Promise.resolve(
      refused(path)
        ? { ok: false, code: ErrorCode.FORBIDDEN }
        : { ok: true, value: optionsFor(path) },
    ),
  );

  const element = await DocumentPermissionsPage({
    params: Promise.resolve({ documentId: DOCUMENT }),
    searchParams: Promise.resolve(params),
  });

  return {
    got: adminGet.mock.calls.map(([path]) => path.split('?')[0] ?? path),
    read: adminRead.mock.calls.map(([path]) => path.split('?')[0] ?? path),
    props: (element as { props?: Record<string, unknown> } | null)?.props ?? {},
  };
}

beforeEach(() => {
  adminAccess.mockReset();
  adminGet.mockReset();
  adminRead.mockReset();
  notFound.mockClear();
});

describe('the request set, for each role that can open it', () => {
  it.each([
    ['the document controller', CONTROLLER],
    ['the tenant administrator', TENANT_ADMIN],
  ])('asks %s for the same six things', async (_name, permissions) => {
    /*
     * The point of the slice, in one assertion repeated twice: the privileged caller and the
     * unprivileged one make the *same* requests. Captions and pickers stopped being a permission
     * question because they stopped being an administrative request.
     */
    const { got, read } = await requestsFor([...permissions]);

    expect(got).toStrictEqual([
      `/documents/${DOCUMENT}`,
      `/scopes/document/${DOCUMENT}/permissions`,
    ]);
    expect(read).toStrictEqual(['/directory/people', '/acl/roles', '/directory/departments']);
  });

  it.each([
    ['the document controller', CONTROLLER],
    ['the tenant administrator', TENANT_ADMIN],
  ])('never makes %s depend on an administrative catalogue', async (_name, permissions) => {
    const { got, read } = await requestsFor([...permissions]);

    for (const path of FORBIDDEN_DEPENDENCIES) {
      expect([...got, ...read], `${path} must not be a dependency`).not.toContain(path);
    }
  });

  it('resolves the effective table only when somebody has been named', async () => {
    const without = await requestsFor([...CONTROLLER]);
    expect(without.got.some((path) => path.includes('/effective'))).toBe(false);

    const withUser = await requestsFor([...CONTROLLER], { params: { userId: 'u-1' } });
    expect(withUser.got).toContain(`/scopes/document/${DOCUMENT}/permissions/effective`);
  });
});

describe('the captions come from the entries', () => {
  it('hands the screen the name the API resolved, on the entry', async () => {
    const { props } = await requestsFor([...CONTROLLER]);
    const entries = props['explicit'] as typeof ENTRIES;

    expect(entries[0]?.subjectName).toBe('Document controller');
  });

  it('gives the document controller exactly what it gives the tenant administrator', async () => {
    // Before this slice these two differed by three catalogues — and for the controller, by the
    // whole page. This is the assertion that the difference is gone.
    const controller = await requestsFor([...CONTROLLER]);
    const admin = await requestsFor([...TENANT_ADMIN]);

    for (const key of ['explicit', 'people', 'roles', 'departments']) {
      expect(controller.props[key]).toStrictEqual(admin.props[key]);
    }
  });

  it('leaves an entry the server could not name to speak for itself', async () => {
    /*
     * `PermissionService.validate` checks the subject *type* and never that the identifier names
     * anything, so an entry can outlive its subject. An absent name must stay absent rather than
     * becoming a blank, so the screen's `subjectName ?? pool ?? subjectId` shows the identifier —
     * which is what an administrator needs to see in order to revoke it.
     */
    const { props } = await requestsFor([...CONTROLLER]);
    const entries = props['explicit'] as typeof ENTRIES;

    expect(entries[1]?.subjectName).toBeUndefined();
  });
});

describe('an optional picker is refused', () => {
  it.each([
    ['the people picker', '/directory/people', 'people'],
    ['the roles picker', '/acl/roles', 'roles'],
    ['the departments picker', '/directory/departments', 'departments'],
  ])('still renders the workspace when %s is refused', async (_name, path, prop) => {
    /*
     * The half this slice made softer. A caller who cannot fill one dropdown has lost the ability
     * to add one kind of subject; they have not lost the entries, the chain, the revoke buttons or
     * the effective table. Discarding all of that because a `<select>` came back empty is what this
     * route used to do.
     */
    const { props } = await requestsFor([...CONTROLLER], { refuse: [path] });

    expect(props[prop]).toStrictEqual([]);
    expect(props['explicit']).toStrictEqual(ENTRIES);
  });

  it('renders even when all three are refused', async () => {
    const { props } = await requestsFor([...CONTROLLER], {
      refuse: ['/directory/', '/acl/roles'],
    });

    expect(props['people']).toStrictEqual([]);
    expect(props['roles']).toStrictEqual([]);
    expect(props['departments']).toStrictEqual([]);
    // The entries — and their names — are unaffected, because they never came from a picker.
    expect((props['explicit'] as typeof ENTRIES)[0]?.subjectName).toBe('Document controller');
  });
});

describe('a render-critical read fails', () => {
  it('throws rather than claiming the document has no explicit permissions', async () => {
    /*
     * The defect this slice fixed in the *other* direction. `adminRead` turned a refused permission
     * read into an empty entries table, which on this screen reads as "nobody has been granted
     * anything here" — a statement about the document rather than about the request.
     */
    await expect(
      requestsFor([...CONTROLLER], { refuse: [`/scopes/document/${DOCUMENT}/permissions`] }),
    ).rejects.toThrow('Forbidden');
  });

  it('throws when the effective resolution is refused', async () => {
    await expect(
      requestsFor([...CONTROLLER], {
        params: { userId: 'u-1' },
        refuse: [`/scopes/document/${DOCUMENT}/permissions/effective`],
      }),
    ).rejects.toThrow('Forbidden');
  });
});

describe('the front door is unchanged', () => {
  it('refuses a caller without document:permission:manage, and asks for no permissions data', async () => {
    const { got, read } = await requestsFor([...AUDITOR]);

    // The document is still read first — that is what makes a document they cannot reach a 404
    // rather than a 403, and the refusal indistinguishable from absence.
    expect(got).toStrictEqual([`/documents/${DOCUMENT}`]);
    expect(read).toStrictEqual([]);
  });

  it('answers a missing document with notFound before deciding anything else', async () => {
    adminAccess.mockResolvedValue({ granted: true, permissions: [...CONTROLLER] });
    adminGet.mockRejectedValue(new DomainError(ErrorCode.NOT_FOUND, 'The requested resource'));

    await expect(
      DocumentPermissionsPage({
        params: Promise.resolve({ documentId: DOCUMENT }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('answers a cross-tenant document the same way, because the API does', async () => {
    // The API cannot distinguish "no such document" from "not yours" and `08 §7` requires that it
    // must not, so a document in another tenant arrives here as the same NOT_FOUND.
    adminAccess.mockResolvedValue({ granted: true, permissions: [...TENANT_ADMIN] });
    adminGet.mockRejectedValue(new DomainError(ErrorCode.NOT_FOUND, 'The requested resource'));

    await expect(
      DocumentPermissionsPage({
        params: Promise.resolve({ documentId: '019489f0-0000-7000-8000-00000000ffff' }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(adminRead).not.toHaveBeenCalled();
  });
});
