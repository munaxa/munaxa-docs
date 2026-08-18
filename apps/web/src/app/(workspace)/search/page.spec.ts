import { Permission, type PermissionKey } from '@edms/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the search workspace asks the API for, and what it stops asking for — Slice 10.
 *
 * ## The defect this file pins down
 *
 * `/search` fetched seven things in one `Promise.all`. Four of them — the document types, the
 * categories, the departments and the entities — exist only to turn a facet's value into a name,
 * and every one sits behind `settings:manage` or `org:manage`. The seeded document controller and
 * auditor hold neither, so all four answered 403, one rejection discarded the whole server render,
 * and `/search` was the route error boundary for two of the three roles that can open it.
 *
 * Measured on the running stack before the fix: `document:view`, `/search`, `/search/saved` and
 * `/search/recent` all answered **200** for all three roles. The search API was never the problem.
 *
 * ## Why the assertions are the request set
 *
 * The same reason they are in `documents/page.spec.ts`: a render test cannot see any of this. The
 * page draws identically whether it asked for four datasets it had no right to, asked and was
 * refused, or never asked. These tests read the mocks' call lists, which is the thing that changed.
 *
 * And the previous defect survived twenty-five green search E2E tests because every one of them
 * ran as a fixture holding `ALL_PERMISSIONS`. Grants are a parameter here for exactly that reason.
 */

const { adminAccess, adminGet, adminRead } = vi.hoisted(() => ({
  adminAccess:
    vi.fn<
      (
        permission: PermissionKey,
      ) => Promise<{ readonly granted: boolean; readonly permissions: readonly PermissionKey[] }>
    >(),
  adminGet: vi.fn<(path: string) => Promise<unknown>>(),
  adminRead:
    vi.fn<(path: string) => Promise<{ ok: true; value: unknown } | { ok: false; code: string }>>(),
}));

vi.mock('../../../lib/admin/api', () => ({ adminAccess, adminGet, adminRead }));
vi.mock('../../../features/search/search-screen', () => ({ SearchScreen: () => null }));
vi.mock('../../../features/admin-shared', () => ({ AdminForbidden: () => null }));

const { default: SearchPage } = await import('./page');

/** The seeded grants that decide this page's behaviour, from `role-seed.ts`. */
const AUDITOR = [Permission.DOCUMENT_VIEW, Permission.SEARCH_ALL] as const;
const CONTROLLER = [...AUDITOR, Permission.CONFIGURATION_VIEW, Permission.DIRECTORY_VIEW] as const;
const TENANT_ADMIN = [...CONTROLLER, Permission.ORG_MANAGE, Permission.SETTINGS_MANAGE] as const;

/** The administrative endpoints a search user must never be made to depend on. */
const ADMINISTRATIVE = [
  '/admin/document-types',
  '/admin/categories',
  '/admin/departments',
  '/admin/entities',
];

/** A result set carrying a bucket in every facet the screen can label. */
function resultsWith(facets: Readonly<Record<string, readonly string[]>>, hits = 1) {
  return {
    data: Array.from({ length: hits }, (_, index) => ({
      id: `doc-${String(index)}`,
      documentTypeId: 'type-1',
      title: 'Quality Manual',
    })),
    meta: { total: hits, unrestricted: false },
    facets: Object.fromEntries(
      Object.entries(facets).map(([facet, values]) => [
        facet,
        values.map((value) => ({ value, count: 1 })),
      ]),
    ),
    nextCursor: null,
  };
}

const ALL_FACETS = {
  status: ['PUBLISHED'],
  type: ['type-1'],
  category: ['cat-1'],
  department: ['dep-1'],
  entity: ['ent-1'],
  year: ['2026'],
};

/** Renders the page for a caller holding exactly these grants, and reports what it asked for. */
async function requestsFor(
  permissions: readonly PermissionKey[],
  {
    params = {},
    facets = ALL_FACETS,
    hits = 1,
    refuse = [],
  }: {
    params?: Readonly<Record<string, string>>;
    facets?: Readonly<Record<string, readonly string[]>>;
    hits?: number;
    /** Paths whose label read answers `FORBIDDEN` however the capability check went. */
    refuse?: readonly string[];
  } = {},
): Promise<{ readonly requested: readonly string[]; readonly props: Record<string, unknown> }> {
  adminAccess.mockResolvedValue({ granted: true, permissions });
  adminGet.mockImplementation((path: string) =>
    Promise.resolve(path.startsWith('/search?') ? resultsWith(facets, hits) : { data: [] }),
  );
  adminRead.mockImplementation((path: string) =>
    Promise.resolve(
      refuse.some((prefix) => path.startsWith(prefix))
        ? { ok: false as const, code: 'FORBIDDEN' }
        : { ok: true as const, value: { data: [{ id: 'x-1', name: 'Resolved name' }] } },
    ),
  );

  const element = await SearchPage({ searchParams: Promise.resolve(params) });
  const props = (element as { props?: Record<string, unknown> } | null)?.props ?? {};

  return {
    requested: [
      ...adminGet.mock.calls.map(([path]) => path.split('?')[0] ?? path),
      ...adminRead.mock.calls.map(([path]) => path.split('?')[0] ?? path),
    ],
    props,
  };
}

/** Only the label reads, which is the set this slice is about. */
const labelReads = (requested: readonly string[]): readonly string[] =>
  requested.filter((path) => !path.startsWith('/search'));

beforeEach(() => {
  adminAccess.mockReset();
  adminGet.mockReset();
  adminRead.mockReset();
});

describe('A · the landing page, with nothing searched yet', () => {
  it('asks for the workspace and for no labels at all', async () => {
    /*
     * The facet rail is behind `facetsPresent(initialResults.facets, …)` and `initialResults` is
     * null until a query or a filter exists — so an empty `/search` rendered no facet and no result
     * card, and fetched four datasets to caption them anyway.
     */
    const { requested } = await requestsFor([...TENANT_ADMIN], { params: {} });

    expect(requested).toStrictEqual(['/search/saved', '/search/recent']);
    expect(labelReads(requested)).toStrictEqual([]);
  });

  it('does not run a search either', async () => {
    const { requested } = await requestsFor([...TENANT_ADMIN], { params: {} });
    expect(requested).not.toContain('/search');
  });

  it('reads nothing administrative, for the most privileged caller there is', async () => {
    const { requested } = await requestsFor([...TENANT_ADMIN], { params: {} });
    for (const path of ADMINISTRATIVE) {
      expect(requested).not.toContain(path);
    }
  });
});

describe('B · the auditor, searching', () => {
  it('asks for the workspace and stops there', async () => {
    /*
     * The role the defect was about. It holds `document:view` and `search:all` and no management
     * key at all — so before this slice it issued four requests it had no right to, was refused
     * four times, and got the error boundary. It now issues none of them.
     */
    const { requested } = await requestsFor([...AUDITOR], { params: { q: 'quality' } });

    expect(requested).toStrictEqual(['/search', '/search/saved', '/search/recent']);
    expect(labelReads(requested)).toStrictEqual([]);
  });

  it('touches no administrative endpoint', async () => {
    const { requested } = await requestsFor([...AUDITOR], { params: { q: 'quality' } });
    for (const path of ADMINISTRATIVE) {
      expect(requested, `${path} must not be a dependency of search`).not.toContain(path);
    }
  });

  it('touches no operational read model it does not hold the key for', async () => {
    // `configuration:view` and `directory:view` are held by the tenant administrator and the
    // document controller. The auditor was deliberately left out of both, so asking would be four
    // hundred and three again with a different path in it.
    const { requested } = await requestsFor([...AUDITOR], { params: { q: 'quality' } });

    expect(requested).not.toContain('/configuration/document-types');
    expect(requested).not.toContain('/configuration/categories');
    expect(requested).not.toContain('/directory/departments');
  });

  it('still renders, and hands the screen empty labels rather than none', async () => {
    // Empty maps, not `undefined`: `facetLabel` reads `labels?.[value] ?? value`, so the facets
    // show their raw values and stay pressable.
    const { props } = await requestsFor([...AUDITOR], { params: { q: 'quality' } });

    expect(props['initialResults']).not.toBeNull();
    expect(props['typeLabels']).toStrictEqual({});
    expect(props['categoryLabels']).toStrictEqual({});
    expect(props['departmentLabels']).toStrictEqual({});
    expect(props['entityLabels']).toStrictEqual({});
  });
});

describe('C · the document controller, searching', () => {
  it('uses the operational read models and never the administrative ones', async () => {
    const { requested } = await requestsFor([...CONTROLLER], { params: { q: 'quality' } });

    expect(requested).toStrictEqual([
      '/search',
      '/search/saved',
      '/search/recent',
      '/configuration/document-types',
      '/configuration/categories',
      '/directory/departments',
    ]);
  });

  it('does not ask for the entities, because it may not have them', async () => {
    /*
     * There is no operational read model for entities and this slice does not add one, so the
     * entity facet keeps its raw values for everybody below `org:manage`. That is the trade this
     * slice makes deliberately: a caption, against a workspace that opens at all.
     */
    const { requested, props } = await requestsFor([...CONTROLLER], { params: { q: 'quality' } });

    expect(requested).not.toContain('/admin/entities');
    expect(props['entityLabels']).toStrictEqual({});
  });

  it('resolves the labels it is entitled to', async () => {
    const { props } = await requestsFor([...CONTROLLER], { params: { q: 'quality' } });

    expect(props['typeLabels']).toStrictEqual({ 'x-1': 'Resolved name' });
    expect(props['categoryLabels']).toStrictEqual({ 'x-1': 'Resolved name' });
    expect(props['departmentLabels']).toStrictEqual({ 'x-1': 'Resolved name' });
  });
});

describe('D · the tenant administrator, searching', () => {
  it('keeps every label it had, entities included', async () => {
    const { requested, props } = await requestsFor([...TENANT_ADMIN], { params: { q: 'quality' } });

    expect(requested).toContain('/configuration/document-types');
    expect(requested).toContain('/configuration/categories');
    expect(requested).toContain('/directory/departments');
    expect(requested).toContain('/admin/entities');
    expect(props['entityLabels']).toStrictEqual({ 'x-1': 'Resolved name' });
  });

  it('reads the configuration rather than the administrative catalogue', async () => {
    // The types and the categories move to the read models even for a caller who could have had
    // the administrative ones: those return the numbering rule, the retention schedule and the
    // approval workflow to caption a facet.
    const { requested } = await requestsFor([...TENANT_ADMIN], { params: { q: 'quality' } });

    expect(requested).not.toContain('/admin/document-types');
    expect(requested).not.toContain('/admin/categories');
    expect(requested).not.toContain('/admin/departments');
  });
});

describe('a dataset is read only when something on screen needs it', () => {
  it('leaves out the facets this query did not produce', async () => {
    // Facets differ by query. A search with no department bucket has no use for the department
    // names, whoever is asking.
    const { requested } = await requestsFor([...TENANT_ADMIN], {
      params: { q: 'quality' },
      facets: { status: ['PUBLISHED'], type: ['type-1'] },
    });

    expect(requested).toContain('/configuration/document-types');
    expect(requested).not.toContain('/configuration/categories');
    expect(requested).not.toContain('/directory/departments');
    expect(requested).not.toContain('/admin/entities');
  });

  it('still resolves the types for result cards when no facet asked for them', async () => {
    // `ResultCard` prints the type chip from `typeLabels`, so the types are worth resolving
    // whenever there is a hit — with or without a `type` facet.
    const { requested } = await requestsFor([...TENANT_ADMIN], {
      params: { q: 'quality' },
      facets: { status: ['PUBLISHED'] },
      hits: 3,
    });

    expect(requested).toContain('/configuration/document-types');
  });

  it('asks for nothing when a search matched nothing', async () => {
    const { requested } = await requestsFor([...TENANT_ADMIN], {
      params: { q: 'nothing-matches' },
      facets: {},
      hits: 0,
    });

    expect(requested).toStrictEqual(['/search', '/search/saved', '/search/recent']);
  });

  it('runs for a filter with no query text, and labels it', async () => {
    const { requested } = await requestsFor([...TENANT_ADMIN], {
      params: { status: 'PUBLISHED' },
    });

    expect(requested).toContain('/search');
    expect(requested).toContain('/configuration/document-types');
  });
});

describe('E · a label read is refused anyway', () => {
  it('renders the workspace and falls back to raw values', async () => {
    /*
     * The capability check should make this impossible, and `permission_version` makes it possible
     * anyway: a role edit lands in the database while an outstanding token still carries the grants
     * it was minted with. For up to one access-token lifetime a caller can believe it holds a key
     * the API has already taken away — and that window must cost a caption, not the workspace.
     */
    const { props } = await requestsFor([...TENANT_ADMIN], {
      params: { q: 'quality' },
      refuse: ['/configuration/document-types'],
    });

    expect(props['initialResults']).not.toBeNull();
    expect(props['typeLabels']).toStrictEqual({});
    // Everything else still resolved: one refusal is one missing caption, not four.
    expect(props['categoryLabels']).toStrictEqual({ 'x-1': 'Resolved name' });
    expect(props['departmentLabels']).toStrictEqual({ 'x-1': 'Resolved name' });
  });

  it('survives every label read being refused at once', async () => {
    const { props } = await requestsFor([...TENANT_ADMIN], {
      params: { q: 'quality' },
      refuse: ['/configuration', '/directory', '/admin'],
    });

    expect(props['initialResults']).not.toBeNull();
    expect(props['typeLabels']).toStrictEqual({});
    expect(props['categoryLabels']).toStrictEqual({});
    expect(props['departmentLabels']).toStrictEqual({});
    expect(props['entityLabels']).toStrictEqual({});
  });
});

describe('F · a render-critical read fails', () => {
  it.each([
    ['the search itself', '/search?'],
    ['the saved searches', '/search/saved'],
    ['the recent searches', '/search/recent'],
  ])('still throws when %s is refused', async (_name, failing) => {
    /*
     * The half that must not move. Splitting the graph was to stop a *caption* discarding the
     * render — not to make the page paper over a search it could not run. All three carry
     * `document:view`, the key this page already gated on, so a refusal here is a real problem.
     */
    adminAccess.mockResolvedValue({ granted: true, permissions: [...TENANT_ADMIN] });
    adminRead.mockResolvedValue({ ok: true, value: { data: [] } });
    adminGet.mockImplementation((path: string) =>
      path.startsWith(failing)
        ? Promise.reject(new Error('Forbidden'))
        : Promise.resolve(path.startsWith('/search?') ? resultsWith(ALL_FACETS) : { data: [] }),
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
    expect(adminRead).not.toHaveBeenCalled();
  });
});
