import { readFile } from 'node:fs/promises';

import { DOCS_PRODUCT_KEY } from '@edms/domain';
import {
  applyRevocation,
  licenseVerifier,
  resolveRevocationList,
  revocationInForce,
  verifyLicense,
  type LicenseVerifier,
} from '@munaxa/licensing';

import type { EntitlementLookup, EntitlementLookupResult } from './licensing.ports';

export interface LicenseFileSettings {
  readonly path: string;
  readonly algorithm: 'ES256' | 'RS256';
  readonly publicKeys: readonly { readonly kid: string; readonly publicKey: string }[];
  readonly installationId: string;
  /** Where the signed revocation list is delivered; `null` when it is not. */
  readonly revocationPath: string | null;
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
 *
 * A signed revocation list (platform ADR-0022) can only narrow: a licence it names is suspended. The
 * newest verified list is kept beside the snapshot, so deleting the file or offering an older list
 * does not lift a revocation; a kept list that no longer verifies suspends every licence until a
 * valid one is delivered. A fully offline installation learns of a revocation only when a new list
 * is copied to it.
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
    keptRevocationList: string | null = null,
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

    const revocation = resolveRevocationList(
      await this.offeredRevocationList(),
      keptRevocationList,
      { verifier: this.verifier, product: DOCS_PRODUCT_KEY, now },
    );
    const entry = revocationInForce(result.license, revocation, now);
    const snapshot = applyRevocation(result.snapshot, entry);
    return revocation.persist !== null && revocation.list !== null
      ? {
          kind: 'SNAPSHOT',
          snapshot,
          revocationList: { text: revocation.persist, sequence: revocation.list.sequence },
        }
      : { kind: 'SNAPSHOT', snapshot };
  }

  /** The delivered list, or `null` when none is configured or it cannot be read. */
  private async offeredRevocationList(): Promise<string | null> {
    if (this.settings.revocationPath === null) return null;
    try {
      return await readFile(this.settings.revocationPath, 'utf8');
    } catch {
      return null; // Nothing delivered, or not readable: the kept list stays in force.
    }
  }
}
