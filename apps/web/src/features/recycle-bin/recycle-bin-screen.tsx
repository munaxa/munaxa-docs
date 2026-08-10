'use client';

import type { Route } from 'next';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Badge, Button, Card, EmptyState, Select, useToast } from '@munaxa/ui';

import type { RecycleBinItem } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import { WorkspacePage } from '../../components/workspace-page';
import { restoreFromBin } from './actions';

/**
 * The recycle bin — `16-frontend-architecture.md` §2's top-level route, built in Phase 10.
 *
 * It is a *different question* from the three-way `deleted` filter every administered list already
 * has, which is why it is a route rather than a mode. "Show me the deleted document types" is a
 * mode of one list; "what did we delete last week, and when does it stop being recoverable" crosses
 * every kind of thing that can be deleted, and answering it by opening sixteen screens in turn is
 * not answering it.
 *
 * Three things it shows that a list's deleted filter cannot:
 *
 * **Why.** The delete reason, beside the row. A reason a reader has to open the audit trail to see
 * is a reason nobody reads before deciding whether to put something back.
 *
 * **What went with it.** A row taken by a folder's cascade says so and points at the folder,
 * because restoring the folder is what brings it back — restoring the document alone would put it
 * in a folder that is still deleted, and the API refuses that with a sentence rather than a
 * mystery.
 *
 * **Nothing about purging.** There is no destroy button here and there is deliberately no way to
 * build one: destruction runs from a retention policy, and an administrator's "purge now" is
 * exactly the mechanism by which records under an unnoticed legal hold get destroyed
 * ([ADR-0010](../../../../docs/architecture/adr/0010-soft-delete-and-retention.md) rejects it by
 * name).
 */
export function RecycleBinScreen({
  items,
  total,
}: {
  readonly items: readonly RecycleBinItem[];
  readonly total: number;
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const [working, setWorking] = useState<string | null>(null);

  const kind = params.get('kind') ?? '';

  const applyKind = (value: string): void => {
    const next = new URLSearchParams(params.toString());
    if (value === '') {
      next.delete('kind');
    } else {
      next.set('kind', value);
    }
    // The filter is in the URL, like every other list in this product: a filtered bin is a link
    // somebody can send, and the server component re-runs the query from it.
    router.push(`${pathname}?${next.toString()}` as Route);
  };

  const restore = async (item: RecycleBinItem): Promise<void> => {
    setWorking(item.id);
    const result = await restoreFromBin(item.kind, item.id, item.version);
    setWorking(null);
    if (result.ok) {
      toast.success(translate('recycleBin.restored'));
      // The list is server-rendered, so the row's disappearance comes from re-running the request
      // rather than from editing an array here — one source of truth for what the page shows.
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  return (
    <WorkspacePage
      title={translate('recycleBin.title')}
      description={translate('recycleBin.subtitle')}
    >
      <div className="flex items-center gap-3">
        <Select
          aria-label={translate('recycleBin.filter.kind')}
          value={kind}
          onChange={(event) => {
            applyKind(event.currentTarget.value);
          }}
        >
          <option value="">{translate('recycleBin.filter.everything')}</option>
          <option value="DOCUMENT">{translate('recycleBin.filter.documents')}</option>
          <option value="FOLDER">{translate('recycleBin.filter.folders')}</option>
        </Select>
        <p className="text-muted-foreground text-sm">
          {translate('recycleBin.count', { count: items.length, total })}
        </p>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title={translate('recycleBin.empty')}
          description={translate('recycleBin.emptyHint')}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <Card className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone="muted">
                    {translate(
                      item.kind === 'DOCUMENT'
                        ? 'recycleBin.kind.document'
                        : 'recycleBin.kind.folder',
                    )}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
                  {item.documentNumber !== null && (
                    <Badge tone="muted">{item.documentNumber}</Badge>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={working !== null}
                    onClick={() => {
                      void restore(item);
                    }}
                  >
                    {working === item.id
                      ? translate('recycleBin.restoring')
                      : translate('admin.actions.restore')}
                  </Button>
                </div>
                <dl className="text-muted-foreground grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div className="flex gap-2">
                    <dt>{translate('recycleBin.deletedAt')}</dt>
                    <dd>
                      <time dateTime={item.deletedAt}>
                        {new Date(item.deletedAt).toLocaleString()}
                      </time>
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt>{translate('recycleBin.deletedBy')}</dt>
                    <dd>{item.deletedByName ?? translate('recycleBin.system')}</dd>
                  </div>
                  {item.path !== null && (
                    <div className="flex gap-2">
                      <dt>{translate('recycleBin.location')}</dt>
                      <dd className="truncate">{item.path}</dd>
                    </div>
                  )}
                  {item.deleteReason !== null && (
                    <div className="flex gap-2">
                      <dt>{translate('recycleBin.reason')}</dt>
                      <dd>{item.deleteReason}</dd>
                    </div>
                  )}
                </dl>
                {item.deleteReason === null && item.cascadeId !== null && (
                  // A row a folder's delete took. Restoring the folder brings it back; restoring
                  // this alone would put it in a folder that is still deleted, which the API
                  // refuses — so the screen says so before somebody tries.
                  <p className="text-muted-foreground text-sm">
                    {translate('recycleBin.cascaded')}
                  </p>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </WorkspacePage>
  );
}
