import { readFile } from 'node:fs/promises';

import { DOCS_PRODUCT_KEY } from '@edms/domain';
import { licenseVerifier, verifyLicense, type LicenseVerifier } from '@munaxa/licensing';

import type { EntitlementLookup, EntitlementLookupResult } from './licensing.ports';

export interface LicenseFileSettings {
  readonly path: string;
  readonly algorithm: 'ES256' | 'RS256';
  readonly publicKeys: readonly { readonly kid: string; readonly publicKey: string }[];
  readonly installationId: string;
}

/**
 * `LICENSING_MODE=LICENSE_FILE`: the on-premises mode. No network.
 *
 * The file is read on every lookup rather than once at boot, so renewing is copying a new file into
 * place — no restart, and no window in which the old licence and the new one disagree about which
 * is loaded.
 *
 * A missing or unreadable file is `UNAVAILABLE` (somebody moved it; the last verified licence
 * carries on, degraded). A file that is present and fails verification is `NONE`: a forged,
 * foreign or clock-rolled licence must not be bridged by the one it was meant to replace.
 */
export class LicenseFileLookup implements EntitlementLookup {
  readonly source = 'LICENSE_FILE' as const;
  readonly cachesSnapshots = true;
  private readonly verifier: LicenseVerifier;

  constructor(private readonly settings: LicenseFileSettings) {
    this.verifier = licenseVerifier(settings.algorithm, settings.publicKeys);
  }

  async lookup(
    tenantId: string,
    lastObservedAt: Date | null,
    now: Date,
  ): Promise<EntitlementLookupResult> {
    let text: string;
    try {
      text = await readFile(this.settings.path, 'utf8');
    } catch {
      return { kind: 'UNAVAILABLE', reason: 'LICENSE_FILE_UNREADABLE' };
    }
    const result = verifyLicense(text, {
      verifier: this.verifier,
      product: DOCS_PRODUCT_KEY,
      installationId: this.settings.installationId,
      now,
      lastObservedAt,
    });
    if (!result.ok) return { kind: 'NONE', reason: `LICENSE_${result.reason}` };
    // A licence names the tenant it was issued for. An installation serving a different tenant is
    // not licensed for it, however valid the signature.
    if (result.snapshot.tenantId !== tenantId)
      return { kind: 'NONE', reason: 'LICENSE_WRONG_TENANT' };
    return { kind: 'SNAPSHOT', snapshot: result.snapshot };
  }
}
