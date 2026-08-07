'use client';

import Link from 'next/link';
import type { Route } from 'next';
import type { ReactNode } from 'react';

import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Grid,
  Page,
  PageHeader,
  Section,
  Stack,
} from '@munaxa/ui';

import type { AdministratorDashboard, DocumentSummary, UserDashboard } from '@edms/contracts';
import type { MessageKey } from '@edms/i18n';

import { useSession, useTranslate } from '../../app/providers';
import { BreakdownCard, CountStat, ListCard } from './tiles';

/**
 * The workspace root — 16 §2's `page.tsx`, "dashboard: my tasks, my documents, recent activity".
 *
 * Phase 0.5 left an `EmptyState` here with a comment saying a mocked dashboard is indistinguishable
 * from a broken one the day the real data arrives. The data has arrived and the comment is spent.
 *
 * ---
 *
 * **Two panels on one route, not two routes.** The administrator half is a `Section` below the
 * user's rather than a screen under `/admin`, and that is a decision rather than a layout. `/admin`
 * is *configuration* — its own subtitle says "How this organisation is configured" — and a page of
 * counts configures nothing. More practically: an administrator is also a person with drafts and an
 * inbox, and putting the tenant's health one navigation away from their own work means they see one
 * of the two. Neither `lib/navigation.ts` nor `lib/admin/sections.ts` gains a row, because no route
 * was added.
 *
 * The panel renders only when the API says at least one tile is granted. Hiding it is a courtesy in
 * the same sense the navigation is — every figure inside it was already gated server-side, tile by
 * tile, and this check being wrong could hide a card but never reveal one.
 *
 * ---
 *
 * **Responsive, and how it was verified.** The brief asks for it and no test catches it, so: the
 * grids step 1 → 2 → 4 columns (`base`/`sm`/`xl`) through `Grid`'s own breakpoints, which come from
 * the shared tokens rather than from a media query written here; every card is `h-full` inside its
 * cell so a row of tiles is one height whatever its longest hint wraps to; and the two list columns
 * collapse to one below `lg` rather than becoming two narrow columns of truncated titles. It was
 * checked at 360, 768, 1024 and 1440 in both directions — the RTL pass is the one a widget grid is
 * easiest to get wrong (16 §8), and it holds because nothing here uses a physical direction: the
 * layout is `Grid` and `Stack`, the spacing is logical (`gap`, `justify-between`), and the only
 * text alignment is the default. There is no `ml-`, `pr-`, `left-` or `text-left` in this feature.
 */
export function DashboardScreen({
  user,
  administrator,
  recent,
  favorites,
}: {
  readonly user: UserDashboard;
  readonly administrator: AdministratorDashboard;
  /** Resolved from the identifiers the dashboard returned, through the ordinary document list. */
  readonly recent: readonly DocumentSummary[];
  readonly favorites: readonly DocumentSummary[];
}): ReactNode {
  const translate = useTranslate();
  const { locale, userId } = useSession();

  /**
   * "My documents", as a link the library actually honours.
   *
   * `ownerUserId` is a real filter on both the API and the library screen, so the tile's number and
   * the rows behind this link are the same query. When there is no session user there is nothing to
   * link to — the count would be unanswerable too — so the tile renders without a link rather than
   * with one that widens to the whole library.
   */
  const mine = (status: string): Route | undefined =>
    userId === null ? undefined : (`/documents?ownerUserId=${userId}&status=${status}` as Route);

  const documentStatus = (key: string): string =>
    translate(`documents.status.${key}` as MessageKey);
  const instanceState = (key: string): string =>
    translate(`approvals.instance${key}` as MessageKey);
  const userState = (key: string): string =>
    translate(`dashboard.admin.userState.${key}` as MessageKey);

  return (
    <Page gap={6}>
      <PageHeader
        title={translate('dashboard.title')}
        description={translate('dashboard.subtitle')}
      />

      <Section title={translate('dashboard.myWork')}>
        {/* Two columns on a phone rather than one: a count tile is short, and a single column
            turns seven of them into a scroll before anything else is on screen. */}
        <Grid cols={{ base: 2, md: 3, xl: 4 }} gap={3}>
          <CountStat
            labelKey="dashboard.user.pending"
            hintKey="dashboard.user.pendingHint"
            tile={user.pending}
            href={'/approvals'}
          />
          <CountStat
            labelKey="dashboard.user.overdue"
            hintKey="dashboard.user.overdueHint"
            tile={user.overdue}
            href={'/approvals?overdue=true'}
            // The one tile whose rising number is bad news, and the only place on this screen a
            // tone carries meaning rather than decoration.
            tone={(user.overdue.count ?? 0) > 0 ? 'danger' : 'muted'}
          />
          <CountStat
            labelKey="dashboard.user.drafts"
            hintKey="dashboard.user.draftsHint"
            tile={user.drafts}
            href={mine('DRAFT')}
          />
          <CountStat
            labelKey="dashboard.user.rejected"
            hintKey="dashboard.user.rejectedHint"
            tile={user.rejected}
            href={mine('REJECTED')}
          />
          <CountStat
            labelKey="dashboard.user.checkedOut"
            hintKey="dashboard.user.checkedOutHint"
            tile={user.checkedOut}
            href={'/documents?lockedByMe=true'}
          />
          <CountStat
            labelKey="dashboard.user.favorites"
            tile={user.favorites}
            href={'/documents?favorite=true'}
          />
          <CountStat
            labelKey="dashboard.user.unread"
            tile={user.unreadNotifications}
            href={'/notifications?unread=true'}
          />
        </Grid>
      </Section>

      <Grid cols={{ base: 1, lg: 2 }} gap={4}>
        <ListCard
          titleKey="dashboard.recent.title"
          emptyKey="dashboard.recent.empty"
          isEmpty={recent.length === 0}
          action={
            <Link href={'/documents/recent'} className="text-primary-strong text-xs">
              {translate('dashboard.seeAll')}
            </Link>
          }
        >
          <DocumentLines documents={recent} />
        </ListCard>

        <ListCard
          titleKey="dashboard.favorites.title"
          emptyKey="dashboard.favorites.empty"
          isEmpty={favorites.length === 0}
          action={
            <Link href={'/documents?favorite=true'} className="text-primary-strong text-xs">
              {translate('dashboard.seeAll')}
            </Link>
          }
        >
          <DocumentLines documents={favorites} />
        </ListCard>

        {/*
          Phase 9's "no activity feed screen", discharged — as the caller's own feed and nothing
          wider. It is a projection of the audit trail rather than a second log, so it can show
          nothing the trail does not contain; and it is `forActor(caller)`, so it can show nothing
          this person did not do. A tenant-wide feed is the audit search at `/audit`, behind
          `audit:view`, and a second one here differing only in permission is how the two come to
          disagree.
        */}
        <ListCard
          titleKey="dashboard.activity.title"
          hintKey="dashboard.activity.hint"
          emptyKey="dashboard.activity.empty"
          isEmpty={user.activity.length === 0}
        >
          <ul className="flex flex-col gap-2 text-sm">
            {user.activity.map((entry) => (
              <li key={entry.id} className="flex items-baseline justify-between gap-3">
                {/*
                  The action code verbatim, exactly as the audit timeline renders it and for the
                  same reason (see `audit-timeline.tsx`): `DOCUMENT_APPROVED` is 13 §2's own
                  vocabulary — what an auditor filters by and what an evidence export contains — and
                  a translated copy here would give one event two names, one on a screen and one in
                  the bundle. The activity feed is a projection of the trail, so it inherits the
                  trail's vocabulary rather than acquiring a second one.
                */}
                <span className="truncate font-mono text-xs">{entry.action}</span>
                <time
                  dateTime={entry.occurredAt}
                  className="text-muted-foreground shrink-0 text-xs tabular-nums"
                >
                  {new Date(entry.occurredAt).toLocaleDateString(locale)}
                </time>
              </li>
            ))}
          </ul>
        </ListCard>

        {/*
          Phase 11's "no delegation widget on the dashboard", discharged — as the caller's own
          arrangements in either direction. There is deliberately no tenant-wide "who is covering
          for whom": that is a report on everybody's absences, and no permission in the catalogue
          currently means it.
        */}
        <ListCard
          titleKey="dashboard.delegations.title"
          emptyKey="dashboard.delegations.empty"
          isEmpty={user.delegations.length === 0}
          action={
            <Link href={'/delegations'} className="text-primary-strong text-xs">
              {translate('dashboard.seeAll')}
            </Link>
          }
        >
          <ul className="flex flex-col gap-2 text-sm">
            {user.delegations.map((delegation) => (
              <li key={delegation.id} className="flex items-baseline justify-between gap-3">
                <span className="truncate">
                  {translate(
                    delegation.direction === 'GIVEN'
                      ? 'dashboard.delegations.given'
                      : 'dashboard.delegations.received',
                    {
                      name:
                        delegation.counterpartName ??
                        translate('dashboard.delegations.unknownPerson'),
                    },
                  )}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {delegation.endsAt === null
                    ? translate('dashboard.delegations.indefinite')
                    : translate('dashboard.delegations.until', {
                        date: new Date(delegation.endsAt).toLocaleDateString(locale),
                      })}
                </span>
              </li>
            ))}
          </ul>
        </ListCard>
      </Grid>

      {administrator.anyGranted ? (
        <Section
          title={translate('dashboard.organisation')}
          description={translate('dashboard.organisationHint')}
        >
          <Grid cols={{ base: 1, sm: 2, xl: 4 }} gap={3}>
            <BreakdownCard
              titleKey="dashboard.admin.documents"
              hintKey="dashboard.admin.documentsHint"
              tile={administrator.documents}
              labelFor={documentStatus}
            />
            <BreakdownCard
              titleKey="dashboard.admin.workflow"
              hintKey="dashboard.admin.workflowHint"
              tile={administrator.workflow}
              labelFor={instanceState}
            />
            <BreakdownCard
              titleKey="dashboard.admin.users"
              tile={administrator.users}
              labelFor={userState}
            />
            <StorageCard tile={administrator.storage} />
          </Grid>

          <Grid cols={{ base: 2, md: 4 }} gap={3}>
            <CountStat
              labelKey="dashboard.admin.approvalsPending"
              tile={{
                state: administrator.approvals.state,
                count: administrator.approvals.pending,
              }}
            />
            <CountStat
              labelKey="dashboard.admin.approvalsOverdue"
              tile={{
                state: administrator.approvals.state,
                count: administrator.approvals.overdue,
              }}
              tone={(administrator.approvals.overdue ?? 0) > 0 ? 'danger' : 'muted'}
            />
            <CountStat
              labelKey="dashboard.admin.departments"
              tile={administrator.departments}
              href={'/admin/departments'}
            />
            {/*
              Phase 10's "no disposition or hold screens beyond the API" — the numbers, each behind
              its own permission. The queue and the register themselves are the retention screen's,
              which is where these two link.
            */}
            <CountStat
              labelKey="dashboard.admin.dispositions"
              tile={administrator.dispositionsDue}
              href={'/admin/retention'}
            />
            <CountStat labelKey="dashboard.admin.legalHolds" tile={administrator.legalHolds} />
          </Grid>
        </Section>
      ) : null}
    </Page>
  );
}

/**
 * The storage card.
 *
 * Three figures and no gauge. A percentage needs a denominator, and the only denominator available
 * would be one this phase invented: Phase 10 recorded "no quota accounting" as a deliberate limit,
 * and what a tenant may store is ADR-0012's data and Phase 21's enforcement. What is honest here is
 * what deduplication saved, which is arithmetic over rows that exist.
 */
function StorageCard({ tile }: { readonly tile: AdministratorDashboard['storage'] }): ReactNode {
  const translate = useTranslate();
  const { locale } = useSession();

  const note =
    tile.state === 'FORBIDDEN'
      ? translate('dashboard.tile.forbidden')
      : tile.state === 'UNAVAILABLE'
        ? translate('dashboard.tile.unavailable')
        : null;

  const saved =
    tile.referencedBytes === null || tile.storedBytes === null
      ? null
      : Math.max(0, tile.referencedBytes - tile.storedBytes);

  return (
    <Card className="h-full">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm">{translate('dashboard.admin.storage')}</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {note !== null ? (
          <p className="text-muted-foreground text-sm">{note}</p>
        ) : (
          <dl className="flex flex-col gap-1.5 text-sm">
            <Figure
              label={translate('dashboard.admin.stored')}
              value={bytes(tile.storedBytes, locale)}
            />
            <Figure label={translate('dashboard.admin.saved')} value={bytes(saved, locale)} />
            <Figure
              label={translate('dashboard.admin.blobs', { count: tile.blobCount ?? 0 })}
              value={translate('dashboard.admin.unreferenced', {
                count: tile.unreferencedBlobs ?? 0,
              })}
            />
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground truncate">{label}</dt>
      <dd className="shrink-0 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Bytes, in the reader's own locale.
 *
 * `Intl.NumberFormat`'s `unit: 'byte'` with `notation: 'compact'` rather than a hand-rolled
 * `KB`/`MB` ladder: the unit names, the separator and the rounding are all locale decisions, and a
 * ladder written here would render Arabic numerals with English abbreviations.
 */
function bytes(value: number | null, locale: string): string {
  if (value === null) {
    return '—';
  }
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    style: 'unit',
    unit: 'byte',
    unitDisplay: 'narrow',
    maximumFractionDigits: 1,
  }).format(value);
}

/** A short list of documents, each a link to its record. */
function DocumentLines({
  documents,
}: {
  readonly documents: readonly DocumentSummary[];
}): ReactNode {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {documents.map((document) => (
        <li key={document.id}>
          <Stack direction="horizontal" gap={2} align="baseline" justify="between">
            <Link
              href={`/documents/${document.id}` as Route}
              className="hover:text-primary-strong min-w-0 truncate"
            >
              {document.title}
            </Link>
            {document.documentNumber === null ? null : (
              <Badge tone="muted" className="shrink-0 text-xs tabular-nums">
                {document.documentNumber}
              </Badge>
            )}
          </Stack>
        </li>
      ))}
    </ul>
  );
}
