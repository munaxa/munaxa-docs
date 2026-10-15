import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BulkExportItems, BulkOperationResult } from '@edms/contracts';
import { ar, en } from '@edms/i18n';

import { renderWithProviders } from '../../test/a11y';
import { BulkResultDialog } from './bulk-panel';

/**
 * A bulk export's released documents — ADR-0026 §10, the export design §3.1.
 *
 * The dialog used to fetch a column of five-minute store URLs at once. Now it lists what the API
 * says the person may see now — with no URL — and each Download issues its own verified link,
 * followed by navigation. Unavailable documents say why; documents the person can no longer see
 * are only a count.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const items = vi.fn();
const itemLink = vi.fn();
const manifestLink = vi.fn();
vi.mock('./bulk-actions', () => ({
  bulkExportItems: (id: string, page: number) => items(id, page) as unknown,
  bulkExportItemLink: (id: string, documentId: string) => itemLink(id, documentId) as unknown,
  bulkExportManifestLink: (id: string) => manifestLink(id) as unknown,
  bulkSetMetadata: vi.fn(),
}));

const OPERATION = '0199f5a1-5a9e-7000-8000-00000000c0a1';
const DOC_A = '0199f5a1-5a9e-7000-8000-00000000d0a1';
const DOC_B = '0199f5a1-5a9e-7000-8000-00000000d0b1';

const RESULT: BulkOperationResult = {
  operationId: OPERATION,
  kind: 'EXPORT',
  state: 'COMPLETED',
  tally: { requested: 3, applied: 2, refused: 1, blocked: 0, failed: 0 },
  items: [],
};

function listing(overrides: Partial<BulkExportItems> = {}): BulkExportItems {
  return {
    operationId: OPERATION,
    tally: RESULT.tally,
    hidden: 1,
    manifestAvailable: true,
    data: [
      {
        documentId: DOC_A,
        documentNumber: 'QA-014',
        title: 'Procedure',
        filename: 'qa-014.pdf',
        sizeBytes: 10,
        exportedRevisionLabel: 'Rev 2',
        currentRevisionLabel: 'Rev 3',
        available: true,
        unavailableReason: null,
      },
      {
        documentId: DOC_B,
        documentNumber: 'QA-015',
        title: 'Drawing',
        filename: 'qa-015.pdf',
        sizeBytes: 10,
        exportedRevisionLabel: 'Rev 1',
        currentRevisionLabel: 'Rev 1',
        available: false,
        unavailableReason: 'INTEGRITY_FAILED',
      },
    ],
    meta: { page: 1, pageSize: 50, total: 2, hasMore: false },
    ...overrides,
  };
}

const original = window.location;
const assign = vi.fn();
const open = vi.fn();

beforeEach(() => {
  for (const mock of [items, itemLink, manifestLink, assign, open]) {
    mock.mockReset();
  }
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
  vi.spyOn(window, 'open').mockImplementation(open);
  items.mockResolvedValue({ ok: true, value: listing() });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: original });
  vi.restoreAllMocks();
});

async function openReleased(locale: 'en' | 'ar' = 'en') {
  renderWithProviders(<BulkResultDialog result={RESULT} onClose={() => undefined} />, locale);
  const strings = locale === 'en' ? en : ar;
  fireEvent.click(screen.getByRole('button', { name: strings.bulk.result.links }));
  await waitFor(() => {
    expect(items).toHaveBeenCalledWith(OPERATION, 1);
  });
  await screen.findByText('QA-014');
}

describe('a bulk export’s released documents', () => {
  it('lists them with counts and both revisions, says why one is unavailable, and counts the hidden', async () => {
    await openReleased();
    expect(screen.getByText('2 released · 1 not released')).not.toBeNull();
    expect(screen.getByText('Exported Rev 2 · current Rev 3')).not.toBeNull();
    expect(screen.getByText(en.bulk.result.exported.unavailable.INTEGRITY_FAILED)).not.toBeNull();
    expect(screen.getByText('1 released document is no longer available to you.')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Download qa-015.pdf' })).toBeNull();
    // Nothing was issued by listing.
    expect(itemLink).not.toHaveBeenCalled();
  });

  it('issues one item’s link only when it is clicked, and navigates to it — no popup', async () => {
    const url = 'https://docs.example.test/api/v1/downloads?token=item';
    itemLink.mockResolvedValue({
      ok: true,
      value: { documentId: DOC_A, filename: 'qa-014.pdf', url, expiresAt: '' },
    });
    await openReleased();
    fireEvent.click(screen.getByRole('button', { name: 'Download qa-014.pdf' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(url);
    });
    expect(itemLink).toHaveBeenCalledWith(OPERATION, DOC_A);
    expect(open).not.toHaveBeenCalled();
  });

  it('downloads the manifest through its own verified link', async () => {
    const url = 'https://docs.example.test/api/v1/downloads?token=manifest';
    manifestLink.mockResolvedValue({
      ok: true,
      value: { documentId: null, filename: 'bulk-export.json', url, expiresAt: '' },
    });
    await openReleased();
    fireEvent.click(screen.getByRole('button', { name: en.bulk.result.exported.manifest }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(url);
    });
  });

  it('pages', async () => {
    items.mockResolvedValueOnce({
      ok: true,
      value: listing({ meta: { page: 1, pageSize: 50, total: 120, hasMore: true } }),
    });
    await openReleased();
    fireEvent.click(screen.getByRole('button', { name: en.bulk.result.exported.next }));
    await waitFor(() => {
      expect(items).toHaveBeenCalledWith(OPERATION, 2);
    });
  });

  it('says it in Arabic', async () => {
    await openReleased('ar');
    expect(screen.getByText(ar.bulk.result.exported.unavailable.INTEGRITY_FAILED)).not.toBeNull();
    expect(screen.getByRole('button', { name: ar.bulk.result.exported.manifest })).not.toBeNull();
  });
});
