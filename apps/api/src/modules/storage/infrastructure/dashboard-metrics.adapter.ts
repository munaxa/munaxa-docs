import { Injectable } from '@nestjs/common';

import type { DashboardStorageMetrics, StorageUsage } from '../../dashboard/application/ports';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';

/**
 * What the dashboard needs from Storage, answered by Storage.
 *
 * **Three figures, and the third is the reason the tile is worth having.** `storedBytes` is what
 * the tenant's blobs occupy. `referencedBytes` is what they would occupy if every revision and
 * every preview artefact held its own copy. The gap between them is what content addressing saved
 * (ADR-0007), and it is the only claim about storage this product can currently make that is
 * arithmetic over rows rather than a policy.
 *
 * **There is no fourth figure.** Phase 10 recorded "no quota accounting" as a deliberate limit and
 * nothing since has lifted it: `file_object` knows what a tenant *holds*, and no table anywhere
 * knows what a tenant is *entitled to*. A "72% of your quota" tile would have to invent that
 * denominator, and inventing it here would put an entitlement in the storage module rather than in
 * ADR-0012's data model — where Phase 21 will have to enforce it against billing, plan changes and
 * overage, none of which a dashboard tile can know about.
 *
 * `sizeBytes` is `BigInt` in the schema, because a tenant's total will exceed 2^53 long before its
 * row count exceeds anything else. It is narrowed to `number` at this boundary and the sum is
 * computed in the database rather than in JavaScript, so the widening only ever happens once, on a
 * total that has already been reduced.
 */
@Injectable()
export class StorageDashboardMetrics implements DashboardStorageMetrics {
  async usage(): Promise<StorageUsage> {
    const tenantId = requireContext().tenantId;
    const tx = requireTransaction();

    const [live, unreferenced, referenced] = await Promise.all([
      tx.fileObject.aggregate({
        where: { tenantId, deletedAt: null },
        _count: { _all: true },
        _sum: { sizeBytes: true },
      }),
      tx.fileObject.count({ where: { tenantId, deletedAt: null, refCount: 0 } }),
      // `sum(size × ref_count)` has no Prisma aggregate, and expressing it as a fetch-and-reduce
      // would load every blob row to add up a single number — the shape 02 §5 exists to prevent.
      tx.$queryRaw<{ referenced: bigint | null }[]>`
        SELECT COALESCE(SUM(size_bytes * ref_count), 0)::bigint AS referenced
        FROM file_object
        WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
      `,
    ]);

    return {
      blobCount: live._count._all,
      storedBytes: Number(live._sum.sizeBytes ?? 0n),
      referencedBytes: Number(referenced[0]?.referenced ?? 0n),
      unreferencedBlobs: unreferenced,
    };
  }
}
