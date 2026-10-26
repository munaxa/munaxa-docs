import type { AppConfig } from '../core/config';
import { EntitlementService } from '../core/licensing/entitlement.service';
import type {
  EntitlementLookup,
  EntitlementStateStore,
  StoredEntitlementState,
} from '../core/licensing/licensing.ports';
import { UnmeteredLookup } from '../core/licensing/unmetered.lookup';
import type { Logger } from '../core/observability/logger';
import type { ClockPort } from '../ports/clock.port';
import { FakeClock } from './fake-ports';

/** An `entitlement_state` that lives in a map — the same forward-only rule for the observed time. */
export class MemoryEntitlementStateStore implements EntitlementStateStore {
  readonly rows = new Map<string, StoredEntitlementState>();

  read(tenantId: string): Promise<StoredEntitlementState | null> {
    return Promise.resolve(this.rows.get(tenantId) ?? null);
  }

  write(tenantId: string, state: Parameters<EntitlementStateStore['write']>[1]): Promise<void> {
    const previous = this.rows.get(tenantId)?.lastObservedAt;
    const lastObservedAt =
      previous !== undefined && previous > state.observedAt ? previous : state.observedAt;
    this.rows.set(tenantId, { snapshot: state.snapshot, lastObservedAt });
    return Promise.resolve();
  }
}

const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

/** An `EntitlementService` over any lookup, for a suite that is about licensing. */
export function entitlementsWith(options: {
  readonly lookup: EntitlementLookup;
  readonly store?: EntitlementStateStore;
  readonly clock?: ClockPort;
  readonly refreshSeconds?: number;
}): EntitlementService {
  return new EntitlementService(
    options.lookup,
    options.store ?? new MemoryEntitlementStateStore(),
    options.clock ?? new FakeClock(),
    { licensing: { refreshSeconds: options.refreshSeconds ?? 60 } } as AppConfig,
    quiet,
  );
}

/**
 * The unlimited plan `LICENSING_MODE=NONE` gives every tenant — for a suite that is about something
 * else, where licensing must neither refuse nor be skipped. An unlimited ceiling takes no lock and
 * runs no count, so it adds nothing to what such a suite measures.
 */
export function unmeteredEntitlements(clock?: ClockPort): EntitlementService {
  return entitlementsWith({ lookup: new UnmeteredLookup('SAAS'), ...(clock && { clock }) });
}
