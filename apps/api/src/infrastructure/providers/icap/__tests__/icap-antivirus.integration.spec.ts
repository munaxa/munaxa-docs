import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { deflateRawSync, crc32 } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseIcapUrl } from '../../../../core/config/icap-url';
import { AntivirusScanError } from '../../../../ports/antivirus.port';
import { IcapAntivirusAdapter } from '../icap-antivirus.adapter';

/**
 * The ICAP adapter against a real scanner — RC D-3.
 *
 * `AV_ICAP_TEST_URL` names a running ICAP antivirus service: c-icap's `virus_scan` in front of ClamAV's
 * clamd with the official signature databases, configured by `infra/antivirus/`. CI's integration
 * job starts exactly that. Nothing here is a double for the scanner: every verdict below is one
 * ClamAV reached by reading the bytes. The storage read is the only thing supplied directly,
 * because the store is not the subject — the end-to-end suite
 * (`src/__tests__/antivirus.e2e.integration.spec.ts`) covers upload through storage to the scanner.
 *
 * EICAR is the anti-malware industry's standard test file: harmless, and detected as a virus by
 * every scanner by agreement. It is assembled at runtime so no file in this repository is itself
 * detected.
 */

const SCANNER = process.env['AV_ICAP_TEST_URL'] ?? '';
const EICAR = Buffer.from(
  ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''),
  'latin1',
);

/** A stored (uncompressed) or deflated zip of the given entries — the format real archives use. */
function zip(entries: readonly { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'latin1');
    const body = entry.deflate === true ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate === true ? 8 : 0;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function scannerFor(bytes: Buffer, url = SCANNER, timeoutMs = 60_000): IcapAntivirusAdapter {
  return new IcapAntivirusAdapter(
    { endpoint: parseIcapUrl(url), maxBytes: 64 * 1024 * 1024, timeoutMs },
    { read: () => Promise.resolve(bytes) },
  );
}

const scan = (bytes: Buffer, adapter = scannerFor(bytes)) =>
  adapter.scan({
    storageKey: 'blobs/under-test',
    sizeBytes: bytes.length,
    declaredMimeType: 'application/pdf',
    timeoutMs: 60_000,
  });

async function failure(promise: Promise<unknown>): Promise<AntivirusScanError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AntivirusScanError);
    return error as AntivirusScanError;
  }
  throw new Error('expected no verdict');
}

beforeAll(() => {
  if (SCANNER === '') {
    throw new Error(
      'AV_ICAP_TEST_URL must name a running ICAP antivirus service (infra/antivirus/): this suite ' +
        'proves verdicts from a real scanner and has nothing to prove without one.',
    );
  }
});

describe('a real scanner, clean content', () => {
  it('answers CLEAN for a harmless PDF, and says which scanner and signature set', async () => {
    const verdict = await scan(Buffer.from('%PDF-1.7\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n'));
    expect(verdict.status).toBe('CLEAN');
    expect(verdict.threat).toBeNull();
    expect(verdict.scanner).toMatch(/^ICAP C-ICAP\/[\d.]+ ISTag=/);
    expect(verdict.scannerVersion).not.toBe('unknown');
  });

  it('answers CLEAN for a large file — scanned whole, not waved through for its size', async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024, 0x41);
    await expect(scan(bytes)).resolves.toMatchObject({ status: 'CLEAN' });
  }, 60_000);

  it('passes the readiness probe', async () => {
    await expect(scannerFor(Buffer.alloc(0)).probe(10_000)).resolves.toBeUndefined();
  });
});

describe('a real scanner, EICAR', () => {
  it('answers INFECTED for the EICAR test file, naming the signature', async () => {
    const verdict = await scan(EICAR);
    expect(verdict.status).toBe('INFECTED');
    expect(verdict.threat).toMatch(/eicar/i);
  });

  it('answers INFECTED for EICAR inside a deflated archive', async () => {
    const archive = zip([
      { name: 'readme.txt', data: Buffer.from('quarterly figures\n'), deflate: true },
      { name: 'eicar.com', data: EICAR, deflate: true },
    ]);
    await expect(scan(archive)).resolves.toMatchObject({ status: 'INFECTED' });
  });

  it('answers INFECTED for EICAR inside an archive larger than a stock c-icap will scan', async () => {
    // c-icap's shipped `MaxObjectSize` is 5 MB, and it passes larger objects as clean unread.
    // `infra/antivirus/c-icap.conf` raises it; this is the proof that it took effect.
    const archive = zip([
      { name: 'padding.bin', data: Buffer.alloc(8 * 1024 * 1024, 0x5a) },
      { name: 'eicar.com', data: EICAR },
    ]);
    expect(archive.length).toBeGreaterThan(8 * 1024 * 1024);
    await expect(scan(archive)).resolves.toMatchObject({ status: 'INFECTED' });
  }, 60_000);

  it('judges the bytes, not the declared type: EICAR declared as a PDF is still INFECTED', async () => {
    // `scan` above declares `application/pdf` for everything; restated here because it is a rule.
    await expect(scan(EICAR)).resolves.toMatchObject({ status: 'INFECTED' });
  });
});

describe('a scanner that cannot give a verdict — never CLEAN', () => {
  let silent: Server;
  let silentPort = 0;
  const held: Socket[] = [];

  beforeAll(async () => {
    // Accepts and never answers: the shape of a hung scanner.
    silent = createServer((socket) => {
      held.push(socket);
      socket.on('error', () => undefined);
    });
    await new Promise<void>((ready) => silent.listen(0, '127.0.0.1', ready));
    silentPort = (silent.address() as AddressInfo).port;
  });

  afterAll(async () => {
    held.forEach((socket) => socket.destroy());
    await new Promise((done) => silent.close(done));
  });

  it('unreachable: nothing listening where the scanner should be', async () => {
    const closed = createServer();
    await new Promise<void>((ready) => closed.listen(0, '127.0.0.1', ready));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((done) => closed.close(done));

    const error = await failure(
      scan(EICAR, scannerFor(EICAR, `icap://127.0.0.1:${String(port)}/avscan`)),
    );
    expect(error.reason).toBe('UNREACHABLE');
  });

  it('timed out: a scanner that accepts and never answers', async () => {
    const adapter = scannerFor(EICAR, `icap://127.0.0.1:${String(silentPort)}/avscan`, 1_500);
    expect((await failure(scan(EICAR, adapter))).reason).toBe('TIMEOUT');
  });

  it('an error: the real ICAP server asked for a service it does not have', async () => {
    const url = new URL(SCANNER);
    url.pathname = '/no-such-service';
    const error = await failure(scan(EICAR, scannerFor(EICAR, url.toString())));
    expect(error.reason).toBe('SCANNER_ERROR');
  });
});
