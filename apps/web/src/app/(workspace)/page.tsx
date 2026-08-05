import type { ReactNode } from 'react';

import type { Collection, Dashboard, DocumentSummary, RecentDocument } from '@edms/contracts';

import { DashboardScreen } from '../../features/dashboard/dashboard-screen';
import { adminGet } from '../../lib/admin/api';

/** As many rows as a card holds before it stops being a card and becomes a list. */
const CARD_ROWS = 8;

/**
 * The workspace root — 16 §2's "dashboard: my tasks, my documents, recent activity".
 *
 * Phase 0.5 rendered an `EmptyState` here with a comment explaining why: "a mocked dashboard is
 * indistinguishable from a broken one the day the real data arrives". The real data has arrived,
 * and the comment is discharged rather than merely deleted — it is why nothing on this screen is a
 * placeholder, and why a tile that cannot be answered says *which* of the two reasons applies
 * instead of showing a zero.
 *
 * ---
 *
 * **Three calls, and each is a list somebody could already open.** `/dashboard` returns every
 * count, the caller's own trail and the cover in force, with each administrator tile already gated
 * server-side against the ACL resolver. The two document cards come from the endpoints that already
 * serve exactly those lists — `/documents/recent` and `/documents?favorite=true` — rather than from
 * rows projected onto the dashboard payload, so the product keeps one definition of what a document
 * summary contains. The alternative shape, one request per widget on the route every session opens
 * first, is what 19 exists to prevent.
 *
 * They are fetched together. A card that waited on the card above it would make the page as slow as
 * the sum of its parts rather than as slow as its slowest part.
 *
 * A server component, because reads are (16 §4) — the access token is in an `httpOnly` cookie and
 * never reaches client JavaScript. Nothing on this screen writes, so there is no server action
 * beside it, which is the same reason a dashboard load has no audit action.
 *
 * **No permission guard here, and that is not an omission.** Unlike the administration pages, this
 * route has no `adminAccess` check: the API gates the whole response on `document:view` and gates
 * each administrator tile individually, and there is no useful screen to render to somebody it
 * refuses. A caller holding none of the administrator permissions gets their own dashboard and no
 * second panel — being an ordinary user is not a failure to be an administrator.
 */
export default async function WorkspaceHome(): Promise<ReactNode> {
  const [dashboard, recent, favorites] = await Promise.all([
    adminGet<Dashboard>('/dashboard'),
    adminGet<Collection<RecentDocument>>(
      `/documents/recent?page=1&pageSize=${CARD_ROWS}&sortDirection=desc`,
    ),
    adminGet<Collection<DocumentSummary>>(
      `/documents?page=1&pageSize=${CARD_ROWS}&favorite=true&sortBy=updatedAt&sortDirection=desc`,
    ),
  ]);

  return (
    <DashboardScreen
      user={dashboard.user}
      administrator={dashboard.administrator}
      recent={recent.data}
      favorites={favorites.data}
    />
  );
}
