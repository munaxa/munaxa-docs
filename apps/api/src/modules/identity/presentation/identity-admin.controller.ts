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
  Put,
  Query,
} from '@nestjs/common';

import {
  type Collection,
  type CreateRoleBody,
  type CreateUserBody,
  type PermissionCatalogue,
  type Role,
  type SetUserPasswordBody,
  type UpdateRoleBody,
  type UpdateUserBody,
  type User,
  createRoleSchema,
  createUserSchema,
  roleListQuerySchema,
  setUserPasswordSchema,
  updateRoleSchema,
  updateUserSchema,
  userListQuerySchema,
} from '@edms/contracts';
import { Permission, UserStatus } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { IfMatch } from '../../../core/http/admin-request';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { ROLE_ADMIN_SERVICE, USER_ADMIN_SERVICE } from '../application/administration.ports';
import type { RoleAdminService } from '../application/role-admin.service';
import type { UserAdminService } from '../application/user-admin.service';
import { toCollection, toPermissionCatalogue, toRole, toUser } from './identity-admin.view';

/**
 * People and access.
 *
 * Two controllers rather than one, because they carry **different permissions**: `user:manage` and
 * `role:manage` are separate keys in the catalogue and separate rows in the matrix — only the tenant
 * administrator holds either — and a single controller would have to gate per method, which is
 * exactly the arrangement a boot-time assertion cannot check as cleanly.
 */
@Controller({ path: 'admin/users', version: '1' })
@RequirePermission(Permission.USER_MANAGE)
export class UserAdminController {
  constructor(@Inject(USER_ADMIN_SERVICE) private readonly users: UserAdminService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(userListQuerySchema))
    query: ReturnType<typeof userListQuerySchema.parse>,
  ): Promise<Collection<User>> {
    return toCollection(await this.users.list(query), toUser);
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<User> {
    return toUser(await this.users.get(id));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body(new ZodValidationPipe(createUserSchema)) body: CreateUserBody): Promise<User> {
    return toUser(await this.users.create(body));
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserBody,
    @IfMatch() version: number | undefined,
  ): Promise<User> {
    return toUser(await this.users.update(id, body, version));
  }

  /**
   * Sets a password. `PUT`, because it replaces a single sub-resource and is idempotent.
   *
   * Returns no content on purpose: there is nothing to say that the caller should keep, and a
   * response body from this endpoint is a body that could end up in a log.
   */
  @Put(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setPassword(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setUserPasswordSchema)) body: SetUserPasswordBody,
    @IfMatch() version: number | undefined,
  ): Promise<void> {
    await this.users.setPassword(id, body.password, version);
  }

  @Post(':id/activate')
  async activate(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<User> {
    return toUser(await this.users.setStatus(id, UserStatus.ACTIVE, version));
  }

  @Post(':id/disable')
  async disable(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<User> {
    return toUser(await this.users.setStatus(id, UserStatus.DISABLED, version));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.users.delete(id, version);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restore(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.users.restore(id, version);
  }
}

@Controller({ path: 'admin/roles', version: '1' })
@RequirePermission(Permission.ROLE_MANAGE)
export class RoleAdminController {
  constructor(@Inject(ROLE_ADMIN_SERVICE) private readonly roles: RoleAdminService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(roleListQuerySchema))
    query: ReturnType<typeof roleListQuerySchema.parse>,
  ): Promise<Collection<Role>> {
    return toCollection(await this.roles.list(query), toRole);
  }

  /**
   * The permission catalogue.
   *
   * A sub-resource of roles rather than a top-level one, because it exists to be rendered *beside*
   * them: the matrix editor needs the rows and the columns in the same screen. Reads no database.
   */
  @Get('permissions')
  catalogue(): PermissionCatalogue {
    return toPermissionCatalogue(this.roles.catalogue());
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<Role> {
    return toRole(await this.roles.get(id));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body(new ZodValidationPipe(createRoleSchema)) body: CreateRoleBody): Promise<Role> {
    return toRole(await this.roles.create(body));
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) body: UpdateRoleBody,
    @IfMatch() version: number | undefined,
  ): Promise<Role> {
    return toRole(await this.roles.update(id, body, version));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.roles.delete(id, version);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restore(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.roles.restore(id, version);
  }
}
