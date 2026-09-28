import { describe, expect, it } from 'vitest';

import { parseIcapUrl } from '../../../core/config/icap-url';
import { AntivirusScanError } from '../../../ports/antivirus.port';
import {
  bodyChunk,
  BODY_END,
  headEnd,
  parseResponseHead,
  respmodHead,
  scannerOf,
  verdictOf,
} from './icap-protocol';

/**
 * The verdict rules, against the bytes c-icap 0.5.10 with ClamAV actually sent during the RC D-3
 * validation — captured, not invented.
 */
const CLEAN_REPLY = [
  'ICAP/1.0 204 Unmodified',
  'Server: C-ICAP/0.5.10',
  'Connection: close',
  'ISTag: "CI0001-vPD0LySzC+gUSwny8IR89gAA"',
].join('\r\n');

const EICAR_REPLY = [
  'ICAP/1.0 200 OK',
  'Server: C-ICAP/0.5.10',
  'Connection: close',
  'ISTag: "CI0001-vPD0LySzC+gUSwny8IR89gAA"',
  'X-Infection-Found: Type=0; Resolution=2; Threat=Eicar-Test-Signature;',
  'X-Violations-Found: 1',
  '\t-',
  '\tEicar-Test-Signature',
  '\t0',
  '\t0',
  'Encapsulated: res-hdr=0, res-body=161',
].join('\r\n');

const ENGINE_DOWN_REPLY = [
  'ICAP/1.0 500 Server error',
  'Server: C-ICAP/0.5.10',
  'Connection: close',
  'ISTag: "CI0001-vPD0LySzC+gUSwny8IR89gAA"',
].join('\r\n');

function refusal(head: string): AntivirusScanError {
  try {
    verdictOf(parseResponseHead(head));
  } catch (error) {
    if (error instanceof AntivirusScanError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected no verdict');
}

describe('reading a verdict', () => {
  it('reads 204 as clean — the only answer that is', () => {
    expect(verdictOf(parseResponseHead(CLEAN_REPLY))).toEqual({ infected: false });
  });

  it('reads a 200 naming a threat as infected, with the threat', () => {
    expect(verdictOf(parseResponseHead(EICAR_REPLY))).toEqual({
      infected: true,
      threat: 'Eicar-Test-Signature',
    });
  });

  it('reads the threat from X-Violations-Found when it is the only header naming one', () => {
    const head = EICAR_REPLY.split('\r\n')
      .filter((line) => !line.startsWith('X-Infection-Found'))
      .join('\r\n');
    expect(verdictOf(parseResponseHead(head))).toEqual({
      infected: true,
      threat: 'Eicar-Test-Signature',
    });
  });

  it('reads X-Virus-ID, which other ICAP scanners use', () => {
    const head = 'ICAP/1.0 200 OK\r\nX-Virus-ID: Win.Test.EICAR_HDB-1';
    expect(verdictOf(parseResponseHead(head))).toEqual({
      infected: true,
      threat: 'Win.Test.EICAR_HDB-1',
    });
  });

  it('refuses a 200 that names no threat: rewritten content is not a verdict either way', () => {
    expect(refusal('ICAP/1.0 200 OK\r\nServer: x').reason).toBe('PROTOCOL');
    expect(refusal('ICAP/1.0 200 OK\r\nX-Violations-Found: 0').reason).toBe('PROTOCOL');
  });

  it('refuses a scanner error — the answer c-icap gives with its engine down', () => {
    expect(refusal(ENGINE_DOWN_REPLY).reason).toBe('SCANNER_ERROR');
    expect(refusal('ICAP/1.0 404 ICAP Service not found').reason).toBe('SCANNER_ERROR');
    expect(refusal('ICAP/1.0 400 Bad request').reason).toBe('SCANNER_ERROR');
  });

  it('refuses a 204 given before the scanner had the content', () => {
    try {
      verdictOf(parseResponseHead(CLEAN_REPLY), false);
      throw new Error('expected no verdict');
    } catch (error) {
      expect((error as AntivirusScanError).reason).toBe('PROTOCOL');
    }
    expect(verdictOf(parseResponseHead(EICAR_REPLY), false).infected).toBe(true);
  });

  it('refuses a 100 nobody asked for, and anything else that is not a verdict', () => {
    expect(refusal('ICAP/1.0 100 Continue').reason).toBe('PROTOCOL');
    expect(refusal('ICAP/1.0 206 Partial Content').reason).toBe('PROTOCOL');
    expect(refusal('ICAP/1.0 304 Not Modified').reason).toBe('PROTOCOL');
  });

  it('refuses a status line that is not ICAP', () => {
    expect(refusal('HTTP/1.1 204 No Content').reason).toBe('PROTOCOL');
    expect(refusal('garbage').reason).toBe('PROTOCOL');
    expect(refusal('').reason).toBe('PROTOCOL');
  });

  it('refuses a malformed header rather than guessing past it', () => {
    expect(refusal('ICAP/1.0 204 Unmodified\r\nno colon here').reason).toBe('PROTOCOL');
  });

  it('keeps a threat name to printable ASCII and a bounded length', () => {
    const hostile = `ICAP/1.0 200 OK\r\nX-Virus-ID: ${'\u0007<script>'.repeat(60)}`;
    const verdict = verdictOf(parseResponseHead(hostile));
    expect(verdict.infected).toBe(true);
    if (verdict.infected) {
      expect(verdict.threat).toMatch(/^[\x20-\x7e]+$/);
      expect(verdict.threat.length).toBeLessThanOrEqual(200);
    }
  });

  it('names the scanner and its signature tag', () => {
    expect(scannerOf(parseResponseHead(CLEAN_REPLY))).toEqual({
      name: 'ICAP C-ICAP/0.5.10 ISTag=CI0001-vPD0LySzC+gUSwny8IR89gAA',
      version: 'CI0001-vPD0LySzC+gUSwny8IR89gAA',
    });
  });
});

describe('writing a request', () => {
  const endpoint = { host: 'scanner.internal', port: 1344, service: '/avscan' };

  it('is a RESPMOD allowing 204, with offsets that match the encapsulated headers', () => {
    const head = respmodHead(endpoint, 5).toString('latin1');
    const [icap, encapsulated] = head.split('\r\n\r\n');
    expect(icap).toContain('RESPMOD icap://scanner.internal:1344/avscan ICAP/1.0');
    expect(icap).toContain('Allow: 204');
    expect(icap).toContain('Preview: 0');
    const offsets = /Encapsulated: req-hdr=0, res-hdr=(\d+), res-body=(\d+)/.exec(icap ?? '');
    const rest = head.slice((icap ?? '').length + 4);
    expect(rest.slice(Number(offsets?.[1]))).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    // The body section is the empty preview: one zero-length chunk.
    expect(rest.slice(Number(offsets?.[2]))).toBe('0\r\n\r\n');
    expect(encapsulated).toBe('GET /scan HTTP/1.1\r\nHost: munaxa-docs.invalid');
  });

  it('declares neither the uploaded type nor a filename — the scanner judges the bytes', () => {
    const head = respmodHead(endpoint, 5).toString('latin1');
    expect(head).toContain('Content-Type: application/octet-stream');
    expect(head).not.toMatch(/filename|\.pdf|application\/pdf/i);
  });

  it('frames the body in chunks and ends it', () => {
    expect(bodyChunk(Buffer.from('hello')).toString('latin1')).toBe('5\r\nhello\r\n');
    expect(BODY_END.toString('latin1')).toBe('0\r\n\r\n');
  });

  it('finds the end of a response head', () => {
    expect(headEnd(Buffer.from('ICAP/1.0 204 x\r\nA: b\r\n\r\nbody'))).toBe(20);
    expect(headEnd(Buffer.from('ICAP/1.0 204 x\r\nA: b\r\n'))).toBe(-1);
  });
});

describe('AV_ICAP_URL', () => {
  it('accepts a service URL, defaulting the port to 1344', () => {
    expect(parseIcapUrl('icap://scanner:1344/avscan')).toEqual({
      host: 'scanner',
      port: 1344,
      service: '/avscan',
    });
    expect(parseIcapUrl('icap://10.0.0.5/srv_clamav?allow204=on')).toEqual({
      host: '10.0.0.5',
      port: 1344,
      service: '/srv_clamav?allow204=on',
    });
    expect(parseIcapUrl('icap://[::1]:11344/avscan').host).toBe('::1');
  });

  it.each([
    ['not a url', 'is not a URL'],
    ['http://scanner:1344/avscan', 'only icap://'],
    ['icaps://scanner:11344/avscan', 'only icap://'],
    ['icap://scanner:1344', 'names no ICAP service'],
    ['icap://scanner:1344/', 'names no ICAP service'],
    ['icap://user:pw@scanner:1344/avscan', 'carries credentials'],
  ])('refuses %s', (raw, message) => {
    expect(() => parseIcapUrl(raw)).toThrow(message);
  });
});
