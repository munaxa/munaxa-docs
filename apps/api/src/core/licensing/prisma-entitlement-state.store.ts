import { Inject, Injectable } from '@nestjs/common';
import { parseEntitlementSnapshot } from '@munaxa/licensing';

import { requireTransaction, UNIT_OF_WORK, type UnitOfWork } from '../prisma/unit-of-work';
import type {
  EntitlementSource,
  EntitlementStateStore,
  StoredEntitlementState,
} from './licensing.ports';

/**
 * `entitlement_state`, under the request's tenant transaction and row-level security.
 *
 * A stored snapshot is parsed again on the way out. It was valid when written, and re-validating
 * it costs nothing next to trusting a JSON column that a migration, a restore or a hand edit could
 * have changed.
 */
@Injectable()
export class PrismaEntitlementStateStore implements EntitlementStateStore {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  read(tenantId: string): Promise<StoredEntitlementState | null> {
    return this.uow.run(async () => {
      const row = await requireTransaction().entitlementState.findUnique({ where: { tenantId } });
      if (row === null) return null;
      const parsed = row.snapshot === null ? null : parseEntitlementSnapshot(row.snapshot);
      return {
        snapshot: parsed !== null && parsed.ok ? parsed.snapshot : null,
        lastObservedAt: row.lastObservedAt,
      };
    });
  }

  write(
    tenantId: string,
    state: {
      readonly snapshot: StoredEntitlementState['snapshot'];
      readonly source: EntitlementSource;
      readonly observedAt: Date;
    },
  ): Promise<void> {
    return this.uow.run(async () => {
      const tx = requireTransaction();
      const snapshot = state.snapshot === null ? null : JSON.stringify(state.snapshot);
      // GREATEST in the statement, not a read-then-write: two replicas refreshing at once must not
      // let the earlier clock win.
      await tx.$executeRaw`
        INSERT INTO entitlement_state (tenant_id, snapshot, source, last_observed_at, updated_at)
        VALUES (${tenantId}::uuid, ${snapshot}::jsonb,
                ${state.source}, ${state.observedAt}, now())
        ON CONFLICT (tenant_id) DO UPDATE SET
          snapshot = EXCLUDED.snapshot,
          source = EXCLUDED.source,
          last_observed_at = GREATEST(entitlement_state.last_observed_at, EXCLUDED.last_observed_at),
          updated_at = now()`;
    });
  }
}
