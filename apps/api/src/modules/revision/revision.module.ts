import { Module } from '@nestjs/common';

import { REVISION_WRITER } from '../document/application/ports';
import { PrismaRevisionWriter } from './infrastructure/prisma-revision.writer';

/**
 * Revision — What did it look like at each controlled point in time?
 *
 * **Owns:** DocumentRevision, compare, restore
 * **Depends on:** Document, Storage
 *
 * Nothing in core.
 *
 * **Phase 3 builds one thing: the first revision.** A document's identity, the revision an approver
 * approves and the bytes themselves are three records with three lifetimes
 * ([ADR-0003](../../../../../docs/architecture/adr/0003-document-identity-revision-file-separation.md)),
 * and a document created without the middle one would be a document with no content — so upload
 * creates ordinal zero, in the same transaction, and nothing else.
 *
 * Check-out, check-in, compare and restore are Phase 6's; publishing and superseding are Phase 4's.
 * The `document_revision` table is already the full shape for all of them.
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
 * The alternative — Document writing `document_revision` itself — would put the revision table in
 * two modules, and the second one would be the one that forgets a rule when Phase 6 adds check-in.
 */
@Module({
  providers: [{ provide: REVISION_WRITER, useClass: PrismaRevisionWriter }],
  exports: [REVISION_WRITER],
})
export class RevisionModule {}
