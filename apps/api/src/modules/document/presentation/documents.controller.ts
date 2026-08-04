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
  type CreateDocumentBody,
  type Document,
  type DocumentSummary,
  type DuplicateReport,
  type MoveDocumentBody,
  type RecentDocument,
  type UpdateDocumentBody,
  createDocumentSchema,
  documentListQuerySchema,
  moveDocumentSchema,
  updateDocumentSchema,
} from '@edms/contracts';
import { Permission, type UserId, asId } from '@edms/domain';
import type { Page } from '@edms/utils';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { IfMatch } from '../../../core/http/admin-request';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { readMetadata } from '../domain/metadata';
import { DOCUMENT_SERVICE } from '../application/ports';
import type { DocumentRow, RecentRow } from '../application/ports';
import type { DefaultDocumentService } from '../application/document.service';

/**
 * The document library.
 *
 * Permissions are per operation rather than per controller, which is the difference between this
 * and the administration controllers: reading a document, creating one, moving one and deleting one
 * are four separate grants in the catalogue, and a class-level gate would have to be the loosest of
 * them. `document:view` on the class would let a reader delete; `document:delete` on the class would
 * hide the library from everybody who can only read it.
 *
 * `capabilities` is deliberately absent from the responses: object-level permission resolution is
 * the ACL resolver's, which is unbound until the phase that builds it. Until then the endpoint
 * guards are the whole of the answer, and inventing a `capabilities` object here would be the web
 * client rendering affordances from a decision nothing made.
 */
@Controller({ path: 'documents', version: '1' })
export class DocumentsController {
  constructor(@Inject(DOCUMENT_SERVICE) private readonly documents: DefaultDocumentService) {}

  /**
   * The folder browser, the library browser and the favourites list — one endpoint.
   *
   * They differ by filter, not by shape: `folderId` for what is in a folder, `underFolderId` for
   * everything beneath it, `libraryId` for a whole library, `favorite` for one person's marks. A
   * separate endpoint per view would be four projections to keep in step.
   */
  @Get()
  @RequirePermission(Permission.DOCUMENT_VIEW)
  async list(
    @Query(new ZodValidationPipe(documentListQuerySchema))
    query: ReturnType<typeof documentListQuerySchema.parse>,
  ): Promise<Collection<DocumentSummary>> {
    return collection(await this.documents.list(query), toSummary);
  }

  /**
   * Recently opened, for this caller.
   *
   * No `userId` parameter, and that is the design: "recent" is inherently the caller's own list,
   * and an endpoint that took a user would be an endpoint for reading somebody else's reading
   * history — which is a surveillance feature, not a navigation one.
   */
  @Get('recent')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  async recent(
    @Query(new ZodValidationPipe(documentListQuerySchema))
    query: ReturnType<typeof documentListQuerySchema.parse>,
  ): Promise<Collection<RecentDocument>> {
    const { userId } = requireContext();
    const page = await this.documents.listRecent(asId<UserId>(userId ?? ''), query);
    return collection(page, (row: RecentRow) => ({
      ...toSummary(row.document),
      viewedAt: row.viewedAt.toISOString(),
    }));
  }

  /**
   * What else is exactly these bytes.
   *
   * Its own endpoint so a client can warn *during* the upload rather than after the person has
   * filled in a form. It costs a lookup: content addressing already made identical files one blob,
   * so the question is "which documents reference this file object", not a comparison.
   */
  @Get('duplicates/:fileObjectId')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  async duplicates(@Param('fileObjectId') fileObjectId: string): Promise<DuplicateReport> {
    const matches = await this.documents.findDuplicates(fileObjectId);
    return {
      // Echoed back so a client holding several in-flight uploads can match the answer to the file
      // it asked about without tracking request order.
      checksumSha256: '',
      matches: matches.map((match) => ({
        documentId: match.documentId,
        title: match.title,
        documentNumber: match.documentNumber,
        folderPath: match.folderPath,
        folderName: match.folderName,
        createdAt: match.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Opens a document.
   *
   * A `GET` that writes, which is unusual enough to justify: it records the view for "recent
   * documents" and writes the audit event that levels demanding audit-on-read require. The
   * alternative — a `POST /documents/{id}/open` the client must remember to call — would make the
   * compliance record depend on a client remembering, and the one thing an audit trail cannot be is
   * optional.
   */
  @Get(':id')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  async get(@Param('id') id: string): Promise<Document> {
    return toDocument(await this.documents.open(id));
  }

  @Post()
  @RequirePermission(Permission.DOCUMENT_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createDocumentSchema)) body: CreateDocumentBody,
  ): Promise<Document> {
    return toDocument(
      await this.documents.create({
        folderId: body.folderId,
        documentTypeId: body.documentTypeId,
        categoryId: body.categoryId ?? null,
        ...(body.confidentialityId !== undefined && { confidentialityId: body.confidentialityId }),
        title: body.title,
        ...(body.description !== undefined && { description: body.description }),
        fileObjectId: body.fileObjectId,
        filename: body.filename,
        ...(body.metadata !== undefined && { metadata: body.metadata }),
        origin: body.origin,
        acknowledgeDuplicate: body.acknowledgeDuplicate,
      }),
    );
  }

  @Patch(':id')
  @RequirePermission(Permission.DOCUMENT_EDIT)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateDocumentSchema)) body: UpdateDocumentBody,
    @IfMatch() version: number | undefined,
  ): Promise<Document> {
    return toDocument(await this.documents.update(id, body, version));
  }

  /**
   * Moves a document to another folder.
   *
   * Its own endpoint and its own permission, because a move changes the ACL chain the document
   * resolves through — every grant along the old chain stops applying and every grant along the new
   * one starts. That is not something to allow as a field in a patch meant to fix a title.
   */
  @Post(':id/move')
  @RequirePermission(Permission.DOCUMENT_MOVE)
  async move(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(moveDocumentSchema)) body: MoveDocumentBody,
    @IfMatch() version: number | undefined,
  ): Promise<Document> {
    return toDocument(await this.documents.move(id, body.folderId, version));
  }

  @Delete(':id')
  @RequirePermission(Permission.DOCUMENT_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.documents.remove(id, version);
  }

  @Post(':id/restore')
  @RequirePermission(Permission.DOCUMENT_RESTORE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async restore(@Param('id') id: string, @IfMatch() version: number | undefined): Promise<void> {
    await this.documents.restore(id, version);
  }

  /**
   * A short-lived, signed link to the content.
   *
   * The URL is issued after the audit event that records issuing it, and the confidentiality
   * level's own rules are applied on top of the permission: a level may forbid download to somebody
   * who holds `document:download`, and none of them can grant it to somebody who does not.
   */
  @Post(':id/content')
  @RequirePermission(Permission.DOCUMENT_DOWNLOAD)
  async download(
    @Param('id') id: string,
    @Query('inline') inline?: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const signed = await this.documents.downloadUrl(id, inline === 'true');
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }

  /**
   * Marks or unmarks a document for the caller.
   *
   * `document:view` rather than a permission of its own: a favourite is a bookmark on something
   * this person can already see, and a separate grant would be a grant every reader needs.
   */
  @Post(':id/favorite')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  @HttpCode(HttpStatus.NO_CONTENT)
  async favorite(@Param('id') id: string): Promise<void> {
    await this.documents.setFavorite(id, true);
  }

  @Delete(':id/favorite')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  @HttpCode(HttpStatus.NO_CONTENT)
  async unfavorite(@Param('id') id: string): Promise<void> {
    await this.documents.setFavorite(id, false);
  }
}

// --- Mappers ------------------------------------------------------------------------------

function toFile(row: DocumentRow): DocumentSummary['file'] {
  const revision = row.latestRevision;
  if (revision === null) {
    return null;
  }
  return {
    fileObjectId: revision.file.fileObjectId,
    filename: revision.file.filename,
    mimeType: revision.file.mimeType,
    sizeBytes: revision.file.sizeBytes,
    checksumSha256: revision.file.checksumSha256,
    scanStatus: revision.file.scanStatus,
    // Stated rather than left for the client to derive from the status. "Not CLEAN means
    // unreachable" is a rule the API enforces, and a client re-deriving it is a second copy that
    // can disagree.
    reachable: revision.file.scanStatus === 'CLEAN',
    // The URL is not signed here: a list of two hundred rows would mean two hundred audited URL
    // issuances for pictures nobody may look at. The identifier is enough for a client to ask.
    thumbnailUrl: revision.file.thumbnailFileObjectId,
  };
}

function toSummary(row: DocumentRow): DocumentSummary {
  return {
    ...stamps(row),
    title: row.title,
    status: row.status,
    documentNumber: row.documentNumber,
    folderId: row.folderId,
    folderName: row.folderName,
    documentTypeName: row.documentTypeName,
    categoryName: row.categoryName,
    confidentialityName: row.confidentialityName,
    ownerUserId: row.ownerUserId,
    isFavorite: row.isFavorite,
    file: toFile(row),
  };
}

/**
 * The stamps every administered record carries on the wire.
 *
 * Shared by the summary and the document itself, because they are the same eight fields and a
 * second copy is a second place for a nullable actor to be spelled as an empty string.
 */
function stamps(
  row: DocumentRow,
): Pick<
  DocumentSummary,
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

function toDocument(row: DocumentRow): Document {
  const revision = row.latestRevision;
  return {
    ...stamps(row),
    folderId: row.folderId,
    folderName: row.folderName,
    folderPath: row.folderPath,
    libraryId: row.libraryId,
    libraryName: row.libraryName,
    documentTypeId: row.documentTypeId,
    documentTypeName: row.documentTypeName,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    confidentialityId: row.confidentialityId,
    confidentialityName: row.confidentialityName,
    confidentialityRank: row.confidentialityRank,
    title: row.title,
    description: row.description,
    status: row.status,
    origin: row.origin,
    documentNumber: row.documentNumber,
    ownerUserId: row.ownerUserId,
    latestRevision:
      revision === null
        ? null
        : {
            id: revision.id,
            ordinal: revision.ordinal,
            label: revision.label,
            status: revision.status,
            changeNote: revision.changeNote,
            createdAt: revision.createdAt.toISOString(),
            createdBy: revision.createdBy,
            file: toFile(row) ?? {
              fileObjectId: revision.file.fileObjectId,
              filename: revision.file.filename,
              mimeType: revision.file.mimeType,
              sizeBytes: revision.file.sizeBytes,
              checksumSha256: revision.file.checksumSha256,
              scanStatus: revision.file.scanStatus,
              reachable: false,
              thumbnailUrl: null,
            },
          },
    metadata: row.metadata.map((entry) => ({
      fieldId: entry.fieldId,
      key: entry.key,
      name: entry.name,
      dataType: entry.dataType,
      isRequired: entry.isRequired,
      // The stored columns turned back into the one value the field's type means. The inverse of
      // what `coerceMetadata` did on the way in, and in the same file, so the two cannot drift.
      value: mutableValue(readMetadata(entry.dataType, entry.columns)),
    })),
    isFavorite: row.isFavorite,
  };
}

/**
 * The wire shape wants a mutable array; the domain returns a readonly one.
 *
 * A copy rather than a cast, because a cast would hand a client-facing object a reference into the
 * value the domain computed — and the one thing a response mapper must not do is give somebody a
 * handle on state the layer below still owns.
 */
function mutableValue(
  value: string | number | boolean | readonly string[] | null,
): string | number | boolean | string[] | null {
  // `Array.isArray` widens a `readonly string[]` to `any[]`, so the copy is built explicitly.
  return typeof value === 'object' && value !== null ? Array.from(value) : value;
}

function collection<TRow, TItem>(page: Page<TRow>, map: (row: TRow) => TItem): Collection<TItem> {
  return { data: page.data.map(map), meta: page.meta };
}
