import { Global, Module } from '@nestjs/common';

import { DefaultBulkExecutor } from './bulk-executor';
import { BULK_EXECUTOR, BULK_OPERATION_REPOSITORY } from './bulk.port';
import { PrismaBulkOperationRepository } from './prisma-bulk.repository';

/**
 * The bulk choreography, available to the modules that own the rows.
 *
 * Global, like `PersistenceModule` and `AuditModule`, and for the same reason: two different
 * modules — Document and Workflow — build plans against it, and neither may import the other. A
 * non-global module would have had to be imported by both, which is fine, and by anything either
 * of them re-exports, which is how a `BulkModule` becomes a dependency of half the container.
 *
 * It provides a choreography and a record. It provides no rules: what a bulk restore is allowed to
 * do is `DefaultDocumentService.restore`, and what a bulk approval is allowed to do is
 * `ApprovalService.decide`. That separation is what keeps this from becoming the module every
 * other module calls sideways.
 */
@Global()
@Module({
  providers: [
    { provide: BULK_EXECUTOR, useClass: DefaultBulkExecutor },
    { provide: BULK_OPERATION_REPOSITORY, useClass: PrismaBulkOperationRepository },
  ],
  exports: [BULK_EXECUTOR, BULK_OPERATION_REPOSITORY],
})
export class BulkModule {}
