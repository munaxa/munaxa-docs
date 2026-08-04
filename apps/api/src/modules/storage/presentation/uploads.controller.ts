import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from '@nestjs/common';

import {
  type CompleteUploadBody,
  type CompletedUpload,
  type CreateUploadBody,
  type UploadTarget,
  completeUploadSchema,
  createUploadSchema,
} from '@edms/contracts';
import { Permission, type UploadSessionId, asId } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { STORAGE_SERVICE, type StorageService } from '../application/ports';

/**
 * The upload handshake.
 *
 * Three endpoints and no bytes. The client asks for a target, transfers straight to storage, then
 * says it is done — so a 2 GB drawing never occupies an application process and the API stays
 * stateless (`11-storage-architecture.md` §4).
 *
 * Gated on `document:create` rather than a permission of its own. An upload is not a thing anybody
 * wants for its own sake: it exists to become a document, and a person who may not create one has
 * no use for a target. A separate `upload:*` permission would be a permission every role that can
 * create a document must also be granted, which is a permission that adds a way to get it wrong
 * and no way to express anything new.
 */
@Controller({ path: 'uploads', version: '1' })
@RequirePermission(Permission.DOCUMENT_CREATE)
export class UploadsController {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: StorageService) {}

  /**
   * Validates the file and issues a target — or says the bytes are already here.
   *
   * Everything that can refuse this upload runs before a byte is stored: the declared type against
   * the allow-list, the declared type against the leading bytes, and the size against the ceiling
   * for whatever the bytes turned out to be. A refusal costs the person a round trip rather than a
   * transfer.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createUploadSchema)) body: CreateUploadBody,
  ): Promise<UploadTarget> {
    const issued = await this.storage.createUploadSession({
      filename: body.filename,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      magicBytes: new Uint8Array(Buffer.from(body.magicBytes, 'base64')),
      ...(body.checksumSha256 !== undefined && { checksumSha256: body.checksumSha256 }),
    });
    return {
      uploadSessionId: issued.uploadSessionId,
      url: issued.url,
      method: issued.method,
      headers: issued.headers,
      expiresAt: issued.expiresAt.toISOString(),
      parts: issued.parts === null ? null : issued.parts.map((part) => ({ ...part })),
      alreadyStored: issued.alreadyStored,
    };
  }

  /**
   * Confirms the transfer and creates the blob.
   *
   * The answer carries the scan verdict, and a client that reads `scanStatus` other than `CLEAN`
   * is being told the truth rather than given an error: the bytes are stored, they are not
   * reachable, and attaching them to a document will be refused. Reporting that as a failure would
   * suggest the upload should be retried, which would store the same infected file again.
   */
  @Post(':id/complete')
  async complete(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(completeUploadSchema)) body: CompleteUploadBody,
  ): Promise<CompletedUpload> {
    const completed = await this.storage.completeUploadSession(
      asId<UploadSessionId>(id),
      body.parts,
    );
    return {
      fileObjectId: completed.fileObjectId,
      checksumSha256: completed.checksumSha256,
      sizeBytes: completed.sizeBytes,
      mimeType: completed.mimeType,
      scanStatus: completed.scanStatus,
      deduplicated: completed.deduplicated,
    };
  }

  /**
   * Abandons an upload the client is not going to finish.
   *
   * Optional — a session nobody settles expires and is swept — but worth having: a person who
   * cancels a 2 GB transfer should not leave bytes sitting in staging for a day, and the client
   * knows it cancelled long before the sweeper does.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async abandon(@Param('id') id: string): Promise<void> {
    await this.storage.abandonUploadSession(asId<UploadSessionId>(id));
  }
}
