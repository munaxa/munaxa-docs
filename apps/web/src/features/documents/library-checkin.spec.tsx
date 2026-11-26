import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { DocumentSummary } from '@edms/contracts';

import { renderWithProviders } from '../../test/a11y';
import { documentSummary, folder, library, listState } from '../../test/fixtures';
import { LibraryScreen } from './library-screen';

/**
 * Check in from the library — 26 Nov 2026.
 *
 * A document you checked out says so beside its title, and carries a Check in button there, so the
 * new file goes back without opening the record. The dialog is the record's own: the new file
 * becomes the next revision of the same document, so its fields stay as they are.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/documents',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('../revisions/revision-panel', () => ({
  CheckInDialog: ({ document }: { document: { id: string } }) => (
    <div role="dialog" aria-label="check-in dialog" data-document={document.id} />
  ),
}));

const ME = '019489f0-0000-7000-8000-00000000000a';
const OTHER = '019489f0-0000-7000-8000-00000000000b';
const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

function lock(
  lockedBy: string,
  expiresAt = FUTURE,
  lockedByName: string | null = 'Rana',
): DocumentSummary['liveLock'] {
  return {
    id: '019489f0-0000-7000-8000-000000000901',
    lockedBy,
    lockedByName,
    acquiredAt: '2026-11-26T10:00:00.000Z',
    expiresAt,
    draftRevisionId: null,
  };
}

const ROOT = folder({ id: 'root-id', parentId: null, isRoot: true, depth: 1, childCount: 0 });

function render(row: DocumentSummary, canCheckin = true): void {
  renderWithProviders(
    <LibraryScreen
      rows={[row]}
      total={1}
      view="folder"
      state={listState()}
      libraries={[library()]}
      folders={[ROOT]}
      folderPage={{ shown: 1, total: 1, hasMore: false }}
      selectedLibraryId={library().id}
      selectedFolderId={ROOT.id}
      selectedFolderName="Quality"
      documentTypes={[]}
      categories={[]}
      confidentialityLevels={[]}
      users={[]}
      departments={[]}
      filterOptions={{ types: null, confidentiality: null, currentUserId: ME }}
      canCreate
      canCheckin={canCheckin}
      canBulk={{ edit: true, restore: true, download: true }}
    />,
  );
}

const checkInButton = (): HTMLElement | null =>
  screen.queryByRole('button', { name: 'Check in Quality Manual' });

describe('check in from the library', () => {
  it('marks your own check-out and offers Check in beside it', () => {
    render(documentSummary({ liveLock: lock(ME) }));
    expect(screen.getByText('Checked out by you')).toBeTruthy();
    expect(checkInButton()).toBeTruthy();
  });

  it('opens the check-in dialog for that document', () => {
    const row = documentSummary({ liveLock: lock(ME) });
    render(row);
    fireEvent.click(checkInButton() as HTMLElement);
    expect(
      screen.getByRole('dialog', { name: 'check-in dialog' }).getAttribute('data-document'),
    ).toBe(row.id);
  });

  it("names someone else's check-out and offers no button", () => {
    render(documentSummary({ liveLock: lock(OTHER) }));
    expect(screen.getByText('Checked out by Rana')).toBeTruthy();
    expect(checkInButton()).toBeNull();
  });

  it('says only "Checked out" when the holder has no name', () => {
    render(documentSummary({ liveLock: lock(OTHER, FUTURE, null) }));
    expect(screen.getByText('Checked out')).toBeTruthy();
  });

  it('offers no button without the check-in permission', () => {
    render(documentSummary({ liveLock: lock(ME) }), false);
    expect(screen.getByText('Checked out by you')).toBeTruthy();
    expect(checkInButton()).toBeNull();
  });

  it('marks nothing on a document that is not checked out', () => {
    render(documentSummary());
    expect(screen.queryByText(/Checked out/)).toBeNull();
    expect(checkInButton()).toBeNull();
  });

  it('treats an expired check-out as no check-out', () => {
    render(documentSummary({ liveLock: lock(ME, PAST) }));
    expect(screen.queryByText(/Checked out/)).toBeNull();
    expect(checkInButton()).toBeNull();
  });
});
