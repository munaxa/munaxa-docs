import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { type DocumentId, withNormalizedArabic } from '@edms/domain';

import { requireTransaction } from '../../core/prisma';
import type { ClockPort } from '../../ports/clock.port';
import type { IndexDocument, IndexPort } from '../../ports/search.port';

const LIVE_TABLE = 'search_index_entry';
const SHADOW_TABLE = 'search_index_entry_shadow';

/** The PostgreSQL text-search configuration for a detected language. */
function searchConfiguration(language: string): 'arabic' | 'english' {
  return language === 'ar' ? 'arabic' : 'english';
}

/**
 * `INDEX_PORT` on PostgreSQL: the weighted `tsvector` write side of ADR-0008.
 *
 * The weights are 12 §2's: number and title at A, filename and metadata at B, title and
 * description again at C under the language's own stemmer, body at D. A and B are indexed with
 * the `simple` configuration — a document number or a code must match exactly as typed, and a
 * stemmer that "helpfully" reduces `QMS-001` is how exact search breaks. Arabic fields are
 * indexed in both their original and normalised spellings (`@edms/domain` `search-text`), so a
 * differently-spelled query still lands; the query side normalises to match.
 *
 * The rebuild contract is the shadow table and an **atomic, tenant-scoped swap**: one
 * transaction moves the tenant's rows from the build target into the live table. Deliberately
 * *not* a table rename — the application role does not own the tables (renaming is the
 * migration owner's privilege, by design), and in a single-database installation holding two
 * tenants a rename would swap the other tenant's index out with this one's. MVCC keeps readers
 * whole: any concurrent query sees the index before the swap or after it, never empty.
 *
 * Every statement also runs under the tenant's own RLS (`app.tenant_id` is set by the unit of
 * work), so a predicate forgotten here is a query that returns nothing rather than another
 * tenant's rows.
 */
@Injectable()
export class PostgresIndexAdapter implements IndexPort {
  constructor(private readonly clock: ClockPort) {}

  async upsert(document: IndexDocument): Promise<void> {
    // The projection's own write: it read current truth immediately before this, so it is the
    // freshest thing anyone can say about the document and it overwrites whatever is there.
    await requireTransaction().$executeRaw(Prisma.sql`
      INSERT INTO ${Prisma.raw(`"${LIVE_TABLE}"`)} (${COLUMNS})
      VALUES (${this.rowValues(document)})
      ON CONFLICT ("document_id") DO UPDATE SET ${ASSIGNMENTS}
    `);
  }

  async remove(documentId: DocumentId): Promise<void> {
    await requireTransaction().$executeRaw(
      Prisma.sql`DELETE FROM ${Prisma.raw(`"${LIVE_TABLE}"`)} WHERE "document_id" = ${documentId}::uuid`,
    );
  }

  async beginRebuild(): Promise<void> {
    // DELETE rather than TRUNCATE: RLS scopes it to the ambient tenant, which is exactly the
    // isolation a shared-database installation needs — and TRUNCATE is a privilege the
    // application role deliberately does not hold.
    await requireTransaction().$executeRaw(
      Prisma.sql`DELETE FROM ${Prisma.raw(`"${SHADOW_TABLE}"`)}`,
    );
  }

  /**
   * The rebuild's write, which is the one that must give way.
   *
   * A batch reads every document's facts and *then* writes them all, so what it holds here was
   * captured up to `SEARCH_REBUILD_BATCH_SIZE` documents' worth of reads ago. A projection that
   * committed inside that window has already put current truth into the build target — that is
   * the dual-write the rebuild depends on — and it must not be overwritten by the older
   * representation. Two guards, both decided by the database rather than by arrival order:
   *
   * - `DO NOTHING` keeps a row that is already there. `beginRebuild` empties the build target at
   *   a genuine start and `findableIdsAfter` walks `id` ascending from the cursor, so a run
   *   writes each document at most once: a row present here can only be a concurrent
   *   projection's, and a projection's row is never staler than a batch's.
   * - `WHERE EXISTS` refuses a document that has stopped being findable. `rebuildRemove` exists
   *   "so a document deleted mid-rebuild cannot outlive the swap", and without this the batch
   *   would simply insert it again — deleted title and body included — after the removal.
   *
   * A deletion that commits after this statement's snapshot is not this statement's problem: its
   * own projection runs after it commits, and removes the entry from the build target if the
   * swap has not happened yet, or from the live index if it has.
   */
  async rebuildUpsert(documents: readonly IndexDocument[]): Promise<void> {
    const tx = requireTransaction();
    for (const document of documents) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO ${Prisma.raw(`"${SHADOW_TABLE}"`)} (${COLUMNS})
        SELECT ${this.rowValues(document)}
        WHERE EXISTS (
          SELECT 1 FROM "document"
          WHERE "id" = ${document.documentId}::uuid
            AND "tenant_id" = ${document.tenantId}::uuid
            AND "deleted_at" IS NULL
            AND "status" <> 'PURGED'::document_status
        )
        ON CONFLICT ("document_id") DO NOTHING
      `);
    }
  }

  async rebuildRemove(documentId: DocumentId): Promise<void> {
    await requireTransaction().$executeRaw(
      Prisma.sql`DELETE FROM ${Prisma.raw(`"${SHADOW_TABLE}"`)} WHERE "document_id" = ${documentId}::uuid`,
    );
  }

  async completeRebuild(): Promise<void> {
    const tx = requireTransaction();
    // One transaction, three statements: the tenant's live entries are replaced by the build
    // target's, and the target is left empty for the next run. Readers see before or after.
    await tx.$executeRaw(Prisma.sql`DELETE FROM ${Prisma.raw(`"${LIVE_TABLE}"`)}`);
    await tx.$executeRaw(
      Prisma.sql`INSERT INTO ${Prisma.raw(`"${LIVE_TABLE}"`)} SELECT * FROM ${Prisma.raw(`"${SHADOW_TABLE}"`)}`,
    );
    await tx.$executeRaw(Prisma.sql`DELETE FROM ${Prisma.raw(`"${SHADOW_TABLE}"`)}`);
  }

  /** The row's value expressions, in `COLUMNS` order — one source of truth for both writers. */
  private rowValues(doc: IndexDocument): Prisma.Sql {
    const cfg = searchConfiguration(doc.language);
    // A: what exact search hits. B: filename and metadata. C: title and description under the
    // language's stemmer. D: the body. Arabic fields carry both spellings.
    const weightA = [doc.documentNumber ?? '', withNormalizedArabic(doc.title)].join('\n');
    const weightB = [doc.filename ?? '', withNormalizedArabic(doc.metadataText)].join('\n');
    const weightC = withNormalizedArabic([doc.title, doc.description ?? ''].join('\n'));
    const weightD = withNormalizedArabic(doc.body);

    return Prisma.sql`
      ${doc.documentId}::uuid, ${doc.tenantId}::uuid, ${doc.title}, ${doc.documentNumber},
      setweight(to_tsvector('simple', ${weightA}), 'A')
        || setweight(to_tsvector('simple', ${weightB}), 'B')
        || setweight(to_tsvector(${Prisma.raw(`'${cfg}'`)}::regconfig, ${weightC}), 'C')
        || setweight(to_tsvector(${Prisma.raw(`'${cfg}'`)}::regconfig, ${weightD}), 'D'),
      ${JSON.stringify(doc.metadata)}::jsonb,
      ${doc.documentTypeId}::uuid, ${doc.categoryId}::uuid, ${doc.status}::document_status,
      ${doc.confidentialityRank},
      ${doc.entityId}::uuid, ${doc.branchId}::uuid, ${doc.departmentId}::uuid,
      ${doc.libraryId}::uuid, ${doc.folderId}::uuid, ${doc.folderPath},
      ${doc.ownerId}::uuid, ${[...doc.approverIds]}::uuid[], ${doc.revisionOrdinal},
      ${doc.revisionLabel}, ${doc.filename},
      ${doc.language}, ${doc.body}, ${doc.bodySource}::search_content_source,
      ${doc.contentPending}, ${doc.lowConfidence},
      ${doc.createdAt}, ${doc.updatedAt}, ${doc.publishedAt}, ${doc.effectiveFrom}::date,
      ${[...doc.aclSubjects]}::text[], ${[...doc.aclDenySubjects]}::text[], ${doc.aclHash},
      ${this.clock.now()}, ${doc.sourceVersion}
    `;
  }
}

/** The index entry's columns, shared by the live write and the build target's. */
const COLUMNS = Prisma.raw(
  [
    'document_id',
    'tenant_id',
    'title_raw',
    'number_exact',
    'tsv',
    'metadata',
    'document_type_id',
    'category_id',
    'status',
    'confidentiality_rank',
    'entity_id',
    'branch_id',
    'department_id',
    'library_id',
    'folder_id',
    'folder_path',
    'owner_id',
    'approver_ids',
    'revision_ordinal',
    'revision_label',
    'filename',
    'language',
    'body',
    'body_source',
    'content_pending',
    'low_confidence',
    'document_created_at',
    'document_updated_at',
    'published_at',
    'effective_from',
    'acl_subjects',
    'acl_deny_subjects',
    'acl_hash',
    'indexed_at',
    'source_version',
  ]
    .map((column) => `"${column}"`)
    .join(', '),
);

/** Every column but the key, reassigned from the row being written. */
const ASSIGNMENTS = Prisma.raw(
  COLUMNS.sql
    .split(', ')
    .filter((column) => column !== '"document_id"')
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(', '),
);
