import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditExport } from '@edms/contracts';
import { ar, en } from '@edms/i18n';

import { renderWithProviders } from '../../test/a11y';
import { AuditScreen } from './audit-screen';

/**
 * Taking an evidence bundle — ADR-0026 §10, the export design §3.3, E-12.
 *
 * The screen opened one popup per artefact after an `await`, in a loop; a browser allows one per
 * gesture, so every artefact after the first was silently blocked. Now each artefact is its own
 * button, its own verified link issued when it is clicked, followed by navigation. Nothing is
 * issued for an artefact nobody asked for, and nothing depends on a popup.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/audit',
  useSearchParams: () => new URLSearchParams(),
}));

const download = vi.fn();
vi.mock('./actions', () => ({
  downloadAuditArtefact: (id: string, name: string) => download(id, name) as unknown,
  requestAuditExport: vi.fn(),
}));

const ID = '0199f5a1-5a9e-7000-8000-00000000a0e1';

function artefact(name: string, tooLargeToDownload = false) {
  return { name, mediaType: 'text/csv', sizeBytes: 10, sha256: 'a'.repeat(64), tooLargeToDownload };
}

function aBundle(overrides: Partial<AuditExport> = {}): AuditExport {
  return {
    id: ID,
    state: 'COMPLETED',
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-15T00:00:00.000Z',
    filters: {},
    requestedById: '0199f5a1-5a9e-7000-8000-00000000b001',
    requestedAt: '2026-10-15T09:00:00.000Z',
    eventCount: 3,
    artefacts: [
      artefact('events.jsonl'),
      artefact('events.csv'),
      artefact('manifest.json'),
      artefact('manifest.sig'),
    ],
    chainIntact: true,
    completedAt: '2026-10-15T09:00:05.000Z',
    error: null,
    ...overrides,
  };
}

function render(exports: readonly AuditExport[], locale: 'en' | 'ar' = 'en') {
  renderWithProviders(<AuditScreen page={null} actions={[]} exports={exports} canExport />, locale);
}

const original = window.location;
const assign = vi.fn();
const open = vi.fn();

beforeEach(() => {
  download.mockReset();
  assign.mockReset();
  open.mockReset();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
  vi.spyOn(window, 'open').mockImplementation(open);
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: original });
  vi.restoreAllMocks();
});

const button = (name: string, locale: { audit: { export: { downloadArtefact: string } } } = en) =>
  screen.getByRole('button', {
    name: locale.audit.export.downloadArtefact.replace('{name}', name),
  });

describe('an evidence bundle on the audit screen', () => {
  it('offers every artefact as its own download', () => {
    render([aBundle()]);
    for (const name of ['events.jsonl', 'events.csv', 'manifest.json', 'manifest.sig']) {
      expect(button(name)).not.toBeNull();
    }
  });

  it('issues one link for the artefact clicked and navigates to it, with no popup (E-12)', async () => {
    const url = 'https://docs.example.test/api/v1/downloads?token=one';
    download.mockResolvedValue({
      ok: true,
      value: { data: [{ name: 'events.csv', url, expiresAt: '2026-10-15T09:01:00.000Z' }] },
    });
    render([aBundle()]);

    fireEvent.click(button('events.csv'));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(url);
    });
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(ID, 'events.csv');
    expect(open).not.toHaveBeenCalled();
  });

  it('takes every artefact, one click each, none lost', async () => {
    download.mockImplementation((_id: string, name: string) =>
      Promise.resolve({
        ok: true,
        value: { data: [{ name, url: `https://d/api/v1/downloads?token=${name}`, expiresAt: '' }] },
      }),
    );
    render([aBundle()]);
    for (const name of ['events.jsonl', 'events.csv', 'manifest.json', 'manifest.sig']) {
      fireEvent.click(button(name));
      await waitFor(() => {
        expect(assign).toHaveBeenLastCalledWith(`https://d/api/v1/downloads?token=${name}`);
      });
    }
    expect(assign).toHaveBeenCalledTimes(4);
    expect(open).not.toHaveBeenCalled();
  });

  it('says an artefact is too large instead of offering it, in English and Arabic', () => {
    const bundle = aBundle({ artefacts: [artefact('events.jsonl', true), artefact('events.csv')] });
    render([bundle]);
    expect(
      screen.getByText(en.audit.export.tooLarge.replace('{name}', 'events.jsonl')),
    ).not.toBeNull();
    expect(
      screen.queryByRole('button', {
        name: en.audit.export.downloadArtefact.replace('{name}', 'events.jsonl'),
      }),
    ).toBeNull();
  });

  it('labels each download in Arabic', () => {
    render([aBundle()], 'ar');
    expect(button('events.csv', ar)).not.toBeNull();
  });

  it('reports a refusal instead of navigating', async () => {
    download.mockResolvedValue({ ok: false, code: 'NOT_FOUND', detail: 'Not found' });
    render([aBundle()]);
    fireEvent.click(button('events.csv'));
    await waitFor(() => {
      expect(download).toHaveBeenCalled();
    });
    expect(assign).not.toHaveBeenCalled();
  });
});
