import type { ClockPort } from '../ports/clock.port';
import { AdministeredWriter } from '../core/persistence/administered-writer';
import { RecordStamps } from '../core/persistence/record-stamps';
import { PrismaOutboxWriter } from '../core/outbox/prisma-outbox.writer';
import type { UnitOfWork } from '../core/prisma/unit-of-work';
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
import { LibraryPlacementAdapter } from '../modules/document/infrastructure/library-placement.adapter';
import { PrismaDocumentActivityRepository } from '../modules/document/infrastructure/prisma-document-activity.repository';
import { PrismaDocumentRepository } from '../modules/document/infrastructure/prisma-document.repository';
import { StorageContentGateAdapter } from '../modules/document/infrastructure/storage-content-gate.adapter';
import { DocumentPreviewService } from '../modules/document/application/document-preview.service';
import type { UserDirectory } from '../modules/identity/application/ports';
import type { UserAdminService } from '../modules/identity/application/user-admin.service';
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
import type { WorkflowDirectory } from '../modules/workflow/application/ports';
import { WorkflowEngine } from '../modules/workflow/application/workflow-engine.service';
import { WorkflowTimers } from '../modules/workflow/application/workflow-timers.service';
import { DocumentContextAdapter } from '../modules/workflow/infrastructure/document-context.adapter';
import { DocumentNumberAllocatorAdapter } from '../modules/workflow/infrastructure/document-number-allocator.adapter';
import { PrismaApprovalQueryRepository } from '../modules/workflow/infrastructure/prisma-approval-query.repository';
import { PrismaWorkflowEngineRepository } from '../modules/workflow/infrastructure/prisma-workflow-engine.repository';
import { PrismaWorkflowVersionReader } from '../modules/workflow/infrastructure/prisma-workflow-version.reader';
import { WorkflowCalendarAdapter } from '../modules/workflow/infrastructure/workflow-calendar.adapter';
import type { QueuePort } from '../ports/queue.port';
import { PrismaFileObjectRepository } from '../modules/storage/infrastructure/prisma-file-object.repository';
import { PrismaUploadSessionRepository } from '../modules/storage/infrastructure/prisma-upload-session.repository';
import { RevisionControlService } from '../modules/document/application/revision-control.service';
import { PrismaDocumentLockRepository } from '../modules/document/infrastructure/prisma-document-lock.repository';
import { RevisionQueryService } from '../modules/revision/application/revision-query.service';
import { PrismaRevisionQueryRepository } from '../modules/revision/infrastructure/prisma-revision-query.repository';

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
  readonly outbox: PrismaOutboxWriter;
  readonly writer: AdministeredWriter;
} {
  const stamps = new RecordStamps(clock);
  const audit = realAuditWriter(clock, unitOfWork);
  return {
    stamps,
    audit,
    outbox: new PrismaOutboxWriter(stamps),
    writer: new AdministeredWriter(unitOfWork, audit, stamps),
  };
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
}

/**
 * Everything the document library is, wired the way the container wires it.
 *
 * The storage adapter is the real filesystem one *under the real tenant scoping*, so an upload in a
 * suite using this genuinely writes bytes to a genuinely prefixed path — which is what makes the
 * isolation assertions about the filesystem rather than about a wrapper.
 */
export function realDocumentLibrary(options: DocumentLibraryOptions): DocumentLibraryStack {
  const { stamps, outbox, writer } = realWriteStack(options.clock, options.unitOfWork);

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
  const libraries = new LibraryAdminService(
    new PrismaLibraryAdminRepository(stamps),
    realOrganizationService(),
    outbox,
    writer,
  );

  const documentRepository = new PrismaDocumentRepository(stamps);
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
    outbox,
    writer,
  );

  return {
    storage,
    documents,
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
    new PrismaDocumentRepository(stamps),
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
  storage: DefaultStorageService;
  storagePort: StoragePort;
  config: AppConfig;
  configuration: ConfigurationService;
  users: Pick<UserAdminService, 'get'>;
  directory: UserDirectory;
}): DocumentPreviewService {
  const { stamps, writer } = realWriteStack(options.clock, options.unitOfWork);
  const settings = {
    get: (definition: { defaultValue: unknown }) => Promise.resolve(definition.defaultValue),
  } as never;
  return new DocumentPreviewService(
    writer,
    new PrismaDocumentRepository(stamps),
    new AdministrationConfigurationAdapter(
      options.configuration,
      realOrganizationService(),
      options.users as UserAdminService,
    ),
    new PrismaRevisionWriter(stamps, new PrismaOutboxWriter(stamps)),
    options.directory,
    settings,
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
          new PrismaDocumentRepository(stamps),
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
