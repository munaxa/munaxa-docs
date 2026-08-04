import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { FileObjectId, ScanStatusKey } from '@edms/domain';

import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { FileObjectRecord, FileObjectRepository, NewFileObject } from '../application/ports';

/**
 * Stored blobs, in the database.
 *
 * Two things here are not the usual repository shape, and both are about the reference count.
 *
 * **`adjustRefCount` is one statement, never read-modify-write.** Two revisions attaching the same
 * blob in two transactions would each read zero and each write one, and the blob would be deleted
 * at the first detachment while a document still pointed at it. `increment` is atomic under the
 * row lock the update takes, and the check constraint added in `03-content-gate.sql` refuses a
 * negative result — so drift is a failed statement rather than a missing file.
 *
 * **Nothing here soft-deletes.** A blob is removed by retention, at a reference count of zero,
 * after a grace period. There is no "delete this file" operation for a use case to call, because
 * there is no moment at which deleting bytes is the right response to a person's action — deleting
 * a document removes a reference, and what happens to the bytes is a policy decision made later.
 */
@Injectable()
export class PrismaFileObjectRepository implements FileObjectRepository {
  constructor(private readonly stamps: RecordStamps) {}

  async findById(id: FileObjectId): Promise<FileObjectRecord | null> {
    const row = await requireTransaction().fileObject.findFirst({
      where: { id, tenantId: this.tenantId(), deletedAt: null },
    });
    return row === null ? null : toRecord(row);
  }

  async findByChecksum(checksum: string): Promise<FileObjectRecord | null> {
    const row = await requireTransaction().fileObject.findFirst({
      // Within the tenant, always. Dedupe across tenants would let one customer's storage costs
      // and existence signals leak into another's, and under ADR-0015 the bytes are not even in
      // the same place — so a match here would name an object this tenant's prefix cannot address.
      where: { tenantId: this.tenantId(), checksumSha256: checksum, deletedAt: null },
    });
    return row === null ? null : toRecord(row);
  }

  async insert(file: NewFileObject): Promise<void> {
    await requireTransaction().fileObject.create({
      data: {
        id: file.id,
        tenantId: this.tenantId(),
        checksumSha256: file.checksumSha256,
        sizeBytes: BigInt(file.sizeBytes),
        mimeType: file.mimeType,
        storageKey: file.storageKey,
        storageDriver: file.storageDriver,
        scanStatus: file.scanStatus,
        scanner: file.scanner,
        scanThreat: file.scanThreat,
        ...(file.scanner !== null && { scannedAt: this.stamps.now() }),
        derived: file.derived,
        refCount: 0,
        ...this.stamps.creation(),
      },
    });
  }

  async recordScan(
    id: FileObjectId,
    verdict: { status: ScanStatusKey; scanner: string; threat: string | null; at: Date },
  ): Promise<void> {
    await requireTransaction().fileObject.updateMany({
      where: { id, tenantId: this.tenantId() },
      data: {
        scanStatus: verdict.status,
        scanner: verdict.scanner,
        scanThreat: verdict.threat,
        scannedAt: verdict.at,
        ...this.stamps.update(),
      },
    });
  }

  async adjustRefCount(id: FileObjectId, by: number): Promise<number> {
    const updated = await requireTransaction().fileObject.updateManyAndReturn({
      where: { id, tenantId: this.tenantId() },
      data: { refCount: { increment: by }, ...this.stamps.update() },
      select: { refCount: true },
    });
    const row = updated[0];
    if (row === undefined) {
      // Not a "not found" for the caller to handle: a reference is being recorded for a blob the
      // caller has just read inside this transaction, so its absence means the row went away
      // underneath a transaction that holds a lock on it — which cannot happen, and if it does,
      // continuing would leave a revision pointing at nothing.
      throw new Error(`No file object ${id} to reference in this tenant.`);
    }
    return row.refCount;
  }

  async listUnreferenced(limit: number): Promise<readonly FileObjectRecord[]> {
    const rows = await requireTransaction().fileObject.findMany({
      where: { tenantId: this.tenantId(), refCount: 0, deletedAt: null },
      orderBy: { createdAt: Prisma.SortOrder.asc },
      take: limit,
    });
    return rows.map(toRecord);
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

interface FileObjectRow {
  id: string;
  checksumSha256: string;
  sizeBytes: bigint;
  mimeType: string;
  storageKey: string;
  storageDriver: string;
  scanStatus: string;
  scanThreat: string | null;
  refCount: number;
  derived: boolean;
  createdAt: Date;
  createdBy: string | null;
}

function toRecord(row: FileObjectRow): FileObjectRecord {
  return {
    id: row.id as FileObjectId,
    checksumSha256: row.checksumSha256,
    // `bigint` in the column because a blob can legitimately exceed 2 GB; `number` above it because
    // `Number.MAX_SAFE_INTEGER` is nine petabytes and nothing in this product will store one file
    // that large. The narrowing is here, once, rather than at every call site.
    sizeBytes: Number(row.sizeBytes),
    mimeType: row.mimeType,
    storageKey: row.storageKey,
    storageDriver: row.storageDriver,
    scanStatus: row.scanStatus as ScanStatusKey,
    scanThreat: row.scanThreat,
    refCount: row.refCount,
    derived: row.derived,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}
