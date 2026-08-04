import { Module } from '@nestjs/common';

import { REVISION_WRITER } from '../document/application/ports';
import { PreviewModule } from '../preview/preview.module';
import { REVISION_QUERY } from './application/ports';
import { RevisionQueryService } from './application/revision-query.service';
import { PrismaRevisionQueryRepository } from './infrastructure/prisma-revision-query.repository';
import { PrismaRevisionWriter } from './infrastructure/prisma-revision.writer';
import { RevisionsController } from './presentation/revisions.controller';

/**
 * Revision — What did it look like at each controlled point in time?
 *
 * **Owns:** DocumentRevision, compare, restore
 * **Depends on:** Document, Storage
 *
 * Nothing in core.
 *
 * **Phase 3 built the first revision; Phase 6 built the rest.** A document's identity, the
 * revision an approver approves and the bytes themselves are three records with three lifetimes
 * ([ADR-0003](../../../../../docs/architecture/adr/0003-document-identity-revision-file-separation.md)).
 * The writer now covers the whole life of the middle one — the next revision at check-in, the
 * working-status moves, publication with its supersession, the discard a cancelled check-out
 * performs — and the read side answers the history and the compare API.
 *
 * ### Why this module provides a token another module declared
 *
 * `REVISION_WRITER` is declared in `document/application/ports.ts` and implemented here. That is
 * dependency inversion, not a boundary violation, and the import direction is what shows it: this
 * module imports Document's port, and nothing in Document imports anything of this module's. The
 * Nest binding is registered here because this is where the implementation lives, and
 * `DocumentModule` imports this module to receive it — which is the direction DI wiring always
 * points, from the consumer to whatever satisfies it.
 *
 * Phase 6 followed the same seam for every new Document↔Revision operation rather than invent a
 * second pattern: Document declares check-in, publish and discard in its own vocabulary, this
 * module implements them and publishes Revision's own events from inside the same transaction.
 * The alternative — Document writing `document_revision` itself — would put the revision table in
 * two modules, and the second one would be the one that forgets a rule.
 *
 * The *reads* — the timeline, the comparison — are this module's own surface
 * (`presentation/revisions.controller.ts`), behind `document:history:view`, because a superseded
 * revision remaining readable is the module's answer to the question it owns.
 */
@Module({
  // Phase 7: the compare API's text and page sections consume the preview pipeline's
  // artefacts through `PreviewQueryService` — the direction 10 §4 always drew.
  imports: [PreviewModule],
  controllers: [RevisionsController],
  providers: [
    { provide: REVISION_WRITER, useClass: PrismaRevisionWriter },
    { provide: REVISION_QUERY, useClass: PrismaRevisionQueryRepository },
    RevisionQueryService,
  ],
  exports: [REVISION_WRITER],
})
export class RevisionModule {}
