import { DomainError, ErrorCode, Permission, type PermissionKey } from '@edms/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the delegations workspace asks the API for — Slice 20.
 *
 * ## The defect this file pins down
 *
 * The delegate picker was filled from `/admin/users`, behind `user:manage`.
 * `08-permission-model.md` §6 marks `delegation:manage` **`own`** for the author and the approver,
 * and `role-seed.ts` seeds it to those two and to the document controller — *none* of which holds
 * `user:manage`. `adminGet` throws on a 403 and one rejection settles the whole `Promise.all`, so
 * `/delegations` rendered the route's error boundary for every role the matrix says the screen is
 * for, and opened only for the tenant administrator, the one role it does not mark `own`.
 *
 * Same shape as `/search` before Slice 10 and `/documents/:id/permissions` before Slice 12, and it
 * survived for the same reason all three did: a suite whose callers hold the whole catalogue cannot
 * notice a screen that depends on a permission it should not.
 *
 * ## Why the assertions are the request set
 *
 * A render test cannot see any of this. The screen draws identically whether the page asked for an
 * administrative catalogue it had no right to, asked and was refused, or never asked at all. These
 * tests read the mock's call list, which is the thing that changed — and the grants are a parameter,
 * because a superuser fixture is exactly what fails to catch the regression.
 */

const { adminAccess, adminGet } = vi.hoisted(() => ({
  adminAccess:
    vi.fn<
      (
        permission: PermissionKey,
      ) => Promise<{ readonly granted: boolean; readonly permissions: readonly PermissionKey[] }>
    >(),
  adminGet: vi.fn<(path: string) => Promise<unknown>>(),
}));

/**
 * `adminList`, `adminOptions` and `adminRead` are deliberately **not** provided.
 *
 * `adminOptions` is the wrapper the other read-dependency slices removed, and `adminRead` is the
 * one that turns a refusal into an empty list. A page that reached for either would fail to import
 * here rather than quietly restoring an administrative dependency, or quietly swallowing a refusal
 * on a screen where every caller holds the key the route declares.
 */
vi.mock('../../../lib/admin/api', () => ({ adminAccess, adminGet }));
vi.mock('../../../features/delegations/delegations-screen', () => ({
  DelegationsScreen: () => null,
}));
vi.mock('../../../features/admin-shared', () => ({ AdminForbidden: () => null }));

const { default: DelegationsPage } = await import('./page');

/** The seeded grants that decide this page's behaviour, from `role-seed.ts`. */
const AUTHOR = [Permission.DELEGATION_MANAGE, Permission.NOTIFICATION_MANAGE] as const;
const APPROVER = AUTHOR;
const CONTROLLER = [
  Permission.DELEGATION_MANAGE,
  Permission.DOCUMENT_VIEW,
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
/** The auditor: reads everything in scope and arranges nobody's cover. */
const AUDITOR = [Permission.DOCUMENT_VIEW, Permission.SEARCH_ALL] as const;

/**
 * Everything a delegator must never be made to depend on.
 *
 * `/directory/people` is on the list beside the administrative routes, and it is the interesting
 * entry: it returns exactly the shape this picker wants, so it is the repair somebody reaches for
 * — and taking it would mean seeding `AUTHOR` and `APPROVER` a key that also opens the organisation
 * chart. The route this page uses instead carries the key the screen already gated on.
 */
const FORBIDDEN_DEPENDENCIES = [
  '/admin/users',
  '/admin/roles',
  '/admin/departments',
  '/directory/',
];

const PEOPLE = {
  data: [
    { id: '019489f0-0000-7000-8000-0000000000u1', displayName: 'Ada Lovelace' },
    { id: '019489f0-0000-7000-8000-0000000000u2', displayName: 'Grace Hopper' },
  ],
  meta: { page: 1, pageSize: 100, total: 2, hasMore: false },
};

/** Renders the page for a caller holding exactly these grants, and reports what it asked for. */
async function requestsFor(
  permissions: readonly PermissionKey[],
  {
    params = {},
    refuse = [],
  }: { params?: Readonly<Record<string, string>>; refuse?: readonly string[] } = {},
): Promise<{ readonly got: readonly string[]; readonly props: Record<string, unknown> }> {
  adminAccess.mockResolvedValue({
    granted: permissions.includes(Permission.DELEGATION_MANAGE),
    permissions,
  });

  adminGet.mockImplementation((path: string) => {
    if (refuse.some((prefix) => path.startsWith(prefix))) {
      return Promise.reject(new DomainError(ErrorCode.FORBIDDEN, 'Forbidden'));
    }
    if (path.startsWith('/delegations/delegates')) {
      return Promise.resolve(PEOPLE);
    }
    return Promise.resolve({ data: [], meta: { page: 1, pageSize: 50, total: 0, hasMore: false } });
  });

  const element = await DelegationsPage({ searchParams: Promise.resolve(params) });

  return {
    got: adminGet.mock.calls.map(([path]) => path),
    props: (element as { props?: Record<string, unknown> } | null)?.props ?? {},
  };
}

beforeEach(() => {
  adminAccess.mockReset();
  adminGet.mockReset();
});

describe('the request set, for each role the matrix marks own', () => {
  it.each([
    ['the author', AUTHOR],
    ['the approver', APPROVER],
    ['the document controller', CONTROLLER],
    ['the tenant administrator', TENANT_ADMIN],
  ])('asks %s for the same two things', async (_name, permissions) => {
    /*
     * The point of the slice, in one assertion repeated four times: the caller holding two grants
     * and the caller holding the whole catalogue make the *same* requests. The picker stopped being
     * a permission question because it stopped being an administrative request.
     */
    const { got } = await requestsFor(permissions);
    const paths = got.map((path) => path.split('?')[0] ?? path);

    expect(paths).toEqual(['/delegations', '/delegations/delegates']);
  });

  it.each([
    ['the author', AUTHOR],
    ['the document controller', CONTROLLER],
  ])('never asks %s for an administrative catalogue or the directory', async (_n, permissions) => {
    const { got } = await requestsFor(permissions);

    for (const forbidden of FORBIDDEN_DEPENDENCIES) {
      expect(got.some((path) => path.startsWith(forbidden))).toBe(false);
    }
  });
});

describe('the delegate picker', () => {
  it('reads the people from the route that carries delegation:manage', async () => {
    const { got } = await requestsFor(AUTHOR);
    const delegates = got.find((path) => path.startsWith('/delegations/delegates'));

    expect(delegates).toBeDefined();
    // The bound the pagination schema enforces. This screen asked for 200 once, which
    // `pageQuerySchema` *rejects* rather than clamps, and the page threw before rendering.
    expect(delegates).toContain('pageSize=100');
    expect(delegates).toContain('sortBy=displayName');
  });

  it('spells no parameter the operational schema would reject', async () => {
    // `optionListQuerySchema` has no `deleted` and the route has no `status`: active accounts are
    // the endpoint's behaviour rather than a filter the caller may turn off. A request that cannot
    // be spelled cannot be made, and one that is spelled anyway is a 422 the page dies on.
    const { got } = await requestsFor(AUTHOR);
    const delegates = got.find((path) => path.startsWith('/delegations/delegates'));

    // Asserted before the two absences below, or this test passes vacuously the moment the page
    // stops calling the route at all — which is the regression the file exists to catch.
    expect(delegates).toBeDefined();
    expect(delegates).not.toContain('deleted=');
    expect(delegates).not.toContain('status=');
  });

  it('hands the screen the identifier and the label, and nothing else', async () => {
    const { props } = await requestsFor(AUTHOR);

    expect(props['people']).toEqual([
      { id: '019489f0-0000-7000-8000-0000000000u1', name: 'Ada Lovelace' },
      { id: '019489f0-0000-7000-8000-0000000000u2', name: 'Grace Hopper' },
    ]);
  });

  it('throws rather than degrading when the read is refused', async () => {
    /*
     * Deliberately not `adminRead`. Every caller who reaches this line holds `delegation:manage` —
     * the page gates on it above and the route declares it — so a refusal is a real authorization
     * defect, and an empty picker would be the screen saying this tenant has nobody to delegate to.
     */
    await expect(requestsFor(AUTHOR, { refuse: ['/delegations/delegates'] })).rejects.toThrow();
  });
});

describe('the boundary the slice does not move', () => {
  it('refuses the auditor, and asks for nothing on its behalf', async () => {
    const { got } = await requestsFor(AUDITOR);

    expect(got).toEqual([]);
  });
});
