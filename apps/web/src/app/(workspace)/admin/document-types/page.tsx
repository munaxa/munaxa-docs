import type { ReactNode } from 'react';

import type {
  ConfidentialityLevel,
  DocumentType,
  MetadataField,
  NumberingRule,
  RetentionPolicy,
  WorkflowDefinition,
} from '@edms/contracts';
import { Permission } from '@edms/domain';

import { DocumentTypesScreen } from '../../../../features/admin-configuration/document-types-screen';
import { AdminForbidden } from '../../../../features/admin-shared';
import { adminAccess, adminList, adminOptions } from '../../../../lib/admin/api';
import { type RawSearchParams, readListState } from '../../../../lib/admin/list-state';
import {
  DOCUMENT_TYPE_FILTER_KEYS,
  DOCUMENT_TYPE_SORT_FIELDS,
} from '../../../../lib/admin/list-keys';

/**
 * Document types, with every list the form draws from.
 *
 * Six requests, issued together. They are independent of one another and of the page being shown, so
 * awaiting them in sequence would turn one navigation into six round trips.
 */
export default async function DocumentTypesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.SETTINGS_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const state = readListState(
    await searchParams,
    DOCUMENT_TYPE_SORT_FIELDS,
    DOCUMENT_TYPE_FILTER_KEYS,
  );
  const [page, rules, levels, workflows, policies, fields] = await Promise.all([
    adminList<DocumentType>('/admin/document-types', state),
    adminOptions<NumberingRule>('/admin/numbering-rules', 'name'),
    adminOptions<ConfidentialityLevel>('/admin/confidentiality-levels', 'rank'),
    adminOptions<WorkflowDefinition>('/admin/workflows', 'name'),
    adminOptions<RetentionPolicy>('/admin/retention-policies', 'name'),
    adminOptions<MetadataField>('/admin/fields', 'name'),
  ]);

  return (
    <DocumentTypesScreen
      rows={page.data}
      total={page.meta.total}
      state={state}
      numberingRules={rules.data.map((rule) => ({
        value: rule.id,
        label: `${rule.name} — ${rule.sample}`,
      }))}
      confidentialityLevels={levels.data.map((level) => ({
        value: level.id,
        label: `${String(level.rank)} · ${level.name}`,
      }))}
      workflows={workflows.data.map((workflow) => ({ value: workflow.id, label: workflow.name }))}
      retentionPolicies={policies.data.map((policy) => ({ value: policy.id, label: policy.name }))}
      fields={fields.data.map((field) => ({
        value: field.id,
        label: `${field.name} (${field.key})`,
      }))}
    />
  );
}
