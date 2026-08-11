import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Providers } from '../../app/providers';
import {
  SEARCH_HIT_TYPE_ID,
  populatedSearchResults,
  searchHit,
  searchResults,
} from '../../test/fixtures';
import { SearchScreen } from './search-screen';

/**
 * The Search result row and the screen's section grammar — Phase 7.7B.
 *
 * Both defects these guard were invisible until Phase 7.7B drove a real reindex and rendered a
 * screen that actually had a result on it. Before that the only Search evidence in this repository
 * was the empty state, which is why a doubled revision label survived every previous phase.
 *
 * The assertions are about what a reader receives — a revision named once, a type spelled out, a
 * status as a word, regions a screen reader can move between — rather than about which components
 * produce them. A future rewrite that keeps the outcome keeps these green.
 */
const TYPE_LABELS = { [SEARCH_HIT_TYPE_ID]: 'Standard operating procedure' };

function renderSearch(results = populatedSearchResults()): void {
  render(
    <Providers session={{ userId: 'u', tenantId: 't', locale: 'en' }}>
      <SearchScreen
        queryText="batch"
        sort="relevance"
        filters={{}}
        initialResults={results}
        saved={[]}
        recent={[]}
        typeLabels={TYPE_LABELS}
        categoryLabels={{}}
        departmentLabels={{}}
        entityLabels={{}}
      />
    </Providers>,
  );
}

describe('search result row', () => {
  /**
   * The defect this phase found, stated as the thing a reader would have seen.
   *
   * `revisionLabelFor` mints `Original`, `R1`, `A` or `1.0` — each already the revision's whole
   * name. The screen wrapped it in `search.revisionLabel`'s "Rev {label}", which reads `Rev R2` for
   * real data and read `Rev Rev 0` against the E2E fixture's hand-written label.
   */
  it('names the revision once', () => {
    renderSearch();

    expect(screen.getByText('R2')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Rev\s+R2/);
    expect(document.body.textContent).not.toMatch(/Rev\s+Rev/);
  });

  it('renders any revision style the domain can mint, unprefixed', () => {
    // `Original` is ordinal zero under NUMERIC and `1.0` is MAJOR_MINOR's first issue. A screen
    // that prefixes would read "Rev Original", which is why this asserts the label alone.
    renderSearch(
      searchResults({
        data: [searchHit({ revisionLabel: 'Original', revisionOrdinal: 0 })],
        meta: { total: 1, unrestricted: false },
      }),
    );

    expect(screen.getByText('Original')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Rev\s+Original/);
  });

  it('shows the document type as its label, not as an id', () => {
    renderSearch();

    // Twice: once in the `Type` facet, once on the result. Both resolve the same id through the
    // same map, which is the point — the label beside a result is the label above it.
    expect(screen.getAllByText('Standard operating procedure')).toHaveLength(2);
    expect(document.body.textContent).not.toContain(SEARCH_HIT_TYPE_ID);
  });

  it('shows the status as a word rather than an enum or a key path', () => {
    renderSearch();

    expect(screen.getAllByText('Published').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/documents\.status\./);
  });

  it('keeps the document number and dates the result from updatedAt', () => {
    renderSearch();

    expect(screen.getByText('SOP-0001')).toBeTruthy();
    expect(screen.getByText(new Date(searchHit().updatedAt).toLocaleDateString())).toBeTruthy();
  });

  it('is a link to the document', () => {
    renderSearch();

    const link = screen.getByRole('link', { name: /Batch release procedure/ });
    expect(link.getAttribute('href')).toBe(`/documents/${searchHit().documentId}`);
  });

  it('leaks no raw message key', () => {
    renderSearch();

    expect(document.body.textContent).not.toMatch(/search\.[a-zA-Z]/);
  });
});

describe('search section grammar', () => {
  /**
   * A2, asserted through the outcome rather than through a class name.
   *
   * The facet rail hand-rolled `<Card><h3 class="text-sm font-medium">`, which is markup a screen
   * reader cannot navigate between and typography the rest of the product does not use. `Panel`
   * labels the region and supplies the shared heading treatment. Reverting to the old markup loses
   * the accessible name, so this fails.
   */
  it('exposes each facet group as a region a reader can jump to', () => {
    renderSearch();

    expect(screen.getByRole('region', { name: 'Status' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Type' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Year' })).toBeTruthy();
  });

  it('exposes saved and recent searches as regions on the unsearched screen', () => {
    render(
      <Providers session={{ userId: 'u', tenantId: 't', locale: 'en' }}>
        <SearchScreen
          queryText=""
          sort="relevance"
          filters={{}}
          initialResults={null}
          saved={[]}
          recent={[]}
          typeLabels={{}}
          categoryLabels={{}}
          departmentLabels={{}}
          entityLabels={{}}
        />
      </Providers>,
    );

    expect(screen.getByRole('region', { name: 'Saved searches' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Recent searches' })).toBeTruthy();
  });

  /**
   * A3, re-scoped to what the renders actually showed.
   *
   * A fruitless search comes back with no facet buckets, and the rail used to render anyway — an
   * empty 256px column that pushed "0 of 0 results" into the middle of the screen. That is the
   * "orphaned and centred" count Phase 7.7 reported; with results present the same markup reads
   * correctly, which is why the finding survived unexamined. The rail now appears only when it has
   * something in it.
   */
  it('lays out no filter rail when a search matches nothing', () => {
    renderSearch(searchResults());

    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Status' })).toBeNull();
  });

  it('keeps the filter rail when a filter is active even with no buckets left', () => {
    render(
      <Providers session={{ userId: 'u', tenantId: 't', locale: 'en' }}>
        <SearchScreen
          queryText="batch"
          sort="relevance"
          filters={{ status: 'PUBLISHED' }}
          initialResults={searchResults()}
          saved={[]}
          recent={[]}
          typeLabels={TYPE_LABELS}
          categoryLabels={{}}
          departmentLabels={{}}
          entityLabels={{}}
        />
      </Providers>,
    );

    // Without this the reader would be stranded in a filter they cannot clear.
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy();
  });

  it('keeps the rail when there are facets to show', () => {
    renderSearch();

    expect(screen.getByRole('complementary')).toBeTruthy();
  });

  it('keeps one h1 and puts every section heading beneath it', () => {
    renderSearch();

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    // The hand-rolled `<h3>` under no `<h2>` is gone; the facet headings are the shared level.
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });
});
