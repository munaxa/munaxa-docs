/**
 * The half of ICAP (RFC 3507) the antivirus adapter speaks, as pure functions — RC D-3.
 *
 * Kept apart from the socket so every rule that decides a verdict is unit-tested against the exact
 * bytes a scanner sends, and so the adapter is left holding nothing but I/O.
 *
 * ## The verdict rules, which are the security content of this file
 *
 * - **`204` is the only CLEAN.** The request says `Allow: 204`, and a scanner that found nothing
 *   answers with it. Nothing else is read as clean.
 * - **`200` is INFECTED only when it names a threat** — `X-Infection-Found`, `X-Violations-Found`
 *   with a non-zero count, or `X-Virus-ID`. Those are the headers c-icap, Squid-ecosystem scanners
 *   and the common commercial ICAP servers use to say "blocked".
 * - **Everything else is no verdict.** A `200` that rewrote the content without naming a threat, a
 *   `100` nobody asked for, any `4xx`/`5xx`, a status line that does not parse: each is thrown as an
 *   `AntivirusScanError`, which the storage service records as `FAILED`. Guessing in either
 *   direction is wrong — guessing "clean" is the one failure this gate exists to prevent, and
 *   guessing "infected" would raise a security incident about a file nobody has shown to be hostile.
 */
import type { IcapEndpoint } from '../../../core/config/icap-url';
import { AntivirusScanError } from '../../../ports/antivirus.port';

const CRLF = '\r\n';

/**
 * The head of a RESPMOD request carrying `bodyLength` bytes, with an empty preview.
 *
 * `Preview: 0` and the zero-length preview that ends this head make the scanner answer before any
 * content is sent: `100 Continue` to ask for it, or a final answer if it will not scan at all (an
 * unknown service, an overloaded server). Without it that final answer arrives while the body is
 * still being written, the write fails, and the answer is lost with the socket.
 *
 * The encapsulated HTTP response names the content `application/octet-stream` whatever the upload
 * declared, and no filename: a scanner that chooses what to scan by declared type or extension must
 * not be handed the declaration to choose by. The content is identified by its bytes alone.
 */
export function respmodHead(endpoint: IcapEndpoint, bodyLength: number): Buffer {
  const requestHeader = `GET /scan HTTP/1.1${CRLF}` + `Host: munaxa-docs.invalid${CRLF}` + CRLF;
  const responseHeader =
    `HTTP/1.1 200 OK${CRLF}` +
    `Content-Type: application/octet-stream${CRLF}` +
    `Content-Length: ${String(bodyLength)}${CRLF}` +
    CRLF;
  const reqLength = Buffer.byteLength(requestHeader, 'latin1');
  const resLength = Buffer.byteLength(responseHeader, 'latin1');
  const icap =
    `RESPMOD ${icapUri(endpoint)} ICAP/1.0${CRLF}` +
    `Host: ${hostHeader(endpoint)}${CRLF}` +
    `Allow: 204${CRLF}` +
    `Preview: 0${CRLF}` +
    `Connection: close${CRLF}` +
    `Encapsulated: req-hdr=0, res-hdr=${String(reqLength)}, res-body=${String(reqLength + resLength)}${CRLF}` +
    CRLF;
  return Buffer.from(icap + requestHeader + responseHeader + `0${CRLF}${CRLF}`, 'latin1');
}

/** One chunk of the encapsulated body, in HTTP chunked framing. */
export function bodyChunk(bytes: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from(`${bytes.length.toString(16)}${CRLF}`, 'latin1'),
    bytes,
    Buffer.from(CRLF, 'latin1'),
  ]);
}

/** The zero-length chunk that ends the body. */
export const BODY_END = Buffer.from(`0${CRLF}${CRLF}`, 'latin1');

/** An ICAP response's status and headers. Header names are lower-cased; folded lines are joined with `\n`. */
export interface IcapResponseHead {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
}

/** Where the response head ends in what has arrived so far, or -1. */
export function headEnd(received: Buffer): number {
  return received.indexOf(`${CRLF}${CRLF}`, 0, 'latin1');
}

export function parseResponseHead(raw: string): IcapResponseHead {
  const lines = raw.split(CRLF);
  const statusLine = lines.shift() ?? '';
  const match = /^ICAP\/1\.0 (\d{3})(?: .*)?$/.exec(statusLine);
  if (match === null) {
    throw new AntivirusScanError(
      `The scanner answered with an unreadable status line: ${printable(statusLine, 80)}`,
      'PROTOCOL',
    );
  }
  const headers = new Map<string, string>();
  let last: string | null = null;
  for (const line of lines) {
    if (line === '') {
      continue;
    }
    if ((line.startsWith(' ') || line.startsWith('\t')) && last !== null) {
      // A folded continuation — `X-Violations-Found` lists its findings this way.
      headers.set(last, `${headers.get(last) ?? ''}\n${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new AntivirusScanError('The scanner answered with a malformed header.', 'PROTOCOL');
    }
    last = line.slice(0, colon).trim().toLowerCase();
    headers.set(last, line.slice(colon + 1).trim());
  }
  return { status: Number(match[1]), headers };
}

/**
 * What a response says about the content. Throws when it says nothing this product may act on.
 *
 * `contentSent` is whether the scanner had been given all of it. A `204` before then is a scanner
 * waving through bytes it never read, and is refused; a named threat is accepted whenever it comes,
 * because blocking early is the safe direction.
 */
export function verdictOf(
  head: IcapResponseHead,
  contentSent = true,
): { readonly infected: false } | { readonly infected: true; readonly threat: string } {
  if (head.status === 204) {
    if (!contentSent) {
      throw new AntivirusScanError(
        'The scanner answered 204 before it had the content; that is not a verdict.',
        'PROTOCOL',
      );
    }
    return { infected: false };
  }
  if (head.status === 200) {
    const threat = threatOf(head.headers);
    if (threat !== null) {
      return { infected: true, threat };
    }
    throw new AntivirusScanError(
      'The scanner modified the content without naming a threat; no verdict was recorded.',
      'PROTOCOL',
    );
  }
  if (head.status >= 400) {
    throw new AntivirusScanError(
      `The scanner answered ICAP ${String(head.status)}; no verdict was recorded.`,
      'SCANNER_ERROR',
    );
  }
  throw new AntivirusScanError(
    `The scanner answered ICAP ${String(head.status)}, which is not a verdict.`,
    'PROTOCOL',
  );
}

/**
 * The threat a blocking response names, or null when it names none.
 *
 * Bounded and reduced to printable ASCII: the name goes into the database, the audit trail and an
 * incident notification, and it is text a remote service chose.
 */
function threatOf(headers: ReadonlyMap<string, string>): string | null {
  const infection = headers.get('x-infection-found');
  if (infection !== undefined) {
    const named = /Threat=([^;]*)/i.exec(infection)?.[1]?.trim();
    return printable(named !== undefined && named !== '' ? named : 'unnamed', 200);
  }
  const violations = headers.get('x-violations-found');
  if (violations !== undefined) {
    const [count, , threat] = violations.split('\n');
    if (Number(count) > 0) {
      return printable(threat !== undefined && threat !== '' ? threat : 'unnamed', 200);
    }
  }
  const virus = headers.get('x-virus-id');
  if (virus !== undefined && virus !== '') {
    return printable(virus, 200);
  }
  return null;
}

/** Who scanned: the server's own name and its ISTag, which changes when its signatures do. */
export function scannerOf(head: IcapResponseHead): { name: string; version: string } {
  const server = head.headers.get('server') ?? head.headers.get('service') ?? 'unknown';
  const istag = (head.headers.get('istag') ?? '').replace(/^"|"$/g, '');
  return {
    name: printable(`ICAP ${server}${istag === '' ? '' : ` ISTag=${istag}`}`, 200),
    version: printable(istag === '' ? 'unknown' : istag, 100),
  };
}

function icapUri(endpoint: IcapEndpoint): string {
  return `icap://${hostHeader(endpoint)}${endpoint.service}`;
}

function hostHeader(endpoint: IcapEndpoint): string {
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host;
  return `${host}:${String(endpoint.port)}`;
}

function printable(value: string, max: number): string {
  return value
    .replace(/[^\x20-\x7e]/g, '?')
    .trim()
    .slice(0, max);
}
