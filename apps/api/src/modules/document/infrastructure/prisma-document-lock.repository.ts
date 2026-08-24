import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  type DocumentId,
  DocumentLockReleaseReason,
  type DocumentLockReleaseReasonKey,
  type UserId,
  asId,
} from '@edms/domain';

import { DocumentLockedError } from '../../../core/errors/application-errors';
import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { DocumentLockRepository, LockRecord } from '../application/ports';

/**
 * The check-out lock, in the database.
 *
 * `acquire` is the part worth reading: it is an insert against `uq_document_lock_live` and
 * nothing else. There is no `SELECT` first, because two check-outs racing is a
 * partial-unique-index question — the same shape as `uq_workflow_instance_live` — never a
 * read-then-check question: the check that ran a moment earlier is a moment old by the time
 * the insert runs. The index decides, and the loser's violation is translated into the same
 * refusal a polite pre-check would have produced, naming the holder.
 *
 * The lock order against the document row is fixed and stated in
 * `revision-control.service.ts`: the document row first, this table second. Every path that
 * touches both takes them in that order, which is what makes the pair deadlock-free.
 */
@Injectable()
export class PrismaDocumentLockRepository implements DocumentLockRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async acquire(input: {
    id: string;
    documentId: string;
    lockedBy: string;
    checkedOutRevisionId: string | null;
    acquiredAt: Date;
    expiresAt: Date;
  }): Promise<LockRecord> {
    try {
      const row = await requireTransaction().documentLock.create({
        data: {
          id: input.id,
          tenantId: this.tenantId(),
          documentId: input.documentId,
          lockedBy: input.lockedBy,
          checkedOutRevisionId: input.checkedOutRevisionId,
          acquiredAt: input.acquiredAt,
          expiresAt: input.expiresAt,
          ...this.stamps.creation(),
        },
      });
      return toRecord(row);
    } catch (error) {
      if (isLiveLockViolation(error)) {
        // Somebody else's insert committed between whatever this transaction read and now.
        // Name the holder — a refusal that does not say who is a refusal nobody can act on.
        const holder = await this.liveFor(asId<DocumentId>(input.documentId));
        throw new DocumentLockedError(
          holder?.lockedBy ?? 'unknown',
          holder?.expiresAt ?? input.expiresAt,
        );
      }
      throw error;
    }
  }

  async liveFor(documentId: DocumentId): Promise<LockRecord | null> {
    const row = await requireTransaction().documentLock.findFirst({
      where: { documentId, tenantId: this.tenantId(), releasedAt: null },
    });
    return row === null ? null : toRecord(row);
  }

  async releaseExpired(documentId: DocumentId, now: Date): Promise<LockRecord | null> {
    const tx = requireTransaction();
    const live = await tx.documentLock.findFirst({
      where: { documentId, tenantId: this.tenantId(), releasedAt: null },
    });
    if (live === null || live.expiresAt > now) {
      return null;
    }
    // `releasedAt: null` stays in the predicate: if a concurrent release got there first, this
    // matches nothing and the caller proceeds against a document that is simply unlocked.
    const { count } = await tx.documentLock.updateMany({
      where: { id: live.id, tenantId: this.tenantId(), releasedAt: null },
      data: {
        releasedAt: now,
        releasedBy: null,
        releaseReason: DocumentLockReleaseReason.EXPIRED,
        ...this.stamps.update(),
        version: { increment: 1 },
      },
    });
    return count === 0 ? null : toRecord(live);
  }

  async release(input: {
    lockId: string;
    reason: DocumentLockReleaseReasonKey;
    releasedBy: string | null;
    releaseNote: string | null;
    at: Date;
  }): Promise<boolean> {
    // `releasedAt: null` in the predicate and the affected-row count as the answer — `settle`'s
    // idiom, for `settle`'s reason. A lock somebody else ended a moment ago matches nothing, and
    // the caller must not go on to say it ended the check-out.
    const { count } = await requireTransaction().documentLock.updateMany({
      where: { id: input.lockId, tenantId: this.tenantId(), releasedAt: null },
      data: {
        releasedAt: input.at,
        releasedBy: input.releasedBy,
        releaseReason: input.reason,
        releaseNote: input.releaseNote,
        ...this.stamps.update(),
        version: { increment: 1 },
      },
    });
    return count === 1;
  }

  async attachDraft(lockId: string, revisionId: string | null): Promise<void> {
    await requireTransaction().documentLock.updateMany({
      where: { id: lockId, tenantId: this.tenantId(), releasedAt: null },
      data: { draftRevisionId: revisionId, ...this.stamps.update(), version: { increment: 1 } },
    });
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

/** The one violation `acquire` translates; anything else is a genuine failure. */
function isLiveLockViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

interface LockRow {
  id: string;
  documentId: string;
  lockedBy: string;
  checkedOutRevisionId: string | null;
  draftRevisionId: string | null;
  acquiredAt: Date;
  expiresAt: Date;
  releasedAt: Date | null;
}

function toRecord(row: LockRow): LockRecord {
  return {
    id: row.id,
    documentId: asId<DocumentId>(row.documentId),
    lockedBy: asId<UserId>(row.lockedBy),
    checkedOutRevisionId: row.checkedOutRevisionId,
    draftRevisionId: row.draftRevisionId,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
    releasedAt: row.releasedAt,
  };
}
