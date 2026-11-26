import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../test/a11y';
import { UploadDialog } from './upload-dialog';

/**
 * Removing a chosen file before filing — asked for 26 Nov 2026.
 *
 * The transfer is mocked: what is under test is the list, the submit count and the abort, not the
 * network. Each upload resolves only when the test says so, so a removal can land mid-flight.
 */
const { uploadFile, createDocument, pending } = vi.hoisted(() => {
  const pending = new Map<string, { resolve: (value: unknown) => void; signal?: AbortSignal }>();
  return {
    pending,
    uploadFile: vi.fn(
      (file: File, _onProgress: unknown, signal?: AbortSignal) =>
        new Promise((resolve) => {
          pending.set(file.name, { resolve, ...(signal !== undefined && { signal }) });
        }),
    ),
    createDocument: vi.fn(() => Promise.resolve({ ok: true, value: undefined })),
  };
});

vi.mock('./upload', async (original) => ({
  ...(await original<typeof import('./upload')>()),
  uploadFile,
}));
vi.mock('./actions', () => ({ createDocument }));

const stored = (name: string) => ({
  fileObjectId: `obj-${name}`,
  filename: name,
  mimeType: 'application/pdf',
  sizeBytes: 4,
  checksumSha256: 'x',
  scanStatus: 'CLEAN',
  deduplicated: false,
  duplicates: [],
});

function dialog(): void {
  renderWithProviders(
    <UploadDialog
      open
      onClose={() => undefined}
      onSaved={() => undefined}
      folderId="folder-1"
      folderName="Procedures"
      documentTypes={[{ value: 'type-1', label: 'Procedure', fields: [] }]}
      categories={[]}
      confidentialityLevels={[]}
      users={[]}
      departments={[]}
      origin="UPLOAD"
    />,
  );
}

const pdf = (name: string): File => new File(['%PDF'], name, { type: 'application/pdf' });

async function choose(...files: File[]): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  await userEvent.setup().upload(input, files);
}

beforeEach(() => {
  pending.clear();
  uploadFile.mockClear();
  createDocument.mockClear();
});

describe('removing a chosen file', () => {
  it('offers a named remove button for every chosen file', async () => {
    dialog();
    await choose(pdf('a.pdf'), pdf('b.pdf'));
    expect(screen.getByRole('button', { name: 'Remove a.pdf' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove b.pdf' })).toBeTruthy();
  });

  it('takes the file out of the list and out of the count', async () => {
    dialog();
    await choose(pdf('a.pdf'), pdf('b.pdf'));
    pending.get('a.pdf')?.resolve(stored('a.pdf'));
    pending.get('b.pdf')?.resolve(stored('b.pdf'));
    await screen.findByRole('button', { name: 'File 2 documents' });

    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove a.pdf' }));

    expect(screen.queryByText('a.pdf')).toBeNull();
    expect(screen.getByText('b.pdf')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'File 1 document' })).toBeTruthy();
  });

  it('aborts an upload still on its way, and ignores its late answer', async () => {
    dialog();
    await choose(pdf('a.pdf'));
    const flight = pending.get('a.pdf');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove a.pdf' }));

    expect(flight?.signal?.aborted).toBe(true);
    flight?.resolve(stored('a.pdf'));
    await waitFor(() => {
      expect(screen.queryByText('a.pdf')).toBeNull();
    });
  });

  it('can choose the same file again after removing it', async () => {
    dialog();
    await choose(pdf('a.pdf'));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove a.pdf' }));
    await choose(pdf('a.pdf'));
    expect(screen.getByText('a.pdf')).toBeTruthy();
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });
});
