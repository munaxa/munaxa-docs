import { createHash } from 'node:crypto';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { AntivirusScanError } from '../../../ports/antivirus.port';
import { IcapAntivirusAdapter } from './icap-antivirus.adapter';

/**
 * The adapter's I/O and every way it can fail, against scripted loopback servers — RC D-3.
 *
 * These doubles stand in for the network, not for a scanner's judgement: what a verdict *is* is
 * `icap-protocol.spec.ts`, and whether a real scanner gives one is
 * `icap-antivirus.integration.spec.ts`, which talks to c-icap and ClamAV. Nothing here is evidence
 * that anything was scanned.
 */

const CLEAN = 'ICAP/1.0 204 Unmodified\r\nServer: scripted\r\nISTag: "T1"\r\n\r\n';
const INFECTED =
  'ICAP/1.0 200 OK\r\nServer: scripted\r\nISTag: "T1"\r\n' +
  'X-Infection-Found: Type=0; Resolution=2; Threat=Eicar-Test-Signature;\r\n' +
  'Encapsulated: res-hdr=0, res-body=0\r\n\r\n';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** A server that runs `script` per connection, and records what each connection sent. */
async function scripted(
  script: (socket: Socket, received: () => Buffer) => void,
): Promise<{ port: number; requests: Buffer[] }> {
  const requests: Buffer[] = [];
  const server = createServer((socket) => {
    let received = Buffer.alloc(0);
    const index = requests.push(received) - 1;
    socket.on('data', (data: Buffer) => {
      received = Buffer.concat([received, data]);
      requests[index] = received;
    });
    socket.on('error', () => undefined);
    script(socket, () => received);
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return { port: (server.address() as AddressInfo).port, requests };
}

/** How many zero-length chunks have arrived: the first ends the preview, the second the body. */
function terminators(received: Buffer): number {
  return received.toString('latin1').split('\r\n0\r\n\r\n').length - 1;
}

/** Asks for the content after the empty preview, and answers once the whole body has arrived. */
function answerAfterBody(reply: string) {
  return (socket: Socket, received: () => Buffer) => {
    let continued = false;
    socket.on('data', () => {
      const ended = terminators(received());
      if (ended >= 1 && !continued) {
        continued = true;
        socket.write('ICAP/1.0 100 Continue\r\n\r\n');
      }
      if (ended >= 2) {
        socket.end(reply);
      }
    });
  };
}

/** Answers the preview itself, without asking for the content. */
function answerPreview(reply: string) {
  return (socket: Socket, received: () => Buffer) => {
    socket.on('data', () => {
      if (terminators(received()) >= 1) {
        socket.end(reply);
      }
    });
  };
}

const HARMLESS = Buffer.from('%PDF-1.7 harmless');
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function adapter(
  port: number,
  options: { maxBytes?: number; timeoutMs?: number } = {},
  bytes?: Buffer | null | Error,
) {
  const content = bytes === undefined ? HARMLESS : bytes;
  return new IcapAntivirusAdapter(
    {
      endpoint: { host: '127.0.0.1', port, service: '/avscan' },
      maxBytes: options.maxBytes ?? 1_048_576 * 4,
      timeoutMs: options.timeoutMs ?? 5_000,
    },
    {
      read: () => (content instanceof Error ? Promise.reject(content) : Promise.resolve(content)),
    },
  );
}

/** A request for `bytes`, recorded under their own digest — what the storage service sends. */
const request = (sizeBytes = HARMLESS.length, bytes: Buffer = HARMLESS) => ({
  storageKey: 'blobs/ab/abcdef',
  checksumSha256: sha256(bytes),
  sizeBytes,
  declaredMimeType: 'application/pdf',
  timeoutMs: 5_000,
});

async function failure(promise: Promise<unknown>): Promise<AntivirusScanError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AntivirusScanError);
    return error as AntivirusScanError;
  }
  throw new Error('expected the scan to fail');
}

/** The body a RESPMOD request carried, de-chunked. */
function bodyOf(raw: Buffer): Buffer {
  const text = raw.toString('latin1');
  const encapsulated = /res-body=(\d+)/.exec(text);
  // Past the encapsulated headers and the empty preview's terminator.
  let at = text.indexOf('\r\n\r\n') + 4 + Number(encapsulated?.[1]) + '0\r\n\r\n'.length;
  const parts: Buffer[] = [];
  for (;;) {
    const lineEnd = text.indexOf('\r\n', at);
    const size = parseInt(text.slice(at, lineEnd), 16);
    if (size === 0) {
      return Buffer.concat(parts);
    }
    parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
}

describe('a scanner that answers', () => {
  it('sends the stored bytes whole, and reads 204 as CLEAN', async () => {
    const bytes = Buffer.alloc(300_000, 7); // several chunks
    const scanner = await scripted(answerAfterBody(CLEAN));

    const verdict = await adapter(scanner.port, {}, bytes).scan(request(bytes.length, bytes));

    expect(verdict).toMatchObject({ status: 'CLEAN', threat: null, scannerVersion: 'T1' });
    expect(bodyOf(scanner.requests[0] ?? Buffer.alloc(0)).equals(bytes)).toBe(true);
  });

  it('reads a named threat as INFECTED', async () => {
    const scanner = await scripted(answerAfterBody(INFECTED));
    await expect(adapter(scanner.port).scan(request())).resolves.toMatchObject({
      status: 'INFECTED',
      threat: 'Eicar-Test-Signature',
    });
  });

  it('never tells the scanner the declared type or the key', async () => {
    const scanner = await scripted(answerAfterBody(CLEAN));
    await adapter(scanner.port).scan(request());
    const sent = (scanner.requests[0] ?? Buffer.alloc(0)).toString('latin1');
    expect(sent).not.toContain('application/pdf');
    expect(sent).not.toContain('blobs/ab/abcdef');
  });

  it('sends no content until the scanner asks for it', async () => {
    const scanner = await scripted(() => undefined);
    await failure(adapter(scanner.port, { timeoutMs: 1_000 }).scan(request()));
    const sent = (scanner.requests[0] ?? Buffer.alloc(0)).toString('latin1');
    expect(sent).toContain('Preview: 0');
    expect(sent).not.toContain('%PDF');
  });

  it('takes an early refusal as the answer, even with the body unsent', async () => {
    const scanner = await scripted((socket) => {
      socket.end('ICAP/1.0 500 Server error\r\n\r\n');
    });
    const bytes = Buffer.alloc(2_000_000, 1);
    expect(
      (await failure(adapter(scanner.port, {}, bytes).scan(request(bytes.length, bytes)))).reason,
    ).toBe('SCANNER_ERROR');
  });
});

describe('a scanner that gives no verdict — never CLEAN', () => {
  it('unreachable: nothing listening', async () => {
    const scanner = await scripted(() => undefined);
    const port = scanner.port;
    await new Promise((done) => servers.pop()?.close(done));
    expect((await failure(adapter(port).scan(request()))).reason).toBe('UNREACHABLE');
  });

  it('timed out: accepts the connection and never answers', async () => {
    const scanner = await scripted(() => undefined);
    const started = Date.now();
    const error = await failure(adapter(scanner.port, { timeoutMs: 1_000 }).scan(request()));
    expect(error.reason).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('timed out: the shorter of the configured bound and the caller’s', async () => {
    const scanner = await scripted(() => undefined);
    const error = await failure(
      adapter(scanner.port, { timeoutMs: 60_000 }).scan({ ...request(), timeoutMs: 1_000 }),
    );
    expect(error.reason).toBe('TIMEOUT');
  });

  it('closed without answering', async () => {
    const scanner = await scripted((socket) => socket.destroy());
    expect((await failure(adapter(scanner.port).scan(request()))).reason).toBe('PROTOCOL');
  });

  it('answered with something that is not ICAP', async () => {
    const scanner = await scripted(answerAfterBody('HTTP/1.1 200 OK\r\n\r\n'));
    expect((await failure(adapter(scanner.port).scan(request()))).reason).toBe('PROTOCOL');
  });

  it('answered with an endless head', async () => {
    const scanner = await scripted((socket) => {
      socket.write(`ICAP/1.0 204 x\r\nX-Pad: ${'a'.repeat(70 * 1024)}`);
    });
    expect((await failure(adapter(scanner.port).scan(request()))).reason).toBe('PROTOCOL');
  });

  it('modified the content without naming a threat', async () => {
    const scanner = await scripted(answerAfterBody('ICAP/1.0 200 OK\r\nServer: x\r\n\r\n'));
    expect((await failure(adapter(scanner.port).scan(request()))).reason).toBe('PROTOCOL');
  });
});

describe('an answer to the empty preview — the scanner will not look at the content', () => {
  it('an error to the preview is a scanner error — c-icap’s answer for an unknown service', async () => {
    const scanner = await scripted(answerPreview('ICAP/1.0 404 Service not found\r\n\r\n'));
    expect((await failure(adapter(scanner.port).scan(request()))).reason).toBe('SCANNER_ERROR');
  });

  it('a 204 to the preview is not CLEAN: it is a verdict on bytes the scanner never saw', async () => {
    const scanner = await scripted(answerPreview(CLEAN));
    expect((await failure(adapter(scanner.port).scan(request()))).reason).toBe('PROTOCOL');
  });

  it('a threat named before the content is still a block', async () => {
    const scanner = await scripted(answerPreview(INFECTED));
    await expect(adapter(scanner.port).scan(request())).resolves.toMatchObject({
      status: 'INFECTED',
    });
  });
});

describe('content the adapter will not send', () => {
  it('above AV_ICAP_MAX_BYTES, by the declared size: the scanner is never contacted', async () => {
    const scanner = await scripted(answerAfterBody(CLEAN));
    const error = await failure(adapter(scanner.port, { maxBytes: 1_024 }).scan(request(4_096)));
    expect(error.reason).toBe('UNSCANNABLE');
    expect(scanner.requests).toHaveLength(0);
  });

  it('above AV_ICAP_MAX_BYTES, by the stored size', async () => {
    const scanner = await scripted(answerAfterBody(CLEAN));
    const error = await failure(
      adapter(scanner.port, { maxBytes: 1_024 }, Buffer.alloc(4_096)).scan(request(10)),
    );
    expect(error.reason).toBe('UNSCANNABLE');
    expect(scanner.requests).toHaveLength(0);
  });

  it('bytes that do not hash to the recorded digest: a short read is never judged', async () => {
    // What the local store handed a scan while another upload of the same bytes was copying onto the
    // content key: an empty file. An empty body scans clean, so judging it would have made the real
    // content CLEAN unread.
    const scanner = await scripted(answerAfterBody(CLEAN));
    const truncated = await failure(
      adapter(scanner.port, {}, Buffer.alloc(0)).scan(request(HARMLESS.length, HARMLESS)),
    );
    expect(truncated.reason).toBe('UNSCANNABLE');
    const partial = await failure(
      adapter(scanner.port, {}, HARMLESS.subarray(0, 5)).scan(request(HARMLESS.length, HARMLESS)),
    );
    expect(partial.reason).toBe('UNSCANNABLE');
    expect(scanner.requests).toHaveLength(0);
  });

  it('missing from storage, or unreadable', async () => {
    const scanner = await scripted(answerAfterBody(CLEAN));
    expect((await failure(adapter(scanner.port, {}, null).scan(request()))).reason).toBe(
      'UNSCANNABLE',
    );
    expect(
      (await failure(adapter(scanner.port, {}, new Error('store down')).scan(request()))).reason,
    ).toBe('UNSCANNABLE');
    expect(scanner.requests).toHaveLength(0);
  });
});

describe('the readiness probe', () => {
  it('passes when the scanner scans the probe clean', async () => {
    const scanner = await scripted(answerAfterBody(CLEAN));
    await expect(adapter(scanner.port).probe(2_000)).resolves.toBeUndefined();
  });

  it('fails when the engine behind the ICAP server is down', async () => {
    const scanner = await scripted(answerAfterBody('ICAP/1.0 500 Server error\r\n\r\n'));
    expect((await failure(adapter(scanner.port).probe(2_000))).reason).toBe('SCANNER_ERROR');
  });
});
