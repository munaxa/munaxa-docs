import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReportExport } from '@edms/contracts';
import { ar, en } from '@edms/i18n';

import { renderWithProviders } from '../../test/a11y';
import { ReportsScreen } from './reports-screen';

/**
 * Taking a report export — ADR-0026 §10, the export design §3.2.
 *
 * The list is tenant-wide, the file is its requester's (E-11): Download is offered exactly where the
 * API says this person may take it. A file too large to verify says so instead. And the download is
 * a navigation to the verified link, as a document's is — no popup a browser could block (E-12).
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/reports',
  useSearchParams: () => new URLSearchParams(),
}));

const download = vi.fn();
vi.mock('./actions', () => ({
  downloadReportExport: (id: string) => download(id) as unknown,
  requestReportExport: vi.fn(),
  saveReportDefinition: vi.fn(),
  deleteReportDefinition: vi.fn(),
}));

function anExport(overrides: Partial<ReportExport>): ReportExport {
  return {
    id: '0199f5a1-5a9e-7000-8000-00000000c0e1',
    reportKey: 'documents',
    format: 'CSV',
    state: 'COMPLETED',
    parameters: {},
    requestedAt: '2026-10-15T09:00:00.000Z',
    rowCount: 12,
    sizeBytes: 2_048,
    sha256: 'a'.repeat(64),
    truncated: false,
    substitutions: 0,
    completedAt: '2026-10-15T09:00:05.000Z',
    error: null,
    downloadable: true,
    tooLargeToDownload: false,
    ...overrides,
  };
}

function render(exports: readonly ReportExport[], locale: 'en' | 'ar' = 'en') {
  renderWithProviders(
    <ReportsScreen reports={[]} selected={null} page={null} definitions={[]} exports={exports} />,
    locale,
  );
}

const original = window.location;
const assign = vi.fn();
const open = vi.fn();

beforeEach(() => {
  download.mockReset();
  assign.mockReset();
  open.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...original, assign },
  });
  vi.spyOn(window, 'open').mockImplementation(open);
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: original });
  vi.restoreAllMocks();
});

describe('a report export on the reports screen', () => {
  it('offers Download only on the person’s own exports, never on somebody else’s (E-11)', () => {
    render([
      anExport({ id: '0199f5a1-5a9e-7000-8000-00000000c0e1' }),
      anExport({ id: '0199f5a1-5a9e-7000-8000-00000000c0e2', downloadable: false }),
    ]);
    expect(screen.getAllByRole('button', { name: en.reports.exports.download })).toHaveLength(1);
  });

  it('says a file is too large to download instead of offering a button that would fail', () => {
    render([anExport({ downloadable: false, tooLargeToDownload: true })]);
    expect(screen.getByText(en.reports.exports.tooLarge)).not.toBeNull();
    expect(screen.queryByRole('button', { name: en.reports.exports.download })).toBeNull();
  });

  it('says so in Arabic too', () => {
    render([anExport({ downloadable: false, tooLargeToDownload: true })], 'ar');
    expect(screen.getByText(ar.reports.exports.tooLarge)).not.toBeNull();
  });

  it('downloads by navigating to the verified link, with no popup to be blocked', async () => {
    const url = 'https://docs.example.test/api/v1/downloads?token=abc';
    download.mockResolvedValue({
      ok: true,
      value: { url, expiresAt: '2026-10-15T09:01:00.000Z', filename: 'documents.csv' },
    });
    render([anExport({})]);

    fireEvent.click(screen.getByRole('button', { name: en.reports.exports.download }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(url);
    });
    expect(download).toHaveBeenCalledWith('0199f5a1-5a9e-7000-8000-00000000c0e1');
    expect(open).not.toHaveBeenCalled();
  });
});
