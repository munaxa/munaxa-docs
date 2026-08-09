import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PreviewManifest } from '@edms/contracts';

import { renderWithProviders } from '../../test/a11y';
import { document as documentFixture } from '../../test/fixtures';
import { PreviewPanel } from './preview-panel';

/**
 * One audited issuance per viewer open — measured, not asserted from the comment that claims it.
 *
 * ## Why this test exists
 *
 * Phase 6.8 measured the shipped panel and found it issuing **6,704 preview content URLs in 1.5
 * seconds** from a single mount. Each one is a presigned URL and an audited event, so an open
 * viewer was a self-inflicted denial of service against the tenant's own API and a flood through
 * its compliance trail.
 *
 * The cause was one dependency array. `useTranslate()` calls `translatorFor`, which returns a new
 * closure on every call, so `openContent` — a `useCallback` listing `translate` — was a new
 * function on every render; the effect beside it depends on `openContent` and *calls* it; the call
 * sets `content`; setting `content` re-renders; the loop closes.
 *
 * ## Why it is a count rather than a "does not loop"
 *
 * Because the defect was invisible to every other kind of check. The panel rendered correctly, axe
 * was clean, the screenshots matched and the types were sound — the only observable was *how many
 * times a server action ran*. So that is what is asserted, with the URL held constant so the number
 * measures the parent's own render loop and not a child reloading on a changed prop.
 */

const requestPreviewContent = vi.fn();

vi.mock('./actions', () => ({
  requestPreviewContent: (...args: unknown[]) => requestPreviewContent(...args) as unknown,
  fetchPreviewManifest: () => Promise.resolve(null),
  requestPreviewText: () => Promise.resolve({ ok: false, code: 'NOT_FOUND', detail: null }),
  requestPreviewPrint: () => Promise.resolve({ ok: false, code: 'NOT_FOUND', detail: null }),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const READY: PreviewManifest = {
  revisionId: '019489f0-0000-7000-8000-000000000401',
  state: 'READY',
  reason: null,
  pageCount: 3,
  mode: 'PDF',
  hasText: false,
  ocr: null,
  confidentiality: { downloadAllowed: true, printAllowed: true, watermark: false },
};

describe('the preview viewer', () => {
  it('issues a content URL a handful of times, not thousands', async () => {
    let issued = 0;
    requestPreviewContent.mockImplementation(() => {
      issued += 1;
      // Constant, so this counts the panel's own renders rather than the child reloading.
      return Promise.resolve({
        ok: true,
        value: { url: 'https://example.test/content', expiresAt: '2026-01-01T00:00:00.000Z' },
      });
    });

    renderWithProviders(
      <main>
        <PreviewPanel
          document={documentFixture()}
          initialManifest={READY}
          canPrint={false}
          canDownload={false}
        />
      </main>,
    );

    await waitFor(() => {
      expect(issued).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 800));

    // A small bound rather than exactly one: the viewer legitimately re-issues when a URL expires,
    // and pdf.js cannot load in jsdom so that path is reached here. What must never come back is
    // the order of magnitude — the regression this guards produced four figures in under a second.
    expect(issued).toBeLessThan(10);
  });
});
