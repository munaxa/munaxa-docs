import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import {
  type Collection,
  type CreateWorkflowDefinitionBody,
  type UpdateWorkflowDefinitionBody,
  type UpdateWorkflowVersionBody,
  type WorkflowDefinition,
  type WorkflowDefinitionBody,
  createWorkflowDefinitionSchema,
  updateWorkflowDefinitionSchema,
  updateWorkflowVersionSchema,
  workflowDefinitionBodySchema,
  workflowDefinitionListQuerySchema,
} from '@edms/contracts';
import { Permission } from '@edms/domain';
import type { Page } from '@edms/utils';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { IfMatch } from '../../../core/http/admin-request';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { WORKFLOW_ADMIN_SERVICE } from '../application/administration.ports';
import type {
  WorkflowDefinitionRow,
  WorkflowVersionRow,
} from '../application/administration.ports';
import type { WorkflowAdminService } from '../application/workflow-admin.service';

/**
 * Approval workflows, behind `workflow:manage`.
 *
 * Versions are sub-resources rather than a top-level collection, because a version has no meaning apart
 * from its definition: `POST .../versions` starts a draft, `PUT .../versions/{id}` replaces one, and
 * publishing and retiring are actions on it. Actions that are not CRUD are sub-resources, never verbs
 * in a query string (`15-api-architecture.md` §1).
 */
@Controller({ path: 'admin/workflows', version: '1' })
@RequirePermission(Permission.WORKFLOW_MANAGE)
export class WorkflowAdminController {
  constructor(@Inject(WORKFLOW_ADMIN_SERVICE) private readonly workflows: WorkflowAdminService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(workflowDefinitionListQuerySchema))
    query: ReturnType<typeof workflowDefinitionListQuerySchema.parse>,
  ): Promise<Collection<WorkflowDefinition>> {
    const { isActive, ...rest } = query;
    const page = await this.workflows.list({
      ...rest,
      // `'true' | 'false'` on the wire, because a query string has no booleans.
      ...(isActive !== undefined && { isActive: isActive === 'true' }),
    });
    return collection(page, toWorkflow);
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<WorkflowDefinition> {
    return toWorkflow(await this.workflows.get(id));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createWorkflowDefinitionSchema)) body: CreateWorkflowDefinitionBody,
  ): Promise<WorkflowDefinition> {
    return toWorkflow(
      await this.workflows.create({
        key: body.key,
        name: body.name,
        ...(body.description !== undefined && { description: body.description }),
        definition: body.definition,
      }),
    );
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateWorkflowDefinitionSchema)) body: UpdateWorkflowDefinitionBody,
    @IfMatch() version: number | undefined,
  ): Promise<WorkflowDefinition> {
    return toWorkflow(await this.workflows.update(id, body, version));
  }

  /**
   * Starts a new draft.
   *
   * This is what editing a published workflow *is*: a published version is immutable, because an
   * approval binds to a version and editing one would change the rules of an approval already running.
   */
  @Post(':id/versions')
  @HttpCode(HttpStatus.CREATED)
  async addDraft(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(workflowDefinitionBodySchema)) body: WorkflowDefinitionBody,
  ): Promise<WorkflowDefinition> {
    return toWorkflow(await this.workflows.addDraft(id, body));
  }

  /** Replaces a draft's body. `PUT`, because it replaces the whole definition rather than patching it. */
  @Patch(':id/versions/:versionId')
  async updateDraft(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body(new ZodValidationPipe(updateWorkflowVersionSchema)) body: UpdateWorkflowVersionBody,
  ): Promise<WorkflowDefinition> {
    return toWorkflow(await this.workflows.updateDraft(id, versionId, body.definition));
  }

  @Post(':id/versions/:versionId/publish')
  async publish(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @IfMatch() version: number | undefined,
  ): Promise<WorkflowDefinition> {
    return toWorkflow(await this.workflows.publish(id, versionId, version));
  }

  /** Retires a version. New approvals stop using it; running ones are untouched. */
  @Post(':id/versions/:versionId/deprecate')
  async deprecate(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @IfMatch() version: number | undefined,
  ): Promise<WorkflowDefinition> {
    return toWorkflow(await this.workflows.deprecate(id, versionId, version));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.workflows.delete(id, version);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restore(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.workflows.restore(id, version);
  }
}

// --- Mappers ------------------------------------------------------------------------------

function toVersion(row: WorkflowVersionRow): WorkflowDefinition['versions'][number] {
  return {
    id: row.id,
    version: row.version,
    state: row.state,
    // Stored as validated `jsonb` and re-parsed on the way out, so a row written by an older release
    // cannot reach a client as a shape the contract does not describe. A body that no longer parses is
    // returned with no stages rather than failing the whole list — the version is visible and plainly
    // unusable, which is what an administrator needs to see.
    definition: parseDefinition(row.definition),
    publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    publishedBy: row.publishedBy,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    instanceCount: row.instanceCount,
  };
}

function parseDefinition(raw: unknown): WorkflowDefinitionBody {
  const parsed = workflowDefinitionBodySchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : {
        appliesTo: { documentTypes: [], condition: null },
        stages: [],
        onComplete: { assignNumber: true, publish: 'IMMEDIATELY' },
      };
}

function toWorkflow(row: WorkflowDefinitionRow): WorkflowDefinition {
  return {
    id: row.id,
    // The record's optimistic-locking version, which is what `If-Match` carries. Deliberately not the
    // workflow version number: those are two different numbers, and the contract's `versions[].version`
    // is the other one.
    version: row.recordVersion,
    key: row.key,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    publishedVersion: row.publishedVersion,
    latestVersion: row.latestVersion,
    versions: row.versions.map(toVersion),
    documentTypeCount: row.documentTypeCount,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    deletedBy: row.deletedBy,
  };
}

function collection<TRow, TItem>(page: Page<TRow>, map: (row: TRow) => TItem): Collection<TItem> {
  return { data: page.data.map(map), meta: page.meta };
}
