import { Module } from '@nestjs/common';

import { AdministrationModule } from '../administration/administration.module';
import { IdentityModule } from '../identity/identity.module';
import { LibraryModule } from '../library/library.module';
import { OrganizationModule } from '../organization/organization.module';
import { PreviewModule } from '../preview/preview.module';
import { RevisionModule } from '../revision/revision.module';
import { StorageModule } from '../storage/storage.module';
import { DefaultDocumentService } from './application/document.service';
import { DOCUMENT_CONFIGURATION } from './application/configuration.port';
import { DOCUMENT_PLACEMENT } from './application/placement.port';
import {
  DOCUMENT_ACTIVITY_REPOSITORY,
  DOCUMENT_CONTENT_GATE,
  DOCUMENT_REPOSITORY,
  DOCUMENT_SERVICE,
} from './application/ports';
import { AdministrationConfigurationAdapter } from './infrastructure/administration-configuration.adapter';
import { LibraryPlacementAdapter } from './infrastructure/library-placement.adapter';
import { PrismaDocumentActivityRepository } from './infrastructure/prisma-document-activity.repository';
import { PrismaDocumentRepository } from './infrastructure/prisma-document.repository';
import { StorageContentGateAdapter } from './infrastructure/storage-content-gate.adapter';
import { DocumentsController } from './presentation/documents.controller';

/**
 * Document — What is this document, in the business's terms?
 *
 * **Owns:** Document, DocumentMetadataValue, Tag, Link, check-out Lock
 * **Depends on:** Library, Administration
 *
 * Nothing in core. It is the product's root aggregate and the busiest publisher of events.
 *
 * Phase 3 builds the library: creating a controlled record from uploaded content, its business
 * metadata, where it sits, and the two per-person lists — favourites and recents — that make a
 * library navigable. Tags, links and the check-out lock are later phases; the aggregate is here.
 *
 * ### What it imports, and why each one
 *
 * `LibraryModule` and `AdministrationModule` are the declared dependencies: a document sits in a
 * folder and is assembled from a document type. Both are reached through their **application
 * services**, behind ports this module declares — see `configuration.port.ts` and
 * `placement.port.ts` — so the coupling is to a question rather than to a schema.
 *
 * `OrganizationModule` and `IdentityModule` are there for one narrow reason each: a metadata field
 * of type `DEPARTMENT` or `USER` names something, and a document that stored an identifier for a
 * person who does not work here would be a document whose details are silently wrong.
 *
 * `StorageModule`, `RevisionModule` and `PreviewModule` are the **inverted** ones, and their
 * direction is worth being precise about. All three sit below Document in the module order, so
 * Document may not call them — and it does not. It declares `DOCUMENT_CONTENT_GATE`,
 * `REVISION_WRITER` and `DOCUMENT_THUMBNAILER` in its own application layer, in its own vocabulary,
 * and each of those modules implements one. The Nest import points from consumer to container
 * entry, which is what DI wiring does; the *code* dependency points the other way, which is what
 * the boundary lint checks. Nothing in this module imports anything of theirs.
 */
@Module({
  imports: [
    LibraryModule,
    AdministrationModule,
    OrganizationModule,
    IdentityModule,
    StorageModule,
    RevisionModule,
    PreviewModule,
  ],
  controllers: [DocumentsController],
  providers: [
    PrismaDocumentRepository,
    { provide: DOCUMENT_REPOSITORY, useExisting: PrismaDocumentRepository },
    { provide: DOCUMENT_ACTIVITY_REPOSITORY, useClass: PrismaDocumentActivityRepository },
    { provide: DOCUMENT_CONFIGURATION, useClass: AdministrationConfigurationAdapter },
    { provide: DOCUMENT_PLACEMENT, useClass: LibraryPlacementAdapter },
    { provide: DOCUMENT_CONTENT_GATE, useClass: StorageContentGateAdapter },
    { provide: DOCUMENT_SERVICE, useClass: DefaultDocumentService },
  ],
  exports: [DOCUMENT_SERVICE],
})
export class DocumentModule {}
