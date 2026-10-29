import type { EntitlementSnapshot } from '@munaxa/licensing';

/**
 * Where this deployment's entitlements come from — ADR-0026.
 *
 * One lookup per deployment, chosen by `LICENSING_MODE`: an unlimited plan, a signed licence on
 * disk, or the central subscription service. A lookup answers for one tenant and never decides
 * anything; `EntitlementService` turns its answer into a ceiling through the shared contract.
 */
export const ENTITLEMENT_LOOKUP = Symbol('EntitlementLookup');

export type EntitlementLookupResult =
  /** The source of truth answered with a snapshot. */
  | {
      readonly kind: 'SNAPSHOT';
      readonly snapshot: EntitlementSnapshot;
      /** A newly verified revocation list for the store to keep (platform ADR-0022). */
      readonly revocationList?: { readonly text: string; readonly sequence: number };
    }
  /**
   * The source of truth answered, and the answer is that there is nothing: no subscription, or a
   * licence that cannot be trusted. Not an outage — a cached snapshot must not outlive it.
   */
  | { readonly kind: 'NONE'; readonly reason: string }
  /** The source could not be asked. The last verified snapshot is used, degraded by age. */
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

export interface EntitlementLookup {
  /** Which source this is, recorded beside the snapshot it produced. */
  readonly source: EntitlementSource;
  /**
   * Whether the stored snapshot is worth keeping for an outage. False for the unlimited plan,
   * which is computed rather than fetched and so is never unavailable.
   */
  readonly cachesSnapshots: boolean;
  /** Never throws: an outage is an answer, and a thrown error tends to be caught permissively. */
  lookup(
    tenantId: string,
    lastObservedAt: Date | null,
    now: Date,
    /** The revocation list this deployment kept for the tenant, if any. */
    keptRevocationList?: string | null,
  ): Promise<EntitlementLookupResult>;
}

export type EntitlementSource = 'UNMETERED' | 'LICENSE_FILE' | 'CONTROL_PLANE';

export const ENTITLEMENT_STATE_STORE = Symbol('EntitlementStateStore');

export interface StoredEntitlementState {
  readonly snapshot: EntitlementSnapshot | null;
  readonly lastObservedAt: Date;
  /** The newest revocation list verified for the tenant, as delivered; `null` when none. */
  readonly revocationList: string | null;
}

/** The `entitlement_state` row, read and written inside the request's own tenant transaction. */
export interface EntitlementStateStore {
  read(tenantId: string): Promise<StoredEntitlementState | null>;
  /**
   * Records what was verified. `lastObservedAt` only moves forward: the store keeps the later of
   * the stored and the given value, so a rolled-back clock cannot pull it back.
   */
  write(
    tenantId: string,
    state: {
      readonly snapshot: EntitlementSnapshot | null;
      readonly source: EntitlementSource;
      readonly observedAt: Date;
    },
  ): Promise<void>;
  /**
   * Keeps a newly verified revocation list. Only a higher `sequence` replaces the stored one, so two
   * replicas racing can never put an older list back. A tenant with no state row yet keeps nothing;
   * the next refresh, after its state is written, keeps it.
   */
  writeRevocationList(tenantId: string, list: string, sequence: number): Promise<void>;
}
