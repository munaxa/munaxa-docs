import { Module, type OnModuleInit } from '@nestjs/common';

import { AdministrationModule } from '../administration/administration.module';
import { IdentityModule } from '../identity/identity.module';
import { LibraryModule } from '../library/library.module';
import { OrganizationModule } from '../organization/organization.module';
import { PreviewModule } from '../preview/preview.module';
import { DOCUMENT_DISPOSITION } from '../retention/application/ports';
import { RetentionModule } from '../retention/retention.module';
import { RevisionModule } from '../revision/revision.module';
import { FolderContentsRegistry } from '../library/application/folder-contents.port';
import { StorageModule } from '../storage/storage.module';
import { DefaultDocumentNumberService } from './application/document-number.service';
import { DocumentPreviewService } from './application/document-preview.service';
import { DefaultDocumentService } from './application/document.service';
import { RevisionControlService } from './application/revision-control.service';
import { DOCUMENT_CONFIGURATION } from './application/configuration.port';
import { DOCUMENT_PLACEMENT } from './application/placement.port';
import {
  DOCUMENT_ACTIVITY_REPOSITORY,
  DOCUMENT_CONTENT_GATE,
  DOCUMENT_LOCK_REPOSITORY,
  DOCUMENT_NUMBER_SERVICE,
  DOCUMENT_REPOSITORY,
  DOCUMENT_SERVICE,
} from './application/ports';
import { AdministrationConfigurationAdapter } from './infrastructure/administration-configuration.adapter';
import { LibraryPlacementAdapter } from './infrastructure/library-placement.adapter';
import { PrismaDocumentActivityRepository } from './infrastructure/prisma-document-activity.repository';
import { PrismaDocumentLockRepository } from './infrastructure/prisma-document-lock.repository';
import { PrismaDocumentRepository } from './infrastructure/prisma-document.repository';
import { DocumentFolderContentsParticipant } from './infrastructure/folder-contents.participant';
import { RetentionDispositionAdapter } from './infrastructure/retention-disposition.adapter';
import { StorageContentGateAdapter } from './infrastructure/storage-content-gate.adapter';
import { DocumentsController } from './presentation/documents.controller';
import { DocumentPreviewController } from './presentation/document-preview.controller';
import { RevisionControlController } from './presentation/revision-control.controller';
import { DocumentDashboardMetrics } from './infrastructure/dashboard-metrics.adapter';
import { DASHBOARD_DOCUMENT_METRICS } from '../dashboard/application/ports';

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
    // Phase 10: the scheduling half of Retention — the seam a delete, restore or publication
    // writes a schedule through, and the hold that refuses a delete. The *execution* half
    // (`DispositionModule`) imports this module instead; see `retention/retention.module.ts`
    // for why the capability is split at exactly that line.
    RetentionModule,
  ],
  controllers: [DocumentsController, RevisionControlController, DocumentPreviewController],
  providers: [
    // Phase 13: what the dashboard needs from Document, answered over this module's own list
    // predicate — see `dashboard-metrics.adapter.ts`.
    { provide: DASHBOARD_DOCUMENT_METRICS, useClass: DocumentDashboardMetrics },
    PrismaDocumentRepository,
    { provide: DOCUMENT_REPOSITORY, useExisting: PrismaDocumentRepository },
    { provide: DOCUMENT_ACTIVITY_REPOSITORY, useClass: PrismaDocumentActivityRepository },
    // Declared in Phase 0.5, bound in Phase 6. The insert it performs is decided by
    // `uq_document_lock_live` — the check-out race is the index's to referee.
    { provide: DOCUMENT_LOCK_REPOSITORY, useClass: PrismaDocumentLockRepository },
    { provide: DOCUMENT_CONFIGURATION, useClass: AdministrationConfigurationAdapter },
    { provide: DOCUMENT_PLACEMENT, useClass: LibraryPlacementAdapter },
    { provide: DOCUMENT_CONTENT_GATE, useClass: StorageContentGateAdapter },
    { provide: DOCUMENT_SERVICE, useClass: DefaultDocumentService },
    { provide: DOCUMENT_NUMBER_SERVICE, useClass: DefaultDocumentNumberService },
    RevisionControlService,
    // Phase 10: the purge, implemented by the module that owns the aggregate being destroyed and
    // consumed by Retention's sweep — the same inversion as `REVISION_WRITER`, pointing the other
    // way. The folder-contents participant is the document half of a folder's delete cascade,
    // registered into Library's registry at boot (see `folder-contents.participant.ts`).
    { provide: DOCUMENT_DISPOSITION, useClass: RetentionDispositionAdapter },
    DocumentFolderContentsParticipant,
    // Phase 7: the preview access decisions — permission → state → confidentiality — live
    // beside the download's, because they are the same decisions about the same record.
    DocumentPreviewService,
  ],
  // `DOCUMENT_NUMBER_SERVICE` is exported for exactly one consumer: Workflow's allocator
  // adapter, which is how the engine's `DOCUMENT_NUMBER_ALLOCATOR` seam gets its binding.
  exports: [
    DOCUMENT_SERVICE,
    DOCUMENT_NUMBER_SERVICE,
    DOCUMENT_DISPOSITION,
    DASHBOARD_DOCUMENT_METRICS,
  ],
})
export class DocumentModule implements OnModuleInit {
  constructor(
    private readonly registry: FolderContentsRegistry,
    private readonly participant: DocumentFolderContentsParticipant,
  ) {}

  /**
   * Fills Library's folder-contents slot. A registry rather than a binding because Document
   * already imports Library, so Library cannot import Document's module for a provider without a
   * cycle — the same reason the preview renderers register rather than bind.
   */
  onModuleInit(): void {
    this.registry.register(this.participant);
  }
}
