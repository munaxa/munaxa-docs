import type { ReactNode } from 'react';

import type {
  NotificationTemplateOverride,
  NotificationTypeDescriptor,
  SuppressedAddress,
} from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../features/admin-shared';
import { NotificationTemplatesScreen } from '../../../../features/notifications/notification-templates-screen';
import { adminAccess, adminGet } from '../../../../lib/admin/api';

/**
 * Notification templates — 18 §6, and the brief's "configurable templates".
 *
 * Under `/admin` because it is tenant configuration: an override changes the words the product
 * uses to tell *everybody* in the tenant that their approval is needed. The per-user half of 18
 * §5 — channels, digests, quiet hours — is a person's own and lives at `/notifications` instead.
 *
 * The suppressed-address list is on the same screen rather than one of its own, because it is the
 * other half of the same operational question: an administrator who has been told an address
 * stopped accepting mail (§7) arrives here, and giving that one list its own route would be a
 * route somebody visits once a year and cannot find.
 */
export default async function NotificationTemplatesPage(): Promise<ReactNode> {
  const access = await adminAccess(Permission.SETTINGS_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const [types, templates, suppressions] = await Promise.all([
    adminGet<{ data: NotificationTypeDescriptor[] }>('/admin/notifications/types'),
    adminGet<{ data: NotificationTemplateOverride[] }>('/admin/notifications/templates'),
    adminGet<{ data: SuppressedAddress[] }>('/admin/notifications/suppressions?page=1&pageSize=50'),
  ]);

  return (
    <NotificationTemplatesScreen
      types={types.data}
      overrides={templates.data}
      suppressions={suppressions.data}
    />
  );
}
