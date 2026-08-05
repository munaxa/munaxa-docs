import { Inject, Injectable } from '@nestjs/common';

import { type FileObjectId, asId } from '@edms/domain';

import { STORAGE_SERVICE, type StorageService } from '../../storage/application/ports';
import type { AttachableFile, DocumentContentGate } from '../application/ports';

/**
 * Document's four questions about bytes, answered by Storage.
 *
 * Narrower than `StorageService` on purpose, and the narrowing is the security property rather
 * than tidiness. Document may ask whether a blob can be attached, take a reference on it, give one
 * back, and get a link to it. It may not create an upload, complete one, or delete a blob — those
 * belong to the module that owns the bytes, and a document use case able to delete a blob is a
 * document use case able to delete another document's content.
 *
 * The gate itself — content is unreachable unless the verdict is `CLEAN` — is not applied here. It
 * is applied by the caller, which can produce a sentence a person reads, and again by a database
 * trigger, which still holds when the caller is a repair script. This adapter reports the verdict
 * and decides nothing.
 */
@Injectable()
export class StorageContentGateAdapter implements DocumentContentGate {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: StorageService) {}

  async describe(fileObjectId: string): Promise<AttachableFile | null> {
    const file = await this.storage.get(asId<FileObjectId>(fileObjectId));
    if (file === null || file.derived) {
      // A derived artefact is a thumbnail or a rendition. It is regenerable, excluded from quota
      // and purged with its source, and a document whose *content* was one would be a document
      // whose content the preview pipeline is free to delete.
      return null;
    }
    return {
      fileObjectId: file.id,
      checksumSha256: file.checksumSha256,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
      scanStatus: file.scanStatus,
    };
  }

  async storeManifest(input: { readonly content: Buffer; readonly mimeType: string }): Promise<{
    readonly fileObjectId: string;
    readonly sizeBytes: number;
    readonly checksumSha256: string;
  }> {
    // `storeDerived` rather than `storeStreamed`: a manifest is one line per document and is
    // content-addressed, so two identical releases are one blob — which is the same property that
    // makes a thumbnail free, applied to an artefact that is genuinely small.
    const stored = await this.storage.storeDerived(input);
    return {
      fileObjectId: stored.id,
      sizeBytes: stored.sizeBytes,
      checksumSha256: stored.checksumSha256,
    };
  }

  reference(fileObjectId: string): Promise<void> {
    return this.storage.reference(asId<FileObjectId>(fileObjectId));
  }

  dereference(fileObjectId: string): Promise<void> {
    return this.storage.dereference(asId<FileObjectId>(fileObjectId));
  }

  downloadUrl(
    fileObjectId: string,
    filename: string,
    options: { inline?: boolean } = {},
  ): Promise<{ url: string; expiresAt: Date }> {
    return this.storage.createDownloadUrl(asId<FileObjectId>(fileObjectId), filename, options);
  }
}
