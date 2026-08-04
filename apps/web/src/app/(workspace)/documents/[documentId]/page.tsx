import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import type {
  Category,
  ConfidentialityLevel,
  Department,
  Document,
  DocumentType,
  Folder,
  MetadataField,
  User,
} from '@edms/contracts';
import { DomainError, ErrorCode, Permission } from '@edms/domain';

import { AdminForbidden } from '../../../../features/admin-shared';
import { DocumentScreen } from '../../../../features/documents/document-screen';
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

  const [folders, categories, levels, users, departments, fields, types] = await Promise.all([
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
    />
  );
}
