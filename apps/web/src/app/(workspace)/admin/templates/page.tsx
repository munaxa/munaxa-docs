import type { ReactNode } from 'react';

import type {
  Category,
  ConfidentialityLevel,
  DocumentTemplate,
  DocumentType,
  Folder,
} from '@edms/contracts';
import { Permission } from '@edms/domain';

import {
  TEMPLATE_SORT_FIELDS,
  TemplatesScreen,
} from '../../../../features/admin-configuration/templates-screen';
import { AdminForbidden } from '../../../../features/admin-shared';
import { adminAccess, adminList, adminOptions } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';

/**
 * Document templates — Phase 6.5, the surface for a capability that has existed since Phase 16.
 *
 * Guarded on `template:manage`, which is the permission the five API routes behind this screen
 * already declare. The guard here is a courtesy that keeps the menu honest; the endpoints refuse
 * independently, which is what actually enforces it (08 §7).
 *
 * The four option lists are fetched in parallel and are the same `adminOptions` calls the sibling
 * configuration screens make. Folders are included because a template may name a default one, and
 * they are read from the same admin listing the library screens use rather than from a second
 * folder endpoint written for this page.
 */
export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.TEMPLATE_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const requested = readListState(await searchParams, TEMPLATE_SORT_FIELDS);
  const state =
    requested.sortBy === null
      ? { ...requested, sortBy: 'name', sortDirection: 'asc' as const }
      : requested;

  const [page, documentTypes, confidentialityLevels, categories, folders] = await Promise.all([
    adminList<DocumentTemplate>('/document-templates', state),
    adminOptions<DocumentType>('/admin/document-types', 'name'),
    adminOptions<ConfidentialityLevel>('/admin/confidentiality-levels', 'rank'),
    adminOptions<Category>('/admin/categories', 'path'),
    adminOptions<Folder>('/admin/folders', 'path'),
  ]);

  return (
    <TemplatesScreen
      rows={page.data}
      total={page.meta.total}
      state={state}
      documentTypes={documentTypes.data.map((type) => ({ value: type.id, label: type.name }))}
      confidentialityLevels={confidentialityLevels.data.map((level) => ({
        value: level.id,
        label: level.name,
      }))}
      categories={categories.data.map((category) => ({
        value: category.id,
        label: category.name,
      }))}
      folders={folders.data.map((folder) => ({ value: folder.id, label: folder.path }))}
    />
  );
}
