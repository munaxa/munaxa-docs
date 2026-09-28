/**
 * `AV_ICAP_URL`, parsed — RC D-3. Here rather than beside the adapter because configuration
 * validation reports a bad value at boot, and `core/` may not reach into `infrastructure/`.
 */

/** Where the scanner is, parsed from `AV_ICAP_URL`. */
export interface IcapEndpoint {
  readonly host: string;
  readonly port: number;
  /** The service path and query, e.g. `/avscan`. */
  readonly service: string;
}

/** The ICAP default port (RFC 3507 §4.2). */
export const ICAP_DEFAULT_PORT = 1344;

/**
 * Parses and checks an `icap://host[:port]/service` URL.
 *
 * Throws with a sentence naming what is wrong, for configuration validation to report at boot.
 * `icaps://` is refused rather than accepted and spoken in plain text: this build has no TLS for
 * ICAP, and a scheme that promises encryption the connection does not have is worse than a refusal.
 */
export function parseIcapUrl(raw: string): IcapEndpoint {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('is not a URL; expected icap://host:1344/service');
  }
  if (url.protocol !== 'icap:') {
    throw new Error(`uses ${url.protocol.replace(/:$/, '')}; only icap:// is supported`);
  }
  if (url.hostname === '') {
    throw new Error('names no host');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('carries credentials, which ICAP does not use');
  }
  if (url.pathname === '' || url.pathname === '/') {
    throw new Error('names no ICAP service, e.g. icap://scanner:1344/avscan');
  }
  const port = url.port === '' ? ICAP_DEFAULT_PORT : Number(url.port);
  // IPv6 literals come back bracketed from `URL`; the socket wants them bare.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return { host, port, service: `${url.pathname}${url.search}` };
}
