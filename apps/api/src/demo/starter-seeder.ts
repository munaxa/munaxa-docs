import {
  createApprovalGroupSchema,
  createCategorySchema,
  createConfidentialityLevelSchema,
  createDepartmentSchema,
  createDocumentTypeSchema,
  createFolderSchema,
  createLibrarySchema,
  createMetadataFieldSchema,
  createNumberingRuleSchema,
  createRetentionPolicySchema,
  createWorkflowDefinitionSchema,
} from '@edms/contracts';
import type { Page } from '@edms/utils';

import type { ApprovalRoutingService } from '../modules/administration/application/approval-routing.service';
import type { ConfigurationService } from '../modules/administration/application/configuration.service';
import type { NumberingAdminService } from '../modules/administration/application/numbering-admin.service';
import type { LibraryAdminService } from '../modules/library/application/library-admin.service';
import type { ScopeAdminService } from '../modules/organization/application/scope-admin.service';
import type { WorkflowAdminService } from '../modules/workflow/application/workflow-admin.service';
import {
  STARTER_APPROVAL_GROUP,
  STARTER_CATEGORIES,
  STARTER_CONFIDENTIALITY,
  STARTER_DEPARTMENTS,
  STARTER_DOCUMENT_TYPES,
  STARTER_LIBRARIES,
  STARTER_METADATA_FIELDS,
  STARTER_NUMBERING_RULES,
  STARTER_RETENTION,
  STARTER_WORKFLOW,
} from './starter-catalogue';

/**
 * Loads the demo starter configuration into one tenant, through the product's own services.
 *
 * **Additive and re-runnable.** Every item is looked up by its code or key first. One that exists
 * is left exactly as it is — never updated, never restored — and is reused as a reference, so a
 * second run creates nothing and changes nothing, and a tenant an administrator has already
 * configured keeps every one of their edits. An item retired (soft-deleted) by an administrator is
 * respected: it is not brought back, and anything that needs it is skipped with the reason.
 *
 * **No second write path.** Each item is parsed by the same `@edms/contracts` schema the HTTP
 * controller uses and created by the same application service, so validation, the audit trail,
 * the outbox events and the suspended-tenant refusal all apply exactly as they do for an
 * administrator clicking through the screens. The audit trail records the system as the actor,
 * on the `SYSTEM` channel, under a correlation id that names this command.
 *
 * Not one transaction: each item commits on its own, as it would from the screens. A failure
 * part-way leaves the items before it in place, and a re-run picks up from there.
 */

export type StarterStepOutcome = 'created' | 'exists' | 'skipped';

export interface StarterStep {
  readonly kind: string;
  readonly code: string;
  readonly outcome: StarterStepOutcome;
  readonly note?: string;
}

export interface StarterSeedResult {
  readonly steps: readonly StarterStep[];
  readonly created: number;
  readonly existing: number;
  readonly skipped: number;
}

/** The services the seeder drives. Narrowed to what it calls, so a test can supply fakes. */
export interface StarterServices {
  readonly scopes: Pick<ScopeAdminService, 'listEntities' | 'listDepartments' | 'createDepartment'>;
  readonly config: Pick<
    ConfigurationService,
    | 'listConfidentiality'
    | 'createConfidentiality'
    | 'listRetention'
    | 'createRetention'
    | 'listCategories'
    | 'createCategory'
    | 'listMetadataFields'
    | 'createMetadataField'
    | 'listDocumentTypes'
    | 'createDocumentType'
  >;
  readonly numbering: Pick<NumberingAdminService, 'list' | 'create'>;
  readonly routing: Pick<ApprovalRoutingService, 'listGroups' | 'createGroup'>;
  readonly workflows: Pick<WorkflowAdminService, 'list' | 'create' | 'publish'>;
  readonly libraries: Pick<
    LibraryAdminService,
    'listLibraries' | 'createLibrary' | 'listFolders' | 'createFolder'
  >;
  /** The tenant's current administrators: the starting members of the approval group. */
  readonly administrators: () => Promise<readonly string[]>;
}

export interface StarterSeedOptions {
  /** Report what would be created without writing anything. */
  readonly dryRun: boolean;
}

interface Existing {
  readonly id: string;
  readonly deleted: boolean;
}

const PAGE_SIZE = 100;
/** Far beyond any starter tenant; a guard against a listing that never reports `hasMore: false`. */
const MAXIMUM_PAGES = 50;

const listing = {
  sortDirection: 'asc' as const,
  deleted: 'all' as const,
};

/** Every row of a paged listing. Configuration tables are small, so reading them whole is fine. */
async function everything<TRow>(
  list: (page: number) => Promise<Page<TRow>>,
): Promise<readonly TRow[]> {
  const rows: TRow[] = [];
  for (let page = 1; page <= MAXIMUM_PAGES; page += 1) {
    const result = await list(page);
    rows.push(...result.data);
    if (!result.meta.hasMore) {
      break;
    }
  }
  return rows;
}

/** Codes are case-insensitive in this product; keys are stored lower-case. */
function byIdentity<TRow extends { id: string; deletedAt: Date | null }>(
  rows: readonly TRow[],
  identity: (row: TRow) => string,
): Map<string, Existing> {
  const map = new Map<string, Existing>();
  for (const row of rows) {
    const key = identity(row).toUpperCase();
    const current = map.get(key);
    // A live row wins over a retired one with the same code: that is the one a reference means.
    if (current === undefined || (current.deleted && row.deletedAt === null)) {
      map.set(key, { id: row.id, deleted: row.deletedAt !== null });
    }
  }
  return map;
}

/** A placeholder id for a dry run, where nothing is created and so nothing has a real id. */
function planned(kind: string, code: string): string {
  return `planned:${kind}:${code}`;
}

export class StarterSeeder {
  private readonly steps: StarterStep[] = [];

  constructor(
    private readonly services: StarterServices,
    private readonly options: StarterSeedOptions,
  ) {}

  async run(): Promise<StarterSeedResult> {
    const departments = await this.seedDepartments();
    const confidentiality = await this.seedConfidentiality();
    const retention = await this.seedRetention();
    await this.seedCategories();
    const fields = await this.seedMetadataFields();
    const rules = await this.seedNumberingRules();
    const workflow = await this.seedWorkflow();
    await this.seedDocumentTypes({ confidentiality, retention, fields, rules, workflow });
    await this.seedLibraries(departments);

    return {
      steps: [...this.steps],
      created: this.steps.filter((step) => step.outcome === 'created').length,
      existing: this.steps.filter((step) => step.outcome === 'exists').length,
      skipped: this.steps.filter((step) => step.outcome === 'skipped').length,
    };
  }

  // --- Organisation ---------------------------------------------------------------------------

  private async seedDepartments(): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    const entities = await everything((page) =>
      this.services.scopes.listEntities({ page, pageSize: PAGE_SIZE, ...listing, deleted: 'live' }),
    );
    // Provisioning creates exactly one company and one entity; the departments go under the oldest
    // live entity, which is that one. A tenant an administrator has restructured still has one.
    const root = [...entities].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (root === undefined) {
      for (const department of STARTER_DEPARTMENTS) {
        this.record('department', department.code, 'skipped', 'the tenant has no live entity');
      }
      return ids;
    }

    const existing = byIdentity(
      await everything((page) =>
        this.services.scopes.listDepartments({ page, pageSize: PAGE_SIZE, ...listing }),
      ),
      (row) => row.code,
    );

    for (const department of STARTER_DEPARTMENTS) {
      const id = await this.ensure('department', department.code, existing, async () => {
        const body = createDepartmentSchema.parse({ entityId: root.id, ...department });
        return (await this.services.scopes.createDepartment(body)).id;
      });
      if (id !== null) {
        ids.set(department.code, id);
      }
    }
    return ids;
  }

  // --- Configuration --------------------------------------------------------------------------

  private async seedConfidentiality(): Promise<Map<string, string>> {
    const existing = byIdentity(
      await everything((page) =>
        this.services.config.listConfidentiality({ page, pageSize: PAGE_SIZE, ...listing }),
      ),
      (row) => row.code,
    );
    const ids = new Map<string, string>();
    for (const level of STARTER_CONFIDENTIALITY) {
      const id = await this.ensure('confidentiality level', level.code, existing, async () => {
        const body = createConfidentialityLevelSchema.parse(level);
        return (await this.services.config.createConfidentiality(body)).id;
      });
      if (id !== null) {
        ids.set(level.code, id);
      }
    }
    return ids;
  }

  private async seedRetention(): Promise<Map<string, string>> {
    const existing = byIdentity(
      await everything((page) =>
        this.services.config.listRetention({ page, pageSize: PAGE_SIZE, ...listing }),
      ),
      (row) => row.code,
    );
    const ids = new Map<string, string>();
    for (const policy of STARTER_RETENTION) {
      const id = await this.ensure('retention policy', policy.code, existing, async () => {
        const body = createRetentionPolicySchema.parse(policy);
        return (await this.services.config.createRetention(body)).id;
      });
      if (id !== null) {
        ids.set(policy.code, id);
      }
    }
    return ids;
  }

  private async seedCategories(): Promise<void> {
    const existing = byIdentity(
      await everything((page) =>
        this.services.config.listCategories({ page, pageSize: PAGE_SIZE, ...listing }),
      ),
      (row) => row.code,
    );
    const ids = new Map<string, string>();
    // The catalogue lists every parent before its children, so one pass resolves every parent.
    for (const category of STARTER_CATEGORIES) {
      let parentId: string | null = null;
      if (category.parent !== null) {
        const parent = ids.get(category.parent);
        if (parent === undefined) {
          this.record(
            'category',
            category.code,
            'skipped',
            `parent ${category.parent} unavailable`,
          );
          continue;
        }
        parentId = parent;
      }
      const id = await this.ensure('category', category.code, existing, async () => {
        const body = createCategorySchema.parse({
          parentId,
          code: category.code,
          name: category.name,
        });
        return (await this.services.config.createCategory(body)).id;
      });
      if (id !== null) {
        ids.set(category.code, id);
      }
    }
  }

  private async seedMetadataFields(): Promise<Map<string, string>> {
    const existing = byIdentity(
      await everything((page) =>
        this.services.config.listMetadataFields({ page, pageSize: PAGE_SIZE, ...listing }),
      ),
      (row) => row.key,
    );
    const ids = new Map<string, string>();
    for (const field of STARTER_METADATA_FIELDS) {
      const id = await this.ensure('metadata field', field.key, existing, async () => {
        const body = createMetadataFieldSchema.parse(field);
        return (await this.services.config.createMetadataField(body)).id;
      });
      if (id !== null) {
        ids.set(field.key, id);
      }
    }
    return ids;
  }

  private async seedNumberingRules(): Promise<Map<string, string>> {
    const existing = byIdentity(
      await everything((page) =>
        this.services.numbering.list({ page, pageSize: PAGE_SIZE, ...listing }),
      ),
      (row) => row.key,
    );
    const ids = new Map<string, string>();
    for (const rule of STARTER_NUMBERING_RULES) {
      const id = await this.ensure('numbering rule', rule.key, existing, async () => {
        const body = createNumberingRuleSchema.parse(rule);
        return (await this.services.numbering.create(body)).id;
      });
      if (id !== null) {
        ids.set(rule.key, id);
      }
    }
    return ids;
  }

  // --- Approval -------------------------------------------------------------------------------

  /**
   * The approval group, then the workflow that routes to it, published.
   *
   * Returns the workflow's id only when it has a published version — a document type attached to
   * a definition with nothing published would refuse every submission — or `null` otherwise, in
   * which case the controlled types are created without a workflow.
   */
  private async seedWorkflow(): Promise<string | null> {
    const groups = byIdentity(
      await everything((page) =>
        this.services.routing.listGroups({ page, pageSize: PAGE_SIZE, ...listing }),
      ),
      (row) => row.key,
    );
    const groupId = await this.ensure(
      'approval group',
      STARTER_APPROVAL_GROUP.key,
      groups,
      async () => {
        const memberIds = await this.services.administrators();
        const body = createApprovalGroupSchema.parse({ ...STARTER_APPROVAL_GROUP, memberIds });
        return (await this.services.routing.createGroup(body)).id;
      },
    );
    if (groupId === null) {
      this.record(
        'workflow',
        STARTER_WORKFLOW.key,
        'skipped',
        `approval group ${STARTER_APPROVAL_GROUP.key} unavailable`,
      );
      return null;
    }

    const definitions = await everything((page) =>
      this.services.workflows.list({ page, pageSize: PAGE_SIZE, ...listing }),
    );
    const found = definitions.find(
      (row) => row.key.toLowerCase() === STARTER_WORKFLOW.key.toLowerCase(),
    );
    if (found !== undefined) {
      if (found.deletedAt !== null) {
        this.record('workflow', STARTER_WORKFLOW.key, 'skipped', 'retired by an administrator');
        return null;
      }
      this.record('workflow', STARTER_WORKFLOW.key, 'exists');
      // Attached only when something is published; an administrator's unpublished draft is theirs.
      return found.publishedVersion === null ? null : found.id;
    }

    if (this.options.dryRun) {
      this.record('workflow', STARTER_WORKFLOW.key, 'created', 'dry run: would create and publish');
      return planned('workflow', STARTER_WORKFLOW.key);
    }

    const body = createWorkflowDefinitionSchema.parse(STARTER_WORKFLOW);
    const created = await this.services.workflows.create(body);
    const draft = created.versions[0];
    if (draft === undefined) {
      this.record('workflow', STARTER_WORKFLOW.key, 'skipped', 'created without a draft version');
      return null;
    }
    const published = await this.services.workflows.publish(
      created.id,
      draft.id,
      created.recordVersion,
    );
    this.record('workflow', STARTER_WORKFLOW.key, 'created', 'published');
    return published.id;
  }

  // --- Document types -------------------------------------------------------------------------

  private async seedDocumentTypes(refs: {
    readonly confidentiality: Map<string, string>;
    readonly retention: Map<string, string>;
    readonly fields: Map<string, string>;
    readonly rules: Map<string, string>;
    readonly workflow: string | null;
  }): Promise<void> {
    const existing = byIdentity(
      await everything((page) =>
        this.services.config.listDocumentTypes({ page, pageSize: PAGE_SIZE, ...listing }),
      ),
      (row) => row.code,
    );

    for (const type of STARTER_DOCUMENT_TYPES) {
      const rule = refs.rules.get(type.numberingRule);
      const confidentiality = refs.confidentiality.get(type.confidentiality);
      const missing = [
        rule === undefined ? `numbering rule ${type.numberingRule}` : null,
        confidentiality === undefined ? `confidentiality ${type.confidentiality}` : null,
        ...type.fields.map((field) =>
          refs.fields.has(field.key) ? null : `metadata field ${field.key}`,
        ),
      ].filter((entry): entry is string => entry !== null);
      if (rule === undefined || confidentiality === undefined || missing.length > 0) {
        // Only when the type would be *created*: an existing type is reported as existing below.
        if (!existing.has(type.code.toUpperCase())) {
          this.record('document type', type.code, 'skipped', `${missing.join(', ')} unavailable`);
          continue;
        }
      }

      await this.ensure('document type', type.code, existing, async () => {
        const body = createDocumentTypeSchema.parse({
          code: type.code,
          name: type.name,
          description: type.description,
          numberingRuleId: rule,
          workflowDefinitionId: type.workflow === null ? null : refs.workflow,
          retentionPolicyId:
            type.retention === null ? null : (refs.retention.get(type.retention) ?? null),
          defaultConfidentialityId: confidentiality,
          revisionLabelStyle: type.revisionLabelStyle,
          isActive: true,
          fields: type.fields.map((field, index) => ({
            metadataFieldId: refs.fields.get(field.key),
            isRequired: field.isRequired,
            sortOrder: (index + 1) * 10,
            defaultValue: null,
          })),
        });
        return (await this.services.config.createDocumentType(body)).id;
      });
    }
  }

  // --- Libraries ------------------------------------------------------------------------------

  private async seedLibraries(departments: Map<string, string>): Promise<void> {
    const rows = await everything((page) =>
      this.services.libraries.listLibraries({ page, pageSize: PAGE_SIZE, ...listing }),
    );
    const existing = byIdentity(rows, (row) => row.code);

    for (const library of STARTER_LIBRARIES) {
      let ownerScopeId: string | null = null;
      if (library.department !== null) {
        const department = departments.get(library.department);
        if (department === undefined) {
          this.record(
            'library',
            library.code,
            'skipped',
            `department ${library.department} unavailable`,
          );
          continue;
        }
        ownerScopeId = department;
      }

      const before = existing.get(library.code.toUpperCase());
      const id = await this.ensure('library', library.code, existing, async () => {
        const body = createLibrarySchema.parse({
          code: library.code,
          name: library.name,
          description: library.description,
          ownerScopeType: library.department === null ? 'TENANT' : 'DEPARTMENT',
          ownerScopeId,
        });
        return (await this.services.libraries.createLibrary(body)).id;
      });
      if (id === null) {
        continue;
      }
      // Folders are added only to a library this run created. An existing library is the
      // administrator's: its folder tree is left exactly as they arranged it.
      if (before !== undefined) {
        continue;
      }
      await this.seedFolders(library.code, id, library.folders);
    }
  }

  private async seedFolders(
    code: string,
    libraryId: string,
    names: readonly string[],
  ): Promise<void> {
    if (this.options.dryRun) {
      for (const name of names) {
        this.record('folder', `${code}/${name}`, 'created', 'dry run');
      }
      return;
    }
    const folders = await everything((page) =>
      this.services.libraries.listFolders({
        page,
        pageSize: PAGE_SIZE,
        ...listing,
        deleted: 'live',
        libraryId,
      }),
    );
    const root = folders.find((folder) => folder.isRoot);
    if (root === undefined) {
      for (const name of names) {
        this.record('folder', `${code}/${name}`, 'skipped', 'the library has no root folder');
      }
      return;
    }
    for (const name of names) {
      const body = createFolderSchema.parse({
        libraryId,
        parentId: root.id,
        name,
        inheritAcl: true,
      });
      await this.services.libraries.createFolder(body);
      this.record('folder', `${code}/${name}`, 'created');
    }
  }

  // --- Plumbing -------------------------------------------------------------------------------

  /**
   * The id of the item with this code: the existing one, a newly created one, or `null` when an
   * administrator retired it (which the seeder respects rather than restores).
   */
  private async ensure(
    kind: string,
    code: string,
    existing: Map<string, Existing>,
    create: () => Promise<string>,
  ): Promise<string | null> {
    const found = existing.get(code.toUpperCase());
    if (found !== undefined) {
      if (found.deleted) {
        this.record(kind, code, 'skipped', 'retired by an administrator');
        return null;
      }
      this.record(kind, code, 'exists');
      return found.id;
    }
    if (this.options.dryRun) {
      this.record(kind, code, 'created', 'dry run');
      return planned(kind, code);
    }
    const id = await create();
    this.record(kind, code, 'created');
    return id;
  }

  private record(kind: string, code: string, outcome: StarterStepOutcome, note?: string): void {
    this.steps.push({ kind, code, outcome, ...(note !== undefined && { note }) });
  }
}
