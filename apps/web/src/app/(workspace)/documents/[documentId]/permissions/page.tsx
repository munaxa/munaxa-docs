import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import type {
  Department,
  Document,
  EffectivePermissions,
  ExplicitAcl,
  Role,
  User,
} from '@edms/contracts';
import { DomainError, ErrorCode, Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../../features/admin-shared';
import { PermissionsScreen } from '../../../../../features/permissions/permissions-screen';
import { adminAccess, adminGet, adminOptions, adminRead } from '../../../../../lib/admin/api';

/**
 * `16-frontend-architecture.md` §2's `documents/[documentId]/permissions/` — "effective and
 * explicit ACL", named in Phase 0 and empty until now.
 *
 * A route of its own rather than a tab on the document page, and the reason is what it costs to
 * open. The effective table resolves every permission in the catalogue for one person over the
 * whole chain; the document page already fetches nine things and is the screen people live in.
 * Putting an investigation's cost on the page everybody opens would slow the common case to serve
 * the rare one.
 *
 * **Everything on this screen is the server's answer.** The explicit entries, the effective table,
 * the chain and whether the caller may edit any of it all arrive as data — the client renders and
 * decides nothing (08 §7's UI row). A screen that hid the edit form by inspecting a role name would
 * be exactly the defect this phase exists to remove.
 *
 * The refusal is `AdminForbidden` rather than `notFound()` on the *permission* check and
 * `notFound()` on the *document* — which is not an inconsistency. "You do not hold
 * `document:permission:manage`" is a fact about the caller and discloses nothing; "this document
 * does not exist" is what the API answers for a document they cannot reach, and repeating it here
 * is what keeps the two indistinguishable.
 */
export default async function DocumentPermissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ documentId: string }>;
  searchParams: Promise<{ userId?: string }>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.DOCUMENT_PERMISSION_MANAGE);
  const { documentId } = await params;
  const { userId } = await searchParams;

  let document: Document;
  try {
    document = await adminGet<Document>(`/documents/${documentId}`);
  } catch (error) {
    if (error instanceof DomainError && error.code === ErrorCode.NOT_FOUND) {
      notFound();
    }
    throw error;
  }

  if (!access.granted) {
    return <AdminForbidden />;
  }

  const [explicit, people, roles, departments] = await Promise.all([
    adminRead<ExplicitAcl>(`/scopes/document/${documentId}/permissions`),
    adminOptions<User>('/admin/users', 'displayName'),
    adminOptions<Role>('/admin/roles', 'name'),
    adminOptions<Department>('/admin/departments', 'name'),
  ]);

  // Resolved only when somebody has been named. "Effective for whom" has no default worth
  // guessing, and defaulting to the caller would answer the least interesting version of the
  // question this screen exists for.
  const effective =
    userId === undefined || userId === ''
      ? null
      : await adminRead<EffectivePermissions>(
          `/scopes/document/${documentId}/permissions/effective?userId=${encodeURIComponent(userId)}`,
        );

  return (
    <PermissionsScreen
      scopeType="DOCUMENT"
      scopeId={documentId}
      documentTitle={document.title}
      explicit={explicit.ok ? explicit.value.entries : []}
      chain={explicit.ok ? explicit.value.chain : []}
      inheritanceBroken={explicit.ok ? explicit.value.inheritanceBroken : false}
      effective={effective !== null && effective.ok ? effective.value : null}
      subjectUserId={userId ?? null}
      people={people.data.map((person) => ({ id: person.id, name: person.displayName }))}
      roles={roles.data.map((role) => ({ id: role.id, name: role.name }))}
      departments={departments.data.map((department) => ({
        id: department.id,
        name: department.name,
      }))}
      canManage={access.granted}
      folderId={explicit.ok ? explicit.value.folderId : null}
      folderInherits={explicit.ok ? (explicit.value.folderInheritsAcl ?? true) : true}
    />
  );
}
