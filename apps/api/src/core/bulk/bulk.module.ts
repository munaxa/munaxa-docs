import { Global, Module } from '@nestjs/common';

import { DefaultBulkExecutor } from './bulk-executor';
import { DefaultBulkPlanRegistry } from './bulk-plan.registry';
import { BULK_EXECUTOR, BULK_OPERATION_REPOSITORY, BULK_PLAN_REGISTRY } from './bulk.port';
import { PrismaBulkOperationRepository } from './prisma-bulk.repository';

/**
 * The bulk choreography, available to the modules that own the rows.
 *
 * Global, like `PersistenceModule` and `AuditModule`, and for the same reason: two different
 * modules — Document and Workflow — build plans against it, and neither may import the other. A
 * non-global module would have had to be imported by both, which is fine, and by anything either
 * of them re-exports, which is how a `BulkModule` becomes a dependency of half the container.
 *
 * **Phase 6.2 added the plan registry here** — data the modules fill, so the consumer can rebuild
 * a plan belonging to Document or Workflow without either module executing the other's rules. The
 * consumer itself is `BulkDispatchModule`'s, because it needs an export this global module cannot
 * see; that file says why.
 *
 * It provides a choreography and a record. It provides no rules: what a bulk restore is allowed to
 * do is `DefaultDocumentService.restore`, and what a bulk approval is allowed to do is
 * `ApprovalService.decide`. That separation is what keeps this from becoming the module every
 * other module calls sideways.
 */
@Global()
@Module({
  providers: [
    DefaultBulkExecutor,
    { provide: BULK_EXECUTOR, useExisting: DefaultBulkExecutor },
    { provide: BULK_OPERATION_REPOSITORY, useClass: PrismaBulkOperationRepository },
    // Phase 6.2. A singleton the modules fill at boot, so core holds the map and owns none of the
    // rules in it — `FolderContentsRegistry`'s shape exactly.
    { provide: BULK_PLAN_REGISTRY, useClass: DefaultBulkPlanRegistry },
  ],
  exports: [BULK_EXECUTOR, BULK_OPERATION_REPOSITORY, BULK_PLAN_REGISTRY, DefaultBulkExecutor],
})
export class BulkModule {}
