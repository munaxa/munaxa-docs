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
  type CreateFolderBody,
  type CreateLibraryBody,
  type Folder,
  type Library,
  type MoveFolderBody,
  type UpdateFolderBody,
  type UpdateLibraryBody,
  createFolderSchema,
  createLibrarySchema,
  folderListQuerySchema,
  libraryListQuerySchema,
  moveFolderSchema,
  updateFolderSchema,
  updateLibrarySchema,
} from '@edms/contracts';
import { Permission, ScopeType } from '@edms/domain';
import type { Page } from '@edms/utils';

import { RequirePermission, ScopedTo } from '../../../core/authorization/permission.decorator';
import { IfMatch } from '../../../core/http/admin-request';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { LIBRARY_ADMIN_SERVICE } from '../application/administration.ports';
import type { FolderRow, LibraryRow } from '../application/administration.ports';
import type { LibraryAdminService } from '../application/library-admin.service';

/**
 * Libraries and folders.
 *
 * Two controllers because they are two permissions: `library:manage` and `folder:manage` are separate
 * keys in the catalogue, and a library manager granted one on a node is frequently not meant to have
 * the other. Splitting them is what lets a class-level gate say the right thing.
 */
@Controller({ path: 'admin/libraries', version: '1' })
@RequirePermission(Permission.LIBRARY_MANAGE)
export class LibraryAdminController {
  constructor(@Inject(LIBRARY_ADMIN_SERVICE) private readonly libraries: LibraryAdminService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(libraryListQuerySchema))
    query: ReturnType<typeof libraryListQuerySchema.parse>,
  ): Promise<Collection<Library>> {
    return collection(await this.libraries.listLibraries(query), toLibrary);
  }

  @Get(':id')
  @ScopedTo('id', ScopeType.LIBRARY)
  async get(@Param('id') id: string): Promise<Library> {
    return toLibrary(await this.libraries.getLibrary(id));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createLibrarySchema)) body: CreateLibraryBody,
  ): Promise<Library> {
    return toLibrary(await this.libraries.createLibrary(body));
  }

  @Patch(':id')
  @ScopedTo('id', ScopeType.LIBRARY)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateLibrarySchema)) body: UpdateLibraryBody,
    @IfMatch() version: number | undefined,
  ): Promise<Library> {
    return toLibrary(await this.libraries.updateLibrary(id, body, version));
  }

  @Delete(':id')
  @ScopedTo('id', ScopeType.LIBRARY)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.libraries.deleteLibrary(id, version);
  }

  @Post(':id/restore')
  @ScopedTo('id', ScopeType.LIBRARY)
  @HttpCode(HttpStatus.NO_CONTENT)
  async restore(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.libraries.restoreLibrary(id, version);
  }
}

@Controller({ path: 'admin/folders', version: '1' })
@RequirePermission(Permission.FOLDER_MANAGE)
export class FolderAdminController {
  constructor(@Inject(LIBRARY_ADMIN_SERVICE) private readonly libraries: LibraryAdminService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(folderListQuerySchema))
    query: ReturnType<typeof folderListQuerySchema.parse>,
  ): Promise<Collection<Folder>> {
    return collection(await this.libraries.listFolders(query), toFolder);
  }

  @Get(':id')
  @ScopedTo('id', ScopeType.FOLDER)
  async get(@Param('id') id: string): Promise<Folder> {
    return toFolder(await this.libraries.getFolder(id));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createFolderSchema)) body: CreateFolderBody,
  ): Promise<Folder> {
    return toFolder(await this.libraries.createFolder(body));
  }

  @Patch(':id')
  @ScopedTo('id', ScopeType.FOLDER)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateFolderSchema)) body: UpdateFolderBody,
    @IfMatch() version: number | undefined,
  ): Promise<Folder> {
    return toFolder(await this.libraries.updateFolder(id, body, version));
  }

  @Post(':id/move')
  @ScopedTo('id', ScopeType.FOLDER)
  async move(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(moveFolderSchema)) body: MoveFolderBody,
    @IfMatch() version: number | undefined,
  ): Promise<Folder> {
    return toFolder(await this.libraries.moveFolder(id, body.parentId, version));
  }

  /**
   * Soft-deletes a folder and everything under it.
   *
   * Returns the count rather than no content, because a cascade that removed twelve folders and said
   * nothing is a cascade nobody can confirm went as expected.
   */
  @Delete(':id')
  @ScopedTo('id', ScopeType.FOLDER)
  async remove(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<{ foldersRemoved: number }> {
    return { foldersRemoved: await this.libraries.deleteFolder(id, version) };
  }

  @Post(':id/restore')
  @ScopedTo('id', ScopeType.FOLDER)
  async restore(
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
  ): Promise<{ foldersRestored: number }> {
    return { foldersRestored: await this.libraries.restoreFolder(id, version) };
  }
}

// --- Mappers ------------------------------------------------------------------------------

interface Stamps {
  readonly id: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
}

function stamps(
  row: Stamps,
): Pick<
  Library,
  | 'id'
  | 'version'
  | 'createdAt'
  | 'createdBy'
  | 'updatedAt'
  | 'updatedBy'
  | 'deletedAt'
  | 'deletedBy'
> {
  return {
    id: row.id,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    deletedBy: row.deletedBy,
  };
}

function toLibrary(row: LibraryRow): Library {
  return {
    ...stamps(row),
    code: row.code,
    name: row.name,
    description: row.description,
    ownerScopeType: row.ownerScopeType,
    ownerScopeId: row.ownerScopeId,
    ownerScopeName: row.ownerScopeName,
    rootFolderId: row.rootFolderId,
    folderCount: row.folderCount,
  };
}

function toFolder(row: FolderRow): Folder {
  return {
    ...stamps(row),
    libraryId: row.libraryId,
    libraryName: row.libraryName,
    parentId: row.parentId,
    name: row.name,
    description: row.description,
    path: row.path,
    depth: row.depth,
    inheritAcl: row.inheritAcl,
    isRoot: row.isRoot,
    childCount: row.childCount,
  };
}

function collection<TRow, TItem>(page: Page<TRow>, map: (row: TRow) => TItem): Collection<TItem> {
  return { data: page.data.map(map), meta: page.meta };
}
