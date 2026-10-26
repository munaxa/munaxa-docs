/**
 * What Munaxa Docs sells — its own catalogue of features and limits.
 *
 * The keys are this product's alone. The shared contract (`@munaxa/licensing`) evaluates them
 * without knowing what they mean, and the central service stores them in plans without
 * interpreting them; a key changes meaning only here.
 *
 * A feature is a capability a plan includes or not. A limit is a ceiling on a metered quantity. A
 * permission is neither: whether a *user* may act is `permissions.ts`, and no entry here can
 * grant what a role does not (`docs/architecture/adr/0012-entitlements-as-data-enforced-centrally.md`).
 */

/** This product's key in every snapshot and licence. */
export const DOCS_PRODUCT_KEY = 'docs';

export const DocsFeature = {
  /** Machine callers — API clients and their keys. */
  API_ACCESS: 'api.access',
  /** Outbound webhooks. */
  WEBHOOKS: 'integration.webhooks',
  /** Federated sign-in through the tenant's identity provider. */
  SSO_FEDERATION: 'sso.federation',
  /** The audit stream to a SIEM. */
  AUDIT_STREAM: 'audit.stream',
  /** Electronic signatures. */
  ESIGNATURE: 'esignature',
} as const;
export type DocsFeatureKey = (typeof DocsFeature)[keyof typeof DocsFeature];

export const ALL_DOCS_FEATURES: readonly DocsFeatureKey[] = Object.values(DocsFeature);

export const DocsLimit = {
  /** Accounts that can sign in or are invited to: every live account that is not disabled. */
  USERS: 'users',
  /** Stored bytes, after deduplication, excluding derived renditions (`11-storage-architecture.md` §7). */
  STORAGE_BYTES: 'storage.bytes',
} as const;
export type DocsLimitKey = (typeof DocsLimit)[keyof typeof DocsLimit];

export const ALL_DOCS_LIMITS: readonly DocsLimitKey[] = Object.values(DocsLimit);
