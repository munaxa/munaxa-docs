import { notFound } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';

import type {
  Category,
  ConfidentialityLevel,
  Department,
  Document,
  DocumentType,
  DocumentWorkflow,
  Folder,
  MetadataField,
  PreviewManifest,
  RevisionHistory,
  User,
} from '@edms/contracts';
import { DomainError, ErrorCode, Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../features/admin-shared';
import { ApprovalPanel } from '../../../../features/approvals/approval-panel';
import { AuditTimeline } from '../../../../features/audit/audit-timeline';
import { DocumentScreen } from '../../../../features/documents/document-screen';
import { PreviewPanel } from '../../../../features/preview/preview-panel';
import { RevisionPanel } from '../../../../features/revisions/revision-panel';
import { adminAccess, adminGet, adminList, adminOptions } from '../../../../lib/admin/api';

/**
 * One document.
 *
 * Fetching it is what records the view: the API's `GET` writes the "recently opened" entry and the
 * audit event that confidentiality levels demanding audit-on-read require. That is why opening a
 * document is a page navigation rather than a panel that expands — a compliance record that
 * depended on a client remembering to call something would not be a compliance record.
 *
 * The candidate folders for a move are limited to the document's own library. A document does not
 * cross libraries: its contents would move into a different permission chain, and there is no
 * confirmation dialogue that can honestly summarise that.
 *
 * The approval area is fetched alongside, in the same round of requests. Phase 4 added it, and it is
 * on this page rather than a page of its own for one reason: "who must agree before this becomes
 * official, and where has it got to" is a question about *this document*, and answering it somewhere
 * else would make somebody navigate away from the thing they are deciding about.
 *
 * The audit timeline is the one panel deliberately *not* in that round of requests. Phase 9 added
 * it inside a `Suspense` boundary, fetching its own data, which is what `16 §7`'s "shell first,
 * preview and audit stream in" actually requires: awaited beside the document, a slow trail query
 * would delay the number, the title and every action on the page. Suspended, it delays nothing.
 */
export default async function DocumentPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.DOCUMENT_VIEW);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const { documentId } = await params;
  let document: Document;
  try {
    document = await adminGet<Document>(`/documents/${documentId}`);
  } catch (error) {
    if (error instanceof DomainError && error.code === ErrorCode.NOT_FOUND) {
      notFound();
    }
    throw error;
  }

  // The timeline is compliance evidence with its own permission: fetched only when the caller
  // holds `document:history:view`, and the panel simply omits it otherwise.
  const canViewHistory = access.permissions.includes(Permission.DOCUMENT_HISTORY_VIEW);

  const [
    workflow,
    history,
    preview,
    folders,
    categories,
    levels,
    users,
    departments,
    fields,
    types,
  ] = await Promise.all([
    adminGet<DocumentWorkflow>(`/documents/${documentId}/workflow`),
    canViewHistory
      ? adminGet<RevisionHistory>(`/documents/${documentId}/revisions`)
      : Promise.resolve(null),
    // The viewer's manifest. Absent — a document with no content yet, or an API refusal — the
    // panel is simply not rendered, which is the same posture as the history above.
    adminGet<PreviewManifest>(`/documents/${documentId}/preview`).catch(() => null),
    adminList<Folder>('/admin/folders', {
      page: 1,
      pageSize: 200,
      sortBy: 'path',
      sortDirection: 'asc',
      search: '',
      deleted: 'live',
      filters: { libraryId: document.libraryId },
    }),
    adminOptions<Category>('/admin/categories', 'path'),
    adminOptions<ConfidentialityLevel>('/admin/confidentiality-levels', 'name'),
    adminOptions<User>('/admin/users', 'displayName'),
    adminOptions<Department>('/admin/departments', 'path'),
    adminOptions<MetadataField>('/admin/fields', 'name'),
    adminOptions<DocumentType>('/admin/document-types', 'name'),
  ]);

  const fieldsById = new Map(fields.data.map((field) => [field.id, field]));
  const type = types.data.find((candidate) => candidate.id === document.documentTypeId);

  return (
    <DocumentScreen
      document={document}
      folders={folders.data}
      categories={categories.data.map((category) => ({
        value: category.id,
        label: category.name,
      }))}
      // Only levels at or above the document's own rank: a document's confidentiality may be raised
      // and never lowered, and offering the lower ones would be offering an action the API refuses.
      confidentialityLevels={levels.data
        .filter((level) => level.rank >= document.confidentialityRank)
        .map((level) => ({ value: level.id, label: level.name }))}
      users={users.data.map((user) => ({ value: user.id, label: user.displayName }))}
      departments={departments.data.map((department) => ({
        value: department.id,
        label: department.name,
      }))}
      fields={(type?.fields ?? []).flatMap((entry) => {
        const definition = fieldsById.get(entry.metadataFieldId);
        return definition === undefined
          ? []
          : [
              {
                id: definition.id,
                key: definition.key,
                name: definition.name,
                dataType: definition.dataType,
                isRequired: entry.isRequired,
                options: definition.options.map((option) => ({
                  value: option.value,
                  label: option.label,
                })),
                description: definition.description,
                defaultValue: entry.defaultValue,
              },
            ];
      })}
      canEdit={access.permissions.includes(Permission.DOCUMENT_EDIT)}
      canMove={access.permissions.includes(Permission.DOCUMENT_MOVE)}
      canDownload={access.permissions.includes(Permission.DOCUMENT_DOWNLOAD)}
      canAssignNumber={access.permissions.includes(Permission.NUMBERING_MANAGE)}
      canManagePermissions={access.permissions.includes(Permission.DOCUMENT_PERMISSION_MANAGE)}
      preview={
        preview === null ? undefined : (
          <PreviewPanel
            document={document}
            initialManifest={preview}
            canPrint={access.permissions.includes(Permission.DOCUMENT_PRINT)}
            canDownload={access.permissions.includes(Permission.DOCUMENT_DOWNLOAD)}
          />
        )
      }
      approvals={
        <ApprovalPanel
          workflow={workflow}
          canSubmit={access.permissions.includes(Permission.DOCUMENT_SUBMIT)}
          canApprove={access.permissions.includes(Permission.DOCUMENT_APPROVE)}
          canReject={access.permissions.includes(Permission.DOCUMENT_REJECT)}
          canManage={access.permissions.includes(Permission.WORKFLOW_MANAGE)}
        />
      }
      audit={
        <Suspense fallback={null}>
          <AuditTimeline subjectType="DOCUMENT" subjectId={documentId} />
        </Suspense>
      }
      revisions={
        <RevisionPanel
          document={document}
          history={history}
          availableTransitions={workflow.availableTransitions}
          canCheckout={access.permissions.includes(Permission.DOCUMENT_CHECKOUT)}
          canCheckin={access.permissions.includes(Permission.DOCUMENT_CHECKIN)}
          canForce={access.permissions.includes(Permission.DOCUMENT_FORCE_CHECKIN)}
          canPublish={access.permissions.includes(Permission.DOCUMENT_PUBLISH)}
          canDownload={access.permissions.includes(Permission.DOCUMENT_DOWNLOAD)}
        />
      }
    />
  );
}
