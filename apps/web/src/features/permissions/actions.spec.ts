import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the subject pickers ask the API for — Slice 13.
 *
 * ## The defect this file pins down
 *
 * Both pickers were `<select>` elements filled from one page of a hundred options fetched with the
 * page, and nothing ever sent `search`. A tenant with more than a hundred people has people the
 * picker could not offer: they sort after position 100 by display name, and a native `<select>` has
 * no way to ask for more. The operational read models had accepted `search` since they were
 * written.
 *
 * ## Why the assertions are the request
 *
 * A render test cannot see the difference between a picker that searches the server and one that
 * filters a hundred rows it already had — both show matching names for a term that matches
 * something inside the first hundred. The difference only appears in the request, and only for a
 * term that matches something outside it. So these read the mock's call list, and the real-stack
 * suite proves the >100 case against a database.
 */

const { adminRead, adminWrite } = vi.hoisted(() => ({
  adminRead: vi.fn<(path: string) => Promise<unknown>>(),
  adminWrite: vi.fn<(request: unknown) => Promise<unknown>>(),
}));

vi.mock('../../lib/admin/api', () => ({ adminRead, adminWrite }));
// `validated` pulls in `server-only`, which has no module outside a Next build. The write actions
// beside this one need it; the read action under test does not.
vi.mock('../../lib/admin/validated', () => ({ validated: () => Promise.resolve({ ok: true }) }));

const { searchAclSubjects } = await import('./actions');

/** Every administrative catalogue a picker must never reach for. */
const FORBIDDEN = ['/admin/users', '/admin/roles', '/admin/departments', '/admin/entities'];

function parse(path: string): { readonly route: string; readonly params: URLSearchParams } {
  const [route = path, query = ''] = path.split('?');
  return { route, params: new URLSearchParams(query) };
}

async function requested(
  subjectType: string,
  term: string,
  rows: readonly Record<string, unknown>[] = [],
): Promise<{ readonly route: string; readonly params: URLSearchParams; readonly value: unknown }> {
  adminRead.mockResolvedValue({ ok: true, value: { data: rows } });
  const result = await searchAclSubjects(subjectType, term);
  const path = adminRead.mock.calls[0]?.[0] ?? '';
  return { ...parse(path), value: (result as { value?: unknown }).value };
}

beforeEach(() => {
  adminRead.mockReset();
  adminWrite.mockReset();
});

describe('each subject type asks its own operational read model', () => {
  it.each([
    ['a person', 'USER', '/directory/people', 'displayName'],
    ['a role', 'ROLE', '/acl/roles', 'name'],
    ['a department', 'DEPARTMENT', '/directory/departments', 'name'],
  ])('sends %s to the right route, sorted by its own label', async (_what, type, route, sortBy) => {
    const { route: asked, params } = await requested(type, 'amal');

    expect(asked).toBe(route);
    expect(params.get('sortBy')).toBe(sortBy);
    expect(params.get('sortDirection')).toBe('asc');
  });

  it.each([
    ['a person', 'USER'],
    ['a role', 'ROLE'],
    ['a department', 'DEPARTMENT'],
  ])('never reaches an administrative catalogue for %s', async (_what, type) => {
    const { route } = await requested(type, 'amal');

    for (const path of FORBIDDEN) {
      expect(route, `${path} must not be a picker dependency`).not.toBe(path);
    }
  });
});

describe('the search itself', () => {
  it('sends the term to the server rather than filtering here', async () => {
    // The whole slice, in one assertion: the term leaves the browser. A picker that filtered
    // locally would issue the same request with no `search` on it, whatever the person typed.
    const { params } = await requested('USER', 'amal');

    expect(params.get('search')).toBe('amal');
  });

  it('trims what was typed, because the schema does and a space is not a search', async () => {
    const { params } = await requested('USER', '  amal  ');

    expect(params.get('search')).toBe('amal');
  });

  it('omits the term entirely when the box is empty', async () => {
    /*
     * `searchTermSchema` requires at least one character, so `search=` would be a 400. An empty box
     * means the unfiltered first page, which is what an opened picker should show — the same list
     * the page already fetched.
     */
    const { params } = await requested('USER', '   ');

    expect(params.has('search')).toBe(false);
  });

  it('asks for one page, at the maximum the API will accept and no more', async () => {
    /*
     * 100 is `MAX_PAGE_SIZE`, and `pageQuerySchema` **rejects** anything above it rather than
     * clamping — so there is no spelling of "give me the whole catalogue" for this or any other
     * caller to send. The bound is the server's; this asserts the client does not try to exceed it.
     */
    const { params } = await requested('USER', 'amal');

    expect(params.get('page')).toBe('1');
    expect(params.get('pageSize')).toBe('100');
    expect(Number(params.get('pageSize'))).toBeLessThanOrEqual(100);
  });

  it('never asks for deleted records — the operational schema has no word for it', async () => {
    const { params } = await requested('DEPARTMENT', 'quality');

    expect(params.has('deleted')).toBe(false);
  });
});

describe('what comes back', () => {
  it('reads a person by displayName and a role by name, into one shape', async () => {
    const people = await requested('USER', 'a', [{ id: 'u-1', displayName: 'Amal Haddad' }]);
    const roles = await requested('ROLE', 'a', [{ id: 'r-1', name: 'Auditor' }]);

    expect(people.value).toStrictEqual([{ id: 'u-1', name: 'Amal Haddad' }]);
    expect(roles.value).toStrictEqual([{ id: 'r-1', name: 'Auditor' }]);
  });

  it('is an empty list when nothing matches, not an error', async () => {
    const { value } = await requested('USER', 'nobody at all', []);

    expect(value).toStrictEqual([]);
  });

  it('hands a refusal back as a result rather than throwing', async () => {
    // The picker degrades to "no new matches" on a refusal, which is a narrowing of something the
    // caller can already see. Throwing here would take the whole screen down for a dropdown.
    adminRead.mockResolvedValue({ ok: false, code: 'FORBIDDEN' });

    await expect(searchAclSubjects('USER', 'amal')).resolves.toMatchObject({ ok: false });
  });
});
