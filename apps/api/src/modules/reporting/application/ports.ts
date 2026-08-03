import type { ReportDefinitionId, UserId } from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

/**
 * Reports read from read models, never from another module's tables.
 *
 * That constraint is what keeps a reporting query from quietly becoming the reason a schema
 * cannot change (`docs/architecture/02-backend-architecture.md` §3).
 */
export const REPORT_DEFINITION_REPOSITORY = Symbol('ReportDefinitionRepository');

export interface ReportDefinitionRecord {
  readonly id: ReportDefinitionId;
  readonly key: string;
  readonly name: string;
  readonly ownerId: UserId;
  readonly query: Readonly<Record<string, unknown>>;
}

export interface ReportDefinitionRepository {
  findById(id: ReportDefinitionId): Promise<ReportDefinitionRecord | null>;
  findByKey(key: string): Promise<ReportDefinitionRecord | null>;
  listFor(ownerId: UserId, page: PageRequest): Promise<Page<ReportDefinitionRecord>>;
  save(definition: ReportDefinitionRecord): Promise<void>;
}

export const REPORTING_SERVICE = Symbol('ReportingService');

export interface ReportingService {
  /** Every row is permission-scoped to the caller, in SQL, exactly like a document list. */
  run(
    key: string,
    parameters: Readonly<Record<string, string>>,
    page: PageRequest,
  ): Promise<Page<Readonly<Record<string, unknown>>>>;
  /** Large exports are queued and audited rather than streamed from a request. */
  requestExport(
    key: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<{ jobId: string }>;
}
