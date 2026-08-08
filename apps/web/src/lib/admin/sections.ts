import type { Route } from 'next';

import { Permission, type PermissionKey } from '@edms/domain';
import type { MessageKey } from '@edms/i18n';

/**
 * Everything Administration contains, in the order an administrator would set it up.
 *
 * One table, read by three things: the section navigation, the `/admin` index, and the guard on
 * each page. They agree because they are the same data — a screen reachable from the menu but
 * refused by its own guard, or guarded by a permission the menu never checked, is the kind of
 * mismatch that only shows up in front of a user.
 *
 * The order matters. Numbering before document types, and confidentiality before document types,
 * because a document type *requires* a numbering rule and a default confidentiality level: an
 * administrator working top to bottom is never asked for something that does not exist yet.
 *
 * Hiding an area the caller cannot administer is a courtesy, never a control — the endpoint behind
 * every one of these is guarded regardless (`docs/architecture/08-permission-model.md` §7).
 */
export interface AdminDestination {
  readonly id: string;
  /** Typed, so a section pointing at a route that does not exist is a build error. */
  readonly href: Route;
  readonly titleKey: MessageKey;
  readonly descriptionKey: MessageKey;
  readonly permission: PermissionKey;
}

export interface AdminSection {
  readonly id: string;
  readonly titleKey: MessageKey;
  readonly destinations: readonly AdminDestination[];
}

export const ADMIN_SECTIONS: readonly AdminSection[] = Object.freeze([
  {
    id: 'organization',
    titleKey: 'admin.sections.organization',
    destinations: [
      {
        id: 'companies',
        href: '/admin/companies',
        titleKey: 'admin.companies.title',
        descriptionKey: 'admin.companies.description',
        permission: Permission.ORG_MANAGE,
      },
      {
        id: 'entities',
        href: '/admin/entities',
        titleKey: 'admin.entities.title',
        descriptionKey: 'admin.entities.description',
        permission: Permission.ORG_MANAGE,
      },
      {
        id: 'branches',
        href: '/admin/branches',
        titleKey: 'admin.branches.title',
        descriptionKey: 'admin.branches.description',
        permission: Permission.ORG_MANAGE,
      },
      {
        id: 'departments',
        href: '/admin/departments',
        titleKey: 'admin.departments.title',
        descriptionKey: 'admin.departments.description',
        permission: Permission.ORG_MANAGE,
      },
    ],
  },
  {
    id: 'people',
    titleKey: 'admin.sections.people',
    destinations: [
      {
        id: 'users',
        href: '/admin/users',
        titleKey: 'admin.users.title',
        descriptionKey: 'admin.users.description',
        permission: Permission.USER_MANAGE,
      },
      {
        id: 'roles',
        href: '/admin/roles',
        titleKey: 'admin.roles.title',
        descriptionKey: 'admin.roles.description',
        permission: Permission.ROLE_MANAGE,
      },
      {
        id: 'permissions',
        href: '/admin/permissions',
        titleKey: 'admin.permissions.title',
        descriptionKey: 'admin.permissions.description',
        permission: Permission.ROLE_MANAGE,
      },
    ],
  },
  {
    id: 'control',
    titleKey: 'admin.sections.control',
    destinations: [
      {
        id: 'numbering',
        href: '/admin/numbering',
        titleKey: 'admin.numbering.title',
        descriptionKey: 'admin.numbering.description',
        permission: Permission.NUMBERING_MANAGE,
      },
      {
        id: 'retention',
        href: '/admin/retention',
        titleKey: 'admin.retention.title',
        descriptionKey: 'admin.retention.description',
        permission: Permission.RETENTION_MANAGE,
      },
      {
        id: 'workflows',
        href: '/admin/workflows',
        titleKey: 'admin.workflows.title',
        descriptionKey: 'admin.workflows.description',
        permission: Permission.WORKFLOW_MANAGE,
      },
      // Phase 4. Both sit directly after workflows and before them in nothing, because both are
      // things a workflow *names*: a stage routes to a group, and a stage's deadline is counted
      // against a calendar. An administrator authoring a workflow reaches for them from here.
      {
        id: 'approval-groups',
        href: '/admin/approval-groups',
        titleKey: 'admin.approvalGroups.title',
        descriptionKey: 'admin.approvalGroups.description',
        permission: Permission.WORKFLOW_MANAGE,
      },
      {
        id: 'working-calendars',
        href: '/admin/working-calendars',
        titleKey: 'admin.calendars.title',
        descriptionKey: 'admin.calendars.description',
        permission: Permission.WORKFLOW_MANAGE,
      },
    ],
  },
  {
    id: 'classification',
    titleKey: 'admin.sections.classification',
    destinations: [
      {
        id: 'confidentiality',
        href: '/admin/confidentiality',
        titleKey: 'admin.confidentiality.title',
        descriptionKey: 'admin.confidentiality.description',
        permission: Permission.SETTINGS_MANAGE,
      },
      {
        id: 'fields',
        href: '/admin/fields',
        titleKey: 'admin.metadataFields.title',
        descriptionKey: 'admin.metadataFields.description',
        permission: Permission.SETTINGS_MANAGE,
      },
      {
        id: 'categories',
        href: '/admin/categories',
        titleKey: 'admin.categories.title',
        descriptionKey: 'admin.categories.description',
        permission: Permission.SETTINGS_MANAGE,
      },
      {
        id: 'document-types',
        href: '/admin/document-types',
        titleKey: 'admin.documentTypes.title',
        descriptionKey: 'admin.documentTypes.description',
        permission: Permission.SETTINGS_MANAGE,
      },
      {
        // Last in the section, and after document types for the ordering reason above: a template
        // names a type, a confidentiality level and optionally a category, so an administrator
        // working top to bottom reaches it only once all three exist.
        //
        // The one destination in this section not gated on `settings:manage`. `template:manage` is
        // its own permission because authoring the starting point for a controlled document is the
        // document controller's job rather than the system administrator's — and the routes behind
        // this screen have declared it since Phase 16.
        id: 'templates',
        href: '/admin/templates',
        titleKey: 'admin.templates.title',
        descriptionKey: 'admin.templates.description',
        permission: Permission.TEMPLATE_MANAGE,
      },
    ],
  },
  {
    id: 'places',
    titleKey: 'admin.sections.places',
    destinations: [
      {
        id: 'libraries',
        href: '/admin/libraries',
        titleKey: 'admin.libraries.title',
        descriptionKey: 'admin.libraries.description',
        permission: Permission.LIBRARY_MANAGE,
      },
    ],
  },
  {
    id: 'system',
    titleKey: 'admin.sections.system',
    destinations: [
      {
        id: 'settings',
        href: '/admin/settings',
        titleKey: 'admin.settings.title',
        descriptionKey: 'admin.settings.description',
        permission: Permission.SETTINGS_MANAGE,
      },
      {
        // Phase 12. Tenant configuration, not a person's own preferences: an override changes the
        // words everybody in the tenant is told. The per-user half of 18 §5 is at
        // `/notifications`, outside Administration entirely.
        id: 'notification-templates',
        href: '/admin/notification-templates',
        titleKey: 'admin.notificationTemplates.title',
        descriptionKey: 'admin.notificationTemplates.description',
        permission: Permission.SETTINGS_MANAGE,
      },
      /**
       * Phase 17. Two destinations behind one permission, because they are one administrative
       * surface: whoever may mint a key may mint one bound to an auditor, and whoever may point a
       * webhook at a URL can exfiltrate the same events a key would read. `08 §2`'s test for a
       * permission — is this a decision somebody can be trusted with *separately* — says no.
       *
       * Under System rather than People, deliberately. A key acts as a person, which makes it
       * tempting to file beside users; but what an administrator is doing here is connecting this
       * tenant to another system, and the neighbours that make that legible are the settings and
       * the templates rather than the directory.
       */
      {
        id: 'api-clients',
        href: '/admin/api-clients',
        titleKey: 'admin.apiClients.title',
        descriptionKey: 'admin.apiClients.description',
        permission: Permission.INTEGRATION_MANAGE,
      },
      {
        id: 'webhooks',
        href: '/admin/webhooks',
        titleKey: 'admin.webhooks.title',
        descriptionKey: 'admin.webhooks.description',
        permission: Permission.INTEGRATION_MANAGE,
      },
    ],
  },
]);

/** Every permission that reaches some part of Administration — what gates the menu entry itself. */
export const ADMIN_PERMISSIONS: readonly PermissionKey[] = Object.freeze([
  ...new Set(
    ADMIN_SECTIONS.flatMap((section) =>
      section.destinations.map((destination) => destination.permission),
    ),
  ),
]);

/** The sections this caller can reach, with empty ones dropped rather than rendered bare. */
export function sectionsFor(permissions: readonly PermissionKey[]): readonly AdminSection[] {
  const held = new Set<PermissionKey>(permissions);
  return ADMIN_SECTIONS.map((section) => ({
    ...section,
    destinations: section.destinations.filter((destination) => held.has(destination.permission)),
  })).filter((section) => section.destinations.length > 0);
}
