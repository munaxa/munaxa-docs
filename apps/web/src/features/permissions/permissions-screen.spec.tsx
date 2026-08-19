import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { StoredAclEntry } from '@edms/contracts';
import { AclEffect, AclSubjectType, Permission } from '@edms/domain';

import { expectAccessible, expectNoViolations, renderWithProviders } from '../../test/a11y';
import { PermissionsScreen } from './permissions-screen';

/** The one action the pickers call. Every other action on this screen is a write and unused here. */
const { searchAclSubjects } = vi.hoisted(() => ({
  searchAclSubjects: vi.fn<(subjectType: string, term: string) => Promise<unknown>>(),
}));

vi.mock('./actions', () => ({
  searchAclSubjects,
  replaceScopeAcl: vi.fn(),
  setFolderInheritance: vi.fn(),
}));

// A promise by default, for every test in this file: `Combobox` debounces, so a search can be in
// flight while a later test is setting up, and a mock with no implementation returns `undefined`.
searchAclSubjects.mockImplementation(() => Promise.resolve({ ok: true, value: [] }));

/**
 * Who an entry names, as the table says it — Slice 12.
 *
 * ## Why this file exists
 *
 * The screen used to caption its entries by looking each subject up in the three picker pools, and
 * those pools came from `/admin/users`, `/admin/roles` and `/admin/departments` — `user:manage`,
 * `role:manage` and `org:manage`. The seeded document controller holds `document:permission:manage`
 * and none of the three, so the page threw before it could render at all.
 *
 * The caption now arrives on the entry, and the pools are only pickers. That is a claim about what
 * this component reads, and the page-level request test cannot make it: the page passes `explicit`
 * straight through, so a screen that quietly went back to the pool would keep every one of those
 * tests green while showing an administrator a raw identifier — or, worse, showing them nothing
 * they could recognise on the screen where they decide who may read a document.
 *
 * So the assertions below are deliberately about a rendered *name* with **empty pools**. Any
 * implementation that resolves through a pool fails them.
 */

const NOBODY: readonly { readonly id: string; readonly name: string }[] = [];

function entry(overrides: Partial<StoredAclEntry> = {}): StoredAclEntry {
  return {
    id: '019489f0-0000-7000-8000-0000000000e1',
    scopeType: 'DOCUMENT',
    scopeId: '019489f0-0000-7000-8000-000000000001',
    subjectType: AclSubjectType.ROLE,
    subjectId: '019489f0-0000-7000-8000-0000000000r1',
    permission: Permission.DOCUMENT_VIEW,
    effect: AclEffect.ALLOW,
    createdAt: '2026-08-17T00:00:00.000Z',
    createdBy: null,
    ...overrides,
  };
}

function screenFor(entries: readonly StoredAclEntry[]) {
  return (
    <PermissionsScreen
      scopeType="DOCUMENT"
      scopeId="019489f0-0000-7000-8000-000000000001"
      documentTitle="Quality Manual"
      explicit={entries}
      chain={[{ type: 'LIBRARY', id: 'lib-1', name: 'Quality', breaksInheritance: false }]}
      inheritanceBroken={false}
      effective={null}
      subjectUserId={null}
      // Empty on purpose: a caller who cannot fill a picker must still read the table.
      people={NOBODY}
      roles={NOBODY}
      departments={NOBODY}
      canManage
      folderId="fol-1"
      folderInherits
    />
  );
}

function render(entries: readonly StoredAclEntry[]): HTMLElement {
  cleanup();
  return renderWithProviders(screenFor(entries));
}

describe('the entries table names its subjects without any picker', () => {
  it.each([
    ['a role', AclSubjectType.ROLE, 'Document controller'],
    ['a person', AclSubjectType.USER, 'Ada Lovelace'],
    ['a department', AclSubjectType.DEPARTMENT, 'Quality Assurance'],
  ])('shows the name the server resolved for %s', (_what, subjectType, subjectName) => {
    render([entry({ subjectType, subjectName })]);

    expect(screen.getByText(subjectName)).toBeTruthy();
  });

  it('falls back to the identifier when the server had no name to give', () => {
    /*
     * An entry outlives its subject — `PermissionService.validate` never checks that the identifier
     * names anything — and this is the case an administrator most needs to see, because a stale
     * entry showing a raw identifier is the one they should revoke. A blank cell would hide it.
     */
    const orphan = entry({ subjectId: '019489f0-0000-7000-8000-00000000dead' });
    render([orphan]);

    expect(screen.getByText(orphan.subjectId)).toBeTruthy();
  });

  it('stays accessible with the pickers empty', async () => {
    // The degraded state is a real state now, so it is one the axe pass has to cover: a `<select>`
    // with only its placeholder is still a labelled control an administrator will tab through.
    cleanup();

    await expectAccessible(screenFor([entry({ subjectName: 'Document controller' })]));
  });
});

/**
 * Choosing a subject out of more than the picker was handed — Slice 13.
 *
 * The picker was a `<select>` filled from one page of a hundred, so a tenant with more people than
 * that had people it could not offer. It is a `Combobox` handed `onSearch`, which switches its own
 * local filtering off and asks the server instead — the difference between filtering a hundred rows
 * in the browser and asking about all of them.
 *
 * The assertions below are deliberately about a name that is **not** in the options the component
 * was rendered with. Any implementation that filters what it was given fails them.
 */
describe('the subject picker searches the server', () => {
  const FIRST_PAGE = [{ id: 'r-1', name: 'Auditor' }];
  /** Sorts far past any first page, and is in nothing this component was rendered with. */
  const BEYOND = { id: 'r-999', name: 'Zulu Reviewer' };

  beforeEach(() => {
    // Cleared rather than reset: `Combobox` debounces, so a timer from the previous test can still
    // fire during this one's setup, and `mockReset` would leave the mock returning `undefined` in
    // the window between the reset and the next implementation being set.
    searchAclSubjects.mockClear();
    searchAclSubjects.mockImplementation(() => Promise.resolve({ ok: true, value: [BEYOND] }));
  });

  function renderWithRoles() {
    cleanup();
    return renderWithProviders(
      <PermissionsScreen
        scopeType="DOCUMENT"
        scopeId="019489f0-0000-7000-8000-000000000001"
        documentTitle="Quality Manual"
        explicit={[]}
        chain={[{ type: 'LIBRARY', id: 'lib-1', name: 'Quality', breaksInheritance: false }]}
        inheritanceBroken={false}
        effective={null}
        subjectUserId={null}
        people={NOBODY}
        roles={FIRST_PAGE}
        departments={NOBODY}
        canManage
        folderId="fol-1"
        folderInherits
      />,
    );
  }

  /** Opens the subject combobox and returns its search box. */
  async function openSubjectPicker() {
    const user = userEvent.setup();
    renderWithRoles();
    const trigger = screen.getByRole('combobox', { name: 'Subject' });
    await user.click(trigger);
    return { user, box: await screen.findByPlaceholderText('Search') };
  }

  it('offers what the page already fetched before anybody types', async () => {
    await openSubjectPicker();

    expect(screen.getByText('Auditor')).toBeTruthy();
    expect(searchAclSubjects).not.toHaveBeenCalled();
  });

  it('finds a subject that was never in its options', async () => {
    // The >100 case in miniature: `Zulu Reviewer` is in no list this component was handed, and it
    // appears because the server was asked. A locally-filtering picker cannot pass this.
    const { user, box } = await openSubjectPicker();

    await user.type(box, 'zulu');

    await waitFor(() => {
      expect(searchAclSubjects).toHaveBeenCalledWith('ROLE', 'zulu');
    });
    expect(await screen.findByText('Zulu Reviewer')).toBeTruthy();
  });

  it('keeps the chosen subject named after the search moves on', async () => {
    /*
     * `Combobox` renders its trigger from `options.find((o) => o.value === value)`, so an option
     * that falls out of the result set takes its label with it — you would choose somebody, type
     * something else, and watch the trigger fall back to "Choose…" while still holding their id.
     * The selection was never in doubt; the label has to be kept alive deliberately.
     */
    const { user, box } = await openSubjectPicker();
    await user.type(box, 'zulu');
    await user.click(await screen.findByText('Zulu Reviewer'));

    searchAclSubjects.mockResolvedValue({ ok: true, value: [{ id: 'r-2', name: 'Approver' }] });
    await user.click(screen.getByRole('combobox', { name: 'Subject' }));
    const again = await screen.findByPlaceholderText('Search');
    await user.clear(again);
    await user.type(again, 'appr');
    await waitFor(() => {
      expect(screen.queryByText('Approver')).not.toBeNull();
    });

    expect(
      screen.getByRole('combobox', { name: 'Subject' }).textContent,
      'the chosen subject lost its name when the search changed',
    ).toContain('Zulu Reviewer');
  });

  it('ignores a reply that is no longer the current search', async () => {
    /*
     * Typing "zu" then "zulu" issues two requests and the network owes them no order. Without a
     * sequence number the slower first reply lands last and repopulates the list with the wrong
     * thing under the right query — a stale selection offered as a match.
     */
    let releaseStale: (value: unknown) => void = () => {};
    searchAclSubjects.mockImplementation((_type: string, term: string) =>
      term === 'zulu'
        ? Promise.resolve({ ok: true, value: [BEYOND] })
        : // Every earlier, shorter term is held open, so its reply can be delivered *after* the
          // final one has already landed — which is the ordering a network is free to choose.
          new Promise((resolve) => (releaseStale = resolve)),
    );

    const { user, box } = await openSubjectPicker();
    await user.type(box, 'zulu');
    expect(await screen.findByText('Zulu Reviewer')).toBeTruthy();

    releaseStale({ ok: true, value: [{ id: 'stale', name: 'A Stale Match' }] });
    await waitFor(() => {
      expect(screen.queryByText('Zulu Reviewer')).not.toBeNull();
    });

    expect(
      screen.queryByText('A Stale Match'),
      'a superseded reply repopulated the list',
    ).toBeNull();
  });

  it('leaves the list alone when the search is refused', async () => {
    // A narrowing of something the caller can already see. An emptied picker would read as "this
    // tenant has nobody", which is a statement about the tenant rather than about the request.
    searchAclSubjects.mockResolvedValue({ ok: false, code: 'FORBIDDEN' });
    const { user, box } = await openSubjectPicker();

    await user.type(box, 'zulu');
    await waitFor(() => {
      expect(searchAclSubjects).toHaveBeenCalled();
    });

    expect(screen.getByText('Auditor')).toBeTruthy();
  });

  it('selects with the keyboard alone', async () => {
    // APG combobox: focus stays in the search box and the arrows move `aria-activedescendant`, so
    // a person who never touches a pointer must still be able to grant a permission.
    const { user, box } = await openSubjectPicker();

    await user.type(box, 'zulu');
    await screen.findByText('Zulu Reviewer');
    await user.keyboard('{ArrowDown}{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Subject' }).textContent).toContain(
        'Zulu Reviewer',
      );
    });
  });

  it('stays accessible with the picker open', async () => {
    const user = userEvent.setup();
    const container = renderWithRoles();
    await user.click(screen.getByRole('combobox', { name: 'Subject' }));
    await screen.findByPlaceholderText('Search');

    // The panel is portalled outside the render container, so both are checked: the trigger in
    // place, and the listbox wherever Radix put it.
    await expectNoViolations(container);
    await expectNoViolations(document.body);
  });
});

/**
 * The picker in Arabic — Slice 13.
 *
 * A searching control is where right-to-left usually goes wrong, because it mixes a typed query
 * with results that may be Latin, Arabic or both. Nothing here is a new string: the labels are
 * `admin.list.search`, `admin.list.emptySearch` and `permissions.choose`, all of which the Arabic
 * catalogue has carried since Administration was built, and the names come from the fixture rather
 * than being invented for the test.
 */
describe('the picker in Arabic', () => {
  const ARABIC = { id: 'r-ar', name: 'مدقق' };
  const LATIN = { id: 'r-en', name: 'Zulu Reviewer' };

  beforeEach(() => {
    searchAclSubjects.mockClear();
    searchAclSubjects.mockImplementation(() =>
      Promise.resolve({ ok: true, value: [ARABIC, LATIN] }),
    );
  });

  function renderArabic() {
    cleanup();
    return renderWithProviders(
      <PermissionsScreen
        scopeType="DOCUMENT"
        scopeId="019489f0-0000-7000-8000-000000000001"
        documentTitle="Quality Manual"
        explicit={[]}
        chain={[{ type: 'LIBRARY', id: 'lib-1', name: 'Quality', breaksInheritance: false }]}
        inheritanceBroken={false}
        effective={null}
        subjectUserId={null}
        people={NOBODY}
        roles={[ARABIC]}
        departments={NOBODY}
        canManage
        folderId="fol-1"
        folderInherits
      />,
      'ar',
    );
  }

  it('labels the search box from the Arabic catalogue', async () => {
    const user = userEvent.setup();
    renderArabic();

    await user.click(screen.getByRole('combobox', { name: 'الجهة' }));

    expect(await screen.findByPlaceholderText('بحث')).toBeTruthy();
  });

  it('returns an Arabic name and a Latin one from the same search', async () => {
    // A tenant's staff are not all in one script, and the result list has to carry both without
    // either being reordered into the other's direction.
    const user = userEvent.setup();
    renderArabic();
    await user.click(screen.getByRole('combobox', { name: 'الجهة' }));

    await user.type(await screen.findByPlaceholderText('بحث'), 'r');

    // The Latin name first: it is in no initial list, so finding it is what proves the search
    // landed. `مدقق` is also the seeded option, so waiting on it would prove nothing.
    expect(await screen.findByText('Zulu Reviewer')).toBeTruthy();
    expect(screen.getByText('مدقق')).toBeTruthy();
  });

  it('says nothing matched in Arabic', async () => {
    searchAclSubjects.mockImplementation(() => Promise.resolve({ ok: true, value: [] }));
    const user = userEvent.setup();
    renderArabic();
    await user.click(screen.getByRole('combobox', { name: 'الجهة' }));

    await user.type(await screen.findByPlaceholderText('بحث'), 'لا شيء');

    expect(await screen.findByText('لا نتائج مطابقة لهذا البحث')).toBeTruthy();
  });

  it('stays accessible right to left with the picker open', async () => {
    const user = userEvent.setup();
    const container = renderArabic();
    await user.click(screen.getByRole('combobox', { name: 'الجهة' }));
    await screen.findByPlaceholderText('بحث');

    await expectNoViolations(container);
    await expectNoViolations(document.body);
  });
});
