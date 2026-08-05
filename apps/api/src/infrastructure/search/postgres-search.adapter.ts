import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  DocumentStatus,
  type DocumentId,
  asId,
  detectLanguage,
  normalizeArabic,
} from '@edms/domain';

import { ValidationError } from '../../core/errors/application-errors';
import { requireTransaction } from '../../core/prisma';
import type {
  FacetBucket,
  HighlightSpan,
  SearchHit,
  SearchQuery,
  SearchResults,
  SearchSubject,
} from '../../ports/search.port';
import type { PlacedSearchPort } from '../tenancy/tenant-scoped-search';
import {
  type SearchCursor,
  type SearchSortKey,
  decodeSearchCursor,
  encodeSearchCursor,
} from './search-cursor';

const TABLE = Prisma.raw('"search_index_entry"');

/** Headline markers: chosen for being valid text nowhere in real documents. */
const START_SEL = '⸢';
const STOP_SEL = '⸣';
const FRAGMENT_DELIMITER = '⸤';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_OP = /^(>=|<=|>|<)?(\d{4}-\d{2}-\d{2})$/;
const DATE_RANGE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;
const YEAR = /^\d{4}$/;
const RANK = /^\d{1,3}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `SEARCH_PORT`'s PostgreSQL engine — ADR-0008 made real, underneath `TenantScopedSearch`.
 *
 * The predicate order is the security order (`12-search-architecture.md` §3): tenant first,
 * then the ACL overlap — `acl_subjects && callerSubjects AND NOT (acl_deny_subjects && …)` —
 * then the structured filters, then the text match; scoring, facet counts and the total all
 * happen strictly after that `WHERE`. `search:all` drops the ACL clause and nothing else.
 *
 * Filters arrive as a closed vocabulary and are validated shape-by-shape before any of them
 * touches SQL — every value is a bind parameter, and an unknown key or malformed value is a
 * refusal, never a pass-through. The one piece of SQL assembled from strings is the choice
 * between two literal text-search configurations.
 *
 * Pagination is keyset on the sort's own `(value, document_id)` pair; the cursor is minted
 * here, refused here, and opaque everywhere else.
 *
 * The `index` parameter names the tenant's placement (`docs-<slug>`). For this engine the
 * physical selection already happened when the unit of work opened the tenant's database —
 * the name is asserted and carried, because for an external engine it is the entire boundary
 * and an adapter written without it would be an adapter that cannot be replaced.
 */
@Injectable()
export class PostgresSearchAdapter implements PlacedSearchPort {
  async query(index: string, subject: SearchSubject, query: SearchQuery): Promise<SearchResults> {
    if (index === '') {
      throw new ValidationError('A search cannot run without an index.', [
        { field: 'index', message: 'The tenant placement names no search index.' },
      ]);
    }
    const tx = requireTransaction();

    const text = query.text?.trim() ?? '';
    const hasText = text !== '';
    const language = hasText ? detectLanguage(text) : 'en';
    const cfg = Prisma.raw(language === 'ar' ? `'arabic'` : `'english'`);
    const normalized = hasText ? normalizeArabic(text) : '';

    // The sort: relevance without text to rank falls back to recency, honestly.
    const sort: SearchSortKey = query.sort === 'RELEVANCE' && !hasText ? 'RECENT' : query.sort;

    const where = this.whereClauses(subject, query.filters);
    const textPredicate = hasText
      ? Prisma.sql`"tsv" @@ (websearch_to_tsquery('simple', ${normalized}) || websearch_to_tsquery(${cfg}::regconfig, ${normalized}))`
      : Prisma.sql`TRUE`;
    const predicate = Prisma.join([...where, textPredicate], ' AND ');

    const rank = hasText
      ? Prisma.sql`ts_rank_cd("tsv", websearch_to_tsquery('simple', ${normalized}) || websearch_to_tsquery(${cfg}::regconfig, ${normalized}))`
      : Prisma.sql`0::float4`;

    const cursor = this.decodeCursor(query.cursor, sort);
    const keyset = cursor === null ? Prisma.sql`TRUE` : this.keysetPredicate(sort, cursor);
    const order = this.orderBy(sort);
    const limit = Math.max(1, Math.min(query.limit, 100));

    const headlineOptions = `StartSel=${START_SEL},StopSel=${STOP_SEL},FragmentDelimiter=${FRAGMENT_DELIMITER},MaxFragments=2,MinWords=5,MaxWords=18`;
    const highlights = hasText
      ? Prisma.sql`
          ts_headline(${cfg}::regconfig, "title_raw",
            websearch_to_tsquery('simple', ${normalized}) || websearch_to_tsquery(${cfg}::regconfig, ${normalized}),
            ${`StartSel=${START_SEL},StopSel=${STOP_SEL},HighlightAll=true`}) AS title_headline,
          ts_headline(${cfg}::regconfig, left("body", 20000),
            websearch_to_tsquery('simple', ${normalized}) || websearch_to_tsquery(${cfg}::regconfig, ${normalized}),
            ${headlineOptions}) AS body_headline`
      : Prisma.sql`'' AS title_headline, '' AS body_headline`;

    const rows = await tx.$queryRaw<RawHit[]>(Prisma.sql`
      SELECT * FROM (
        SELECT
          "document_id", "title_raw", "number_exact", "status"::text AS status,
          "document_type_id", "category_id", "library_id", "folder_id", "owner_id",
          "filename", "revision_ordinal", "revision_label", "language", "body_source"::text AS body_source,
          "content_pending", "low_confidence", "confidentiality_rank",
          "document_updated_at", "published_at", "effective_from",
          ${rank} AS rank,
          ${highlights}
        FROM ${TABLE}
        WHERE ${predicate}
      ) hits
      WHERE ${keyset}
      ORDER BY ${order}
      LIMIT ${limit + 1}
    `);

    const totalRows = await tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
      SELECT count(*) AS total FROM ${TABLE} WHERE ${predicate}
    `);
    const total = Number(totalRows[0]?.total ?? 0n);

    const facets: Record<string, readonly FacetBucket[]> = {};
    for (const facet of query.facets) {
      facets[facet] = await this.countFacet(facet, predicate);
    }

    const page = rows.slice(0, limit);
    const hits = page.map((row) => this.toHit(row));
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last !== undefined
        ? encodeSearchCursor(this.cursorFor(sort, last))
        : null;

    return { hits, total, facets, nextCursor };
  }

  /** Tenant, then ACL, then the structured filters — the predicate 12 §3 writes out. */
  private whereClauses(
    subject: SearchSubject,
    filters: Readonly<Record<string, readonly string[]>>,
  ): Prisma.Sql[] {
    const clauses: Prisma.Sql[] = [Prisma.sql`"tenant_id" = ${subject.tenantId}::uuid`];

    if (!subject.unrestricted) {
      const subjects = [...subject.subjectIds] as string[];
      clauses.push(
        Prisma.sql`"acl_subjects" && ${subjects}::text[]`,
        Prisma.sql`NOT ("acl_deny_subjects" && ${subjects}::text[])`,
      );
    }

    for (const [key, values] of Object.entries(filters)) {
      if (values.length === 0) {
        continue;
      }
      clauses.push(this.filterClause(key, values));
    }
    return clauses;
  }

  private filterClause(key: string, values: readonly string[]): Prisma.Sql {
    switch (key) {
      case 'status': {
        const statuses = values.map((value) => value.toUpperCase());
        for (const status of statuses) {
          if (!(status in DocumentStatus)) {
            throw badFilter(key, `Unknown status ${status}.`);
          }
        }
        return Prisma.sql`"status"::text = ANY(${statuses})`;
      }
      case 'type':
        return Prisma.sql`"document_type_id" = ANY(${uuids(key, values)}::uuid[])`;
      case 'category':
        return Prisma.sql`"category_id" = ANY(${uuids(key, values)}::uuid[])`;
      case 'department':
        return Prisma.sql`"department_id" = ANY(${uuids(key, values)}::uuid[])`;
      case 'entity':
        return Prisma.sql`"entity_id" = ANY(${uuids(key, values)}::uuid[])`;
      case 'branch':
        return Prisma.sql`"branch_id" = ANY(${uuids(key, values)}::uuid[])`;
      case 'owner':
        return Prisma.sql`"owner_id" = ANY(${uuids(key, values)}::uuid[])`;
      case 'approver':
        return Prisma.sql`"approver_ids" && ${uuids(key, values)}::uuid[]`;
      case 'folder': {
        // The subtree, by materialised path: separator-delimited so one id cannot match
        // inside another (`@edms/domain` tree.ts, the same boundary rule).
        const patterns = uuids(key, values).map((id) => `%.${id}.%`);
        return Prisma.sql`('.' || "folder_path" || '.') LIKE ANY(${patterns})`;
      }
      case 'number': {
        const alternatives = values.map((value) => {
          const trimmed = value.trim();
          if (trimmed.endsWith('*')) {
            return Prisma.sql`"number_exact" LIKE ${`${escapeLike(trimmed.slice(0, -1))}%`}`;
          }
          return Prisma.sql`"number_exact" = ${trimmed}`;
        });
        return Prisma.sql`(${Prisma.join(alternatives, ' OR ')})`;
      }
      case 'language': {
        for (const value of values) {
          if (value !== 'ar' && value !== 'en') {
            throw badFilter(key, 'Only `ar` and `en` are indexed languages.');
          }
        }
        return Prisma.sql`"language" = ANY(${[...values]})`;
      }
      case 'confidentiality': {
        const ranks = values.map((value) => {
          if (!RANK.test(value)) {
            throw badFilter(key, 'A confidentiality filter is a rank number.');
          }
          return Number(value);
        });
        return Prisma.sql`"confidentiality_rank" = ANY(${ranks}::int[])`;
      }
      case 'year': {
        const years = values.map((value) => {
          if (!YEAR.test(value)) {
            throw badFilter(key, 'A year filter is a four-digit year.');
          }
          return Number(value);
        });
        return Prisma.sql`EXTRACT(YEAR FROM COALESCE("published_at", "document_created_at"))::int = ANY(${years}::int[])`;
      }
      case 'updated':
        return this.dateClause(Prisma.raw('"document_updated_at"'), key, values);
      case 'created':
        return this.dateClause(Prisma.raw('"document_created_at"'), key, values);
      case 'published':
        return this.dateClause(Prisma.raw('"published_at"'), key, values);
      case 'effective':
        return this.dateClause(Prisma.raw('"effective_from"'), key, values);
      default: {
        if (key.startsWith('meta.')) {
          return this.metadataClause(key.slice('meta.'.length), values);
        }
        throw badFilter(key, 'Not a filter this engine knows.');
      }
    }
  }

  private dateClause(column: Prisma.Sql, key: string, values: readonly string[]): Prisma.Sql {
    const alternatives = values.map((value) => {
      const range = DATE_RANGE.exec(value);
      if (range !== null) {
        const [, from, to] = range;
        return Prisma.sql`(${column} >= ${dayStart(from ?? '')} AND ${column} < ${dayAfter(to ?? '')})`;
      }
      const match = DATE_OP.exec(value);
      if (match === null) {
        throw badFilter(key, 'Dates are `YYYY-MM-DD`, with an optional >, >=, < or <= prefix.');
      }
      const [, op, day] = match;
      const date = day ?? '';
      switch (op) {
        case '>':
          return Prisma.sql`${column} >= ${dayAfter(date)}`;
        case '>=':
          return Prisma.sql`${column} >= ${dayStart(date)}`;
        case '<':
          return Prisma.sql`${column} < ${dayStart(date)}`;
        case '<=':
          return Prisma.sql`${column} < ${dayAfter(date)}`;
        default:
          // A bare date means that day.
          return Prisma.sql`(${column} >= ${dayStart(date)} AND ${column} < ${dayAfter(date)})`;
      }
    });
    return Prisma.sql`(${Prisma.join(alternatives, ' OR ')})`;
  }

  private metadataClause(fieldId: string, values: readonly string[]): Prisma.Sql {
    if (!UUID.test(fieldId)) {
      throw badFilter(`meta.${fieldId}`, 'A metadata filter is keyed by the field id.');
    }
    const alternatives = values.map(
      (value) =>
        Prisma.sql`((jsonb_typeof("metadata" -> ${fieldId}) = 'array' AND "metadata" -> ${fieldId} ? ${value}) OR "metadata" ->> ${fieldId} = ${value})`,
    );
    return Prisma.sql`(${Prisma.join(alternatives, ' OR ')})`;
  }

  private async countFacet(facet: string, predicate: Prisma.Sql): Promise<readonly FacetBucket[]> {
    const column = FACET_COLUMNS[facet];
    if (column === undefined) {
      throw badFilter(facet, 'Not a facet this engine counts.');
    }
    // Post-filter, so a count can never leak a document the predicate excluded (12 §5).
    const rows = await requireTransaction().$queryRaw<{ value: string | null; count: bigint }[]>(
      Prisma.sql`
        SELECT ${column} AS value, count(*) AS count
        FROM ${TABLE}
        WHERE ${predicate}
        GROUP BY 1
        HAVING ${column} IS NOT NULL
        ORDER BY count(*) DESC, 1 ASC
        LIMIT 20
      `,
    );
    return rows
      .filter((row) => row.value !== null)
      .map((row) => ({ value: String(row.value), count: Number(row.count) }));
  }

  private orderBy(sort: SearchSortKey): Prisma.Sql {
    switch (sort) {
      case 'RELEVANCE':
        return Prisma.raw('rank DESC, document_id ASC');
      case 'RECENT':
        return Prisma.raw('document_updated_at DESC, document_id ASC');
      case 'NUMBER':
        return Prisma.raw('number_exact ASC NULLS LAST, document_id ASC');
      case 'TITLE':
        return Prisma.raw('title_raw ASC, document_id ASC');
    }
  }

  private keysetPredicate(sort: SearchSortKey, cursor: SearchCursor): Prisma.Sql {
    const id = cursor.documentId;
    switch (sort) {
      case 'RELEVANCE': {
        const value = Number(cursor.value ?? 0);
        return Prisma.sql`(rank < ${value} OR (rank = ${value} AND document_id > ${id}::uuid))`;
      }
      case 'RECENT': {
        const value = new Date(String(cursor.value ?? 0));
        return Prisma.sql`(document_updated_at < ${value} OR (document_updated_at = ${value} AND document_id > ${id}::uuid))`;
      }
      case 'NUMBER': {
        if (cursor.value === null) {
          return Prisma.sql`(number_exact IS NULL AND document_id > ${id}::uuid)`;
        }
        const value = String(cursor.value);
        return Prisma.sql`(number_exact > ${value} OR (number_exact = ${value} AND document_id > ${id}::uuid) OR number_exact IS NULL)`;
      }
      case 'TITLE': {
        const value = String(cursor.value ?? '');
        return Prisma.sql`(title_raw > ${value} OR (title_raw = ${value} AND document_id > ${id}::uuid))`;
      }
    }
  }

  private cursorFor(sort: SearchSortKey, row: RawHit): SearchCursor {
    switch (sort) {
      case 'RELEVANCE':
        return { sort, value: row.rank, documentId: row.document_id };
      case 'RECENT':
        return { sort, value: row.document_updated_at.toISOString(), documentId: row.document_id };
      case 'NUMBER':
        return { sort, value: row.number_exact, documentId: row.document_id };
      case 'TITLE':
        return { sort, value: row.title_raw, documentId: row.document_id };
    }
  }

  private decodeCursor(encoded: string | null, sort: SearchSortKey): SearchCursor | null {
    if (encoded === null) {
      return null;
    }
    const decoded = decodeSearchCursor(encoded, sort);
    if (!decoded.ok) {
      throw new ValidationError(
        decoded.reason === 'SORT_MISMATCH'
          ? 'The cursor does not belong to this sort order.'
          : 'The cursor is not one this API issued.',
        [{ field: 'cursor', message: 'Start again without a cursor.' }],
      );
    }
    return decoded.cursor;
  }

  private toHit(row: RawHit): SearchHit {
    return {
      documentId: asId<DocumentId>(row.document_id),
      score: row.rank,
      summary: {
        title: row.title_raw,
        documentNumber: row.number_exact,
        status: row.status,
        documentTypeId: row.document_type_id,
        categoryId: row.category_id,
        libraryId: row.library_id,
        folderId: row.folder_id,
        ownerId: row.owner_id,
        filename: row.filename,
        revisionOrdinal: row.revision_ordinal,
        revisionLabel: row.revision_label,
        language: row.language,
        bodySource: row.body_source as 'TEXT' | 'OCR' | null,
        contentPending: row.content_pending,
        lowConfidence: row.low_confidence,
        confidentialityRank: row.confidentiality_rank,
        updatedAt: row.document_updated_at,
        publishedAt: row.published_at,
        effectiveFrom: row.effective_from,
      },
      highlights: {
        ...(row.title_headline.includes(START_SEL) ? { title: [toSpans(row.title_headline)] } : {}),
        ...(row.body_headline.includes(START_SEL)
          ? {
              body: row.body_headline
                .split(FRAGMENT_DELIMITER)
                .filter((fragment) => fragment.trim() !== '')
                .map(toSpans),
            }
          : {}),
      },
    };
  }
}

const FACET_COLUMNS: Readonly<Record<string, Prisma.Sql>> = {
  status: Prisma.raw('"status"::text'),
  type: Prisma.raw('"document_type_id"::text'),
  category: Prisma.raw('"category_id"::text'),
  department: Prisma.raw('"department_id"::text'),
  entity: Prisma.raw('"entity_id"::text'),
  language: Prisma.raw('"language"'),
  confidentiality: Prisma.raw('"confidentiality_rank"::text'),
  year: Prisma.raw(`EXTRACT(YEAR FROM COALESCE("published_at", "document_created_at"))::int::text`),
};

interface RawHit {
  document_id: string;
  title_raw: string;
  number_exact: string | null;
  status: string;
  document_type_id: string;
  category_id: string | null;
  library_id: string;
  folder_id: string;
  owner_id: string;
  filename: string | null;
  revision_ordinal: number | null;
  revision_label: string | null;
  language: string;
  body_source: string | null;
  content_pending: boolean;
  low_confidence: boolean;
  confidentiality_rank: number;
  document_updated_at: Date;
  published_at: Date | null;
  effective_from: Date | null;
  rank: number;
  title_headline: string;
  body_headline: string;
}

/** A marker-delimited headline, segmented into render-safe spans. */
function toSpans(headline: string): readonly HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  for (const [index, piece] of headline.split(START_SEL).entries()) {
    if (index === 0) {
      if (piece !== '') {
        spans.push({ text: piece, hit: false });
      }
      continue;
    }
    const end = piece.indexOf(STOP_SEL);
    if (end === -1) {
      spans.push({ text: piece, hit: false });
      continue;
    }
    spans.push({ text: piece.slice(0, end), hit: true });
    const rest = piece.slice(end + STOP_SEL.length);
    if (rest !== '') {
      spans.push({ text: rest, hit: false });
    }
  }
  return spans;
}

function uuids(key: string, values: readonly string[]): string[] {
  return values.map((value) => {
    const trimmed = value.trim().toLowerCase();
    if (!UUID.test(trimmed)) {
      throw badFilter(key, 'Expected an identifier.');
    }
    return trimmed;
  });
}

function escapeLike(term: string): string {
  return term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function dayStart(day: string): Date {
  if (!DATE.test(day)) {
    throw badFilter('date', 'Dates are `YYYY-MM-DD`.');
  }
  return new Date(`${day}T00:00:00.000Z`);
}

function dayAfter(day: string): Date {
  return new Date(dayStart(day).getTime() + DAY_MS);
}

function badFilter(field: string, message: string): ValidationError {
  return new ValidationError('The search filters are not usable.', [{ field, message }]);
}
