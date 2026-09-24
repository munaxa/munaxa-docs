import 'server-only';

import { isIP } from 'node:net';
import { headers } from 'next/headers';

import { CLIENT_ADDRESS_HEADER, CLIENT_ADDRESS_STAMPED_ENV } from '@edms/utils/proxy-trust';

/**
 * The browser's address, as this web server resolved it — or nothing.
 *
 * `server.mjs` resolves it from the socket under `WEB_TRUST_PROXY` and overwrites the header on every
 * request. Under any other entry point the header is whatever the browser sent, so without the
 * server's mark this answers nothing: forwarding no address leaves the API seeing this server, which
 * is the old, over-strict behaviour, rather than a client-chosen one, which would be a bypass.
 */
export async function clientAddress(): Promise<string | undefined> {
  if (process.env[CLIENT_ADDRESS_STAMPED_ENV] !== '1') {
    return undefined;
  }
  const value = (await headers()).get(CLIENT_ADDRESS_HEADER)?.trim();
  return value !== undefined && isIP(value) !== 0 ? value : undefined;
}
