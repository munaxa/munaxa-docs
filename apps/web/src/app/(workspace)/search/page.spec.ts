import { Permission, type PermissionKey } from '@edms/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the search workspace asks the API for — Slices 10 and 11.
 *
 * ## The defect this file pins down
 *
 * `/search` fetched seven things in one `Promise.all`. Four of them — the document types, the
 * categories, the departments and the entities — existed only to turn a facet's value into a name,
 * and every one sat behind `settings:manage` or `org:manage`. The seeded document controller and
 * auditor hold neither, so all four answered 403, one rejection discarded the whole server render,
 * and `/search` was the route error boundary for two of the three roles that can open it.
 *
 * Measured on the running stack: `document:view`, `/search`, `/search/saved` and `/search/recent`
 * all answered **200** for all three roles. The search API was never the problem.
 *
 * Slice 10 made the four reads conditional on capability and non-render-critical. Slice 11 removed
 * them: the server resolves names for the facet values it counted inside the ACL predicate, so the
 * labels arrive with the results. **The request set is now three, for every role, always.**
 *
 * ## Why the assertions are the request set
 *
 * The same reason they are in `documents/page.spec.ts`: a render test cannot see any of this. The
 * page draws identically whether it asked for four datasets it had no right to, asked and was
 * refused, or never asked. These tests read the mock's call list, which is the thing that changed.
 *
 * And the original defect survived twenty-five green search E2E tests because every one of them ran
 * as a fixture holding `ALL_PERMISSIONS`. Grants are a parameter here for exactly that reason.
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
 * `adminRead` is deliberately **not** provided.
 *
 * The page imported it in Slice 10 to fetch labels without throwing. Slice 11 removed the last
 * label read, so a page that reached for it again would fail to import here rather than quietly
 * adding a request nobody asked for.
 */
vi.mock('../../../lib/admin/api', () => ({ adminAccess, adminGet }));
vi.mock('../../../features/search/search-screen', () => ({ SearchScreen: () => null }));
vi.mock('../../../features/admin-shared', () => ({ AdminForbidden: () => null }));

const { default: SearchPage } = await import('./page');

/** The seeded grants that decide this page's behaviour, from `role-seed.ts`. */
const AUDITOR = [Permission.DOCUMENT_VIEW, Permission.SEARCH_ALL] as const;
const CONTROLLER = [...AUDITOR, Permission.CONFIGURATION_VIEW, Permission.DIRECTORY_VIEW] as const;
const TENANT_ADMIN = [...CONTROLLER, Permission.ORG_MANAGE, Permission.SETTINGS_MANAGE] as const;

/** Everything a search user must never be made to depend on, administrative or operational. */
const FORBIDDEN_DEPENDENCIES = [
  '/admin/document-types',
  '/admin/categories',
  '/admin/departments',
  '/admin/entities',
  '/configuration/document-types',
  '/configuration/categories',
  '/directory/departments',
];

/** A bucket as the API now sends it: the filter value, the count, and a name when there is one. */
function bucket(value: string, label?: string) {
  return { value, count: 1, ...(label === undefined ? {} : { label }) };
}

function resultsWith(facets: Readonly<Record<string, readonly ReturnType<typeof bucket>[]>>) {
  return {
    data: [{ id: 'doc-0', documentTypeId: 'type-1', title: 'Quality Manual' }],
    meta: { total: 1, unrestricted: false },
    facets,
    nextCursor: null,
  };
}

const LABELLED = {
  status: [bucket('PUBLISHED')],
  type: [bucket('type-1', 'Standard operating procedure')],
  category: [bucket('cat-1', 'Drawings')],
  department: [bucket('dep-1', 'Quality Assurance')],
  entity: [bucket('ent-1', 'Acme Ltd')],
  year: [bucket('2026')],
};

/** Renders the page for a caller holding exactly these grants, and reports what it asked for. */
async function requestsFor(
  permissions: readonly PermissionKey[],
  {
    params = {},
    facets = LABELLED,
  }: {
    params?: Readonly<Record<string, string>>;
    facets?: Readonly<Record<string, readonly ReturnType<typeof bucket>[]>>;
  } = {},
): Promise<{ readonly requested: readonly string[]; readonly props: Record<string, unknown> }> {
  adminAccess.mockResolvedValue({ granted: true, permissions });
  adminGet.mockImplementation((path: string) =>
    Promise.resolve(path.startsWith('/search?') ? resultsWith(facets) : { data: [] }),
  );

  const element = await SearchPage({ searchParams: Promise.resolve(params) });
  const props = (element as { props?: Record<string, unknown> } | null)?.props ?? {};

  return { requested: adminGet.mock.calls.map(([path]) => path.split('?')[0] ?? path), props };
}

beforeEach(() => {
  adminAccess.mockReset();
  adminGet.mockReset();
});

describe('the request set is the same three, whoever is asking', () => {
  it.each([
    ['the auditor', AUDITOR],
    ['the document controller', CONTROLLER],
    ['the tenant administrator', TENANT_ADMIN],
  ])('asks %s for the workspace and nothing else', async (_name, permissions) => {
    /*
     * The point of Slice 11, in one assertion repeated three times: the privileged caller and the
     * unprivileged one now make the *same* requests. Labels are no longer a permission question,
     * because they are no longer a request.
     */
    const { requested } = await requestsFor([...permissions], { params: { q: 'quality' } });

    expect(requested).toStrictEqual(['/search', '/search/saved', '/search/recent']);
  });

  it.each([
    ['the auditor', AUDITOR],
    ['the document controller', CONTROLLER],
    ['the tenant administrator', TENANT_ADMIN],
  ])('never makes %s depend on a catalogue', async (_name, permissions) => {
    const { requested } = await requestsFor([...permissions], { params: { q: 'quality' } });

    for (const path of FORBIDDEN_DEPENDENCIES) {
      expect(requested, `${path} must not be a dependency of search`).not.toContain(path);
    }
  });

  it('asks for nothing but saved and recent on the landing page', async () => {
    // No query and no filter means no facet rail and no result card, so there is nothing to label
    // and no search to run.
    const { requested } = await requestsFor([...TENANT_ADMIN], { params: {} });

    expect(requested).toStrictEqual(['/search/saved', '/search/recent']);
  });

  it('runs a search for a filter with no query text', async () => {
    const { requested } = await requestsFor([...TENANT_ADMIN], { params: { status: 'PUBLISHED' } });

    expect(requested).toContain('/search');
  });
});

describe('the labels come from the response', () => {
  it('hands the screen the name the API supplied, keyed by the filter value', async () => {
    const { props } = await requestsFor([...AUDITOR], { params: { q: 'quality' } });

    expect(props['typeLabels']).toStrictEqual({ 'type-1': 'Standard operating procedure' });
    expect(props['categoryLabels']).toStrictEqual({ 'cat-1': 'Drawings' });
    expect(props['departmentLabels']).toStrictEqual({ 'dep-1': 'Quality Assurance' });
    expect(props['entityLabels']).toStrictEqual({ 'ent-1': 'Acme Ltd' });
  });

  it('gives the auditor exactly what it gives the tenant administrator', async () => {
    // Before Slice 11 these two differed by four label maps. That difference was the defect's
    // residue, and this is the assertion that it is gone.
    const auditor = await requestsFor([...AUDITOR], { params: { q: 'quality' } });
    const admin = await requestsFor([...TENANT_ADMIN], { params: { q: 'quality' } });

    for (const key of ['typeLabels', 'categoryLabels', 'departmentLabels', 'entityLabels']) {
      expect(auditor.props[key]).toStrictEqual(admin.props[key]);
    }
  });

  it('omits a bucket the server could not name, leaving the value to speak for itself', async () => {
    /*
     * A deleted document type still has documents filed under it, so its identifier can reach a
     * facet with no name behind it. The screen's own `labels?.[value] ?? value` then renders the
     * value — which is why an absent label must stay absent rather than becoming an empty string.
     */
    const { props } = await requestsFor([...TENANT_ADMIN], {
      params: { q: 'quality' },
      facets: { type: [bucket('type-1', 'Procedure'), bucket('type-gone')] },
    });

    expect(props['typeLabels']).toStrictEqual({ 'type-1': 'Procedure' });
    expect((props['typeLabels'] as Record<string, string>)['type-gone']).toBeUndefined();
  });

  it('labels nothing when nothing was searched', async () => {
    const { props } = await requestsFor([...TENANT_ADMIN], { params: {} });

    expect(props['typeLabels']).toStrictEqual({});
    expect(props['entityLabels']).toStrictEqual({});
  });

  it('passes the results through untouched', async () => {
    // The values and the counts are the filter and the arithmetic. This slice adds a caption beside
    // them and must not have altered either.
    const { props } = await requestsFor([...AUDITOR], { params: { q: 'quality' } });
    const results = props['initialResults'] as ReturnType<typeof resultsWith>;

    expect(results.facets['type']).toStrictEqual([
      { value: 'type-1', count: 1, label: 'Standard operating procedure' },
    ]);
    expect(results.meta).toStrictEqual({ total: 1, unrestricted: false });
  });
});

describe('a render-critical read fails', () => {
  it.each([
    ['the search itself', '/search?'],
    ['the saved searches', '/search/saved'],
    ['the recent searches', '/search/recent'],
  ])('still throws when %s is refused', async (_name, failing) => {
    /*
     * The half that must not move. Removing the label reads was to stop a *caption* discarding the
     * render — not to make the page paper over a search it could not run. All three carry
     * `document:view`, the key this page already gated on, so a refusal here is a real problem.
     */
    adminAccess.mockResolvedValue({ granted: true, permissions: [...TENANT_ADMIN] });
    adminGet.mockImplementation((path: string) =>
      path.startsWith(failing)
        ? Promise.reject(new Error('Forbidden'))
        : Promise.resolve(path.startsWith('/search?') ? resultsWith(LABELLED) : { data: [] }),
    );

    await expect(SearchPage({ searchParams: Promise.resolve({ q: 'quality' }) })).rejects.toThrow(
      'Forbidden',
    );
  });
});

describe('the front door is unchanged', () => {
  it('refuses a caller without document:view before asking for anything', async () => {
    adminAccess.mockResolvedValue({ granted: false, permissions: [] });

    await SearchPage({ searchParams: Promise.resolve({ q: 'quality' }) });

    expect(adminGet).not.toHaveBeenCalled();
  });
});
