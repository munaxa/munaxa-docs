import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import type {
  Collection,
  DepartmentOption,
  Document,
  EffectivePermissions,
  ExplicitAcl,
  PersonOption,
  RoleOption,
} from '@edms/contracts';
import { DomainError, ErrorCode, Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../../features/admin-shared';
import { PermissionsScreen } from '../../../../../features/permissions/permissions-screen';
import { adminAccess, adminGet, adminRead } from '../../../../../lib/admin/api';

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
 *
 * ## The request graph — Slice 12
 *
 * Two defects were fixed here, and they pull in opposite directions, which is why the wrappers
 * differ line by line rather than uniformly.
 *
 * **Three reads threw that should never have been made.** The entries table captioned its subjects
 * by fetching `/admin/users`, `/admin/roles` and `/admin/departments` — `user:manage`,
 * `role:manage` and `org:manage`. The seeded **document controller** holds
 * `document:permission:manage` and none of those three, so the one role the permissions controller
 * names as an intended user got three refusals through `adminOptions`, which throws, and this route
 * was its error boundary. The captions now arrive on the entries themselves, resolved server-side
 * for the subjects already written on the node; the pickers come from operational read models the
 * controller can actually reach, and a refusal from one of those degrades a dropdown instead of
 * discarding the page.
 *
 * **One read did not throw that should have.** The explicit ACL was fetched with `adminRead`, so a
 * refused or failed permission read became `ok: false` and rendered `entries: []` — a screen
 * stating this document has *no* explicit permissions when in fact nobody had been able to ask. On
 * a permissions screen that is the most expensive possible thing to be wrong about, so it is
 * `adminGet` now and a failure is an error boundary.
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

  /**
   * The render-critical half: what is written on this node, and what it means for one person.
   *
   * Both carry `document:permission:manage` — the key this page gated on above — plus a reach check
   * on the node itself, and both throw. There is no useful version of this screen without the
   * entries, and an empty table is not the honest way to say "the read failed": it is the way to
   * say "there are no entries", which is a different and far more dangerous statement.
   *
   * The effective table is resolved only when somebody has been named. "Effective for whom" has no
   * default worth guessing, and defaulting to the caller would answer the least interesting version
   * of the question this screen exists for.
   */
  const [explicit, effective] = await Promise.all([
    adminGet<ExplicitAcl>(`/scopes/document/${documentId}/permissions`),
    userId === undefined || userId === ''
      ? Promise.resolve(null)
      : adminGet<EffectivePermissions>(
          `/scopes/document/${documentId}/permissions/effective?userId=${encodeURIComponent(userId)}`,
        ),
  ]);

  /**
   * The optional half: what may be *added*, which is three pickers and nothing the page needs.
   *
   * `adminRead` rather than `adminGet`, and the distinction is the point of the slice. A caller who
   * cannot fill one of these dropdowns has lost the ability to add one kind of subject; they have
   * not lost the entries, the chain, the inheritance flag, the revoke buttons or the effective
   * table. Discarding all of that because a `<select>` came back empty is what this route used to
   * do, and it is not a trade anybody would make deliberately.
   *
   * All three are narrow operational read models — an identifier and a label — rather than the
   * administrative catalogues they replaced. `/directory/people` and `/directory/departments` carry
   * `directory:view`; `/acl/roles` carries `document:permission:manage`, the same key as the write
   * it exists to serve. None of the three administrative routes is reachable from this page any
   * more, and none of them was ever needed.
   */
  const [people, roles, departments] = await Promise.all([
    adminRead<Collection<PersonOption>>(`/directory/people?${OPTIONS}&sortBy=displayName`),
    adminRead<Collection<RoleOption>>(`/acl/roles?${OPTIONS}&sortBy=name`),
    adminRead<Collection<DepartmentOption>>(`/directory/departments?${OPTIONS}&sortBy=name`),
  ]);

  return (
    <PermissionsScreen
      scopeType="DOCUMENT"
      scopeId={documentId}
      documentTitle={document.title}
      explicit={explicit.entries}
      chain={explicit.chain}
      inheritanceBroken={explicit.inheritanceBroken}
      effective={effective}
      subjectUserId={userId ?? null}
      people={people.ok ? people.value.data.map((p) => ({ id: p.id, name: p.displayName })) : []}
      roles={roles.ok ? roles.value.data.map((role) => ({ id: role.id, name: role.name })) : []}
      departments={
        departments.ok ? departments.value.data.map((d) => ({ id: d.id, name: d.name })) : []
      }
      canManage={access.granted}
      folderId={explicit.folderId}
      folderInherits={explicit.folderInheritsAcl ?? true}
    />
  );
}

/**
 * One page of options, ascending — the same bound `adminOptions` applies, spelled out.
 *
 * Spelled out rather than reused because these are `optionListQuerySchema` routes, and that schema
 * deliberately has no `deleted` parameter: an operational picker has no recycle bin to offer, so a
 * request that cannot be spelled cannot be made. `adminOptions` would send `deleted=live` and be
 * rejected by the validation pipe.
 */
const OPTIONS = 'page=1&pageSize=100&sortDirection=asc';
