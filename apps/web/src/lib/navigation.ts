import type { Route } from 'next';

import { Permission, type PermissionKey } from '@edms/domain';
import type { MessageKey } from '@edms/i18n';

import { ADMIN_PERMISSIONS } from './admin/sections';

/**
 * The workspace's navigation, resolved on the server.
 *
 * Two rules, and the second is why this file exists at all.
 *
 * **A destination is listed only if the caller holds its permission.** The filtering happens
 * on the server, from the permissions the API reported, because a client that decided its own
 * menu would be deciding what it is allowed to see. Hiding a link is a courtesy, never a
 * control: the endpoint behind it is guarded regardless
 * (`docs/architecture/08-permission-model.md` §7).
 *
 * **A destination is listed only if its screen exists.** The table below is short because
 * Phase 1 built one screen. Later phases add a row each as they build the destination it
 * points at — a menu item leading to a page that is not there is worse than an absent one.
 */
export interface NavigationDestination {
  readonly id: string;
  /**
   * Typed, so a destination pointing at a route that does not exist is a build error rather
   * than a 404 somebody finds later. That is the whole reason typed routes are switched on.
   */
  readonly href: Route;
  readonly labelKey: MessageKey;
  /** Null for a destination every authenticated caller may reach. */
  readonly permission: PermissionKey | null;
  /**
   * Reached by holding *any* of these, rather than one named permission.
   *
   * Administration is the case this exists for. It is not one capability but sixteen screens behind
   * six permissions, and an administrator who may only manage users must still find their way in.
   * Requiring a single permission would either hide the whole section from them or gate it on the
   * loosest one, and the loosest one is `settings:manage`.
   */
  readonly anyOf?: readonly PermissionKey[];
}

const DESTINATIONS: readonly NavigationDestination[] = Object.freeze([
  { id: 'home', href: '/', labelKey: 'nav.home', permission: null },
  {
    // Phase 3. The row exists now because the screen does: a menu item leading to a page that is
    // not there is worse than an absent one.
    id: 'documents',
    href: '/documents' as Route,
    labelKey: 'nav.documents',
    permission: Permission.DOCUMENT_VIEW,
  },
  {
    id: 'admin',
    href: '/admin',
    labelKey: 'nav.admin',
    permission: null,
    anyOf: ADMIN_PERMISSIONS,
  },
]);

export function destinationsFor(
  permissions: readonly PermissionKey[],
): readonly NavigationDestination[] {
  const held = new Set<PermissionKey>(permissions);
  return DESTINATIONS.filter((destination) => {
    if (destination.anyOf !== undefined) {
      return destination.anyOf.some((permission) => held.has(permission));
    }
    return destination.permission === null || held.has(destination.permission);
  });
}

/** Re-exported so a later phase adding a row does not have to reach for the catalogue too. */
export { Permission };
