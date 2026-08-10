import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../test/a11y';
import { documentSummary, library, listState, folder } from '../../test/fixtures';
import { LibraryScreen } from './library-screen';

/**
 * Plural messages, as a reader actually receives them — Phase 7.4.
 *
 * ## Why this file exists rather than a screenshot
 *
 * The library's row count is the string Phase 7.3 named: it rendered **"1 rows"**. After the plural
 * migration it renders "1 row", and the visual suite **did not notice**. That is not a bug in the
 * migration; it is the harness working as configured. `matchesBaseline` tolerates up to 120 changed
 * pixels so that font antialiasing does not fail a build, and a dropped "s" at this size is about
 * sixty-six. The screenshot could not see the fix, and would not have seen the defect either.
 *
 * So the assertion is made where it can be seen: against the rendered text of the real screen,
 * through the real provider tree, with the real catalogue. This is the client-side half of the
 * plural path — `useTranslate` → `translatorFor` → `Intl.PluralRules` — end to end.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/documents',
  useSearchParams: () => new URLSearchParams(),
}));

function renderLibrary(rowCount: number): void {
  const rows = Array.from({ length: rowCount }, (_, index) =>
    documentSummary({ id: `doc-${String(index)}`, documentNumber: `QM-000${String(index)}` }),
  );
  renderWithProviders(
    <LibraryScreen
      rows={rows}
      total={rowCount}
      state={listState()}
      libraries={[library()]}
      folders={[folder()]}
      selectedLibraryId={library().id}
      selectedFolderId={folder().id}
      selectedFolderName="Procedures"
      documentTypes={[]}
      categories={[]}
      confidentialityLevels={[]}
      users={[]}
      departments={[]}
      canCreate
      canBulk={{ edit: true, restore: true, download: true }}
    />,
  );
}

describe('the document library counts its rows in English', () => {
  it('says "1 row", not "1 rows"', () => {
    renderLibrary(1);
    expect(screen.getByText('1 row')).toBeTruthy();
    expect(screen.queryByText('1 rows')).toBeNull();
  });

  it('says "2 rows"', () => {
    renderLibrary(2);
    expect(screen.getByText('2 rows')).toBeTruthy();
  });

  it('says "0 rows" for an empty folder', () => {
    // The category English uses for zero is `other`, so this is the same form as two — asserted
    // because "0 row" is the failure a hand-rolled `count === 1` check produces at the other end.
    renderLibrary(0);
    expect(screen.getByText('0 rows')).toBeTruthy();
  });
});
