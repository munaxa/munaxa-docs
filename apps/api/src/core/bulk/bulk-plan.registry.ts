import { Injectable } from '@nestjs/common';

import type { BulkOperationKindKey } from '@edms/domain';

import type { BulkPlan, BulkPlanFactory, BulkPlanRegistry } from './bulk.port';

/**
 * Where each module says how to rebuild its plan — Phase 6.2.
 *
 * The same shape as `FolderContentsRegistry`: core holds a map, the modules fill it at boot, and
 * core owns none of the rules in it. A `bulk` module that imported Document and Workflow to build
 * their plans is exactly the sideways dependency `modules/README.md` forbids and the reason bulk
 * lives in `core/` at all.
 *
 * ## Why an unknown kind throws
 *
 * A payload arriving for a kind with no factory is not a bad request — the request was validated
 * and accepted by a controller, and the operation row exists. It means the module that produces
 * that kind failed to register, which is a wiring defect that must be loud at the first delivery
 * rather than silently turning the operation into an empty success. `composition.spec.ts` asserts
 * all five are registered, so the loud failure is one a test finds rather than a customer.
 */
@Injectable()
export class DefaultBulkPlanRegistry implements BulkPlanRegistry {
  private readonly factories = new Map<BulkOperationKindKey, BulkPlanFactory>();

  register(kind: BulkOperationKindKey, factory: BulkPlanFactory): void {
    this.factories.set(kind, factory);
  }

  has(kind: BulkOperationKindKey): boolean {
    return this.factories.has(kind);
  }

  planFor(kind: BulkOperationKindKey, payload: Readonly<Record<string, unknown>>): BulkPlan {
    const factory = this.factories.get(kind);
    if (factory === undefined) {
      throw new Error(
        `No bulk plan is registered for ${kind}. The module that produces it did not register a factory.`,
      );
    }
    return factory(payload);
  }
}
