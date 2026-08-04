import type {
  Category,
  Collection,
  ConfidentialityLevel,
  DocumentType,
  MetadataField,
  NumberReservation,
  NumberingPreview,
  NumberingRule,
  RetentionPolicy,
  Setting,
  SettingsResponse,
} from '@edms/contracts';
import { depthOf } from '@edms/domain';
import type { Page } from '@edms/utils';

import type {
  CategoryRow,
  ConfidentialityLevelRow,
  DocumentTypeRow,
  MetadataFieldRow,
  NumberingRuleRow,
  RetentionPolicyRow,
} from '../application/administration.ports';
import type { ReservationRecord } from '../application/numbering-issue.ports';
import type { SettingRow, SettingsView } from '../application/settings-admin.service';
import type { FormattedNumber } from '../domain/numbering';

/**
 * Rows to wire shapes.
 *
 * Every field named, so adding a column to a configuration table is not the same commit as adding a
 * field to a public contract — and timestamps converted here rather than left as `Date` for an
 * interceptor, so the mapper's return type is honestly the contract's type.
 */

interface Stamps {
  readonly id: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
}

function stamps(
  row: Stamps,
): Pick<
  ConfidentialityLevel,
  | 'id'
  | 'version'
  | 'createdAt'
  | 'createdBy'
  | 'updatedAt'
  | 'updatedBy'
  | 'deletedAt'
  | 'deletedBy'
> {
  return {
    id: row.id,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    deletedBy: row.deletedBy,
  };
}

export function toConfidentialityLevel(row: ConfidentialityLevelRow): ConfidentialityLevel {
  return {
    ...stamps(row),
    code: row.code,
    name: row.name,
    description: row.description,
    rank: row.rank,
    allowDownload: row.allowDownload,
    allowPrint: row.allowPrint,
    watermark: row.watermark,
    requireReason: row.requireReason,
    documentTypeCount: row.documentTypeCount,
  };
}

export function toRetentionPolicy(row: RetentionPolicyRow): RetentionPolicy {
  return {
    ...stamps(row),
    code: row.code,
    name: row.name,
    description: row.description,
    trigger: row.trigger,
    periodMonths: row.periodMonths,
    disposition: row.disposition,
    reviewRequired: row.reviewRequired,
    documentTypeCount: row.documentTypeCount,
  };
}

export function toCategory(row: CategoryRow): Category {
  return {
    ...stamps(row),
    parentId: row.parentId,
    code: row.code,
    name: row.name,
    description: row.description,
    path: row.path,
    // Derived from the path rather than stored: categories have no `depth` column, and two sources
    // for one number is one source too many after a move.
    depth: depthOf(row.path),
    childCount: row.childCount,
  };
}

export function toMetadataField(row: MetadataFieldRow): MetadataField {
  return {
    ...stamps(row),
    key: row.key,
    name: row.name,
    description: row.description,
    dataType: row.dataType,
    options: row.options.map((option) => ({ value: option.value, label: option.label })),
    validation: { ...row.validation },
    isSearchable: row.isSearchable,
    documentTypeCount: row.documentTypeCount,
  };
}

export function toDocumentType(row: DocumentTypeRow): DocumentType {
  return {
    ...stamps(row),
    code: row.code,
    name: row.name,
    description: row.description,
    numberingRuleId: row.numberingRuleId,
    numberingRuleName: row.numberingRuleName,
    workflowDefinitionId: row.workflowDefinitionId,
    workflowDefinitionName: row.workflowDefinitionName,
    retentionPolicyId: row.retentionPolicyId,
    retentionPolicyName: row.retentionPolicyName,
    defaultConfidentialityId: row.defaultConfidentialityId,
    defaultConfidentialityName: row.defaultConfidentialityName,
    revisionLabelStyle: row.revisionLabelStyle,
    isActive: row.isActive,
    fields: row.fields.map((field) => ({
      metadataFieldId: field.metadataFieldId,
      isRequired: field.isRequired,
      sortOrder: field.sortOrder,
      defaultValue: field.defaultValue,
      key: field.key,
      name: field.name,
      dataType: field.dataType,
    })),
  };
}

export function toNumberingRule(row: NumberingRuleRow, sample: string): NumberingRule {
  return {
    ...stamps(row),
    key: row.key,
    name: row.name,
    description: row.description,
    // The stored separator is one of the five the contract allows; a row holding anything else came
    // from a hand edit, and rendering it as the default is better than failing the list.
    separator: (['-', '/', '.', '_', ''] as const).includes(row.separator as '-')
      ? (row.separator as NumberingRule['separator'])
      : '-',
    segments: [...row.segments] as NumberingRule['segments'],
    resetScope: [...row.resetScope],
    reserveOnSubmit: row.reserveOnSubmit,
    strictGapless: row.strictGapless,
    sample,
    sequenceCount: row.sequenceCount,
    documentTypeCount: row.documentTypeCount,
  };
}

export function toNumberingPreview(formatted: FormattedNumber): NumberingPreview {
  return { sample: formatted.formatted, omittedSegments: [...formatted.omitted] };
}

export function toNumberReservation(record: ReservationRecord): NumberReservation {
  return {
    id: record.id,
    scopeKey: record.scopeKey,
    // Text on the wire: a counter is a bigint, and JSON numbers stop being exact at 2^53.
    sequenceValue: record.sequenceValue.toString(),
    formatted: record.formatted,
    state: record.state,
    origin: record.origin,
    documentId: record.documentId,
    workflowInstanceId: record.workflowInstanceId,
    reservedAt: record.reservedAt.toISOString(),
    assignedAt: record.assignedAt === null ? null : record.assignedAt.toISOString(),
    voidedAt: record.voidedAt === null ? null : record.voidedAt.toISOString(),
    voidReason: record.voidReason,
    note: record.note,
  };
}

export function toSetting(row: SettingRow): Setting {
  return {
    key: row.key as Setting['key'],
    description: row.description,
    value: row.value,
    defaultValue: row.defaultValue,
    isOverridden: row.isOverridden,
    kind: row.kind,
    ...(row.allowed && { allowed: [...row.allowed] }),
    ...(row.minimum !== undefined && { minimum: row.minimum }),
    ...(row.maximum !== undefined && { maximum: row.maximum }),
  };
}

export function toSettings(view: SettingsView): SettingsResponse {
  return {
    data: view.data.map(toSetting),
    diagnostics: {
      fellBack: [...view.diagnostics.fellBack],
      unrecognised: [...view.diagnostics.unrecognised],
    },
  };
}

export function toCollection<TRow, TItem>(
  page: Page<TRow>,
  map: (row: TRow) => TItem,
): Collection<TItem> {
  return { data: page.data.map(map), meta: page.meta };
}
