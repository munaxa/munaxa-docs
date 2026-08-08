import { Module } from '@nestjs/common';

import { BulkLaneConsumer } from '../../core/bulk/bulk-lane.consumer';
import { IdentityModule } from '../identity/identity.module';

/**
 * The `documents.bulk` lane's subscriber, in a module of its own — Phase 6.2.
 *
 * ## Why this is under `modules/` and not beside the rest of bulk in `core/`
 *
 * The first draft put it in `core/bulk`, and the boundary lint refused it in one line: *"Core and
 * ports are imported by every module and may never depend on one. Invert the dependency."* It was
 * right — this module has to import `IdentityModule`, and a core file that imports a feature module
 * makes every module that imports core depend on Identity.
 *
 * **This is not the "bulk module" `bulk.port.ts` argues against.** That warning is about a module
 * holding four other modules' rules about what may be restored, approved and edited. This one holds
 * no rules, no services, no repositories and no plans: it is a `providers` array with one entry and
 * an `imports` array with one entry. The choreography, the record and the registry stay in
 * `core/bulk`, where every module can reach them, and the consumer class itself lives there too —
 * only its *composition* is here, because composition is the one thing that needs to know which
 * modules exist.
 *
 * `DispositionModule`'s shape exactly, and for its reason. `BulkModule` is `@Global()` because two
 * modules build plans against it and neither may import the other; a global module cannot see
 * another module's exports, and `BulkLaneConsumer` needs one — `BULK_REQUESTER_DIRECTORY`, which
 * Identity provides because Identity owns people.
 *
 * Making `BulkModule` import `IdentityModule` would have been the smaller diff and the wrong one:
 * a global module that imports a feature module drags that module into everything, and Identity
 * imports `core/bulk` for the port symbol, so the two would reference each other. A separate,
 * non-global module composed after Identity has neither problem — exactly as Phase 10 put the
 * retention lane's consumer beside `DOCUMENT_DISPOSITION`'s provider rather than in
 * `RetentionModule`.
 *
 * It provides the consumer and nothing else. The choreography, the record and the registry stay in
 * `BulkModule`, where every module can reach them.
 */
@Module({
  imports: [IdentityModule],
  providers: [BulkLaneConsumer],
})
export class BulkDispatchModule {}
