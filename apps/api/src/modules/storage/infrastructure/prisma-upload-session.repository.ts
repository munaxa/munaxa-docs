import { Injectable } from '@nestjs/common';

import {
  UploadSessionState,
  type UploadSessionId,
  type UploadSessionStateKey,
  asId,
} from '@edms/domain';

import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { UploadSessionRecord, UploadSessionRepository } from '../application/ports';

/**
 * Uploads in flight.
 *
 * `settle` is the interesting one. It moves a session out of `OPEN` *conditionally* — the state is
 * part of the predicate, not only of the update — and reports whether this call was the one that
 * moved it. Completion creates a blob and bumps a reference count, so a client retrying a request
 * whose response it never saw must not do either twice, and a boolean from one statement is what
 * makes that decidable without a second read that could race.
 */
@Injectable()
export class PrismaUploadSessionRepository implements UploadSessionRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async findById(id: UploadSessionId): Promise<UploadSessionRecord | null> {
    const row = await requireTransaction().uploadSession.findFirst({
      where: { id, tenantId: this.tenantId() },
    });
    return row === null
      ? null
      : {
          id: asId<UploadSessionId>(row.id),
          filename: row.filename,
          declaredMimeType: row.declaredMimeType,
          declaredSizeBytes: Number(row.declaredSizeBytes),
          targetKey: row.targetKey,
          state: row.state,
          multipartUploadId: row.multipartUploadId,
          fileObjectId: row.fileObjectId,
          expiresAt: row.expiresAt,
          createdBy: row.createdBy,
        };
  }

  async insert(session: {
    id: string;
    filename: string;
    declaredMimeType: string;
    declaredSizeBytes: number;
    targetKey: string;
    multipartUploadId: string | null;
    expiresAt: Date;
  }): Promise<void> {
    await requireTransaction().uploadSession.create({
      data: {
        id: session.id,
        tenantId: this.tenantId(),
        filename: session.filename,
        declaredMimeType: session.declaredMimeType,
        declaredSizeBytes: BigInt(session.declaredSizeBytes),
        targetKey: session.targetKey,
        multipartUploadId: session.multipartUploadId,
        state: UploadSessionState.OPEN,
        expiresAt: session.expiresAt,
        ...this.stamps.creation(),
      },
    });
  }

  async settle(
    id: UploadSessionId,
    state: UploadSessionStateKey,
    fileObjectId: string | null,
  ): Promise<boolean> {
    const { count } = await requireTransaction().uploadSession.updateMany({
      // `state: OPEN` in the predicate is what makes this a claim rather than an assignment.
      where: { id, tenantId: this.tenantId(), state: UploadSessionState.OPEN },
      data: { state, fileObjectId, ...this.stamps.update() },
    });
    return count === 1;
  }

  /**
   * Expires sessions nobody finished.
   *
   * The bytes they may have written are swept separately, by key prefix, because a session that
   * expired says nothing about whether the client got as far as transferring anything — and a
   * sweeper that deleted only what sessions recorded would leave behind exactly the objects nobody
   * has a row for (`11-storage-architecture.md` §8).
   */
  async expireOlderThan(cutoff: Date): Promise<number> {
    const { count } = await requireTransaction().uploadSession.updateMany({
      where: {
        tenantId: this.tenantId(),
        state: UploadSessionState.OPEN,
        expiresAt: { lt: cutoff },
      },
      data: { state: UploadSessionState.EXPIRED, ...this.stamps.update() },
    });
    return count;
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}
