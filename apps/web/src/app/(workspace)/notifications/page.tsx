import type { ReactNode } from 'react';

import type {
  InboxNotification,
  NotificationPreference,
  NotificationTypeDescriptor,
  QuietHours,
} from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../features/admin-shared';
import { NotificationsScreen } from '../../../features/notifications/notifications-screen';
import { adminAccess, adminGet } from '../../../lib/admin/api';

type RawSearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * The notification centre — `16-frontend-architecture.md` §2's `notifications/`.
 *
 * Gated on `notification:manage`, which every seeded role holds and whose scope is the caller's
 * own inbox. That looks like a gate that gates nothing and is not: the API refuses a request with
 * no user behind it, and there is no route under `/notifications` that takes a recipient — so the
 * permission exists to satisfy 15 §5's "every mutating route declares one", and the *subject* is
 * enforced by there being no field for it.
 *
 * Both halves are fetched here, in one server component, because the screen renders them together
 * and a preference panel that loaded separately would flash empty on every open.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.NOTIFICATION_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const params = await searchParams;
  const raw = params['unread'];
  const unreadOnly = (typeof raw === 'string' ? raw : raw?.[0]) === 'true';

  const query = new URLSearchParams({ page: '1', pageSize: '50' });
  if (unreadOnly) {
    query.set('unread', 'true');
  }

  const [inbox, unread, preferences] = await Promise.all([
    adminGet<{ data: InboxNotification[] }>(`/notifications?${query.toString()}`),
    adminGet<{ count: number }>('/notifications/unread-count'),
    adminGet<{
      types: NotificationTypeDescriptor[];
      preferences: NotificationPreference[];
      quietHours: QuietHours | null;
    }>('/notifications/preferences'),
  ]);

  return (
    <NotificationsScreen
      notifications={inbox.data}
      unreadCount={unread.count}
      unreadOnly={unreadOnly}
      types={preferences.types}
      preferences={preferences.preferences}
      quietHours={preferences.quietHours}
    />
  );
}
