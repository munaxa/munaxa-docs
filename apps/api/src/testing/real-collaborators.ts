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
import { LocalStorageAdapter } from '../infrastructure/storage/local.adapter';
import { TenantScopedStorage } from '../infrastructure/tenancy/tenant-scoped-storage';
import { ConfigurationService } from '../modules/administration/application/configuration.service';
import { NumberingAdminService } from '../modules/administration/application/numbering-admin.service';
import { PrismaConfigurationRepository } from '../modules/administration/infrastructure/prisma-configuration.repository';
import { DefaultDocumentService } from '../modules/document/application/document.service';
import { AdministrationConfigurationAdapter } from '../modules/document/infrastructure/administration-configuration.adapter';
import { LibraryPlacementAdapter } from '../modules/document/infrastructure/library-placement.adapter';
import { PrismaDocumentActivityRepository } from '../modules/document/infrastructure/prisma-document-activity.repository';
import { PrismaDocumentRepository } from '../modules/document/infrastructure/prisma-document.repository';
import { StorageContentGateAdapter } from '../modules/document/infrastructure/storage-content-gate.adapter';
import type { UserAdminService } from '../modules/identity/application/user-admin.service';
import { LibraryAdminService } from '../modules/library/application/library-admin.service';
import { PrismaLibraryAdminRepository } from '../modules/library/infrastructure/prisma-library-admin.repository';
import { PrismaRevisionWriter } from '../modules/revision/infrastructure/prisma-revision.writer';
import { DefaultStorageService } from '../modules/storage/application/storage.service';
import { PrismaFileObjectRepository } from '../modules/storage/infrastructure/prisma-file-object.repository';
import { PrismaUploadSessionRepository } from '../modules/storage/infrastructure/prisma-upload-session.repository';

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
  const storage = new DefaultStorageService(
    new PrismaFileObjectRepository(stamps),
    new PrismaUploadSessionRepository(stamps),
    new TenantScopedStorage(localStorage, options.registry),
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
    new StorageContentGateAdapter(storage),
    new PrismaRevisionWriter(stamps),
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
  };
}
