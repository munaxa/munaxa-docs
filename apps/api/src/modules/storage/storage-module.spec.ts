import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { DOWNLOAD_REDEEMERS, DownloadRedeemerRegistry } from './application/ports';
import { StorageModule } from './storage.module';

/**
 * The download redeemer registry belongs to one application, never to the process.
 *
 * It was a `useValue`, created once when the module file loaded: every application booted in the
 * same process shared it, so the second boot found its kinds already registered and refused to
 * start (`antivirus.e2e`, `idempotency.e2e` and `client-address` each boot more than one).
 */
describe('the download redeemer registry provider', () => {
  it('builds a fresh registry for each application', () => {
    const providers = Reflect.getMetadata('providers', StorageModule) as readonly unknown[];
    const provider = providers.find(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        (candidate as { provide?: unknown }).provide === DOWNLOAD_REDEEMERS,
    ) as { useFactory?: () => unknown; useValue?: unknown } | undefined;

    expect(provider?.useValue).toBeUndefined();
    const first = provider?.useFactory?.();
    const second = provider?.useFactory?.();
    expect(first).toBeInstanceOf(DownloadRedeemerRegistry);
    expect(second).toBeInstanceOf(DownloadRedeemerRegistry);
    expect(first).not.toBe(second);
  });
});
