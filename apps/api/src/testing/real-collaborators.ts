import type { NotificationChannelKey } from '@edms/domain';

import type { ClockPort } from '../ports/clock.port';
import type { DeliveryReceipt, NotificationPort } from '../ports/notification.port';
import { DeliveryService } from '../modules/notification/application/delivery.service';
import { DigestService } from '../modules/notification/application/digest.service';
import { NotificationAdminService } from '../modules/notification/application/notification-admin.service';
import { NotificationEventService } from '../modules/notification/application/notification-event.service';
import { DefaultNotificationService } from '../modules/notification/application/notification.service';
import { RecipientVisibilityService } from '../modules/notification/application/recipient-visibility.service';
import {
  PrismaNotificationBatchRepository,
  PrismaNotificationMessageRepository,
  PrismaNotificationPreferenceRepository,
  PrismaNotificationSuppressionRepository,
  PrismaNotificationTemplateRepository,
} from '../modules/notification/infrastructure/prisma-notification.repositories';
import type { DocumentService } from '../modules/document/application/ports';
import { AdministeredWriter } from '../core/persistence/administered-writer';
import { RecordStamps } from '../core/persistence/record-stamps';
import { PrismaOutboxWriter } from '../core/outbox/prisma-outbox.writer';
import type { UnitOfWork } from '../core/prisma/unit-of-work';
import type { ReadAuditBuffer } from '../core/audit/read-audit.port';
import { AccessDenialRecorder } from '../core/authorization/access-denial.recorder';
import { AuditExportService } from '../modules/audit/application/audit-export.service';
import { AuditReadService } from '../modules/audit/application/audit-read.service';
import { AuditVerificationService } from '../modules/audit/application/audit-verification.service';
import { BufferedReadAuditWriter } from '../modules/audit/infrastructure/buffered-read-audit.writer';
import { PrismaAuditExportRepository } from '../modules/audit/infrastructure/prisma-audit-export.repository';
import { StorageCheckpointStore } from '../modules/audit/infrastructure/storage-checkpoint.store';
import { ChainedAuditWriter } from '../modules/audit/infrastructure/chained-audit.writer';
import { PrismaAuditRepository } from '../modules/audit/infrastructure/prisma-audit.repository';
import { DefaultOrganizationService } from '../modules/organization/application/organization.service';
import { PrismaScopeRepository } from '../modules/organization/infrastructure/prisma-scope.repository';
import type { AppConfig } from '../core/config/configuration';
import type { AntivirusPort } from '../ports/antivirus.port';
import type { TenantRegistry } from '../core/tenancy/tenant-registry.port';
import type { Logger } from '../core/observability/logger';
import { LocalStorageAdapter } from '../infrastructure/storage/local.adapter';
import { TenantScopedStorage } from '../infrastructure/tenancy/tenant-scoped-storage';
import { ConfigurationService } from '../modules/administration/application/configuration.service';
import { NumberingAdminService } from '../modules/administration/application/numbering-admin.service';
import { NumberingIssueService } from '../modules/administration/application/numbering-issue.service';
import { PrismaConfigurationRepository } from '../modules/administration/infrastructure/prisma-configuration.repository';
import { PrismaNumberIssueRepository } from '../modules/administration/infrastructure/prisma-number-issue.repository';
import { DefaultDocumentNumberService } from '../modules/document/application/document-number.service';
import { DefaultDocumentService } from '../modules/document/application/document.service';
import { AdministrationConfigurationAdapter } from '../modules/document/infrastructure/administration-configuration.adapter';
import { DocumentFolderContentsParticipant } from '../modules/document/infrastructure/folder-contents.participant';
import { LibraryPlacementAdapter } from '../modules/document/infrastructure/library-placement.adapter';
import { PrismaDocumentActivityRepository } from '../modules/document/infrastructure/prisma-document-activity.repository';
import { PrismaDocumentRepository } from '../modules/document/infrastructure/prisma-document.repository';
import { StorageContentGateAdapter } from '../modules/document/infrastructure/storage-content-gate.adapter';
import { DocumentPreviewService } from '../modules/document/application/document-preview.service';
import type { UserDirectory } from '../modules/identity/application/ports';
import { DefaultDelegationService } from '../modules/identity/application/delegation.service';
import { PrismaCredentialRepository } from '../modules/identity/infrastructure/prisma-credential.repository';
import { PrismaDelegationRepository } from '../modules/identity/infrastructure/prisma-delegation.repository';
import { PrismaUserDirectory } from '../modules/identity/infrastructure/prisma-user.directory';
import type { UserAdminService } from '../modules/identity/application/user-admin.service';
import { FolderContentsRegistry } from '../modules/library/application/folder-contents.port';
import { LibraryAdminService } from '../modules/library/application/library-admin.service';
import { PrismaLibraryAdminRepository } from '../modules/library/infrastructure/prisma-library-admin.repository';
import { PrismaRevisionWriter } from '../modules/revision/infrastructure/prisma-revision.writer';
import { DefaultStorageService } from '../modules/storage/application/storage.service';
import { PreviewOcrService } from '../modules/preview/application/ocr.service';
import { PreviewQueryService } from '../modules/preview/application/preview-query.service';
import { PreviewRenderService } from '../modules/preview/application/render.service';
import { NoOfficeConverter } from '../modules/preview/infrastructure/libreoffice.converter';
import { ImageRenderer } from '../modules/preview/infrastructure/image.renderer';
import { OfficeRenderer } from '../modules/preview/infrastructure/office.renderer';
import { PdfRenderer } from '../modules/preview/infrastructure/pdf.renderer';
import {
  DefaultRendererRegistry,
  RegistryPreviewAdapter,
} from '../modules/preview/infrastructure/renderer.registry';
import { TextRenderer } from '../modules/preview/infrastructure/text.renderer';
import {
  PrismaOcrResultRepository,
  PrismaPreviewArtifactRepository,
  PrismaPreviewRenderRepository,
} from '../modules/preview/infrastructure/prisma-preview.repository';
import type { OfficeConverter } from '../modules/preview/application/office-converter.port';
import type { OcrPort } from '../ports/ocr.port';
import type { StoragePort } from '../ports/storage.port';
import { ApprovalRoutingService } from '../modules/administration/application/approval-routing.service';
import { PrismaApprovalRoutingRepository } from '../modules/administration/infrastructure/prisma-approval-routing.repository';
import { ApprovalService } from '../modules/workflow/application/approval.service';
import { WorkflowAdminService } from '../modules/workflow/application/workflow-admin.service';
import { PrismaWorkflowAdminRepository } from '../modules/workflow/infrastructure/prisma-workflow-admin.repository';
import { ParticipantResolver } from '../modules/workflow/application/participant-resolver';
import type {
  WorkflowDelegationGate,
  WorkflowDirectory,
} from '../modules/workflow/application/ports';
import { WorkflowDelegationAdapter } from '../modules/workflow/infrastructure/workflow-delegation.adapter';
import { WorkflowEngine } from '../modules/workflow/application/workflow-engine.service';
import { WorkflowTimers } from '../modules/workflow/application/workflow-timers.service';
import { DocumentContextAdapter } from '../modules/workflow/infrastructure/document-context.adapter';
import { DocumentNumberAllocatorAdapter } from '../modules/workflow/infrastructure/document-number-allocator.adapter';
import { PrismaApprovalQueryRepository } from '../modules/workflow/infrastructure/prisma-approval-query.repository';
import { PrismaWorkflowEngineRepository } from '../modules/workflow/infrastructure/prisma-workflow-engine.repository';
import { PrismaWorkflowVersionReader } from '../modules/workflow/infrastructure/prisma-workflow-version.reader';
import { WorkflowCalendarAdapter } from '../modules/workflow/infrastructure/workflow-calendar.adapter';
import type { QueuePort } from '../ports/queue.port';
import { DefaultLegalHoldService } from '../modules/retention/application/legal-hold.service';
import type { DocumentDisposition } from '../modules/retention/application/ports';
import { DefaultRecycleBinService } from '../modules/retention/application/recycle-bin.service';
import { RetentionSchedulerService } from '../modules/retention/application/retention-scheduler.service';
import { DefaultRetentionService } from '../modules/retention/application/retention.service';
import { PrismaRecycleBinRepository } from '../modules/retention/infrastructure/prisma-recycle-bin.repository';
import {
  PrismaLegalHoldRepository,
  PrismaRetentionPolicyReader,
  PrismaRetentionScheduleRepository,
  PrismaTombstoneRepository,
} from '../modules/retention/infrastructure/prisma-retention.repositories';
import { RetentionDispositionAdapter } from '../modules/document/infrastructure/retention-disposition.adapter';
import { StorageBlobReaper } from '../modules/storage/infrastructure/blob-reaper.adapter';
import { PrismaFileObjectRepository } from '../modules/storage/infrastructure/prisma-file-object.repository';
import { PrismaUploadSessionRepository } from '../modules/storage/infrastructure/prisma-upload-session.repository';
import { RevisionControlService } from '../modules/document/application/revision-control.service';
import { PrismaDocumentLockRepository } from '../modules/document/infrastructure/prisma-document-lock.repository';
import { RevisionQueryService } from '../modules/revision/application/revision-query.service';
import { PrismaRevisionQueryRepository } from '../modules/revision/infrastructure/prisma-revision-query.repository';
import { PostgresIndexAdapter } from '../infrastructure/search/postgres-index.adapter';
import { PostgresSearchAdapter } from '../infrastructure/search/postgres-search.adapter';
import { TenantScopedSearch } from '../infrastructure/tenancy/tenant-scoped-search';
import { PrismaAclResolver } from '../modules/library/infrastructure/prisma-acl.resolver';
import { DefaultPermissionService } from '../modules/library/application/permission.service';
import { PrismaAclRepository } from '../modules/library/infrastructure/prisma-acl.repository';
import { PrismaScopeChainReader } from '../modules/library/infrastructure/prisma-scope-chain.reader';
import { DefaultSearchService } from '../modules/search/application/search.service';
import { SavedSearchService } from '../modules/search/application/saved-search.service';
import { SearchProjectionService } from '../modules/search/application/search-projection.service';
import { SearchRebuildService } from '../modules/search/application/search-rebuild.service';
import { PrismaSearchSourceReader } from '../modules/search/infrastructure/prisma-search-source.reader';
import {
  PrismaRecentSearchRepository,
  PrismaSavedSearchRepository,
  PrismaSearchRebuildRepository,
} from '../modules/search/infrastructure/prisma-search.repositories';

import { AuditActivityReader } from '../modules/audit/infrastructure/audit-activity.reader';
import { DefaultDashboardService } from '../modules/dashboard/application/dashboard.service';
import type {
  DashboardDelegationMetrics,
  DashboardDocumentMetrics,
  DashboardNotificationMetrics,
} from '../modules/dashboard/application/ports';
import { DocumentDashboardMetrics } from '../modules/document/infrastructure/dashboard-metrics.adapter';
import { IdentityDashboardMetrics } from '../modules/identity/infrastructure/dashboard-metrics.adapter';
import { OrganizationDashboardMetrics } from '../modules/organization/infrastructure/dashboard-metrics.adapter';
import { RetentionDashboardMetrics } from '../modules/retention/infrastructure/dashboard-metrics.adapter';
import { StorageDashboardMetrics } from '../modules/storage/infrastructure/dashboard-metrics.adapter';
import { WorkflowDashboardMetrics } from '../modules/workflow/infrastructure/dashboard-metrics.adapter';
import type { CachePort } from '../ports/cache.port';
import { FakeCache } from './fake-ports';
/**
 * Real collaborators, wired the way the container wires them.
 *
 * This exists for one reason, and it is a boundary reason rather than a convenience one. An
 * integration test for the organisation module needs the **real** audit writer, because half of what
 * it is asserting is that the audit event and the change commit together — and a double cannot be
 * wrong about that, since it is written from the same belief as the code it stands in for. But a test
 * living under `src/modules/organization/` may not import `src/modules/audit/infrastructure/`: that
 * is the cross-module boundary `eslint.config.mjs` enforces, and it enforces it for tests too,
 * correctly, because a test that reaches into another module's internals is a test that will keep
 * passing after that module's contract changes.
 *
 * So the composition lives here, outside `src/modules/`, which is the layer whose *job* is to know
 * how the pieces fit together. `tsconfig.build.json` excludes this directory, so nothing here can be
 * reached from production code by accident.
 *
 * The alternative — building each test through `Test.createTestingModule(AppModule)` — is what
 * `auth.e2e.integration.spec.ts` does and is right for an end-to-end test of the HTTP surface. For a
 * test about one service's transactional behaviour it would mean booting Redis, the token verifier
 * and every provider in the application to assert something about two tables.
 */

/**
 * The audit writer the application binds: append-only, hash-chained, joins the caller's
 * transaction.
 */
export function realAuditWriter(clock: ClockPort, unitOfWork: UnitOfWork): ChainedAuditWriter {
  return new ChainedAuditWriter(new PrismaAuditRepository(), clock, unitOfWork);
}

/**
 * Everything an administered service needs to write: the transaction boundary, the audit trail, the
 * record stamps, and the outbox.
 *
 * Returned as a bundle because a test that assembled them individually would be free to assemble
 * them differently from the container — and then it would be testing a composition nothing ships.
 */
export function realWriteStack(
  clock: ClockPort,
  unitOfWork: UnitOfWork,
): {
  readonly stamps: RecordStamps;
  readonly audit: ChainedAuditWriter;
  readonly readAudit: BufferedReadAuditWriter;
  readonly outbox: PrismaOutboxWriter;
  readonly writer: AdministeredWriter;
} {
  const stamps = new RecordStamps(clock);
  const audit = realAuditWriter(clock, unitOfWork);
  return {
    stamps,
    audit,
    readAudit: realReadAuditBuffer(clock, unitOfWork, audit),
    outbox: new PrismaOutboxWriter(stamps),
    writer: new AdministeredWriter(unitOfWork, audit, stamps),
  };
}

/**
 * The real read-audit buffer, flushed by the test rather than by its timer.
 *
 * A double would defeat the point: what these suites assert about `VIEWED` is that a buffered
 * event is *still hash-chained and still contiguous* when it lands, and only the real flush
 * against a real database can answer that. The interval is set beyond any test's lifetime so
 * nothing flushes behind the assertions' back; a suite calls `flush()` when it wants the rows.
 */
export function realReadAuditBuffer(
  clock: ClockPort,
  unitOfWork: UnitOfWork,
  audit: ChainedAuditWriter,
): BufferedReadAuditWriter {
  return new BufferedReadAuditWriter(
    new PrismaAuditRepository(),
    audit,
    unitOfWork,
    clock,
    {
      audit: {
        readBufferSize: 1_000,
        readBufferMax: 10_000,
        readFlushIntervalMs: 3_600_000,
      },
    } as AppConfig,
    silentLogger(),
  );
}

/** Logs nowhere. A suite's output is its assertions, not a service's info lines. */
function silentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
}

/**
 * The organisation module's read side, over the real scope tree.
 *
 * Anything that owns a scope — a library, a numbering rule, a permission grant — asks this service
 * whether the node it was handed exists and what kind of node it is. A double would answer from the
 * same belief as the code under test, so it could not catch the case that matters: a caller naming a
 * node of the wrong kind, or one belonging to another tenant.
 */
export function realOrganizationService(): DefaultOrganizationService {
  return new DefaultOrganizationService(new PrismaScopeRepository());
}

// --- Phase 3: the document library ---------------------------------------------------------
//
// The same boundary reason as everything above, and it bites harder here. A document-library test
// needs the *real* storage service, the real configuration service, the real folder tree and the
// real revision writer, because most of what it asserts is that those four commit together — and a
// double for any of them would be written from the same belief as the code it stands in for. But a
// suite living under `src/modules/document/` may not import `src/modules/storage/infrastructure/`,
// `src/modules/library/infrastructure/` or `src/infrastructure/`: that is the cross-module boundary
// `eslint.config.mjs` enforces, and it enforces it for tests too, correctly.
//
// So the composition lives here, in the layer whose job is knowing how the pieces fit together.

export interface DocumentLibraryStack {
  readonly storage: DefaultStorageService;
  readonly documents: DefaultDocumentService;
  /** Check-out, check-in and publication — what Phase 10's cascade assertions need revisions from. */
  readonly control: RevisionControlService;
  readonly libraries: LibraryAdminService;
  readonly configuration: ConfigurationService;
  readonly numbering: NumberingAdminService;
  /** The filesystem adapter underneath the scoping, for asserting against the disk itself. */
  readonly localStorage: LocalStorageAdapter;
  /** The scoped port the service writes through — what the preview stack fetches bytes with. */
  readonly storagePort: TenantScopedStorage;
}

export interface DocumentLibraryOptions {
  readonly clock: ClockPort;
  readonly unitOfWork: UnitOfWork;
  readonly config: AppConfig;
  readonly registry: TenantRegistry;
  /** Where the filesystem driver writes. A temporary directory, per suite. */
  readonly storageRoot: string;
  readonly signingSecret: string;
  readonly antivirus: AntivirusPort;
  /** Answers `userExists`. Identity's own admin service needs a database this suite has not seeded. */
  readonly users: Pick<UserAdminService, 'get'>;
  /** Overrides for Phase 10's retention settings — the recycle-bin window, the blob grace. */
  readonly retentionSettings?: Readonly<Record<string, unknown>>;
}

/**
 * Everything the document library is, wired the way the container wires it.
 *
 * The storage adapter is the real filesystem one *under the real tenant scoping*, so an upload in a
 * suite using this genuinely writes bytes to a genuinely prefixed path — which is what makes the
 * isolation assertions about the filesystem rather than about a wrapper.
 */
export function realDocumentLibrary(options: DocumentLibraryOptions): DocumentLibraryStack {
  const { stamps, outbox, readAudit, writer } = realWriteStack(options.clock, options.unitOfWork);

  const localStorage = new LocalStorageAdapter({
    root: options.storageRoot,
    transferUrl: 'http://localhost:3001/api/v1/storage/local',
    signingSecret: options.signingSecret,
    now: () => options.clock.now(),
  });
  const scopedStorage = new TenantScopedStorage(localStorage, options.registry);
  const storage = new DefaultStorageService(
    new PrismaFileObjectRepository(stamps),
    new PrismaUploadSessionRepository(stamps),
    scopedStorage,
    options.antivirus,
    options.clock,
    outbox,
    options.config,
    writer,
  );

  const configurationRepository = new PrismaConfigurationRepository(stamps);
  const configuration = new ConfigurationService(configurationRepository, outbox, writer);
  // The registry Library holds and Document fills at boot. Filled below, once the participant
  // has the collaborators it needs — so a folder delete in a suite genuinely cascades to the
  // documents inside it, which is the property Phase 10 added.
  const folderContents = new FolderContentsRegistry();
  const libraries = new LibraryAdminService(
    new PrismaLibraryAdminRepository(stamps),
    realOrganizationService(),
    outbox,
    folderContents,
    writer,
  );

  const documentRepository = realDocumentRepository(options);
  const documents = new DefaultDocumentService(
    documentRepository,
    new PrismaDocumentActivityRepository(documentRepository),
    new AdministrationConfigurationAdapter(
      configuration,
      realOrganizationService(),
      options.users as UserAdminService,
    ),
    new LibraryPlacementAdapter(libraries),
    realOrganizationService(),
    new StorageContentGateAdapter(storage),
    new PrismaRevisionWriter(stamps, outbox),
    // The thumbnailer's whole contract is that it never fails a document, and Phase 3 draws one only
    // for PNG. A suite uploading PDFs would get nothing from the real implementation, so a double
    // that does nothing is honest about that rather than pretending to render.
    { generate: () => Promise.resolve() },
    // Phase 10's two seams, both real: the hold that refuses a delete and the scheduler that
    // writes the clock a delete starts. Doubles would defeat the point — what the suites assert is
    // that the refusal and the schedule commit with the delete.
    new DefaultLegalHoldService(
      new PrismaLegalHoldRepository(stamps),
      new PrismaRetentionScheduleRepository(stamps),
      outbox,
      writer,
    ),
    realRetentionScheduler({
      clock: options.clock,
      unitOfWork: options.unitOfWork,
      ...(options.retentionSettings !== undefined && { settings: options.retentionSettings }),
    }),
    outbox,
    readAudit,
    writer,
  );

  // The container does this in `DocumentModule.onModuleInit`; a suite that skipped it would have
  // a folder delete that silently left its documents live — the Phase 2 behaviour Phase 10 fixed.
  folderContents.register(
    new DocumentFolderContentsParticipant(
      documentRepository,
      new PrismaRevisionWriter(stamps, outbox),
      new StorageContentGateAdapter(storage),
      new DefaultLegalHoldService(
        new PrismaLegalHoldRepository(stamps),
        new PrismaRetentionScheduleRepository(stamps),
        outbox,
        writer,
      ),
      realRetentionScheduler({
        clock: options.clock,
        unitOfWork: options.unitOfWork,
        ...(options.retentionSettings !== undefined && { settings: options.retentionSettings }),
      }),
      stamps,
    ),
  );

  return {
    storage,
    documents,
    control: new RevisionControlService(
      documentRepository,
      new PrismaDocumentLockRepository(stamps),
      new PrismaRevisionWriter(stamps, outbox),
      new StorageContentGateAdapter(storage),
      new AdministrationConfigurationAdapter(
        configuration,
        realOrganizationService(),
        options.users as UserAdminService,
      ),
      documents,
      settingsReaderFor({}),
      realRetentionScheduler({
        clock: options.clock,
        unitOfWork: options.unitOfWork,
        ...(options.retentionSettings !== undefined && { settings: options.retentionSettings }),
      }),
      outbox,
      writer,
    ),
    libraries,
    configuration,
    numbering: new NumberingAdminService(configurationRepository, outbox, writer),
    localStorage,
    storagePort: scopedStorage,
  };
}

// --- Phase 4: the workflow engine ------------------------------------------------------------
//
// The same boundary reason again, and the sharpest instance of it yet. Almost everything the engine
// suite asserts is a property of the *database*: a task decided once under concurrency, a quorum
// counted correctly while two people decide at the same instant, a rolled-back decision leaving no
// trace, a paused timer resuming with the duration it had left. A repository double cannot be asked
// any of those, because it is written from the same belief as the code it stands in for.
//
// So the engine is composed here with its real repositories, the real audit writer, the real outbox
// and the real transaction boundary — and only the two genuinely external things are stood in for:
// the queue, because Redis is not what these assertions are about, and the directory, because who
// works here is Identity's suite to prove.

export interface WorkflowEngineStack {
  readonly engine: WorkflowEngine;
  readonly approvals: ApprovalService;
  readonly routing: ApprovalRoutingService;
  /**
   * Phase 5's numbering, composed the way the container composes it — the issuance service over
   * the real sequences and reservations, and Document's number service over that. Null when the
   * stack was built `withoutNumbering`, which is Phase 4's deliberately unbound state.
   */
  readonly numbers: DefaultDocumentNumberService | null;
  /** The issuance engine underneath it, for held blocks and the reservation listing. */
  readonly issuance: NumberingIssueService | null;
  /**
   * Phase 2's definition administration, composed here too.
   *
   * The engine suite needs a *published* version to bind to, and seeding one directly would
   * sidestep the trigger that refuses a draft binding — which is one of the properties the suite
   * asserts. So a definition is authored and published through the real service, exactly as an
   * administrator would.
   */
  readonly definitions: WorkflowAdminService;
  /** Every job the engine handed to the queue, in order. The scheduling assertions read this. */
  readonly enqueued: EnqueuedTimerJob[];
  /** Job identifiers the engine asked to cancel — what "cancelling a stage cancels its timers" is. */
  readonly cancelled: string[];
}

export interface EnqueuedTimerJob {
  readonly queue: string;
  readonly jobId: string;
  readonly delayMs: number;
}

export interface WorkflowEngineOptions {
  readonly clock: ClockPort;
  readonly unitOfWork: UnitOfWork;
  /**
   * Phase 14: every document repository now carries the resolver, which reads its bounds here.
   * Optional, because a suite about approval routing has no opinion about the ACL cache — see
   * `UNCACHED_ACL_CONFIG`, which is what it gets.
   */
  readonly config?: AppConfig;
  readonly documents: DefaultDocumentService;
  readonly configuration: ConfigurationService;
  /**
   * Who works here.
   *
   * A double rather than the real `PrismaUserDirectory`, and deliberately: a suite about the engine
   * seeds two or three people directly and asserts about routing, not about whether Identity reads
   * `user_role` correctly — which is `identity-admin.integration.spec.ts`'s job. The one thing it
   * must be honest about is `activeAmong`, because "a resolver that yields nobody fails loudly" is a
   * property this suite does assert.
   */
  readonly directory: WorkflowDirectory;
  /**
   * Composes the engine with `DOCUMENT_NUMBER_ALLOCATOR` unbound — Phase 4's state, kept
   * composable because "an approval completes honestly unnumbered when nothing is bound" is
   * still a property of the engine worth asserting.
   */
  readonly withoutNumbering?: boolean;
  /**
   * Phase 11's gate, from `realDelegation`. Absent composes the engine the way Phase 4 shipped it,
   * where only the assignee decides — which is still a property worth asserting, and is what the
   * engine's own suite continues to exercise.
   */
  readonly delegations?: WorkflowDelegationGate | undefined;
}

// --- Phase 6: revision control ---------------------------------------------------------------
//
// The same boundary reason a third time. What this suite asserts is what only the database can
// answer: two check-outs racing against `uq_document_lock_live`, two publishes racing against
// `uq_revision_published`, a restore that costs a reference rather than a copy, and the frozen-
// content refusal while CHECKED_OUT — so the service is composed here with its real lock
// repository, its real revision writer, the real content gate and the real transaction boundary.

export interface RevisionControlStack {
  readonly control: RevisionControlService;
  readonly revisionQueries: RevisionQueryService;
}

export interface RevisionControlOptions {
  readonly clock: ClockPort;
  readonly unitOfWork: UnitOfWork;
  readonly documents: DefaultDocumentService;
  readonly configuration: ConfigurationService;
  readonly storage: DefaultStorageService;
  /** The scoped port, for the compare API's text section reading artefact blobs back. */
  readonly storagePort: StoragePort;
  readonly config: AppConfig;
  /** Answers `userExists`, the way the library stack takes it. */
  readonly users: Pick<UserAdminService, 'get'>;
}

export function realRevisionControl(options: RevisionControlOptions): RevisionControlStack {
  const { stamps, outbox, writer } = realWriteStack(options.clock, options.unitOfWork);

  // The catalogue defaults, the same way the engine stack answers settings for a tenant with no
  // override — the lock expiry these suites exercise is the product's own default.
  const settings = {
    get: (definition: { defaultValue: unknown }) => Promise.resolve(definition.defaultValue),
  } as never;

  const control = new RevisionControlService(
    realDocumentRepository(options),
    new PrismaDocumentLockRepository(stamps),
    new PrismaRevisionWriter(stamps, outbox),
    new StorageContentGateAdapter(options.storage),
    new AdministrationConfigurationAdapter(
      options.configuration,
      realOrganizationService(),
      options.users as UserAdminService,
    ),
    options.documents,
    settings,
    realRetentionScheduler({ clock: options.clock, unitOfWork: options.unitOfWork }),
    outbox,
    writer,
  );

  return {
    control,
    revisionQueries: new RevisionQueryService(
      new PrismaRevisionQueryRepository(),
      writer,
      realPreviewQuery(options),
    ),
  };
}

// --- Phase 7: the preview pipeline -----------------------------------------------------------
//
// The same boundary reason once more. What the preview suite asserts is what only the database
// and the filesystem can answer: a render refused before the scan verdict is CLEAN, artefact
// rows that do not duplicate under redelivery, derived blobs under the derived/ prefix and
// excluded from the source's accounting — so the stack is composed here from the real
// repositories, the real renderers and the real storage service, with only the queue recorded.

/**
 * The real ACL resolver, with the real walk behind it.
 *
 * Phase 14 gave `PrismaAclResolver` four collaborators where it had one, and five call sites in this
 * file constructed it by hand. One factory instead, so a suite cannot accidentally assemble a
 * resolver over a *different* chain reader or a warm cache and then assert a permission answer from
 * it — which would be a suite testing something other than the product.
 *
 * The cache defaults to a `FakeCache` over the suite's own clock, so a test that wants to assert
 * cold-cache equivalence sets `ACL_CACHE_TTL_SECONDS=0` in its config, and one that wants to assert
 * invalidation can inspect this instance.
 */
/**
 * The write half of the ACL model, over the same collaborators the container binds.
 *
 * Assembled here rather than in the suite for the reason every other stack is: the boundary lint
 * forbids a test in one module reaching into another module's `infrastructure/`, and an ACL suite
 * composing itself would have to reach into two.
 *
 * The resolver is shared with whatever else the suite builds, and that is deliberate — the service
 * refuses an edit on a node the caller cannot itself reach, and it asks the *same* resolver the
 * guard would. Two instances would let a suite pass with a privilege-escalation check that never
 * saw the entries the test had just written.
 */
export function realPermissions(options: {
  readonly clock: ClockPort;
  readonly unitOfWork: UnitOfWork;
  readonly config?: AppConfig;
  readonly cache?: CachePort;
  readonly resolver?: PrismaAclResolver;
}): {
  readonly permissions: DefaultPermissionService;
  readonly resolver: PrismaAclResolver;
  readonly chains: PrismaScopeChainReader;
  readonly cache: CachePort;
  readonly enqueuedJobs: {
    readonly queue: string;
    readonly jobId: string;
    readonly payload: unknown;
  }[];
} {
  const cache = options.cache ?? new FakeCache(options.clock);
  const resolver = options.resolver ?? realAclResolver({ ...options, cache });
  const stamps = new RecordStamps(options.clock);
  const { outbox, writer } = realWriteStack(options.clock, options.unitOfWork);
  const chains = new PrismaScopeChainReader(new PrismaScopeRepository());
  const enqueuedJobs: { queue: string; jobId: string; payload: unknown }[] = [];

  return {
    permissions: new DefaultPermissionService(
      new PrismaAclRepository(stamps),
      chains,
      resolver,
      cache,
      outbox,
      writer,
    ),
    resolver,
    chains,
    cache,
    enqueuedJobs,
  };
}

export function realDocumentRepository(options: {
  readonly clock: ClockPort;
  readonly unitOfWork: UnitOfWork;
  readonly config?: AppConfig;
  readonly cache?: CachePort;
}): PrismaDocumentRepository {
  return new PrismaDocumentRepository(new RecordStamps(options.clock), realAclResolver(options));
}

export function realAclResolver(options: {
  readonly clock: ClockPort;
  readonly unitOfWork: UnitOfWork;
  readonly config?: AppConfig;
  readonly cache?: CachePort;
}): PrismaAclResolver {
  const stamps = new RecordStamps(options.clock);
  return new PrismaAclResolver(
    options.unitOfWork,
    new PrismaAclRepository(stamps),
    new PrismaScopeChainReader(new PrismaScopeRepository()),
    options.cache ?? new FakeCache(options.clock),
    withAclDefaults(options.config),
  );
}

/**
 * The suite's config, with an `acl` section if it did not state one.
 *
 * Merged rather than substituted, because most suites hand these factories a hand-built partial
 * `AppConfig` carrying only the two or three sections they care about — and a resolver that
 * silently used a *whole* different config than the rest of the stack would be the subtlest
 * possible way for a suite to stop testing the product.
 */
function withAclDefaults(config: AppConfig | undefined): AppConfig {
  const base = config ?? ({} as AppConfig);
  return { ...base, acl: base.acl ?? UNCACHED_ACL };
}

/**
 * The resolver's configuration for a suite that has not stated one: **the cache off**.
 *
 * Deliberately not the production default. A suite that seeds an ACL entry and then asserts what a
 * caller sees must be asking the database, not a decision this process cached thirty seconds ago
 * under a different set of rows — and the difference between those two is invisible in a green
 * build. The suites that assert the cache is *correct* pass a config with a TTL and a `FakeCache`
 * they can inspect, which is the only way to test a cache without also testing through it.
 */
const UNCACHED_ACL: AppConfig['acl'] = { cacheTtlSeconds: 0, maxSubjectEntries: 5_000 };

export interface PreviewStackOptions {
  readonly clock: ClockPort;
  readonly unitOfWork: UnitOfWork;
  readonly storage: DefaultStorageService;
  readonly storagePort: StoragePort;
  readonly config: AppConfig;
  /** `NONE` by default — the honest CI shape; a suite that has LibreOffice passes the real one. */
  readonly officeConverter?: OfficeConverter;
  readonly ocr?: OcrPort;
}

export interface PreviewStack {
  readonly render: PreviewRenderService;
  readonly ocr: PreviewOcrService;
  readonly queries: PreviewQueryService;
  /** What the render decided to hand the slow lane. */
  readonly enqueuedOcrJobs: {
    readonly queue: string;
    readonly jobId: string;
    readonly payload: unknown;
  }[];
}

export function realPreviewStack(options: PreviewStackOptions): PreviewStack {
  const { stamps, outbox } = realWriteStack(options.clock, options.unitOfWork);
  const registry = new DefaultRendererRegistry();
  registry.register(new PdfRenderer());
  registry.register(new OfficeRenderer(options.officeConverter ?? new NoOfficeConverter()));
  registry.register(new ImageRenderer());
  registry.register(new TextRenderer());

  const enqueuedOcrJobs: PreviewStack['enqueuedOcrJobs'] = [];
  const queue = {
    enqueue: (queueName: string, payload: object, jobOptions: { jobId: string }) => {
      enqueuedOcrJobs.push({ queue: queueName, jobId: jobOptions.jobId, payload });
      return Promise.resolve({
        queue: queueName,
        jobId: jobOptions.jobId,
        availableAt: options.clock.now(),
      });
    },
    cancel: () => Promise.resolve(false),
    depth: () => Promise.resolve({ queue: '', waiting: 0, active: 0, delayed: 0, failed: 0 }),
  } as never;
  const silentLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as never;

  const artifacts = new PrismaPreviewArtifactRepository(stamps);
  const renders = new PrismaPreviewRenderRepository(stamps);
  const ocrResults = new PrismaOcrResultRepository(stamps);

  const ocrPort: OcrPort = options.ocr ?? {
    engine: 'none',
    supports: () => false,
    extract: () => Promise.reject(new Error('No OCR engine in this suite.')),
  };

  return {
    render: new PreviewRenderService(
      options.unitOfWork,
      options.storage,
      new RegistryPreviewAdapter(registry),
      artifacts,
      renders,
      ocrResults,
      outbox,
      queue,
      options.config,
      silentLogger,
    ),
    ocr: new PreviewOcrService(
      options.unitOfWork,
      options.storage,
      ocrPort,
      artifacts,
      ocrResults,
      outbox,
      options.config,
      silentLogger,
    ),
    queries: realPreviewQuery(options),
    enqueuedOcrJobs,
  };
}

/**
 * The preview access decisions, composed with the same real pieces the container binds — so
 * "permission → state → confidentiality" and the audit rows it writes are asserted against the
 * real repositories and the real hash chain, with only the user directory a seeded double.
 */
export function realDocumentPreview(options: {
  clock: ClockPort;
  unitOfWork: UnitOfWork;
  /**
   * The read-audit buffer to record `VIEWED` into.
   *
   * Passed in rather than created here so a suite can *flush* it: since Phase 9 a view is buffered
   * (13 §5), so a test asserting that a view was recorded has to say when the batch lands. One
   * built here would be one the test could not reach, and the assertion would be about nothing.
   *
   * Typed as the core port rather than the class, so a suite under `modules/preview/` can hold one
   * without importing the audit module's internals — which the boundary lint forbids, for tests as
   * much as for code.
   */
  readAudit?: ReadAuditBuffer;
  storage: DefaultStorageService;
  storagePort: StoragePort;
  config: AppConfig;
  configuration: ConfigurationService;
  users: Pick<UserAdminService, 'get'>;
  directory: UserDirectory;
}): DocumentPreviewService {
  const stack = realWriteStack(options.clock, options.unitOfWork);
  const { stamps, writer } = stack;
  const readAudit = options.readAudit ?? stack.readAudit;
  const settings = {
    get: (definition: { defaultValue: unknown }) => Promise.resolve(definition.defaultValue),
  } as never;
  return new DocumentPreviewService(
    writer,
    realDocumentRepository(options),
    new AdministrationConfigurationAdapter(
      options.configuration,
      realOrganizationService(),
      options.users as UserAdminService,
    ),
    new PrismaRevisionWriter(stamps, new PrismaOutboxWriter(stamps)),
    options.directory,
    settings,
    readAudit,
    realPreviewQuery(options),
  );
}

function realPreviewQuery(options: {
  clock: ClockPort;
  unitOfWork: UnitOfWork;
  storage: DefaultStorageService;
  storagePort: StoragePort;
  config: AppConfig;
}): PreviewQueryService {
  const stamps = new RecordStamps(options.clock);
  return new PreviewQueryService(
    options.unitOfWork,
    new PrismaPreviewArtifactRepository(stamps),
    new PrismaPreviewRenderRepository(stamps),
    new PrismaOcrResultRepository(stamps),
    options.storage,
    options.storagePort,
    options.config,
    options.clock,
  );
}

export function realWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngineStack {
  const { stamps, outbox, writer } = realWriteStack(options.clock, options.unitOfWork);
  const repository = new PrismaWorkflowEngineRepository(stamps);
  const enqueued: EnqueuedTimerJob[] = [];
  const cancelled: string[] = [];

  // The queue, recorded rather than run. Redis is not what these assertions are about, and what
  // *is* — that a job is handed over only after the transaction commits, and that cancelling a
  // stage cancels exactly its timers — is visible in what was asked of it.
  const queue: QueuePort = {
    enqueue: (queueName, _payload, jobOptions) => {
      enqueued.push({
        queue: queueName,
        jobId: jobOptions.jobId,
        delayMs: jobOptions.delayMs ?? 0,
      });
      return Promise.resolve({
        queue: queueName,
        jobId: jobOptions.jobId,
        availableAt: options.clock.now(),
      });
    },
    cancel: (_queueName, jobId) => {
      cancelled.push(jobId);
      return Promise.resolve(true);
    },
    depth: (queueName) =>
      Promise.resolve({ queue: queueName, waiting: 0, active: 0, delayed: 0, failed: 0 }),
    // The engine declares no schedules; these exist so the double still satisfies the port.
    schedule: () => Promise.resolve(),
    unschedule: () => Promise.resolve(),
  };

  const routingRepository = new PrismaApprovalRoutingRepository(stamps);
  const routing = new ApprovalRoutingService(routingRepository, writer);

  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as Logger;

  const timers = new WorkflowTimers(repository, queue, logger, stamps);

  // The tenant's timezone, answered the way the settings reader answers it for a tenant with no
  // override: the catalogue default. UTC, so the deadline and numbering assertions read as the
  // dates somebody would check on a wall calendar.
  const settings = {
    get: (definition: { defaultValue: unknown }) => Promise.resolve(definition.defaultValue),
  } as never;

  // Phase 5's numbering, wired as the container wires it: Administration's issuance service over
  // the real counters and reservations, Document's number service resolving the document's own
  // codes, and the workflow adapter over that — bound to the engine's seam.
  const issuance = options.withoutNumbering
    ? null
    : new NumberingIssueService(new PrismaNumberIssueRepository(), settings, writer);
  const numbers =
    issuance === null
      ? null
      : new DefaultDocumentNumberService(
          realDocumentRepository(options),
          new AdministrationConfigurationAdapter(
            options.configuration,
            realOrganizationService(),
            // `userExists` is the one question this adapter would ask Identity, and numbering never
            // asks it.
            { get: () => Promise.resolve(null) } as never,
          ),
          new LibraryPlacementAdapter(
            new LibraryAdminService(
              new PrismaLibraryAdminRepository(stamps),
              realOrganizationService(),
              outbox,
              new FolderContentsRegistry(),
              writer,
            ),
          ),
          realOrganizationService(),
          issuance,
          outbox,
          writer,
        );

  const engine = new WorkflowEngine(
    repository,
    new DocumentContextAdapter(options.documents),
    new PrismaWorkflowVersionReader(),
    new WorkflowCalendarAdapter(routing, settings),
    outbox,
    logger,
    new ParticipantResolver(options.directory),
    timers,
    writer,
    numbers === null ? null : new DocumentNumberAllocatorAdapter(numbers),
    options.delegations ?? null,
  );

  return {
    engine,
    approvals: new ApprovalService(new PrismaApprovalQueryRepository(stamps), writer),
    routing,
    definitions: new WorkflowAdminService(new PrismaWorkflowAdminRepository(stamps), writer),
    numbers,
    issuance,
    enqueued,
    cancelled,
  };
}

// --- Phase 8: search --------------------------------------------------------------------------
//
// The same boundary reason, at its sharpest: nearly everything the search suite asserts is a
// property of the database — a permission predicate refusing rows inside the query, facet
// counts that cannot leak, tsvector matches across Arabic spellings, a rebuild swapping under
// a live reader. So the stack is the real resolver, the real projection, the real PostgreSQL
// adapters under the real tenant scoping, with only the queue recorded.

export interface SearchStackOptions {
  readonly clock: ClockPort;
  readonly unitOfWork: UnitOfWork;
  readonly config: AppConfig;
  readonly registry: TenantRegistry;
  readonly storage: DefaultStorageService;
  readonly storagePort: StoragePort;
}

export interface SearchStack {
  readonly search: DefaultSearchService;
  /** The scoped engine itself, for asserting the tenant-overwrite behaviour directly. */
  readonly engine: TenantScopedSearch;
  readonly projection: SearchProjectionService;
  readonly rebuilds: SearchRebuildService;
  readonly savedSearches: SavedSearchService;
  readonly acl: PrismaAclResolver;
  readonly index: PostgresIndexAdapter;
  readonly source: PrismaSearchSourceReader;
  readonly rebuildRepository: PrismaSearchRebuildRepository;
  /** What a rebuild request handed the lane. */
  readonly enqueuedJobs: {
    readonly queue: string;
    readonly jobId: string;
    readonly payload: unknown;
  }[];
}

export function realSearchStack(options: SearchStackOptions): SearchStack {
  const { stamps, audit, outbox, writer } = realWriteStack(options.clock, options.unitOfWork);

  const source = new PrismaSearchSourceReader(options.unitOfWork);
  const acl = realAclResolver(options);
  const index = new PostgresIndexAdapter(options.clock);
  const engine = new TenantScopedSearch(new PostgresSearchAdapter(), options.registry);
  const rebuildRepository = new PrismaSearchRebuildRepository(stamps);
  const previews = realPreviewQuery(options);

  const projection = new SearchProjectionService(
    source,
    acl,
    index,
    rebuildRepository,
    outbox,
    options.unitOfWork,
    options.config,
    previews,
    stamps,
  );

  const enqueuedJobs: SearchStack['enqueuedJobs'] = [];
  const queue = {
    enqueue: (queueName: string, payload: object, jobOptions: { jobId: string }) => {
      enqueuedJobs.push({ queue: queueName, jobId: jobOptions.jobId, payload });
      return Promise.resolve({
        queue: queueName,
        jobId: jobOptions.jobId,
        availableAt: options.clock.now(),
      });
    },
    cancel: () => Promise.resolve(false),
    depth: () => Promise.resolve({ queue: '', waiting: 0, active: 0, delayed: 0, failed: 0 }),
  } as never;

  return {
    search: new DefaultSearchService(
      engine,
      acl,
      source,
      new PrismaRecentSearchRepository(),
      audit,
      options.unitOfWork,
      options.config,
      stamps,
    ),
    projection,
    rebuilds: new SearchRebuildService(
      rebuildRepository,
      source,
      index,
      queue,
      outbox,
      options.unitOfWork,
      options.config,
      projection,
      writer,
    ),
    savedSearches: new SavedSearchService(
      new PrismaSavedSearchRepository(stamps),
      new PrismaRecentSearchRepository(),
      options.config,
      writer,
    ),
    engine,
    acl,
    index,
    source,
    rebuildRepository,
    enqueuedJobs,
  };
}

// --- Phase 9: audit and compliance -------------------------------------------------------------
//
// The same boundary reason once more, and the assertions are as database-shaped as they get: a
// chain that verifies over rows a *real* writer appended under a *real* advisory lock, a tampered
// row the table itself refuses, a gap the sequence makes visible, a timeline the real resolver
// refuses, and a bundle whose manifest digests match bytes that genuinely went to a filesystem.
//
// The checkpoint store is deliberately the real one over a real filesystem adapter. A double would
// answer from the same belief as the code, and the property under test — that a checkpoint written
// *outside* the database is signed and refused when forged — is exactly the one a double erases.

export interface AuditStackOptions {
  readonly clock: ClockPort;
  readonly unitOfWork: UnitOfWork;
  readonly config: AppConfig;
  readonly storage: DefaultStorageService;
  readonly storagePort: StoragePort;
}

export interface AuditStack {
  readonly repository: PrismaAuditRepository;
  readonly writer: ChainedAuditWriter;
  readonly readAudit: BufferedReadAuditWriter;
  readonly read: AuditReadService;
  readonly verification: AuditVerificationService;
  readonly exports: AuditExportService;
  readonly exportRepository: PrismaAuditExportRepository;
  readonly checkpoints: StorageCheckpointStore;
  readonly acl: PrismaAclResolver;
  /** What an export request handed the lane. */
  readonly enqueuedJobs: { readonly queue: string; readonly jobId: string }[];
}

export function realAuditStack(options: AuditStackOptions): AuditStack {
  const { audit, outbox, writer } = realWriteStack(options.clock, options.unitOfWork);
  const repository = new PrismaAuditRepository();
  const acl = realAclResolver(options);
  const logger = silentLogger();
  const denials = new AccessDenialRecorder(audit, logger);

  const checkpoints = new StorageCheckpointStore(options.storagePort, options.config, logger);
  const verification = new AuditVerificationService(
    repository,
    checkpoints,
    outbox,
    options.unitOfWork,
    options.clock,
    options.config,
    logger,
  );

  const enqueuedJobs: AuditStack['enqueuedJobs'] = [];
  const queue = {
    enqueue: (queueName: string, _payload: object, jobOptions: { jobId: string }) => {
      enqueuedJobs.push({ queue: queueName, jobId: jobOptions.jobId });
      return Promise.resolve({
        queue: queueName,
        jobId: jobOptions.jobId,
        availableAt: options.clock.now(),
      });
    },
    cancel: () => Promise.resolve(true),
    depth: (queueName: string) =>
      Promise.resolve({ queue: queueName, waiting: 0, active: 0, delayed: 0, failed: 0 }),
    schedule: () => Promise.resolve(),
    unschedule: () => Promise.resolve(),
  } satisfies QueuePort;

  const exportRepository = new PrismaAuditExportRepository();

  return {
    repository,
    writer: audit,
    readAudit: realReadAuditBuffer(options.clock, options.unitOfWork, audit),
    read: new AuditReadService(repository, acl, denials, writer),
    verification,
    exportRepository,
    exports: new AuditExportService(
      exportRepository,
      repository,
      checkpoints,
      options.storage,
      queue,
      outbox,
      options.unitOfWork,
      options.clock,
      options.config,
      logger,
      verification,
      writer,
    ),
    checkpoints,
    acl,
    enqueuedJobs,
  };
}

// --- Phase 10: soft delete and retention ------------------------------------------------------
//
// The same boundary reason a fifth time, and the sharpest yet: almost everything Phase 10 asserts
// is a property of the *database* — a cascade that takes exactly one delete's rows, a reference
// count that reaches zero across four revisions, a purge that removes eleven relations in one
// transaction while `audit_event` refuses to be one of them, and a hold whose refusal holds inside
// the transaction that would destroy. A double for any of the collaborators would be written from
// the same belief as the code it stands in for.

export interface RetentionStack {
  readonly scheduler: RetentionSchedulerService;
  readonly holds: DefaultLegalHoldService;
  readonly retention: DefaultRetentionService;
  readonly bin: DefaultRecycleBinService;
  readonly schedules: PrismaRetentionScheduleRepository;
  readonly tombstones: PrismaTombstoneRepository;
  readonly reaper: StorageBlobReaper;
}

export interface RetentionOptions {
  readonly clock: ClockPort;
  readonly unitOfWork: UnitOfWork;
  /** Overrides for the two settings this phase adds. Absent means the catalogue default. */
  readonly settings?: Readonly<Record<string, unknown>>;
}

/**
 * The scheduler half — what Document's own delete, restore and publication call.
 *
 * Built separately from the rest because that is exactly how the container builds it: this half
 * sits below Document and the disposition half sits above it, and a test composing them as one
 * object would be testing a composition nothing ships.
 */
export function realRetentionScheduler(options: RetentionOptions): RetentionSchedulerService {
  const { stamps, outbox, writer } = realWriteStack(options.clock, options.unitOfWork);
  return new RetentionSchedulerService(
    new PrismaRetentionScheduleRepository(stamps),
    new PrismaLegalHoldRepository(stamps),
    new PrismaRetentionPolicyReader(),
    settingsReaderFor(options.settings ?? {}),
    outbox,
    writer,
  );
}

export function realRetention(
  options: RetentionOptions & {
    readonly disposition: DocumentDisposition;
    readonly storage: StoragePort;
  },
): RetentionStack {
  const { stamps, outbox, writer } = realWriteStack(options.clock, options.unitOfWork);
  const schedules = new PrismaRetentionScheduleRepository(stamps);
  const holdRepository = new PrismaLegalHoldRepository(stamps);
  const tombstones = new PrismaTombstoneRepository();
  const reaper = new StorageBlobReaper(options.storage, options.unitOfWork, silentLogger(), stamps);

  return {
    scheduler: new RetentionSchedulerService(
      schedules,
      holdRepository,
      new PrismaRetentionPolicyReader(),
      settingsReaderFor(options.settings ?? {}),
      outbox,
      writer,
    ),
    holds: new DefaultLegalHoldService(holdRepository, schedules, outbox, writer),
    retention: new DefaultRetentionService(
      schedules,
      holdRepository,
      tombstones,
      options.disposition,
      reaper,
      settingsReaderFor(options.settings ?? {}),
      outbox,
      silentLogger(),
      writer,
    ),
    bin: new DefaultRecycleBinService(new PrismaRecycleBinRepository(), writer),
    schedules,
    tombstones,
    reaper,
  };
}

// --- Phase 11: delegation ---------------------------------------------------------------------
//
// The same boundary reason again, and it is the sharpest case yet. What this phase's suite asserts
// is entirely about the database at an instant: a delegation revoked mid-flight refusing the very
// next decision, a delegator's authority disappearing between creation and use, a chain refused by
// a graph walk over live rows, and a period that has passed authorising nothing. Every one of those
// is a question about what is in the table *now*, and a repository double would answer each of them
// from the same belief as the code under test.
//
// So the service is composed with its real repository, the real credential repository — because
// "what does the delegator hold right now" has to be read from `user_role` and `role_permission`
// rather than asserted — the real user directory, the real outbox and the real transaction
// boundary. Only the settings reader is stood in for, because what these suites vary is a number
// and the catalogue is where the number comes from.

export interface DelegationStack {
  readonly delegations: DefaultDelegationService;
  readonly repository: PrismaDelegationRepository;
  /** The adapter the engine binds, so a suite can hand the same object to `realWorkflowEngine`. */
  readonly gate: WorkflowDelegationAdapter;
}

export function realDelegation(options: {
  readonly clock: ClockPort;
  readonly unitOfWork: UnitOfWork;
  /** Overrides for the four settings this phase adds. Absent means the catalogue default. */
  readonly settings?: Readonly<Record<string, unknown>>;
}): DelegationStack {
  const { stamps, outbox, writer } = realWriteStack(options.clock, options.unitOfWork);
  const repository = new PrismaDelegationRepository(stamps);
  const service = new DefaultDelegationService(
    repository,
    new PrismaCredentialRepository(),
    new PrismaUserDirectory(),
    settingsReaderFor(options.settings ?? {}),
    outbox,
    writer,
  );
  return {
    delegations: service,
    repository,
    gate: new WorkflowDelegationAdapter(service),
  };
}

/** The purge, composed the way `DocumentModule` binds `DOCUMENT_DISPOSITION`. */
export function realDisposition(
  clock: ClockPort,
  storage: DefaultStorageService,
): RetentionDispositionAdapter {
  const stamps = new RecordStamps(clock);
  return new RetentionDispositionAdapter(new StorageContentGateAdapter(storage), stamps);
}

/**
 * The catalogue defaults, with the overrides a suite states.
 *
 * The real `CachedSettingsReader` would need Administration's repository and a seeded settings
 * row to answer "thirty days"; what these suites vary is the *number*, and the catalogue is where
 * the number comes from when nobody overrides it.
 */
function settingsReaderFor(overrides: Readonly<Record<string, unknown>>) {
  return {
    get: (definition: { key: string; defaultValue: unknown }) =>
      Promise.resolve(overrides[definition.key] ?? definition.defaultValue),
    all: () => Promise.resolve(overrides),
    invalidate: () => Promise.resolve(),
  } as never;
}

// --- Notifications (Phase 12) ------------------------------------------------------------------

/** Records what it was asked to send, and answers however the suite needs. */
export class RecordingTransport implements NotificationPort {
  readonly channel: NotificationChannelKey = 'EMAIL';
  readonly sent: { address: string; subject: string; bodyHtml: string | null }[] = [];
  receipt: DeliveryReceipt = {
    accepted: true,
    providerMessageId: 'provider-1',
    failureReason: null,
    permanentFailure: false,
  };

  send(message: {
    recipient: { address: string };
    subject: string;
    bodyHtml: string | null;
  }): Promise<DeliveryReceipt> {
    this.sent.push({
      address: message.recipient.address,
      subject: message.subject,
      bodyHtml: message.bodyHtml,
    });
    return Promise.resolve(this.receipt);
  }
}

export interface NotificationStack {
  readonly notifications: DefaultNotificationService;
  readonly delivery: DeliveryService;
  readonly digests: DigestService;
  readonly events: NotificationEventService;
  readonly admin: NotificationAdminService;
  readonly messages: PrismaNotificationMessageRepository;
  readonly preferences: PrismaNotificationPreferenceRepository;
  readonly suppressions: PrismaNotificationSuppressionRepository;
  readonly batches: PrismaNotificationBatchRepository;
  readonly transport: RecordingTransport;
}

/**
 * Everything the notification module is, wired the way `NotificationModule` wires it.
 *
 * Real repositories, the real ACL resolver and the real renderer; a recording transport, because
 * the one thing a suite must not do is send mail. `DOCUMENT_SERVICE` is passed in rather than
 * built here, so a suite that has a real document library asserts against real documents and one
 * that has none can supply a double — which is the difference between the visibility assertions
 * and the rest.
 */
export function realNotifications(options: {
  readonly clock: ClockPort;
  readonly unitOfWork: UnitOfWork;
  readonly config: AppConfig;
  readonly documents: DocumentService;
  readonly settings?: Readonly<Record<string, unknown>>;
}): NotificationStack {
  const { writer } = realWriteStack(options.clock, options.unitOfWork);
  const settings = settingsReaderFor(options.settings ?? {});
  const logger = silentLogger();

  const messages = new PrismaNotificationMessageRepository();
  const preferences = new PrismaNotificationPreferenceRepository();
  const templates = new PrismaNotificationTemplateRepository();
  const suppressions = new PrismaNotificationSuppressionRepository();
  const batches = new PrismaNotificationBatchRepository();
  const directory = new PrismaUserDirectory();

  const notifications = new DefaultNotificationService(
    messages,
    preferences,
    templates,
    suppressions,
    directory,
    settings,
    options.clock,
    logger,
  );
  const transport = new RecordingTransport();
  const delivery = new DeliveryService(
    messages,
    suppressions,
    notifications,
    transport,
    settings,
    options.clock,
    options.unitOfWork,
    directory,
    logger,
    writer,
  );
  const digests = new DigestService(
    messages,
    templates,
    directory,
    settings,
    options.clock,
    options.unitOfWork,
    logger,
  );
  const visibility = new RecipientVisibilityService(realAclResolver(options), directory, logger);
  const events = new NotificationEventService(
    notifications,
    batches,
    options.documents,
    directory,
    settings,
    options.config,
    options.clock,
    options.unitOfWork,
    logger,
    visibility,
  );
  const admin = new NotificationAdminService(
    preferences,
    templates,
    suppressions,
    settings,
    writer,
  );

  return {
    notifications,
    delivery,
    digests,
    events,
    admin,
    messages,
    preferences,
    suppressions,
    batches,
    transport,
  };
}

// --- Phase 13: the dashboard ------------------------------------------------------------------

export interface DashboardStack {
  readonly dashboard: DefaultDashboardService;
  /** The repository the library itself serves from — so a suite can compare a tile to its list. */
  readonly documents: PrismaDocumentRepository;
  readonly acl: PrismaAclResolver;
}

/**
 * The dashboard, wired the way `DashboardModule` wires it.
 *
 * Seven real adapters over seven real modules, the real `PrismaAclResolver` and the real
 * `ACTIVITY_READER`. That composition is the point rather than a convenience: the phase's whole
 * claim is that the dashboard's numbers are *somebody else's* — the list's, the inbox's, the
 * resolver's — and a stack of doubles would assert only that the suite and the code share a belief.
 *
 * Delegation and notifications are passed in, because each is optional in the real composition and
 * a suite needs to be able to run without them: `null` is a deployment that does not have the
 * capability, which must render as `UNAVAILABLE` rather than as zero.
 *
 * It lives here rather than in the suite for the reason every other stack does — the boundary lint
 * forbids one module reaching into another's `infrastructure/`, and a dashboard suite composing
 * itself would have to reach into seven.
 */
export function realDashboard(options: {
  readonly clock: ClockPort;
  readonly unitOfWork: UnitOfWork;
  /** Phase 14: the resolver reads its cache TTL and its walk bounds from here. */
  readonly config?: AppConfig;
  readonly delegations?: DashboardDelegationMetrics | null;
  readonly notifications?: DashboardNotificationMetrics | null;
  /** Overridden by the suite that asserts a failing source degrades one card, not the page. */
  readonly documentMetrics?: DashboardDocumentMetrics;
}): DashboardStack {
  const stamps = new RecordStamps(options.clock);
  const documents = realDocumentRepository(options);
  const acl = realAclResolver(options);

  const dashboard = new DefaultDashboardService(
    options.unitOfWork,
    acl,
    new AuditActivityReader(new PrismaAuditRepository()),
    options.documentMetrics ?? new DocumentDashboardMetrics(documents),
    new WorkflowDashboardMetrics(stamps),
    new StorageDashboardMetrics(),
    new IdentityDashboardMetrics(),
    new OrganizationDashboardMetrics(),
    new RetentionDashboardMetrics(),
    silentLogger(),
    options.clock,
    options.delegations ?? null,
    options.notifications ?? null,
  );

  return { dashboard, documents, acl };
}
