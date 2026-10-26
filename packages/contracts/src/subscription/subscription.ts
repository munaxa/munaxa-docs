/**
 * The tenant's own view of its subscription — ADR-0026.
 *
 * What a tenant administrator may know about what their organisation bought and what it permits
 * right now. It carries no price, no other tenant and nothing about how the central service holds
 * the record: those belong to Munaxa's own administration, not to the customer's workspace.
 */
export interface SubscriptionView {
  /** `UNMETERED` (no licensing configured), `LICENSE_FILE` or `CONTROL_PLANE`. */
  readonly origin: 'UNMETERED' | 'LICENSE_FILE' | 'CONTROL_PLANE';
  /** Whether the answer is live, a cached one, a stale one, or unavailable. */
  readonly freshness: 'LIVE' | 'CACHED' | 'STALE' | 'UNAVAILABLE';
  /** The status now, after dates are applied; `null` when no subscription is known. */
  readonly status: string | null;
  /** What the status and freshness permit: `FULL`, `NO_GROWTH`, `READ_ONLY`, `EXPORT_ONLY`, `NONE`. */
  readonly mode: string;
  readonly plan: { readonly code: string; readonly version: number } | null;
  readonly features: readonly string[];
  /** `null` is unlimited. */
  readonly limits: Readonly<Record<string, number | null>>;
  readonly trialEndsAt: string | null;
  readonly expiresAt: string | null;
  readonly graceUntil: string | null;
}
