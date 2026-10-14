import { randomBytes } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalDownloadStaging } from './download-staging';

/**
 * The staging file a verified download waits in — ADR-0026 §10.
 *
 * What is promised: the bytes come back exactly; no name for them exists on disk while they wait;
 * the disk holds ciphertext only and never the key; a record changed on disk is refused before its
 * plaintext is handed out; and nothing survives disposal or a restart.
 */

let root = '';
let staging: LocalDownloadStaging;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'munaxa-staging-spec-'));
  staging = new LocalDownloadStaging(join(root, 'staging'));
  await staging.prepare();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function replayed(file: { replay(): AsyncIterable<Buffer> }): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of file.replay()) {
    parts.push(part);
  }
  return Buffer.concat(parts);
}

/** The descriptor's path under /proc — the only way to reach an unlinked file, as a test. */
async function descriptorOf(file: object): Promise<string> {
  const handle = (file as { handle: { fd: number } }).handle;
  const path = `/proc/self/fd/${String(handle.fd)}`;
  expect(await readlink(path)).toMatch(/\(deleted\)$/u);
  return path;
}

describe('LocalDownloadStaging', () => {
  it.each([0, 1, 256 * 1024 - 1, 256 * 1024, 256 * 1024 + 1, 3 * 1024 * 1024 + 17])(
    'gives back exactly the %d bytes written, in uneven chunks',
    async (size) => {
      const bytes = randomBytes(size);
      const file = await staging.create();
      for (let offset = 0; offset < size; offset += 70_001) {
        await file.write(bytes.subarray(offset, Math.min(size, offset + 70_001)));
      }
      expect(file.bytesWritten).toBe(size);
      expect((await replayed(file)).equals(bytes)).toBe(true);
      await file.dispose();
    },
  );

  it('leaves no name on disk while the bytes wait, and a private directory', async () => {
    const file = await staging.create();
    await file.write(randomBytes(1024));
    expect(await readdir(join(root, 'staging'))).toEqual([]);
    expect((await stat(join(root, 'staging'))).mode & 0o777).toBe(0o700);
    await file.dispose();
  });

  it('writes ciphertext only: the plaintext is nowhere in the file', async () => {
    const marker = Buffer.from('MUNAXA-PLAINTEXT-MARKER-'.repeat(20_000));
    const file = await staging.create();
    await file.write(marker);
    await replayed(file); // seals the last record
    const onDisk = await readFile(await descriptorOf(file));
    expect(onDisk.length).toBeGreaterThan(marker.length);
    expect(onDisk.includes(Buffer.from('MUNAXA-PLAINTEXT-MARKER'))).toBe(false);
    await file.dispose();
  });

  it('refuses a record changed on disk before handing out any of its plaintext', async () => {
    const bytes = randomBytes(600 * 1024); // three records
    const file = await staging.create();
    await file.write(bytes);
    const path = await descriptorOf(file);
    const iterator: AsyncIterator<Buffer> = file.replay()[Symbol.asyncIterator]();
    const first = await iterator.next(); // seals; first record verified and handed out
    expect((first.value as Buffer).equals(bytes.subarray(0, 256 * 1024))).toBe(true);

    // Flip one byte inside the second record's ciphertext.
    const handle = await open(path, 'r+');
    const at = 20 + 256 * 1024 + 16 + 20 + 100;
    const one = Buffer.alloc(1);
    await handle.read(one, 0, 1, at);
    one[0] = (one[0] ?? 0) ^ 0xff;
    await handle.write(one, 0, 1, at);
    await handle.close();

    await expect(iterator.next()).rejects.toThrow();
    await file.dispose();
  });

  it('frees the file on dispose, and refuses to be used afterwards', async () => {
    const file = await staging.create();
    await file.write(randomBytes(10));
    const handle = (file as unknown as { handle: { fd: number } }).handle;
    await file.dispose();
    await file.dispose(); // idempotent
    // A closed FileHandle reports fd -1: the descriptor, and with it the unlinked file, is gone.
    expect(handle.fd).toBe(-1);
    await expect(file.write(Buffer.from('x'))).rejects.toThrow();
  });

  it('empties the directory at start-up, for a process killed between open and unlink', async () => {
    const directory = join(root, 'staging');
    await writeFile(join(directory, 'left-by-a-crash'), 'ciphertext');
    expect(await new LocalDownloadStaging(directory).prepare()).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it('reports the free space of its file system', async () => {
    expect(await staging.freeBytes()).toBeGreaterThan(0);
  });
});
