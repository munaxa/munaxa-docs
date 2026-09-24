import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLIENT_ADDRESS_HEADER, CLIENT_ADDRESS_STAMPED_ENV } from '@edms/utils/proxy-trust';

/**
 * The half of D-2's fix that the browser suite cannot reach: what the sign-in action forwards when
 * the process was *not* started by `server.mjs`.
 *
 * Under plain `next start` nothing overwrites the header, so its value is whatever the browser sent.
 * Forwarding it would hand the browser its own rate-limit key. The reader must answer nothing there,
 * and must refuse a value that is not an address even when the mark is present.
 */

const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: new Headers() }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(requestHeaders) }));
// A Next marker module with no runtime; the `logic` project has no alias for it.
vi.mock('server-only', () => ({}));

const { clientAddress } = await import('./client-address');

describe('clientAddress', () => {
  beforeEach(() => {
    for (const name of [...requestHeaders.keys()]) {
      requestHeaders.delete(name);
    }
  });

  afterEach(() => {
    delete process.env[CLIENT_ADDRESS_STAMPED_ENV];
  });

  it('forwards nothing when the process was not started by the stamping server', async () => {
    requestHeaders.set(CLIENT_ADDRESS_HEADER, '203.0.113.7');

    expect(await clientAddress()).toBeUndefined();
  });

  it('forwards the stamped address when the server stamped it', async () => {
    process.env[CLIENT_ADDRESS_STAMPED_ENV] = '1';
    requestHeaders.set(CLIENT_ADDRESS_HEADER, '203.0.113.7');

    expect(await clientAddress()).toBe('203.0.113.7');
  });

  it('forwards nothing when the stamped value is not an address', async () => {
    process.env[CLIENT_ADDRESS_STAMPED_ENV] = '1';
    requestHeaders.set(CLIENT_ADDRESS_HEADER, '203.0.113.7, 10.0.0.1');

    expect(await clientAddress()).toBeUndefined();
  });

  it('forwards nothing when the server resolved no address', async () => {
    process.env[CLIENT_ADDRESS_STAMPED_ENV] = '1';

    expect(await clientAddress()).toBeUndefined();
  });
});
