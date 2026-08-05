import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { UploadSessionState } from '@edms/domain';

import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { STORAGE_PORT, type StoragePort } from '../../../ports/storage.port';
import type { BlobReaper, ReclaimableBlob } from '../../retention/application/ports';

/**
 * The only code in the product that removes bytes from storage.
 *
 * It implements Retention's `BLOB_REAPER` port, and it lives in Storage because Storage owns the
 * blobs — Retention decides *when*, this module performs — the same split as the disposition
 * adapter on the Document side. `StoragePort.delete` has been reachable and uncalled since Phase 3
 * for exactly this caller; `listUnreferenced`'s comment ("only retention calls this, and only at a
 * reference count of zero") stops being aspiration here.
 *
 * `reclaim` is deliberately paranoid: the reference count is re-checked *inside* the deleting
 * transaction with the row taken `FOR UPDATE`, because the listing ran earlier in somebody else's
 * snapshot. A revision attaching the blob between the two would have moved the count off zero, and
 * deleting the object then is how a live document loses its content. The row is soft-deleted in
 * the same transaction the object is removed in; if the store's delete fails, the row survives
 * with it and the next sweep retries.
 */
@Injectable()
export class StorageBlobReaper implements BlobReaper {
  constructor(
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly stamps: RecordStamps,
  ) {}

  async listReclaimable(before: Date, limit: number): Promise<readonly ReclaimableBlob[]> {
    const rows = await requireTransaction().fileObject.findMany({
      // `updated_at` moves with every reference adjustment, so "unchanged since the cutoff at a
      // count of zero" means "zero at least that long" — the grace period, measured without a
      // second timestamp column nothing else would read.
      where: {
        tenantId: this.tenantId(),
        refCount: 0,
        deletedAt: null,
        updatedAt: { lt: before },
      },
      orderBy: { createdAt: Prisma.SortOrder.asc },
      take: limit,
      select: { id: true, sizeBytes: true, derived: true },
    });
    return rows.map((row) => ({
      id: row.id,
      sizeBytes: Number(row.sizeBytes),
      derived: row.derived,
    }));
  }

  async reclaim(fileObjectId: string): Promise<boolean> {
    return this.unitOfWork.run(async () => {
      const tx = requireTransaction();
      const tenantId = this.tenantId();

      // The re-check, with the row locked so no reference can land between the read and the
      // delete. Raw because Prisma's findFirst cannot express FOR UPDATE.
      const rows = await tx.$queryRaw<{ id: string; storage_key: string }[]>`
        SELECT id, storage_key FROM file_object
        WHERE id = ${fileObjectId}::uuid AND tenant_id = ${tenantId}::uuid
          AND ref_count = 0 AND deleted_at IS NULL
        FOR UPDATE
      `;
      const row = rows[0];
      if (row === undefined) {
        return false;
      }

      // The bytes first, then the row, in one transaction: a failed delete keeps the row for the
      // next sweep, while the reverse order would be a row gone and bytes orphaned with nothing
      // left to name them.
      await this.storage.delete(row.storage_key);
      await tx.fileObject.updateMany({
        where: { id: fileObjectId, tenantId },
        data: { ...this.stamps.deletion() },
      });
      return true;
    });
  }

  /**
   * Expires abandoned upload sessions and removes their partial objects — the whole of
   * `storage.sweep-upload-sessions`, which has been in the schedule catalogue since Phase 0.5.
   *
   * The staging object goes with the state change: an abandoned upload's bytes were never
   * verified, never scanned and never referenced, and a staging area that only ever grows is the
   * leak the session row was invented to prevent.
   */
  async expireUploadSessions(now: Date): Promise<number> {
    return this.unitOfWork.run(async () => {
      const tx = requireTransaction();
      const tenantId = this.tenantId();

      const sessions = await tx.uploadSession.findMany({
        where: { tenantId, state: UploadSessionState.OPEN, expiresAt: { lt: now } },
        select: { id: true, targetKey: true },
      });
      if (sessions.length === 0) {
        return 0;
      }

      for (const session of sessions) {
        try {
          await this.storage.delete(session.targetKey);
        } catch (error) {
          // Best effort per object: most abandoned sessions never wrote a byte, so "nothing to
          // delete" is the common answer and not a failure. Logged so a store that is genuinely
          // refusing deletes is visible rather than silently retried forever.
          this.logger.warn('Could not remove an abandoned upload object', {
            uploadSessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const { count } = await tx.uploadSession.updateMany({
        where: { id: { in: sessions.map((session) => session.id) }, tenantId },
        data: { state: UploadSessionState.EXPIRED, ...this.stamps.update() },
      });
      return count;
    });
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}
