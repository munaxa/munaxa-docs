import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { StorageKey } from '../../ports/storage.port';
import { LocalStorageAdapter } from './local.adapter';
import { decodeTransferToken } from './local-transfer-token';

/**
 * `copy` onto a key somebody is reading — RC D-3.
 *
 * Two uploads of the same bytes both copy them onto the same content key, and each then reads the
 * key back to scan it. `copyFile` straight onto the destination truncated it first: measured, 11 of
 * 3,000 reads made during such a copy returned zero bytes, and a real ClamAV behind c-icap passes an
 * empty body as clean. The copy now lands on a temporary name and is renamed into place, so a reader
 * sees the complete object, old or new, and never a partial one.
 */

let root = '';
let adapter: LocalStorageAdapter;
const key = (name: string): StorageKey => name;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'munaxa-local-copy-'));
  adapter = new LocalStorageAdapter({
    root,
    transferUrl: 'http://localhost:3001/api/v1/storage/local',
    signingSecret: 's'.repeat(32),
    now: () => new Date(),
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('copying onto a key that is being read', () => {
  it('never lets a reader see a truncated object', async () => {
    const bytes = Buffer.from('X'.repeat(68));
    await writeFile(join(root, 'staging-a'), bytes);
    await adapter.copy(key('staging-a'), key('blobs/aa/content'));

    const lengths = new Map<number, number>();
    for (let attempt = 0; attempt < 3_000; attempt += 1) {
      const [, read] = await Promise.all([
        adapter.copy(key('staging-a'), key('blobs/aa/content')),
        adapter.read(key('blobs/aa/content')),
      ]);
      const length = read?.length ?? -1;
      lengths.set(length, (lengths.get(length) ?? 0) + 1);
    }

    expect([...lengths.keys()]).toEqual([bytes.length]);
  }, 60_000);

  it('leaves no temporary file behind, and two copies at once both complete', async () => {
    await writeFile(join(root, 'staging-b'), Buffer.from('second'));
    await Promise.all(
      Array.from({ length: 8 }, () => adapter.copy(key('staging-b'), key('blobs/bb/content'))),
    );

    expect((await adapter.read(key('blobs/bb/content')))?.toString()).toBe('second');
    expect(await readdir(join(root, 'blobs', 'bb'))).toEqual(['content']);
  });
});

describe('the disposition a LOCAL download link carries (RFC 6266) — ADR-0026 §10', () => {
  async function dispositionFor(filename: string, inline = false): Promise<string | null> {
    const signed = await adapter.createDownloadUrl(key('acme/doc'), {
      expiresInSeconds: 60,
      filename,
      inline,
    });
    const token = new URL(signed.url).searchParams.get('token') ?? '';
    const decoded = decodeTransferToken('s'.repeat(32), token, 'GET', new Date());
    return 'grant' in decoded ? (decoded.grant.disposition ?? null) : null;
  }

  it('signs the standard header for Arabic and accented names', async () => {
    expect(await dispositionFor('تقرير.pdf')).toBe(
      `attachment; filename="download.pdf"; filename*=UTF-8''%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf`,
    );
    expect(await dispositionFor('Résumé.txt', true)).toBe(
      `inline; filename="Resume.txt"; filename*=UTF-8''R%C3%A9sum%C3%A9.txt`,
    );
    expect(await dispositionFor('QA-014.pdf')).toBe('attachment; filename="QA-014.pdf"');
  });
});
