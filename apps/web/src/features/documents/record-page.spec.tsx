import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DomainError, ErrorCode, Permission } from '@edms/domain';

import { renderWithProviders } from '../../test/a11y';
import { document as documentFixture } from '../../test/fixtures';

/**
 * The record page's two Phase 7.1C properties, asserted against the real page function and the real
 * screen.
 *
 * Phase 7.1B proved that opening one document cost **fifteen API requests**, seven of them for two
 * dialogues nobody had opened, and that the fifteenth crossed the caller's `default` rate limit and
 * reached the route error boundary as "Something went wrong". Both halves of that are regressions
 * waiting to happen — a future `Promise.all` entry restores the fan-out, and a future `throw`
 * restores the boundary — so both are pinned here.
 *
 * The API module is stubbed because this is a test of *the page's own decisions*: what it fetches,
 * and what it renders when a fetch is refused. The unstubbed path is the E2E suite's, which boots a
 * real API and a real database and is where "the record page loads" is actually proved.
 */

const adminAccess = vi.fn();
const adminGet = vi.fn();
const loadEditOptions = vi.fn();
const loadMoveOptions = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  notFound: () => {
    throw new Error('notFound');
  },
}));

vi.mock('../../lib/admin/api', () => ({
  adminAccess: (...args: unknown[]) => adminAccess(...args) as unknown,
  adminGet: (...args: unknown[]) => adminGet(...args) as unknown,
}));

vi.mock('./actions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadEditOptions: (...args: unknown[]) => loadEditOptions(...args) as unknown,
  loadMoveOptions: (...args: unknown[]) => loadMoveOptions(...args) as unknown,
}));

const { default: DocumentPage } = await import('../../app/(workspace)/documents/[documentId]/page');
const { DocumentScreen } = await import('./document-screen');

const ALL_PERMISSIONS = Object.values(Permission);

function grantEverything(): void {
  adminAccess.mockResolvedValue({ granted: true, permissions: ALL_PERMISSIONS });
}

beforeEach(() => {
  vi.clearAllMocks();
  adminGet.mockImplementation((path: string) => {
    if (path === '/documents/doc-1') {
      return Promise.resolve(documentFixture({}));
    }
    if (path.endsWith('/workflow')) {
      return Promise.resolve({ availableTransitions: [], stages: [] });
    }
    if (path.endsWith('/revisions')) {
      return Promise.resolve({ revisions: [] });
    }
    if (path === '/auth/mfa') {
      return Promise.resolve({ enrolled: false });
    }
    return Promise.resolve(null);
  });
});

describe('the record page’s request fan-out', () => {
  it('asks for nothing the two closed dialogues would need', async () => {
    grantEverything();

    await DocumentPage({ params: Promise.resolve({ documentId: 'doc-1' }) });

    const asked = adminGet.mock.calls.map(([path]) => path as string);
    // The seven Phase 7.1B measured and Phase 7.1C deferred. Each is a *tenant catalogue* — the
    // same answer for every document in the tenant — fetched to fill a picker in a dialogue that
    // opens from the overflow menu and is closed on arrival.
    for (const deferred of [
      '/admin/folders',
      '/admin/categories',
      '/admin/confidentiality-levels',
      '/admin/users',
      '/admin/departments',
      '/admin/fields',
      '/admin/document-types',
    ]) {
      expect(asked.some((path) => path.startsWith(deferred))).toBe(false);
    }
  });

  it('still asks for everything the page itself renders', async () => {
    grantEverything();

    await DocumentPage({ params: Promise.resolve({ documentId: 'doc-1' }) });

    const asked = adminGet.mock.calls.map(([path]) => path as string);
    // The record, its approval, its revisions, its viewer manifest, its signatures, and whether
    // this caller owes a second factor. Nothing here was traded away for the reduction above.
    expect(asked).toEqual(
      expect.arrayContaining([
        '/documents/doc-1',
        '/documents/doc-1/workflow',
        '/documents/doc-1/revisions',
        '/documents/doc-1/preview',
        '/documents/doc-1/signatures',
        '/auth/mfa',
      ]),
    );
  });

  it('loads the properties pickers only when somebody opens that dialogue', async () => {
    loadEditOptions.mockResolvedValue({
      ok: true,
      value: {
        categories: [],
        confidentialityLevels: [],
        users: [],
        departments: [],
        fields: [],
      },
    });

    renderWithProviders(
      (
        <DocumentScreen
          document={documentFixture({})}
          canEdit
          canMove={false}
          canDownload={false}
        />
      ) as ReactElement,
    );

    expect(loadEditOptions).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit properties' }));

    expect(loadEditOptions).toHaveBeenCalledTimes(1);
  });
});

describe('what the record page does with a refused read', () => {
  it('renders a rate-limit state rather than the generic error boundary', async () => {
    grantEverything();
    adminGet.mockImplementation((path: string) =>
      path === '/documents/doc-1'
        ? Promise.reject(new DomainError(ErrorCode.RATE_LIMITED, 'Too many requests.'))
        : Promise.resolve(null),
    );

    const rendered = await DocumentPage({
      params: Promise.resolve({ documentId: 'doc-1' }),
    });
    renderWithProviders(rendered as ReactElement);

    // The reader is told what actually happened and what to do about it, in the API's own words.
    expect(screen.getByText('Too many requests')).toBeTruthy();
    expect(screen.getByText('Too many requests. Wait a moment and try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // And is *not* told the untrue thing the route error boundary would have said.
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });

  it('still throws every other failure, so the error boundary keeps its job', async () => {
    grantEverything();
    adminGet.mockImplementation((path: string) =>
      path === '/documents/doc-1'
        ? Promise.reject(new DomainError(ErrorCode.INTERNAL, 'boom'))
        : Promise.resolve(null),
    );

    await expect(
      DocumentPage({ params: Promise.resolve({ documentId: 'doc-1' }) }),
    ).rejects.toThrowError();
  });
});
