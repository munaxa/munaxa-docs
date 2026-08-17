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

  /**
   * Reading the libraries — `library:view`, which overrides the class's `library:manage`.
   *
   * **Phase 6.3, and the correction of a real gap rather than a tidy-up.** `library:view` has been
   * in the catalogue and in `08-permission-model.md` §6's matrix since Phase 1, granted to eight
   * roles, and enforced by nothing — Phase 6.0 found it by counting non-seed references and getting
   * zero. The reason it gated nothing is that the only route which lists libraries was gated on
   * `library:manage`, and the two are not the same decision.
   *
   * The consequence was demonstrable rather than theoretical. `AUDITOR` is seeded with
   * `library:view` and deliberately without `library:manage` — it *"reads everything in scope and
   * may never mutate anything"* — so an auditor could not list the libraries at all, and the
   * workspace document browser, which fetches this route to populate its library selector, showed
   * them nothing to browse.
   *
   * Reads move to `library:view`; every write below keeps `library:manage`. That is the boundary the
   * matrix always described.
   *
   * **One consequence, stated rather than left to be found:** a tenant that has hand-built a role
   * holding `library:manage` *without* `library:view` loses list access. Every seeded role that
   * holds manage also holds view, and §6's matrix grants view strictly more widely than manage, so
   * that combination is a misconfiguration rather than a supported shape — but it is a change, and
   * the guard requires *all* declared permissions rather than any, so it cannot be expressed as
   * "either".
   */
  @Get()
  @RequirePermission(Permission.LIBRARY_VIEW)
  async list(
    @Query(new ZodValidationPipe(libraryListQuerySchema))
    query: ReturnType<typeof libraryListQuerySchema.parse>,
  ): Promise<Collection<Library>> {
    return collection(await this.libraries.listLibraries(query), toLibrary);
  }

  @Get(':id')
  @RequirePermission(Permission.LIBRARY_VIEW)
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

  /**
   * Reading the structure, which is not the same capability as changing it.
   *
   * Phase 6.3 split the libraries controller this way and deliberately left the folder routes
   * alone: "two controllers because they are two permissions — a library manager granted one on a
   * node frequently is not meant to have the other." That reasoning is about the two *management*
   * grants, and it still holds — every mutation below keeps `folder:manage`. What it did not cover
   * is reading, and the consequence only became visible later.
   *
   * An auditor holds `document:view` and `library:view` and, by design, no management grant at all.
   * It could therefore open the document workspace, list the libraries — and then fail here, on the
   * request for the folder *names*. `adminList` throws on a 403 and a server component that cannot
   * load its data renders the route's error boundary, so the whole workspace was a dead page for
   * the one seeded role whose entire purpose is reading.
   *
   * A folder is the library's internal structure, so it reads with the permission that already
   * means "may see this library". No new permission: `folder:view` would have to be seeded, and
   * every custom role in every existing tenant would silently lack it.
   *
   * The audience does not widen. `library:view` is a tenant-wide grant — `AccessTokenClaims` says
   * so, and ACL reach is resolved per request rather than folded into the token — and the only
   * seeded roles holding it are the tenant administrator, the document controller and the auditor,
   * which is exactly the set that can already list the libraries these folders belong to.
   */
  @Get()
  @RequirePermission(Permission.LIBRARY_VIEW)
  async list(
    @Query(new ZodValidationPipe(folderListQuerySchema))
    query: ReturnType<typeof folderListQuerySchema.parse>,
  ): Promise<Collection<Folder>> {
    return collection(await this.libraries.listFolders(query), toFolder);
  }

  /**
   * The same read capability, and the scope check is untouched.
   *
   * Two questions, two layers: `RbacGuard` asks whether the caller has the structural-read
   * capability at all, and `ScopedTo` asks whether it reaches *this* folder. Relaxing the first
   * does not relax the second.
   */
  @Get(':id')
  @RequirePermission(Permission.LIBRARY_VIEW)
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
