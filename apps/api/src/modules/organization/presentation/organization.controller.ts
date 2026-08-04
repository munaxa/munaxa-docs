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
  type Branch,
  type Collection,
  type Company,
  type CreateBranchBody,
  type CreateCompanyBody,
  type CreateDepartmentBody,
  type CreateEntityBody,
  type Department,
  type Entity,
  type MoveDepartmentBody,
  type UpdateBranchBody,
  type UpdateCompanyBody,
  type UpdateDepartmentBody,
  type UpdateEntityBody,
  branchListQuerySchema,
  companyListQuerySchema,
  createBranchSchema,
  createCompanySchema,
  createDepartmentSchema,
  createEntitySchema,
  departmentListQuerySchema,
  entityListQuerySchema,
  moveDepartmentSchema,
  updateBranchSchema,
  updateCompanySchema,
  updateDepartmentSchema,
  updateEntitySchema,
} from '@edms/contracts';
import { Permission } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { IfMatch } from '../../../core/http/admin-request';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { SCOPE_ADMIN_SERVICE } from '../application/ports';
import type { ScopeAdminService } from '../application/scope-admin.service';
import { OrganizationNodeKind } from '../domain/node-kind';
import { toBranch, toCollection, toCompany, toDepartment, toEntity } from './organization.view';

/**
 * The organisation structure, as an administrator edits it.
 *
 * Four resources on one controller rather than four controllers, because they are one screen and
 * one permission: an administrator laying out a company does not think of entities and branches as
 * separate features, and splitting them would only spread `org:manage` across four files.
 *
 * **Reads are gated too.** `RoutePermissionRegistry` only *requires* a permission on mutating
 * routes, and that is the boot-time floor rather than the policy: an organisation chart names every
 * department and every legal entity a customer has, which is not something every authenticated
 * caller should be able to enumerate. Later phases that need a department picker for non-admins add
 * a narrower endpoint rather than widening this one.
 *
 * **Delete is soft, and `restore` is a sub-resource.** `DELETE` sets `deleted_at`; the row stays,
 * and `POST .../restore` brings it back — actions that are not CRUD are sub-resources rather than
 * verbs in a query string (`15-api-architecture.md` §1).
 */
@Controller({ path: 'admin', version: '1' })
@RequirePermission(Permission.ORG_MANAGE)
export class OrganizationController {
  constructor(@Inject(SCOPE_ADMIN_SERVICE) private readonly scopes: ScopeAdminService) {}

  // --- Companies -------------------------------------------------------------------------

  @Get('companies')
  async listCompanies(
    @Query(new ZodValidationPipe(companyListQuerySchema))
    query: ReturnType<typeof companyListQuerySchema.parse>,
  ): Promise<Collection<Company>> {
    return toCollection(await this.scopes.listCompanies(query), toCompany);
  }

  @Get('companies/:id')
  async getCompany(@Param('id') id: string): Promise<Company> {
    return toCompany(await this.scopes.getCompany(id));
  }

  @Post('companies')
  @HttpCode(HttpStatus.CREATED)
  async createCompany(
    @Body(new ZodValidationPipe(createCompanySchema)) body: CreateCompanyBody,
  ): Promise<Company> {
    return toCompany(await this.scopes.createCompany(body));
  }

  @Patch('companies/:id')
  async updateCompany(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCompanySchema)) body: UpdateCompanyBody,
    @IfMatch() version: number | undefined,
  ): Promise<Company> {
    return toCompany(await this.scopes.updateCompany(id, body, version));
  }

  @Delete('companies/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCompany(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.scopes.delete(OrganizationNodeKind.COMPANY, id, version);
  }

  @Post('companies/:id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restoreCompany(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.scopes.restore(OrganizationNodeKind.COMPANY, id, version);
  }

  // --- Entities --------------------------------------------------------------------------

  @Get('entities')
  async listEntities(
    @Query(new ZodValidationPipe(entityListQuerySchema))
    query: ReturnType<typeof entityListQuerySchema.parse>,
  ): Promise<Collection<Entity>> {
    return toCollection(await this.scopes.listEntities(query), toEntity);
  }

  @Get('entities/:id')
  async getEntity(@Param('id') id: string): Promise<Entity> {
    return toEntity(await this.scopes.getEntity(id));
  }

  @Post('entities')
  @HttpCode(HttpStatus.CREATED)
  async createEntity(
    @Body(new ZodValidationPipe(createEntitySchema)) body: CreateEntityBody,
  ): Promise<Entity> {
    return toEntity(await this.scopes.createEntity(body));
  }

  @Patch('entities/:id')
  async updateEntity(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateEntitySchema)) body: UpdateEntityBody,
    @IfMatch() version: number | undefined,
  ): Promise<Entity> {
    return toEntity(await this.scopes.updateEntity(id, body, version));
  }

  @Delete('entities/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteEntity(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.scopes.delete(OrganizationNodeKind.ENTITY, id, version);
  }

  @Post('entities/:id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restoreEntity(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.scopes.restore(OrganizationNodeKind.ENTITY, id, version);
  }

  // --- Branches --------------------------------------------------------------------------

  @Get('branches')
  async listBranches(
    @Query(new ZodValidationPipe(branchListQuerySchema))
    query: ReturnType<typeof branchListQuerySchema.parse>,
  ): Promise<Collection<Branch>> {
    return toCollection(await this.scopes.listBranches(query), toBranch);
  }

  @Get('branches/:id')
  async getBranch(@Param('id') id: string): Promise<Branch> {
    return toBranch(await this.scopes.getBranch(id));
  }

  @Post('branches')
  @HttpCode(HttpStatus.CREATED)
  async createBranch(
    @Body(new ZodValidationPipe(createBranchSchema)) body: CreateBranchBody,
  ): Promise<Branch> {
    return toBranch(await this.scopes.createBranch(body));
  }

  @Patch('branches/:id')
  async updateBranch(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateBranchSchema)) body: UpdateBranchBody,
    @IfMatch() version: number | undefined,
  ): Promise<Branch> {
    return toBranch(await this.scopes.updateBranch(id, body, version));
  }

  @Delete('branches/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteBranch(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.scopes.delete(OrganizationNodeKind.BRANCH, id, version);
  }

  @Post('branches/:id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restoreBranch(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.scopes.restore(OrganizationNodeKind.BRANCH, id, version);
  }

  // --- Departments -----------------------------------------------------------------------

  @Get('departments')
  async listDepartments(
    @Query(new ZodValidationPipe(departmentListQuerySchema))
    query: ReturnType<typeof departmentListQuerySchema.parse>,
  ): Promise<Collection<Department>> {
    return toCollection(await this.scopes.listDepartments(query), toDepartment);
  }

  @Get('departments/:id')
  async getDepartment(@Param('id') id: string): Promise<Department> {
    return toDepartment(await this.scopes.getDepartment(id));
  }

  @Post('departments')
  @HttpCode(HttpStatus.CREATED)
  async createDepartment(
    @Body(new ZodValidationPipe(createDepartmentSchema)) body: CreateDepartmentBody,
  ): Promise<Department> {
    return toDepartment(await this.scopes.createDepartment(body));
  }

  @Patch('departments/:id')
  async updateDepartment(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateDepartmentSchema)) body: UpdateDepartmentBody,
    @IfMatch() version: number | undefined,
  ): Promise<Department> {
    return toDepartment(await this.scopes.updateDepartment(id, body, version));
  }

  /**
   * Re-parenting, as its own action.
   *
   * Separate from `PATCH` because it is not a field edit: it rewrites the materialised path of the
   * whole subtree and publishes an event that invalidates permission caches. `PATCH` accepts
   * `parentId` too and routes it here, so a form can express both — but a move has a name, and the
   * audit trail records it as `MOVED` rather than as an ordinary update.
   */
  @Post('departments/:id/move')
  async moveDepartment(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(moveDepartmentSchema)) body: MoveDepartmentBody,
    @IfMatch() version: number | undefined,
  ): Promise<Department> {
    return toDepartment(await this.scopes.moveDepartment(id, body.parentId, version));
  }

  @Delete('departments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDepartment(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.scopes.delete(OrganizationNodeKind.DEPARTMENT, id, version);
  }

  @Post('departments/:id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restoreDepartment(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.scopes.restore(OrganizationNodeKind.DEPARTMENT, id, version);
  }
}
