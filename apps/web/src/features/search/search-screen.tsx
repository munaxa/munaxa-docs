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
  Select,
  Spinner,
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
      <form onSubmit={submit} className="flex items-center gap-2">
        <Input
          type="search"
          name="q"
          defaultValue={queryText}
          placeholder={translate('search.placeholder')}
          aria-label={translate('search.placeholder')}
          className="min-w-0 flex-1"
        />
        <Select
          value={sort}
          aria-label={translate('search.sort')}
          className="w-44"
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
      <p className="text-sm opacity-70">{translate('search.syntaxHint')}</p>

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

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="text-sm opacity-70">
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
                    <ResultCard hit={hit} />
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
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-medium">{translate('search.savedTitle')}</h2>
      {saved.length === 0 ? (
        <p className="text-sm opacity-70">
          {translate('search.savedEmpty')} — {translate('search.savedEmptyHint')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {saved.map((entry) => (
            <li key={entry.id}>
              <Card className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span className="truncate text-sm opacity-70">{entry.query}</span>
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
    </section>
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
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-medium">{translate('search.recentTitle')}</h2>
      {recent.length === 0 ? (
        <p className="text-sm opacity-70">{translate('search.recentEmpty')}</p>
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
    </section>
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

  return (
    <Card className="flex flex-col gap-1 p-3">
      <h3 className="text-sm font-medium">
        {titleKey === undefined ? facet : translate(titleKey)}
      </h3>
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
              <span className="opacity-60">{bucket.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ResultCard({ hit }: { readonly hit: SearchHit }): ReactNode {
  const translate = useTranslate();
  const title = hit.highlights.title?.[0];

  return (
    <Link href={`/documents/${hit.documentId}` as Route}>
      <Card className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">
            {title === undefined ? hit.title : <Spans spans={title} />}
          </span>
          {hit.documentNumber !== null && <Badge tone="muted">{hit.documentNumber}</Badge>}
          <DocumentStatusBadge status={hit.status} />
          {hit.revisionLabel !== null && (
            <span className="text-sm opacity-70">
              {translate('search.revisionLabel', { label: hit.revisionLabel })}
            </span>
          )}
        </div>
        {(hit.highlights.body?.length ?? 0) > 0 && (
          <p className="line-clamp-2 text-sm opacity-80">
            {hit.highlights.body?.map((fragment, index) => (
              // Fragments are positional and re-render whole; the index is a stable key here.
              <span key={index}>
                {index > 0 && ' … '}
                <Spans spans={fragment} />
              </span>
            ))}
          </p>
        )}
        <div className="flex items-center gap-2 text-xs opacity-70">
          {hit.contentPending && <Badge tone="muted">{translate('search.contentPending')}</Badge>}
          {!hit.contentPending && hit.bodySource === null && (
            <Badge tone="muted">{translate('search.contentUnavailable')}</Badge>
          )}
          {hit.bodySource === 'OCR' && <Badge tone="muted">{translate('search.ocrMatch')}</Badge>}
          {hit.lowConfidence && <Badge tone="muted">{translate('search.lowConfidence')}</Badge>}
          <time dateTime={hit.updatedAt}>{new Date(hit.updatedAt).toLocaleDateString()}</time>
        </div>
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
