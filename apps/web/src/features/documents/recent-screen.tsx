'use client';

import type { Route } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Badge, Card, EmptyState } from '@munaxa/ui';

import type { RecentDocument } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import { WorkspacePage } from '../../components/workspace-page';

/**
 * What this person opened recently.
 *
 * A plain list rather than the full grid, because the answer is at most a screenful and the useful
 * ordering is fixed: most recently opened first. Sorting a recents list by title would sort away the
 * only thing that makes it a recents list.
 *
 * A client component only because every user-visible string in this product comes from the
 * catalogue and the catalogue is read through a hook. The fetch stayed on the server, where it
 * belongs — the token never leaves it.
 */
export function RecentScreen({ rows }: { readonly rows: readonly RecentDocument[] }): ReactNode {
  const translate = useTranslate();

  /*
   * The empty state is *inside* the frame — Phase 8.1.
   *
   * This screen used to `return <EmptyState … />` before reaching `WorkspacePage`, so somebody who
   * had opened nothing got a page with **no `Page`, no `PageHeader`, no `<h1>` and no breadcrumb**.
   * Phase 8 measured `h1Count: 0` on `/documents/recent` and nowhere else: a screen reader had
   * nothing to announce the page by, and the only way back to the library was the rail.
   *
   * It survived six phases of verification because every one of them populated the list first. An
   * empty screen is a state a real person meets on their first day, and it is the one state nobody
   * had rendered.
   *
   * `EmptyState` itself is unchanged and so is everything below it — the branch simply moved inside
   * the frame the populated state already used, and both branches now share one heading.
   */
  return (
    <WorkspacePage
      title={translate('documents.nav.recent')}
      breadcrumb={[
        { label: translate('nav.documents'), href: '/documents' },
        { label: translate('documents.nav.recent') },
      ]}
    >
      {rows.length === 0 ? (
        <EmptyState
          title={translate('documents.recent.empty')}
          description={translate('documents.recent.emptyHint')}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <Link href={`/documents/${row.id}` as Route}>
                <Card className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate">{row.title}</span>
                  {row.documentNumber !== null && <Badge tone="muted">{row.documentNumber}</Badge>}
                  <span className="text-sm opacity-70">{row.folderName}</span>
                  {/*
                  A `<time>` with a machine-readable attribute and a locale-formatted body: the
                  first is what a screen reader and a crawler read, the second is what a person does.
                */}
                  <time className="text-sm opacity-70" dateTime={row.viewedAt}>
                    {new Date(row.viewedAt).toLocaleString()}
                  </time>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </WorkspacePage>
  );
}
