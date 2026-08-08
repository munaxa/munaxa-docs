import type { ReactNode } from 'react';

import type { SearchRebuild, SettingsResponse } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { SettingsScreen } from '../../../../features/admin-configuration/settings-screen';
import { AdminForbidden } from '../../../../features/admin-shared';
import { adminAccess, adminGet, adminRead } from '../../../../lib/admin/api';

/**
 * Tenant settings, and the one operator action that belongs beside them — Phase 6.5.
 *
 * No search parameters: the catalogue is a fixed, short list that arrives whole, and there is nothing
 * here to page or filter.
 *
 * The rebuild status is read through `adminRead` rather than `adminGet` because **its absence is a
 * normal state**: `GET /search/rebuild` answers `404` for a tenant that has never run one, and that
 * is not a page which cannot render — it is a page whose answer is "never". `adminGet` would throw
 * and take the whole settings screen to an error boundary over a tenant simply being new.
 */
export default async function SettingsPage(): Promise<ReactNode> {
  const access = await adminAccess(Permission.SETTINGS_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const [settings, rebuild] = await Promise.all([
    adminGet<SettingsResponse>('/admin/settings'),
    adminRead<SearchRebuild>('/search/rebuild'),
  ]);

  return <SettingsScreen settings={settings} searchRebuild={rebuild.ok ? rebuild.value : null} />;
}
