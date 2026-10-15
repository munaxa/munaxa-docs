import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ar, en } from '@edms/i18n';

import { renderWithProviders } from '../../test/a11y';
import { document } from '../../test/fixtures';
import { DocumentScreen } from './document-screen';

/**
 * A quarantined file on its record page — Hetzner Phase B, finding 4.
 *
 * The page knew only the scan status, so a file that passed its scan and then failed an integrity
 * check had an enabled Download button and no warning; the click was refused with the malware
 * sentence ("still being checked"). The API now says `reachable: false` for a quarantined file and
 * names its `integrityStatus`, and the page must say what is actually wrong, with nothing offered
 * that the API will refuse.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

function withFile(file: { integrityStatus: string; reachable: boolean; scanStatus?: string }) {
  const base = document();
  const revision = {
    ...base.currentRevision!,
    file: {
      ...base.currentRevision!.file,
      scanStatus: (file.scanStatus ?? 'CLEAN') as never,
      integrityStatus: file.integrityStatus as never,
      reachable: file.reachable,
    },
  };
  return document({ currentRevision: revision, latestRevision: revision });
}

function downloadButton(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

function screenFor(file: Parameters<typeof withFile>[0]) {
  return <DocumentScreen document={withFile(file)} canEdit={false} canMove={false} canDownload />;
}

describe('a quarantined file’s record page', () => {
  it.each(['MISMATCH', 'UNREADABLE'])(
    'says the file failed its integrity check (%s) and offers no enabled download',
    (integrityStatus) => {
      renderWithProviders(screenFor({ integrityStatus, reachable: false }));

      expect(screen.getByText(en.errorReason.INTEGRITY_FAILED)).not.toBeNull();
      expect(screen.queryByText(en.documents.scan.CLEAN)).toBeNull();
      expect(screen.queryByText(en.error.CONTENT_NOT_SCANNED)).toBeNull();
      expect(downloadButton(en.documents.actions.download).disabled).toBe(true);
    },
  );

  it('says the same in Arabic', () => {
    renderWithProviders(screenFor({ integrityStatus: 'MISMATCH', reachable: false }), 'ar');

    expect(screen.getByText(ar.errorReason.INTEGRITY_FAILED)).not.toBeNull();
    expect(downloadButton(ar.documents.actions.download).disabled).toBe(true);
  });

  it('keeps the scan’s own sentence for a file still being scanned', () => {
    renderWithProviders(
      screenFor({ scanStatus: 'PENDING', integrityStatus: 'UNVERIFIED', reachable: false }),
    );

    expect(screen.getByText(en.documents.scan.PENDING)).not.toBeNull();
    expect(screen.queryByText(en.errorReason.INTEGRITY_FAILED)).toBeNull();
  });

  it('shows no warning and an enabled download for a servable file', () => {
    renderWithProviders(screenFor({ integrityStatus: 'VERIFIED', reachable: true }));

    expect(screen.queryByText(en.errorReason.INTEGRITY_FAILED)).toBeNull();
    expect(downloadButton(en.documents.actions.download).disabled).toBe(false);
  });
});
