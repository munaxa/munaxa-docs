import type { TenantId } from '@edms/domain';

/**
 * Policy and entitlement evaluation — the answer to "is this capability switched on for this
 * tenant, right now?", which is a different question from "may this user do it?"
 *
 * Entitlements are data, enforced centrally
 * (`docs/architecture/adr/0012-entitlements-as-data-enforced-centrally.md`): a plan limit is
 * a row, not an `if` in a use case, and a limit that is checked in two places will one day
 * be checked differently in the two places.
 */
export const POLICY_EVALUATOR = Symbol('PolicyEvaluator');

export interface PolicyContext {
  readonly tenantId: TenantId;
  /** Counted usage the limit is compared against, supplied by the caller that knows it. */
  readonly usage?: Readonly<Record<string, number>>;
}

export interface PolicyVerdict {
  readonly allowed: boolean;
  readonly limit: number | null;
  readonly used: number | null;
  /** Operator- and user-facing explanation: "your plan includes 5 libraries". */
  readonly reason: string | null;
}

export interface PolicyEvaluator {
  /** A boolean capability: is this feature part of the tenant's plan? */
  isEnabled(feature: string, context: PolicyContext): Promise<boolean>;
  /** A metered capability: is there headroom left? */
  check(entitlement: string, context: PolicyContext): Promise<PolicyVerdict>;
}

export const FEATURE_FLAGS = Symbol('FeatureFlags');

/**
 * Deployment-time switches, distinct from entitlements: a flag hides unfinished work, an
 * entitlement expresses what a customer bought. Conflating them is how an unfinished feature
 * ends up sold.
 */
export interface FeatureFlags {
  isOn(flag: string, tenantId: TenantId | null): boolean;
  readonly all: Readonly<Record<string, boolean>>;
}
