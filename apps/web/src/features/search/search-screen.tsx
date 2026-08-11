'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, type ReactNode, useState, useTransition } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Panel,
  Section,
  Select,
  Spinner,
  Stack,
  useToast,
} from '@munaxa/ui';

import type {
  FacetBucket,
  HighlightSpan,
  RecentSearch,
  SavedSearch,
  SearchHit,
  SearchResults,
} from '@edms/contracts';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import { WorkspacePage } from '../../components/workspace-page';
import { DocumentStatusBadge } from '../documents/status-badge';
import { FormDialog } from '../admin-shared';
import { continueSearch, createSavedSearch, deleteSavedSearch } from './actions';

/**
 * The search screen: query bar, facet rail, results, keyset "load more", saved searches.
 *
 * The URL is the state — typing a query pushes a new URL and the server renders the first
 * page, so a search is a link. Only the *continuation* lives in component state: further pages
 * are appended through a server action, because a keyset cursor names "after what I have" and
 * putting it in the URL would make refresh show page four alone.
 *
 * Facet counts arrive post-filter from the API and are rendered as-is; the screen never
 * counts anything itself, for the same reason it never decides a permission.
 */
export function SearchScreen({
  queryText,
  sort,
  filters,
  initialResults,
  saved,
  recent,
  typeLabels,
  categoryLabels,
  departmentLabels,
  entityLabels,
}: {
  readonly queryText: string;
  readonly sort: string;
  readonly filters: Readonly<Record<string, string>>;
  readonly initialResults: SearchResults | null;
  readonly saved: readonly SavedSearch[];
  readonly recent: readonly RecentSearch[];
  readonly typeLabels: Readonly<Record<string, string>>;
  readonly categoryLabels: Readonly<Record<string, string>>;
  readonly departmentLabels: Readonly<Record<string, string>>;
  readonly entityLabels: Readonly<Record<string, string>>;
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [hits, setHits] = useState<readonly SearchHit[]>(initialResults?.data ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(initialResults?.nextCursor ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const toast = useToast();

  const facetLabels: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    type: typeLabels,
    category: categoryLabels,
    department: departmentLabels,
    entity: entityLabels,
  };

  function navigate(next: {
    readonly q?: string;
    readonly sort?: string;
    readonly filters?: Readonly<Record<string, string>>;
  }): void {
    const query = new URLSearchParams();
    const text = next.q ?? queryText;
    if (text !== '') {
      query.set('q', text);
    }
    query.set('sort', next.sort ?? sort);
    for (const [key, value] of Object.entries(next.filters ?? filters)) {
      if (value !== '') {
        query.set(key, value);
      }
    }
    startTransition(() => {
      router.push(`/search?${query.toString()}` as Route);
    });
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const typed = data.get('q');
    navigate({ q: typeof typed === 'string' ? typed.trim() : '' });
  }

  async function loadMore(): Promise<void> {
    if (nextCursor === null) {
      return;
    }
    setLoadingMore(true);
    try {
      const params: Record<string, string> = { sort, ...filters, cursor: nextCursor };
      if (queryText !== '') {
        params.q = queryText;
      }
      const more = await continueSearch(params);
      setHits((current) => [...current, ...more.data]);
      setNextCursor(more.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  const searched = initialResults !== null;

  return (
    <WorkspacePage title={translate('search.title')} description={translate('search.promptHint')}>
      {/*
        `flex-wrap`, and the sort control gets a width only once there is room for one — Phase 7.1.
        The row was a single unwrapping line, so at 390px the "Save search" button hung 24px past
        the viewport and took the whole page's horizontal scrollbar with it. Measured in Chromium at
        the six widths the brief names; it is the only overflow the content screens had.

        The query field keeps `flex-1` and a full-width basis below `sm`, so on a phone it takes its
        own line and the three controls sit under it rather than being squeezed to nothing.

        **`sm:basis-0`, not `sm:basis-auto` — Phase 7.7A, and the reason is measured rather than
        reasoned.** Above `sm` the field was still taking a line of its own, so the query sat apart
        from the button that submits it at every desktop width. `sm:basis-auto` was applying
        correctly — computed `flex-basis` really was `auto` at 1440, 1280, 1024, 768 and 640 — so
        the cause was not the specificity fight it looked like from the source.

        It is the platform's own `Input`, which carries `w-full`. `flex-basis: auto` resolves the
        base size from the `width` property, so the field's flex base size *was* 100% of the form; it
        filled the line by itself and everything else wrapped beneath it. Measured: field width
        equalled form width exactly at every one of those widths — 1120/1120, 960/960, 704/704.

        `basis-0` gives the field a base size of zero, so the sort control and the two buttons are
        laid out at their natural widths and the field grows into whatever is left. That is the
        ordinary flex idiom for "fill the rest of the row", and it is one class rather than a width:
        no pixel value, no new breakpoint, no override of the platform's `w-full`.
      */}
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          name="q"
          defaultValue={queryText}
          placeholder={translate('search.placeholder')}
          aria-label={translate('search.placeholder')}
          className="min-w-0 flex-1 basis-full sm:basis-0"
        />
        <Select
          value={sort}
          aria-label={translate('search.sort')}
          className="w-full sm:w-44"
          onChange={(event) => {
            navigate({ sort: event.currentTarget.value });
          }}
        >
          <option value="relevance">{translate('search.sortRelevance')}</option>
          <option value="recent">{translate('search.sortRecent')}</option>
          <option value="number">{translate('search.sortNumber')}</option>
          <option value="title">{translate('search.sortTitle')}</option>
        </Select>
        <Button type="submit" disabled={pending}>
          {translate('search.submit')}
        </Button>
        {searched && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setSaveOpen(true);
            }}
          >
            {translate('search.save')}
          </Button>
        )}
      </form>
      {/*
        `text-muted-foreground` rather than `opacity-70` — Phase 7.7B.

        Nine places on this screen dimmed text by fading it, which is not the same thing as the
        product's quiet-text colour: opacity fades the *rendered* pixel, so the result depends on
        whatever sits behind it and drifts between the light and dark themes. The rest of the
        product uses the token, and this screen now does too. No new colour is introduced — this is
        the platform's own muted foreground, used where a hand-rolled approximation stood.
      */}
      <p className="text-muted-foreground text-sm">{translate('search.syntaxHint')}</p>

      {initialResults?.meta.unrestricted === true && (
        <Alert tone="warning">{translate('search.unrestricted')}</Alert>
      )}

      {!searched ? (
        <div className="flex flex-col gap-6">
          <EmptyState
            title={translate('search.promptTitle')}
            description={translate('search.promptHint')}
          />
          <SavedSearches
            saved={saved}
            onRun={(entry) => {
              navigate({ q: entry.query, filters: entry.filters });
            }}
          />
          <RecentSearches
            recent={recent}
            onRun={(entry) => {
              navigate({ q: entry.query, filters: entry.filters });
            }}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4 md:flex-row">
          {/*
            The rail is rendered only when it has something in it — Phase 7.7B, and this is A3's
            real cause.

            Phase 7.7 recorded that the result count "renders orphaned and centred". With results
            present that is not true: the count sits left-aligned directly above the list, which is
            why the finding looked wrong when a populated screen was finally rendered. Both
            observations are correct, and the difference is the *rail*.

            A search that matches nothing comes back with no facet buckets, so this `aside` rendered
            empty — and still reserved its 256px column plus the gap. The count then began 272px in
            from the content edge with nothing beside it, which is exactly the "orphaned, floating
            in the middle" reading. Nothing was centred; an invisible element was pushing it.

            So the fix is not to move the count. It is to stop laying out a filter rail that has no
            filters in it, which also gives a fruitless search the full measure for its empty state.
          */}
          {facetsPresent(initialResults.facets, filters) && (
            <aside className="flex w-full flex-col gap-3 md:w-64 md:shrink-0">
              {Object.keys(filters).length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    navigate({ filters: {} });
                  }}
                >
                  {translate('search.clearFilters')}
                </Button>
              )}
              {Object.entries(initialResults.facets).map(([facet, buckets]) => (
                <FacetGroup
                  key={facet}
                  facet={facet}
                  buckets={buckets}
                  active={filters[facet]}
                  labels={facetLabels[facet]}
                  onPick={(value) => {
                    const next = { ...filters };
                    if (next[facet] === value) {
                      delete next[facet];
                    } else {
                      next[facet] = value;
                    }
                    navigate({ filters: next });
                  }}
                />
              ))}
            </aside>
          )}

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="text-muted-foreground text-sm">
              {translate('search.resultsCount', {
                count: hits.length,
                total: initialResults.meta.total,
              })}
            </p>
            {hits.length === 0 ? (
              <EmptyState
                title={translate('search.empty')}
                description={translate('search.emptyHint')}
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {hits.map((hit) => (
                  <li key={hit.documentId}>
                    <ResultCard hit={hit} typeLabels={typeLabels} />
                  </li>
                ))}
              </ul>
            )}
            {nextCursor !== null && (
              <Button
                type="button"
                variant="ghost"
                disabled={loadingMore}
                onClick={() => {
                  void loadMore();
                }}
              >
                {loadingMore ? <Spinner className="size-4" /> : translate('search.loadMore')}
              </Button>
            )}
          </div>
        </div>
      )}

      <FormDialog
        open={saveOpen}
        title={translate('search.saveDialogTitle')}
        onClose={() => {
          setSaveOpen(false);
        }}
        onSubmit={(data) => {
          const name = data.get('name');
          return createSavedSearch({
            name: typeof name === 'string' ? name : '',
            query: queryText,
            filters,
          });
        }}
        onSaved={() => {
          setSaveOpen(false);
          toast.success(translate('search.savedCreated'));
          router.refresh();
        }}
        submitLabel={translate('search.saveConfirm')}
      >
        <label className="flex flex-col gap-1">
          <span className="text-sm">{translate('search.saveName')}</span>
          <Input name="name" required maxLength={120} />
        </label>
      </FormDialog>
    </WorkspacePage>
  );
}

/**
 * Whether the filter rail has anything to show.
 *
 * `FacetGroup` already returns `null` for an empty bucket list, so the rail can be present and
 * render nothing — which is the layout bug A3 was really describing. An active filter counts even
 * when its facet came back empty, because "Clear filters" is the way out of a search that filtered
 * everything away and removing it would strand the reader.
 */
function facetsPresent(
  facets: Readonly<Record<string, readonly FacetBucket[]>>,
  filters: Readonly<Record<string, string>>,
): boolean {
  return (
    Object.keys(filters).length > 0 || Object.values(facets).some((buckets) => buckets.length > 0)
  );
}

function SavedSearches({
  saved,
  onRun,
}: {
  readonly saved: readonly SavedSearch[];
  readonly onRun: (entry: SavedSearch) => void;
}): ReactNode {
  const translate = useTranslate();
  const toast = useToast();
  const router = useRouter();

  return (
    <Section title={translate('search.savedTitle')} gap={2}>
      {saved.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {translate('search.savedEmpty')} — {translate('search.savedEmptyHint')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {saved.map((entry) => (
            <li key={entry.id}>
              <Card className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span className="text-muted-foreground truncate text-sm">{entry.query}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onRun(entry);
                  }}
                >
                  {translate('search.runSaved')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void deleteSavedSearch(entry.id, entry.version).then((result) => {
                      if (result.ok) {
                        toast.success(translate('search.savedDeleted'));
                        router.refresh();
                        return;
                      }
                      toast.error(result.detail ?? translate(`error.${result.code}`));
                    });
                  }}
                >
                  {translate('search.deleteSaved')}
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function RecentSearches({
  recent,
  onRun,
}: {
  readonly recent: readonly RecentSearch[];
  readonly onRun: (entry: RecentSearch) => void;
}): ReactNode {
  const translate = useTranslate();

  return (
    <Section title={translate('search.recentTitle')} gap={2}>
      {recent.length === 0 ? (
        <p className="text-muted-foreground text-sm">{translate('search.recentEmpty')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {recent.map((entry) => (
            <li key={`${entry.query}|${JSON.stringify(entry.filters)}`}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  onRun(entry);
                }}
              >
                {entry.query === '' ? translate('search.filters') : entry.query}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function FacetGroup({
  facet,
  buckets,
  active,
  labels,
  onPick,
}: {
  readonly facet: string;
  readonly buckets: readonly FacetBucket[];
  readonly active: string | undefined;
  readonly labels: Readonly<Record<string, string>> | undefined;
  readonly onPick: (value: string) => void;
}): ReactNode {
  const translate = useTranslate();
  if (buckets.length === 0) {
    return null;
  }
  const titleKey = FACET_TITLES[facet];

  /*
   * `Panel`, not a `Card` with an `<h3>` inside it — Phase 7.7B (A2).
   *
   * The platform's own note on `Panel` names this exact use: "the building block of inspectors,
   * **filter panels**, side rails and property lists". It supplies the header treatment the rest of
   * the product shows (`font-display text-sm font-semibold`) where this rail was hand-rolling
   * `text-sm font-medium`, and it labels the region, so a screen-reader user can move between
   * `Status`, `Type` and `Year` instead of walking every option in all three.
   */
  return (
    <Panel title={titleKey === undefined ? facet : translate(titleKey)}>
      <ul className="flex flex-col">
        {buckets.map((bucket) => (
          <li key={bucket.value}>
            <button
              type="button"
              onClick={() => {
                onPick(bucket.value);
              }}
              aria-pressed={active === bucket.value}
              className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-start text-sm hover:bg-accent ${
                active === bucket.value ? 'font-semibold' : ''
              }`}
            >
              <span className="min-w-0 truncate">
                {facetLabel(facet, bucket.value, labels, translate)}
              </span>
              <span className="text-muted-foreground tabular-nums">{bucket.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * One result — Phase 7.7B, composed from the first render that ever had a result in it.
 *
 * ## Why it is two lines rather than one
 *
 * The row was `flex items-center gap-2` with a `flex-1` title, so at 1440 the title sat on the far
 * left and the number, the status and the revision were pushed against the right edge with five
 * hundred pixels of nothing between them — and the revision then **overflowed the card**, clipped
 * by its own border. Both are visible in `search-populated-1440.png` from the previous pass.
 *
 * So this is the shape Phase 7.6B settled on for the dashboard's recent documents: the title and
 * its status on the first line, everything that qualifies the document on a second, quieter one.
 * The two screens now read as the same product because they are the same composition, not because
 * the values were matched by hand.
 *
 * ## Why the revision no longer says "Rev"
 *
 * `revisionLabelFor` mints `Original`, `R1`, `A` or `1.0` depending on the document type's style —
 * every one of them already *is* the revision's name. Prefixing `search.revisionLabel`'s "Rev "
 * produced `Rev R1` and `Rev Original`, and against the E2E fixture's hand-written label the
 * populated screen read **`Rev Rev 0`**. The approval panel and the signature panel have always
 * rendered the label bare; Search was the only screen adding a prefix, so it stops.
 *
 * ## Why the document type is here at all
 *
 * `typeLabels` is already resolved for the facet rail and passed into this screen; the hit carries
 * `documentTypeId`. Nothing is invented — the label rendered beside a result is the same string the
 * `Type` facet shows above it. `folderId` has no such map, so no folder is shown.
 */
function ResultCard({
  hit,
  typeLabels,
}: {
  readonly hit: SearchHit;
  readonly typeLabels: Readonly<Record<string, string>>;
}): ReactNode {
  const translate = useTranslate();
  const title = hit.highlights.title?.[0];
  const typeLabel = typeLabels[hit.documentTypeId];

  return (
    <Link href={`/documents/${hit.documentId}` as Route} className="block">
      <Card className="flex flex-col gap-1">
        {/*
          The status sits *beside* the title, not at the far edge.

          `justify="between"` is right for the dashboard's recent-documents panel, which is 400px
          wide. The results column here is 845px at 1440, and pushing the badge to its end left
          seven hundred pixels of nothing between a document and its own state — two facts that
          belong together, read as two unrelated ones. The title truncates and the badge follows it.
        */}
        <Stack direction="horizontal" gap={2} align="center">
          <span className="min-w-0 truncate font-medium">
            {title === undefined ? hit.title : <Spans spans={title} />}
          </span>
          <div className="shrink-0">
            <DocumentStatusBadge status={hit.status} />
          </div>
        </Stack>
        {(hit.highlights.body?.length ?? 0) > 0 && (
          <p className="text-muted-foreground line-clamp-2 text-sm">
            {hit.highlights.body?.map((fragment, index) => (
              // Fragments are positional and re-render whole; the index is a stable key here.
              <span key={index}>
                {index > 0 && ' … '}
                <Spans spans={fragment} />
              </span>
            ))}
          </p>
        )}
        <Stack
          direction="horizontal"
          gap={2}
          align="center"
          wrap
          className="text-muted-foreground text-xs"
        >
          {typeLabel !== undefined && <span className="shrink-0 font-medium">{typeLabel}</span>}
          {hit.documentNumber !== null && (
            <span className="shrink-0 tabular-nums">{hit.documentNumber}</span>
          )}
          {hit.revisionLabel !== null && <span className="shrink-0">{hit.revisionLabel}</span>}
          <time dateTime={hit.updatedAt} className="shrink-0 tabular-nums">
            {new Date(hit.updatedAt).toLocaleDateString()}
          </time>
          {hit.contentPending && <Badge tone="muted">{translate('search.contentPending')}</Badge>}
          {!hit.contentPending && hit.bodySource === null && (
            <Badge tone="muted">{translate('search.contentUnavailable')}</Badge>
          )}
          {hit.bodySource === 'OCR' && <Badge tone="muted">{translate('search.ocrMatch')}</Badge>}
          {hit.lowConfidence && <Badge tone="muted">{translate('search.lowConfidence')}</Badge>}
        </Stack>
      </Card>
    </Link>
  );
}

/** Marked spans from the server, rendered as text — never as markup. */
function Spans({ spans }: { readonly spans: readonly HighlightSpan[] }): ReactNode {
  return (
    <>
      {spans.map((span, index) =>
        span.hit ? (
          <mark key={index} className="rounded bg-transparent font-semibold text-inherit underline">
            {span.text}
          </mark>
        ) : (
          <span key={index}>{span.text}</span>
        ),
      )}
    </>
  );
}

const FACET_TITLES: Readonly<Record<string, MessageKey>> = {
  status: 'search.facetStatus',
  type: 'search.facetType',
  category: 'search.facetCategory',
  department: 'search.facetDepartment',
  entity: 'search.facetEntity',
  year: 'search.facetYear',
};

function facetLabel(
  facet: string,
  value: string,
  labels: Readonly<Record<string, string>> | undefined,
  translate: (key: MessageKey, values?: Record<string, string | number>) => string,
): string {
  if (facet === 'status') {
    return translate(`documents.status.${value}` as MessageKey);
  }
  return labels?.[value] ?? value;
}
