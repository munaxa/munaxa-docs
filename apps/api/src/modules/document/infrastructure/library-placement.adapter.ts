import { Inject, Injectable } from '@nestjs/common';

import { LIBRARY_ADMIN_SERVICE } from '../../library/application/administration.ports';
import type { LibraryAdminService } from '../../library/application/library-admin.service';
import type { DocumentPlacement, FolderPlacement } from '../application/placement.port';

/**
 * Where a document may sit, answered by Library.
 *
 * Through Library's application service, never by reading `folder`. The folder tree is the chain
 * the ACL resolver walks, so a second reader of it in this module would be a second opinion about
 * where a document sits and therefore about who may see it.
 *
 * A folder that does not exist, is deleted, or belongs to another tenant all answer `null`. That
 * they are indistinguishable is the point: "no such folder" and "not yours" must read identically,
 * or the difference between them is a way to enumerate another tenant's tree.
 */
@Injectable()
export class LibraryPlacementAdapter implements DocumentPlacement {
  constructor(@Inject(LIBRARY_ADMIN_SERVICE) private readonly libraries: LibraryAdminService) {}

  async folder(id: string): Promise<FolderPlacement | null> {
    try {
      const folder = await this.libraries.getFolder(id);
      if (folder.deletedAt !== null) {
        return null;
      }
      return {
        id: folder.id,
        name: folder.name,
        path: folder.path,
        libraryId: folder.libraryId,
        libraryName: folder.libraryName,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'NOT_FOUND'
  );
}
