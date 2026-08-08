'use server';

import {
  type Category,
  type ConfidentialityLevel,
  type DocumentTemplate,
  type DocumentType,
  type HeldNumberBlock,
  type MetadataField,
  type NumberingPreview,
  type NumberingRule,
  type RetentionPolicy,
  type SearchRebuild,
  type SettingsResponse,
  createCategorySchema,
  createConfidentialityLevelSchema,
  createDocumentTemplateSchema,
  createDocumentTypeSchema,
  createMetadataFieldSchema,
  createNumberingRuleSchema,
  createRetentionPolicySchema,
  holdNumberBlockSchema,
  moveCategorySchema,
  previewNumberingRuleSchema,
  resetSettingSchema,
  updateCategorySchema,
  updateConfidentialityLevelSchema,
  updateDocumentTemplateSchema,
  updateDocumentTypeSchema,
  updateMetadataFieldSchema,
  updateNumberingRuleSchema,
  updateRetentionPolicySchema,
  updateSettingSchema,
  voidHeldNumberSchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Writes to the configuration a document type is assembled from.
 *
 * Six resources, and their dependency order is the order the screens are listed in: a document type
 * needs a numbering rule and a confidentiality level to exist, and it may reference a retention
 * policy, a workflow and any number of metadata fields.
 */

// --- Confidentiality levels ---------------------------------------------------------------

export async function createConfidentialityLevel(
  input: unknown,
): Promise<ActionResult<ConfidentialityLevel>> {
  return validated(createConfidentialityLevelSchema, input, (body) =>
    adminWrite<ConfidentialityLevel>({
      path: '/admin/confidentiality-levels',
      method: 'POST',
      body,
    }),
  );
}

export async function updateConfidentialityLevel(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<ConfidentialityLevel>> {
  return validated(updateConfidentialityLevelSchema, input, (body) =>
    adminWrite<ConfidentialityLevel>({
      path: `/admin/confidentiality-levels/${id}`,
      method: 'PATCH',
      body,
      version,
    }),
  );
}

export async function deleteConfidentialityLevel(
  id: string,
  version: number,
): Promise<ActionResult> {
  return adminWrite({ path: `/admin/confidentiality-levels/${id}`, method: 'DELETE', version });
}

export async function restoreConfidentialityLevel(
  id: string,
  version: number,
): Promise<ActionResult> {
  return adminWrite({
    path: `/admin/confidentiality-levels/${id}/restore`,
    method: 'POST',
    version,
  });
}

// --- Retention policies -------------------------------------------------------------------

export async function createRetentionPolicy(
  input: unknown,
): Promise<ActionResult<RetentionPolicy>> {
  return validated(createRetentionPolicySchema, input, (body) =>
    adminWrite<RetentionPolicy>({ path: '/admin/retention-policies', method: 'POST', body }),
  );
}

export async function updateRetentionPolicy(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<RetentionPolicy>> {
  return validated(updateRetentionPolicySchema, input, (body) =>
    adminWrite<RetentionPolicy>({
      path: `/admin/retention-policies/${id}`,
      method: 'PATCH',
      body,
      version,
    }),
  );
}

export async function deleteRetentionPolicy(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/retention-policies/${id}`, method: 'DELETE', version });
}

export async function restoreRetentionPolicy(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/retention-policies/${id}/restore`, method: 'POST', version });
}

// --- Categories ---------------------------------------------------------------------------

export async function createCategory(input: unknown): Promise<ActionResult<Category>> {
  return validated(createCategorySchema, input, (body) =>
    adminWrite<Category>({ path: '/admin/categories', method: 'POST', body }),
  );
}

export async function updateCategory(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<Category>> {
  return validated(updateCategorySchema, input, (body) =>
    adminWrite<Category>({ path: `/admin/categories/${id}`, method: 'PATCH', body, version }),
  );
}

/** Re-parenting, separate for the same reason a department's is: it rewrites a subtree's ancestry. */
export async function moveCategory(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<Category>> {
  return validated(moveCategorySchema, input, (body) =>
    adminWrite<Category>({ path: `/admin/categories/${id}/move`, method: 'POST', body, version }),
  );
}

export async function deleteCategory(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/categories/${id}`, method: 'DELETE', version });
}

export async function restoreCategory(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/categories/${id}/restore`, method: 'POST', version });
}

// --- Metadata fields ----------------------------------------------------------------------

export async function createMetadataField(input: unknown): Promise<ActionResult<MetadataField>> {
  return validated(createMetadataFieldSchema, input, (body) =>
    adminWrite<MetadataField>({ path: '/admin/fields', method: 'POST', body }),
  );
}

export async function updateMetadataField(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<MetadataField>> {
  return validated(updateMetadataFieldSchema, input, (body) =>
    adminWrite<MetadataField>({ path: `/admin/fields/${id}`, method: 'PATCH', body, version }),
  );
}

export async function deleteMetadataField(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/fields/${id}`, method: 'DELETE', version });
}

export async function restoreMetadataField(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/fields/${id}/restore`, method: 'POST', version });
}

// --- Document types -----------------------------------------------------------------------

export async function createDocumentType(input: unknown): Promise<ActionResult<DocumentType>> {
  return validated(createDocumentTypeSchema, input, (body) =>
    adminWrite<DocumentType>({ path: '/admin/document-types', method: 'POST', body }),
  );
}

export async function updateDocumentType(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<DocumentType>> {
  return validated(updateDocumentTypeSchema, input, (body) =>
    adminWrite<DocumentType>({
      path: `/admin/document-types/${id}`,
      method: 'PATCH',
      body,
      version,
    }),
  );
}

export async function deleteDocumentType(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/document-types/${id}`, method: 'DELETE', version });
}

export async function restoreDocumentType(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/document-types/${id}/restore`, method: 'POST', version });
}

// --- Numbering rules ----------------------------------------------------------------------

export async function createNumberingRule(input: unknown): Promise<ActionResult<NumberingRule>> {
  return validated(createNumberingRuleSchema, input, (body) =>
    adminWrite<NumberingRule>({ path: '/admin/numbering-rules', method: 'POST', body }),
  );
}

export async function updateNumberingRule(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<NumberingRule>> {
  return validated(updateNumberingRuleSchema, input, (body) =>
    adminWrite<NumberingRule>({
      path: `/admin/numbering-rules/${id}`,
      method: 'PATCH',
      body,
      version,
    }),
  );
}

/**
 * Renders a sample from an unsaved rule.
 *
 * A `POST` that claims nothing, because there is nothing to `GET` — the rule being previewed does not
 * exist yet — and because drawing a real number to show a preview would burn one.
 */
export async function previewNumberingRule(
  input: unknown,
): Promise<ActionResult<NumberingPreview>> {
  return validated(previewNumberingRuleSchema, input, (body) =>
    adminWrite<NumberingPreview>({ path: '/admin/numbering-rules/preview', method: 'POST', body }),
  );
}

/** Sets a run of values aside for an offline process (`09-numbering-architecture.md` §3). */
export async function holdNumberBlock(
  ruleId: string,
  input: unknown,
): Promise<ActionResult<HeldNumberBlock>> {
  return validated(holdNumberBlockSchema, input, (body) =>
    adminWrite<HeldNumberBlock>({
      path: `/admin/numbering-rules/${ruleId}/held-blocks`,
      method: 'POST',
      body,
    }),
  );
}

/** Voids a held value a controller no longer needs. It is retained, never re-issued. */
export async function voidHeldNumber(
  ruleId: string,
  reservationId: string,
  input: unknown,
): Promise<ActionResult> {
  return validated(voidHeldNumberSchema, input, (body) =>
    adminWrite({
      path: `/admin/numbering-rules/${ruleId}/reservations/${reservationId}/void`,
      method: 'POST',
      body,
    }),
  );
}

export async function deleteNumberingRule(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/numbering-rules/${id}`, method: 'DELETE', version });
}

export async function restoreNumberingRule(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/admin/numbering-rules/${id}/restore`, method: 'POST', version });
}

// --- Settings -----------------------------------------------------------------------------

/**
 * Saves one setting.
 *
 * One key per request rather than the whole bag, matching the API: it merges in the database, so two
 * administrators saving different settings at the same time cannot drop each other's change — which a
 * read-modify-write of a whole bag would do, silently.
 */
export async function updateSetting(input: unknown): Promise<ActionResult<SettingsResponse>> {
  return validated(updateSettingSchema, input, (body) =>
    adminWrite<SettingsResponse>({ path: '/admin/settings', method: 'PUT', body }),
  );
}

/** Returns a setting to the product's default by removing the tenant's override. */
export async function resetSetting(input: unknown): Promise<ActionResult<SettingsResponse>> {
  return validated(resetSettingSchema, input, (body) =>
    adminWrite<SettingsResponse>({ path: '/admin/settings/reset', method: 'POST', body }),
  );
}

// --- Document templates ---------------------------------------------------------------------
//
// Phase 6.5. The five routes `DocumentTemplatesController` has carried since Phase 16 with nothing
// calling them: a complete CRUD contract, `template:manage`, soft delete and restore, and no way
// to reach any of it from the product. Written here rather than in a feature of its own because a
// template *is* configuration in the same family as a document type — it names one, and its whole
// purpose is to fix the defaults a new document of that type starts with.
//
// `POST /document-templates/:id/documents` is deliberately **not** here. Creating from a template
// is an ordinary `document:create` performed from the document library, not an administrative act,
// and putting it on this screen would put a create button behind `template:manage`.

export async function createDocumentTemplate(
  input: unknown,
): Promise<ActionResult<DocumentTemplate>> {
  return validated(createDocumentTemplateSchema, input, (body) =>
    adminWrite<DocumentTemplate>({ path: '/document-templates', method: 'POST', body }),
  );
}

export async function updateDocumentTemplate(
  id: string,
  version: number,
  input: unknown,
): Promise<ActionResult<DocumentTemplate>> {
  return validated(updateDocumentTemplateSchema, input, (body) =>
    adminWrite<DocumentTemplate>({
      path: `/document-templates/${id}`,
      method: 'PATCH',
      body,
      version,
    }),
  );
}

export async function deleteDocumentTemplate(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/document-templates/${id}`, method: 'DELETE', version });
}

export async function restoreDocumentTemplate(id: string, version: number): Promise<ActionResult> {
  return adminWrite({ path: `/document-templates/${id}/restore`, method: 'POST', version });
}

// --- Search index maintenance ---------------------------------------------------------------
//
// Phase 6.5. An **operator** action, not a user feature, which is why it is a button on the
// settings screen rather than a workspace of its own: 12 §12 separates user features from operator
// ones, and a full-index reprojection is the second. It has been reachable only by hand-crafting a
// request since Phase 8.
//
// Asynchronous already, and left that way. `POST /search/rebuild` answers `202` and the work runs
// on the search lane, resumable, exactly as Phase 6.2 requires of anything that could touch every
// document in a tenant. Nothing here waits for it; the status endpoint beside it is what reports
// progress, and both are the existing contract rather than a second job model.

export async function requestSearchRebuild(): Promise<ActionResult<SearchRebuild>> {
  return adminWrite<SearchRebuild>({ path: '/search/rebuild', method: 'POST' });
}
