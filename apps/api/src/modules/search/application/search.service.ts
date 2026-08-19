import { Inject, Injectable } from '@nestjs/common';

import {
  ActorChannel,
  type AnyId,
  AuditOutcome,
  AuditSubjectType,
  Permission,
  type UserId,
  asId,
} from '@edms/domain';

import { ACL_RESOLVER, type AclResolver } from '../../../core/authorization/acl-resolver.port';
import { AUDIT_WRITER, type AuditWriter } from '../../../core/audit/audit-writer.port';
import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { ValidationError } from '../../../core/errors/application-errors';
import { RecordStamps } from '../../../core/persistence/record-stamps';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  SEARCH_PORT,
  type SearchPort,
  type SearchResults,
  type SearchSubject,
} from '../../../ports/search.port';
import { SearchAudit } from '../domain/audit-actions';
import { parseSearchQuery } from '../domain/query-parser';
import {
  FACET_LABEL_READER,
  LABELLED_FACETS,
  RECENT_SEARCH_REPOSITORY,
  SEARCH_SOURCE,
  type FacetLabelReader,
  type LabelledFacet,
  type RecentSearchRepository,
  type SearchOutcome,
  type SearchRequest,
  type SearchService,
  type SearchSource,
} from './ports';

/** A type code that resolves to nothing must match nothing — never widen to everything. */
const NO_MATCH_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The query side: one request in, one permission-filtered page out.
 *
 * The order inside is the security order. The subject's visibility filter comes from
 * `ACL_RESOLVER` — the same implementation that computed the index's `acl_subjects`, so the
 * predicate the engine runs can never disagree with a direct read. `search:all` is the one
 * widening: the ACL predicate is skipped, the tenant predicate never is, and the query itself
 * is written to the audit trail before results leave (`12-search-architecture.md` §3).
 *
 * Recording the recent search shares the query's transaction: a search that fails records
 * nothing, and a search that answers is on the list — never half of either.
 */
@Injectable()
export class DefaultSearchService implements SearchService {
  constructor(
    @Inject(SEARCH_PORT) private readonly engine: SearchPort,
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
    @Inject(SEARCH_SOURCE) private readonly source: SearchSource,
    @Inject(FACET_LABEL_READER) private readonly facetLabels: FacetLabelReader,
    @Inject(RECENT_SEARCH_REPOSITORY) private readonly recents: RecentSearchRepository,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly stamps: RecordStamps,
  ) {}

  async search(request: SearchRequest): Promise<SearchOutcome> {
    const context = requireContext();
    const parsed = parseSearchQuery(request.text ?? '');
    const filters = await this.resolveFilters(mergeFilters(parsed.filters, request.filters));

    const subject = {
      userId: context.userId ?? asId<UserId>(''),
      roleIds: context.roles.map((role) => asId<AnyId>(role)),
      departmentIds: [],
      delegationIds: [],
    };
    const unrestricted = context.permissions.includes(Permission.SEARCH_ALL);

    return this.unitOfWork.run(async () => {
      const visibility = await this.acl.visibilityFilter(subject, Permission.DOCUMENT_VIEW);
      const searchSubject: SearchSubject = {
        tenantId: context.tenantId,
        subjectIds: visibility.subjectIds,
        unrestricted,
      };
      const results = await this.engine.query(searchSubject, {
        text: parsed.text === '' ? null : parsed.text,
        filters,
        facets: request.facets,
        sort: request.sort,
        cursor: request.cursor,
        limit: request.limit,
      });
      await this.recordAftermath(request, results, unrestricted);
      return { results, unrestricted, facetLabels: await this.labelsFor(results) };
    });
  }

  /**
   * Names for the facet values this search produced — Slice 11.
   *
   * ## Why it reads from the results rather than from the tenant
   *
   * `/search` used to render facet captions from four administrative lists the page fetched
   * itself — every document type, every category, every department, every entity in the tenant —
   * which needed `settings:manage` and `org:manage` and made the workspace unopenable for the two
   * seeded roles that hold neither. The names were never the problem; asking for the *catalogue*
   * to find four of them was.
   *
   * This asks the other way round. `results.facets` is what the engine counted **inside** the ACL
   * predicate, so every identifier here is one the caller has already been shown. Resolving those
   * and only those means a facet the caller cannot see has no label — because it has no bucket.
   * The visibility decision stays exactly where it was, in the engine's `WHERE`, and this never
   * gets an opportunity to widen it.
   */
  private async labelsFor(results: SearchResults): Promise<SearchOutcome['facetLabels']> {
    const wanted: Partial<Record<LabelledFacet, readonly string[]>> = {};
    for (const facet of LABELLED_FACETS) {
      const buckets = results.facets[facet] ?? [];
      if (buckets.length > 0) {
        wanted[facet] = buckets.map((bucket) => bucket.value);
      }
    }
    return Object.keys(wanted).length === 0 ? {} : this.facetLabels.labelsFor(wanted);
  }

  /**
   * What a successful search leaves behind: the caller's recent-search row, and — only when
   * `search:all` bypassed the ACL predicate — the audit row 12 §3 requires.
   */
  private async recordAftermath(
    request: SearchRequest,
    results: SearchResults,
    unrestricted: boolean,
  ): Promise<void> {
    const context = requireContext();
    const searched =
      (request.text !== null && request.text.trim() !== '') ||
      Object.keys(request.filters).length > 0;

    if (context.userId !== null && searched) {
      await this.recents.record(
        context.userId,
        {
          id: this.stamps.nextId(),
          query: request.text?.trim() ?? '',
          filters: request.filters,
          searchedAt: this.stamps.now(),
        },
        this.config.search.recentLimit,
      );
    }

    if (unrestricted && context.userId !== null) {
      await this.audit.write(
        {
          tenantId: context.tenantId,
          userId: context.userId,
          channel: context.channel ?? ActorChannel.WEB,
          ...(context.apiClientId !== undefined && { apiClientId: context.apiClientId }),
          correlationId: context.correlationId,
          ipAddress: null,
          userAgent: null,
        },
        {
          action: SearchAudit.SEARCH_PERFORMED,
          subjectType: AuditSubjectType.SEARCH,
          subjectId: asId<AnyId>(context.userId),
          outcome: AuditOutcome.SUCCESS,
          payload: {
            query: request.text ?? '',
            filters: request.filters,
            unrestricted: true,
            total: results.total,
          },
        },
      );
    }
  }

  /**
   * Field-query values that need the caller resolved: `me` becomes the caller's own id, and a
   * `type:` code becomes the type id — or a match-nothing id, because a code that resolves to
   * nothing asked for a type that does not exist, and the honest answer is zero results.
   */
  private async resolveFilters(
    filters: Readonly<Record<string, readonly string[]>>,
  ): Promise<Readonly<Record<string, readonly string[]>>> {
    const context = requireContext();
    const resolved: Record<string, readonly string[]> = {};

    for (const [key, values] of Object.entries(filters)) {
      if (key === 'typeCode') {
        const ids = await Promise.all(
          values.map(async (code) => (await this.source.typeIdByCode(code)) ?? NO_MATCH_ID),
        );
        resolved['type'] = [...(resolved['type'] ?? []), ...ids];
        continue;
      }
      if (key === 'owner' || key === 'approver') {
        resolved[key] = values.map((value) => {
          if (value.toLowerCase() !== 'me') {
            return value;
          }
          if (context.userId === null) {
            throw new ValidationError('`me` has no meaning without a signed-in user.', [
              { field: key, message: 'No current user to resolve `me` against.' },
            ]);
          }
          return context.userId;
        });
        continue;
      }
      resolved[key] = values;
    }
    return resolved;
  }
}

function mergeFilters(
  parsed: Readonly<Record<string, readonly string[]>>,
  explicit: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  const merged: Record<string, string[]> = {};
  for (const source of [parsed, explicit]) {
    for (const [key, values] of Object.entries(source)) {
      merged[key] = [...(merged[key] ?? []), ...values];
    }
  }
  return merged;
}
