import { Injectable } from '@nestjs/common';

import { type Page, skipFor, toPage } from '@edms/utils';

import type { ReportQuery, ReportRow, ReportSource } from '../../reporting/application/ports';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';

/**
 * The storage report, answered by Storage: what this tenant holds, by library.
 *
 * ## Why it is tenant-wide rather than reach-scoped, and why that is honest
 *
 * A blob is content-addressed and deduplicated by construction (ADR-0007): one `file_object` row
 * can back a revision in a library the caller reaches and another in a library they do not.
 * "The bytes this caller may see" is therefore not a quantity this data model has, and producing
 * one would mean apportioning a shared blob across the documents that reference it — an invention,
 * and an invention somebody would report upward. So the report is gated on `report:view` and
 * reports the tenant's own figures, which is exactly what Phase 13's storage tile does behind the
 * same permission.
 *
 * The *breakdown* by library is the addition, and it is not a disclosure the tile did not already
 * make: a library's name and existence are already `library:view`'s, and the totals here sum to the
 * tile's.
 *
 * ## Bytes held, and bytes referenced. No third figure.
 *
 * `storedBytes` is what the blobs occupy; `referencedBytes` is what they would occupy if every
 * revision held its own copy, and the gap is what content addressing saved. **No quota, no
 * percentage, no limit** — Phase 10 recorded "no quota accounting" as a deliberate limit, Phase 13
 * §3.5 recorded that storage reports bytes and never a quota, and both stay true here. What a
 * tenant *may* store is ADR-0012's data and Phase 21's enforcement, and a "% full" column would be
 * this module inventing the denominator every gauge in the product then divides by.
 */
@Injectable()
export class StorageReportSource implements ReportSource {
  async run(query: ReportQuery): Promise<Page<ReportRow>> {
    if (query.query !== 'storage') {
      throw new Error(`Storage answers no report called ${query.query}.`);
    }
    const tenantId = requireContext().tenantId;

    // One statement, two levels of aggregation, and the second level is the point.
    //
    // `referenced_bytes` sums a blob once per revision that points at it — what the library would
    // occupy if nothing were shared. `stored_bytes` sums each **distinct** blob once, which is what
    // it actually occupies: two revisions of one document with identical content are one blob
    // (ADR-0007), and counting it twice would report a saving as a cost.
    //
    // `LEFT JOIN`, so a library with nothing in it reports zeros rather than being absent. An empty
    // library is a fact about the tenant; a missing row reads as a library that does not exist.
    const rows = await requireTransaction().$queryRaw<
      {
        library: string;
        documents: bigint;
        revisions: bigint;
        stored_bytes: bigint;
        referenced_bytes: bigint;
      }[]
    >`
      WITH rev AS (
        SELECT fo.library_id,
               d.id  AS document_id,
               r.id  AS revision_id,
               f.id  AS blob_id,
               f.size_bytes
          FROM folder fo
          JOIN document d          ON d.folder_id = fo.id
                                   AND d.tenant_id = fo.tenant_id
                                   AND d.deleted_at IS NULL
          JOIN document_revision r ON r.document_id = d.id
                                   AND r.tenant_id = fo.tenant_id
                                   AND r.deleted_at IS NULL
          JOIN file_object f       ON f.id = r.file_object_id
                                   AND f.tenant_id = fo.tenant_id
         WHERE fo.tenant_id = ${tenantId}::uuid
           AND fo.deleted_at IS NULL
      )
      SELECT l.name                                  AS library,
             COUNT(DISTINCT rev.document_id)         AS documents,
             COUNT(rev.revision_id)                  AS revisions,
             COALESCE(SUM(rev.size_bytes), 0)        AS referenced_bytes,
             COALESCE((
               SELECT SUM(distinct_blobs.size_bytes)
                 FROM (SELECT DISTINCT inner_rev.blob_id, inner_rev.size_bytes
                         FROM rev AS inner_rev
                        WHERE inner_rev.library_id = l.id) AS distinct_blobs
             ), 0)                                   AS stored_bytes
        FROM library l
        LEFT JOIN rev ON rev.library_id = l.id
       WHERE l.tenant_id = ${tenantId}::uuid AND l.deleted_at IS NULL
       GROUP BY l.id, l.name
       ORDER BY referenced_bytes DESC, l.name ASC
    `;

    const entries = rows.map((row): ReportRow => ({
      library: row.library,
      documents: Number(row.documents),
      revisions: Number(row.revisions),
      // Narrowed at this boundary, on totals already reduced by the database — the same
      // narrowing `file_object.size_bytes` gets everywhere it reaches the wire.
      storedBytes: Number(row.stored_bytes),
      referencedBytes: Number(row.referenced_bytes),
    }));

    // One row per library; the page is applied here because there are as many rows as there are
    // libraries — tens, not millions — and paging in SQL would need a second query to count them.
    const start = skipFor(query.page);
    return toPage(entries.slice(start, start + query.page.pageSize), entries.length, query.page);
  }
}
