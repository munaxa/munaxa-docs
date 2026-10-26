import { Inject, Injectable } from '@nestjs/common';
import {
  AccessMode,
  DenialReason,
  OperationKind,
  SAAS_AVAILABILITY_POLICY,
  SnapshotSource,
  checkFeature,
  checkOperation,
  checkQuota,
  limitOf,
  resolveSnapshot,
  type AvailabilityPolicy,
  type EntitlementDecision,
  type EntitlementSnapshot,
} from '@munaxa/licensing';

import { DOCS_PRODUCT_KEY, type DocsFeatureKey, type DocsLimitKey } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../config';
import { SubscriptionRequiredError } from '../errors/application-errors';
import { LOGGER, type Logger } from '../observability/logger';
import { requireTransaction } from '../prisma/unit-of-work';
import { requireContext } from '../tenancy/tenant-context';
import { CLOCK_PORT, type ClockPort } from '../../ports/clock.port';
import type { PolicyContext, PolicyEvaluator, PolicyVerdict } from '../authorization/policy.port';
import {
  ENTITLEMENT_LOOKUP,
  ENTITLEMENT_STATE_STORE,
  type EntitlementLookup,
  type EntitlementSource,
  type EntitlementStateStore,
} from './licensing.ports';

const DAY = 24 * 60 * 60 * 1000;

/**
 * On premises the licence is a local file, so "unavailable" means somebody moved or broke it. There
 * is no freshness window — growth stops at once — and the last verified licence keeps the
 * installation readable for a month while the file is put back.
 */
export const LICENSE_FILE_AVAILABILITY_POLICY: AvailabilityPolicy = {
  freshForMs: 0,
  noGrowthForMs: 7 * DAY,
  readOnlyForMs: 30 * DAY,
};

/** What a tenant's entitlements resolve to right now, and how far they are trusted. */
export interface EntitlementResolution {
  readonly snapshot: EntitlementSnapshot | null;
  readonly source: SnapshotSource;
  readonly cap: AccessMode;
  readonly origin: EntitlementSource;
  /**
   * The instant decisions are made at: the later of the clock and the latest instant this
   * deployment has recorded. A clock wound back cannot make a term that has ended current again.
   */
  readonly evaluatedAt: Date;
  /** Why the source did not answer with a snapshot, when it did not. Operator-facing. */
  readonly reason: string | null;
}

/**
 * The one place Munaxa Docs asks what a tenant bought — ADR-0012, ADR-0026.
 *
 * Every decision goes through the shared contract (`@munaxa/licensing`), so "what does a suspended
 * tenant keep" has the same answer here as in every other product. This service adds only what is
 * this product's: where the snapshot comes from, how long it is reused, and how a quota is enforced
 * atomically against this product's own rows.
 *
 * It never grants. A route reached through here still needs its permission, its tenant and its
 * object-level reach; a licence is a ceiling on what those allow.
 */
@Injectable()
export class EntitlementService implements PolicyEvaluator {
  private readonly memo = new Map<
    string,
    { readonly resolution: EntitlementResolution; readonly until: number }
  >();

  constructor(
    @Inject(ENTITLEMENT_LOOKUP) private readonly lookup: EntitlementLookup,
    @Inject(ENTITLEMENT_STATE_STORE) private readonly store: EntitlementStateStore,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Resolve, reusing an answer for `LICENSING_REFRESH_SECONDS`.
   *
   * The reuse is why a suspension takes up to that long to reach every process. The alternative —
   * asking the central service on every request — would make its latency every request's latency
   * and its outage everybody's.
   */
  async resolve(tenantId: string): Promise<EntitlementResolution> {
    const now = this.clock.now();
    const memoised = this.memo.get(tenantId);
    if (memoised !== undefined && memoised.until > now.getTime()) return memoised.resolution;

    const resolution = await this.resolveNow(tenantId, now);
    this.memo.set(tenantId, {
      resolution,
      until: now.getTime() + this.config.licensing.refreshSeconds * 1000,
    });
    return resolution;
  }

  /** Forget a memoised answer — after an administrator installs a new licence, say. */
  forget(tenantId: string): void {
    this.memo.delete(tenantId);
  }

  private async resolveNow(tenantId: string, now: Date): Promise<EntitlementResolution> {
    const origin = this.lookup.source;
    const stored = this.lookup.cachesSnapshots ? await this.store.read(tenantId) : null;
    const observed = stored?.lastObservedAt ?? null;
    const evaluatedAt = observed !== null && observed > now ? observed : now;
    const answer = await this.lookup.lookup(tenantId, observed, now);

    if (answer.kind === 'SNAPSHOT') {
      if (this.lookup.cachesSnapshots) {
        await this.store.write(tenantId, {
          snapshot: answer.snapshot,
          source: origin,
          observedAt: now,
        });
      }
      const resolved = resolveSnapshot(answer.snapshot, null, evaluatedAt);
      return { ...resolved, origin, evaluatedAt, reason: null };
    }

    this.logger.warn('Entitlements could not be confirmed', {
      tenantId,
      source: origin,
      outcome: answer.kind,
      reason: answer.reason,
    });

    if (answer.kind === 'NONE') {
      // The source of truth said there is nothing. The stored snapshot goes too, so it cannot
      // bridge a later outage into access the source has already withdrawn.
      if (this.lookup.cachesSnapshots) {
        await this.store.write(tenantId, { snapshot: null, source: origin, observedAt: now });
      }
      return {
        snapshot: null,
        source: SnapshotSource.UNAVAILABLE,
        cap: AccessMode.NONE,
        origin,
        evaluatedAt,
        reason: answer.reason,
      };
    }

    const policy =
      origin === 'LICENSE_FILE' ? LICENSE_FILE_AVAILABILITY_POLICY : SAAS_AVAILABILITY_POLICY;
    const resolved = resolveSnapshot(null, stored?.snapshot ?? null, evaluatedAt, policy);
    return { ...resolved, origin, evaluatedAt, reason: answer.reason };
  }

  private context(tenantId: string, resolution: EntitlementResolution) {
    return {
      now: resolution.evaluatedAt,
      tenantId,
      product: DOCS_PRODUCT_KEY,
      cap: resolution.cap,
    };
  }

  /** Decide, without throwing. */
  async decide(
    tenantId: string,
    operation: OperationKind,
    features: readonly DocsFeatureKey[] = [],
  ): Promise<EntitlementDecision> {
    const resolution = await this.resolve(tenantId);
    const context = this.context(tenantId, resolution);
    let decision = checkOperation(resolution.snapshot, operation, context);
    for (const feature of features) {
      if (!decision.allowed) break;
      decision = checkFeature(resolution.snapshot, feature, operation, context);
    }
    return decision;
  }

  /** Decide for the current request's tenant, and refuse with `402` when the answer is no. */
  async require(operation: OperationKind, features: readonly DocsFeatureKey[] = []): Promise<void> {
    const { tenantId } = requireContext();
    const decision = await this.decide(tenantId, operation, features);
    if (!decision.allowed) throw refusal(decision, features);
  }

  /**
   * Enforce a limit for growth by `requested`, atomically.
   *
   * Must be called inside the transaction that commits the growth. It takes a transaction-scoped
   * advisory lock for this tenant and limit, so two concurrent requests are serialised between the
   * count and the commit and cannot both see the last free unit. The lock is the two-key form, in
   * its own namespace, so it can never contend with the audit chain's single-key lock.
   *
   * An unlimited ceiling takes no lock and runs no count: the unmetered default costs nothing.
   */
  async enforceLimit(
    limitKey: DocsLimitKey,
    requested: number,
    countUsed: () => Promise<number>,
  ): Promise<void> {
    const { tenantId } = requireContext();
    const resolution = await this.resolve(tenantId);
    const context = this.context(tenantId, resolution);
    const growth = checkOperation(resolution.snapshot, OperationKind.GROWTH, context);
    if (!growth.allowed) throw refusal(growth, []);
    if (resolution.snapshot === null || limitOf(resolution.snapshot, limitKey) === null) return;

    await requireTransaction()
      .$executeRaw`SELECT pg_advisory_xact_lock(hashtext('edms:licensing'), hashtext(${`${tenantId}:${limitKey}`}))`;
    const used = await countUsed();
    const decision = checkQuota(resolution.snapshot, limitKey, { used, requested }, context);
    if (!decision.allowed) throw refusal(decision, [], limitKey);
  }

  // --- PolicyEvaluator: the port Phase 0.5 declared and left unbound ----------------------

  async isEnabled(feature: string, context: PolicyContext): Promise<boolean> {
    const resolution = await this.resolve(context.tenantId);
    return checkFeature(
      resolution.snapshot,
      feature,
      OperationKind.READ,
      this.context(context.tenantId, resolution),
    ).allowed;
  }

  async check(entitlement: string, context: PolicyContext): Promise<PolicyVerdict> {
    const resolution = await this.resolve(context.tenantId);
    const used = context.usage?.[entitlement] ?? 0;
    const decision = checkQuota(
      resolution.snapshot,
      entitlement,
      { used, requested: 0 },
      this.context(context.tenantId, resolution),
    );
    const limit = resolution.snapshot === null ? 0 : limitOf(resolution.snapshot, entitlement);
    return {
      allowed: decision.allowed && (limit === null || used <= limit),
      limit,
      used,
      reason: decision.allowed ? null : decision.reason,
    };
  }
}

function refusal(
  decision: EntitlementDecision,
  features: readonly DocsFeatureKey[],
  limitKey?: DocsLimitKey,
): SubscriptionRequiredError {
  const message =
    decision.reason === DenialReason.FEATURE_NOT_INCLUDED
      ? "Your organisation's plan does not include this."
      : decision.reason === DenialReason.QUOTA_EXCEEDED
        ? "Your organisation's plan limit has been reached."
        : "Your organisation's subscription does not allow this right now.";
  return new SubscriptionRequiredError(message, {
    reason: decision.reason,
    status: decision.status,
    mode: decision.mode,
    ...(features.length > 0 && { features: features.join(',') }),
    ...(limitKey !== undefined && { limit: limitKey }),
    ...(decision.limit !== undefined && { ceiling: decision.limit }),
  });
}
