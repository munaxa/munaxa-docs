/**
 * Which fields a list may be sorted by, and which query parameters it accepts as filters.
 *
 * ## Why these live here rather than beside the screens that describe them
 *
 * They used to be `export const` in the screen modules, every one of which begins `'use client'`.
 * A server page importing a value from a client module does not receive the value: Next replaces
 * client-module exports with **client references**, so `new Set(FILTER_KEYS)` received a function
 * and threw
 *
 *     TypeError: function is not iterable (cannot read property Symbol(Symbol.iterator))
 *
 * before the page rendered anything. Twelve screens — the document library and eleven
 * administrative lists — answered `500` in every built deployment, and nothing noticed, because
 * nothing had ever opened the built application. Phase 6.9 opened them.
 *
 * It is the same defect Phase 6.6 found in `EMPTY_FORM_STATE`, in a different guise: a
 * non-function value crossing a boundary that only carries functions. A plain module has no
 * boundary to cross, which is why this file exists and why nothing in it may become a component.
 *
 * The nine screens that happened to survive did so only because they pass no filter keys —
 * `new Set([])` on a default. They are moved too: a latent trap that fires the day somebody adds a
 * filter is not a trap worth keeping.
 */

export const GROUP_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'key'] as const;

export const GROUP_FILTER_KEYS = ['isActive'] as const;

export const CALENDAR_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'code'] as const;

export const CALENDAR_FILTER_KEYS = ['isActive', 'entityId'] as const;

export const CATEGORY_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'code', 'path'] as const;

export const CONFIDENTIALITY_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'name',
  'code',
  'rank',
] as const;

export const DOCUMENT_TYPE_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'code'] as const;

export const DOCUMENT_TYPE_FILTER_KEYS = [
  'isActive',
  'workflowDefinitionId',
  'retentionPolicyId',
] as const;

export const FIELD_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'key'] as const;

export const FIELD_FILTER_KEYS = ['dataType'] as const;

export const NUMBERING_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'key'] as const;

export const RETENTION_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'code'] as const;

export const RETENTION_FILTER_KEYS = ['trigger', 'disposition'] as const;

export const TEMPLATE_SORT_FIELDS = ['createdAt', 'updatedAt', 'name'] as const;

export const ROLE_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'key'] as const;

export const USER_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'displayName',
  'email',
  'lastLoginAt',
] as const;

export const USER_FILTER_KEYS = ['status', 'roleId', 'departmentId'] as const;

export const API_CLIENT_SORT_FIELDS = ['createdAt'] as const;

export const WEBHOOK_SORT_FIELDS = ['createdAt'] as const;

export const FOLDER_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'path'] as const;

export const LIBRARY_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'code'] as const;

export const LIBRARY_FILTER_KEYS = ['ownerScopeType', 'ownerScopeId'] as const;

export const BRANCH_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'code'] as const;

export const BRANCH_FILTER_KEYS = ['entityId'] as const;

/** Sorting is allow-listed by the endpoint; this is the same list, so the grid offers only those. */
export const COMPANY_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'code'] as const;

export const DEPARTMENT_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'code', 'path'] as const;

export const DEPARTMENT_FILTER_KEYS = ['entityId', 'branchId'] as const;

export const ENTITY_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'code'] as const;

export const ENTITY_FILTER_KEYS = ['companyId'] as const;

export const WORKFLOW_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'key'] as const;

export const WORKFLOW_FILTER_KEYS = ['isActive', 'state'] as const;

export const DOCUMENT_SORT_FIELDS = ['createdAt', 'updatedAt', 'title', 'status'] as const;

export const DOCUMENT_FILTER_KEYS = [
  'libraryId',
  'folderId',
  'underFolderId',
  'documentTypeId',
  'categoryId',
  'confidentialityId',
  'status',
  'favorite',
  /**
   * Phase 13's two dashboard links, so the tile and the list it points at describe the same rows.
   *
   * A count nobody can open is a count nobody can check, and the dashboard's whole claim is that
   * its numbers *are* the lists. Adding them here rather than only to the API is what makes
   * `/documents?ownerUserId=…&status=DRAFT` render the four drafts the "Drafts" tile counted
   * instead of silently ignoring the filter and showing the library.
   */
  'ownerUserId',
  'lockedByMe',
] as const;
