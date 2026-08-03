import type { ReactNode } from 'react';

import type { SettingsResponse } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { SettingsScreen } from '../../../../features/admin-configuration/settings-screen';
import { AdminForbidden } from '../../../../features/admin-shared';
import { adminAccess, adminGet } from '../../../../lib/admin/api';

/**
 * Tenant settings.
 *
 * No search parameters: the catalogue is a fixed, short list that arrives whole, and there is nothing
 * here to page or filter.
 */
export default async function SettingsPage(): Promise<ReactNode> {
  const access = await adminAccess(Permission.SETTINGS_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  return <SettingsScreen settings={await adminGet<SettingsResponse>('/admin/settings')} />;
}
