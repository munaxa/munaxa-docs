import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import type { SearchHit, SearchResults } from '../../../ports/search.port';
import type { SearchOutcome, SearchService } from '../application/ports';
import { SearchController } from './search.controller';

/**
 * The wire shape of a search — Slice 11, and the mapper nothing else covers.
 *
 * The integration suite exercises `SearchService` against two real databases and proves what the
 * *service* returns. Between that and the browser sits `toResults`, which is where the facet label
 * is attached — and a mutation that renamed every facet value or added one to every count sailed
 * through both, because the web tests mock the API and the integration tests stop at the service.
 *
 * So this asserts the translation itself: the filter value and the arithmetic pass through
 * untouched, and the label is written beside them only when there is one.
 */

const HIT: SearchHit = {
  documentId: 'doc-1',
  score: 1,
  summary: {
    title: 'Quality Manual',
    documentNumber: 'QM-0001',
    status: 'PUBLISHED',
    documentTypeId: 'type-1',
    categoryId: 'cat-1',
    libraryId: 'lib-1',
    folderId: 'fol-1',
    ownerId: 'user-1',
    filename: 'quality-manual.pdf',
    revisionOrdinal: 0,
    revisionLabel: 'Rev 0',
    language: 'en',
    contentPending: false,
    lowConfidence: false,
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    publishedAt: null,
  },
  highlights: [],
} as unknown as SearchHit;

function controllerReturning(outcome: SearchOutcome): SearchController {
  const service: SearchService = { search: () => Promise.resolve(outcome) };
  return new SearchController(service, {} as never, {} as never, {} as never, {} as never);
}

const RESULTS: SearchResults = {
  hits: [HIT],
  total: 1,
  facets: {
    type: [
      { value: 'type-1', count: 7 },
      { value: 'type-gone', count: 2 },
    ],
    status: [{ value: 'PUBLISHED', count: 9 }],
  },
  nextCursor: null,
};

const query = (controller: SearchController) =>
  controller.query({ sort: 'relevance', limit: 25 } as never);

describe('the wire results', () => {
  it('writes the label beside the value the server resolved', async () => {
    const wire = await query(
      controllerReturning({
        results: RESULTS,
        unrestricted: false,
        facetLabels: { type: { 'type-1': 'Standard operating procedure' } },
      }),
    );

    expect(wire.facets['type']?.[0]).toStrictEqual({
      value: 'type-1',
      count: 7,
      label: 'Standard operating procedure',
    });
  });

  it('leaves a bucket the server could not name exactly as it was', async () => {
    // Absent rather than empty, so the client's `label ?? value` renders the value it already had.
    const wire = await query(
      controllerReturning({
        results: RESULTS,
        unrestricted: false,
        facetLabels: { type: { 'type-1': 'Standard operating procedure' } },
      }),
    );

    expect(wire.facets['type']?.[1]).toStrictEqual({ value: 'type-gone', count: 2 });
    expect('label' in (wire.facets['type']?.[1] ?? {})).toBe(false);
  });

  it('never invents a label for a facet whose values are their own', async () => {
    // `status` and `year` are not identifiers; the catalogue translates them client-side.
    const wire = await query(
      controllerReturning({ results: RESULTS, unrestricted: false, facetLabels: {} }),
    );

    expect(wire.facets['status']).toStrictEqual([{ value: 'PUBLISHED', count: 9 }]);
  });

  it('passes every value and every count through untouched', async () => {
    /*
     * The filter and the arithmetic. A label is presentation beside them, and this is the assertion
     * that renaming a value or nudging a count — which no web test can see, because they mock this
     * away — fails somewhere.
     */
    const wire = await query(
      controllerReturning({
        results: RESULTS,
        unrestricted: false,
        facetLabels: { type: { 'type-1': 'Standard operating procedure' } },
      }),
    );

    expect(wire.facets['type']?.map((bucket) => bucket.value)).toStrictEqual([
      'type-1',
      'type-gone',
    ]);
    expect(wire.facets['type']?.map((bucket) => bucket.count)).toStrictEqual([7, 2]);
    expect(wire.meta).toStrictEqual({ total: 1, unrestricted: false });
    expect(wire.nextCursor).toBeNull();
  });

  it('reports an unrestricted search as unrestricted', async () => {
    const wire = await query(
      controllerReturning({ results: RESULTS, unrestricted: true, facetLabels: {} }),
    );

    expect(wire.meta.unrestricted).toBe(true);
  });

  it('cannot label a facet the results do not contain', async () => {
    /*
     * Belt and braces on the disclosure rule. Even if the service handed over a name for something
     * that is not in the facets — which it cannot, because it reads them to build the map — the
     * mapper walks the *buckets*, so an extra entry has nowhere to land.
     */
    const wire = await query(
      controllerReturning({
        results: RESULTS,
        unrestricted: false,
        facetLabels: {
          type: { 'type-1': 'Standard operating procedure' },
          entity: { 'ent-invisible': 'A company nobody may see' },
        },
      }),
    );

    expect(wire.facets['entity']).toBeUndefined();
    expect(JSON.stringify(wire)).not.toContain('A company nobody may see');
  });
});
