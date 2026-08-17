import { describe, expect, it } from 'vitest';

import {
  categoryOptionSchema,
  confidentialityOptionSchema,
  documentTypeOptionSchema,
  typeFieldOptionSchema,
} from './configuration-read';
import { departmentOptionSchema, personOptionSchema } from './directory-read';
import { optionListQuerySchema } from './option-query';

/**
 * What the operational read models do **not** carry.
 *
 * ## Why absence is asserted by name
 *
 * These five shapes exist because the administrative ones carry more than the workflows that
 * consume them need — the tenant's security policy, an operations view of every account, the
 * organisation's headcount. Every one of those omissions is a security decision, and a security
 * decision expressed only as "we did not write that line" survives exactly until somebody adds the
 * line to fix an unrelated screen.
 *
 * So each exclusion below names the field and says why it is out. A test that asserted the shape
 * *positively* would pass just as happily with an extra property on it; these fail.
 */

/** Zod strips unknown keys, so a rejected field is one absent from the parsed value. */
function keysOf(schema: { parse: (value: unknown) => object }, input: Record<string, unknown>) {
  return new Set(Object.keys(schema.parse(input)));
}

describe('a person, as a picker sees them', () => {
  const parsed = keysOf(personOptionSchema, {
    id: '019489f0-0000-7000-8000-0000000000a1',
    displayName: 'Ada Lovelace',
    // Everything the administrative record adds, offered and expected to be dropped.
    email: 'ada@example.test',
    status: 'ACTIVE',
    mfaEnrolled: false,
    lastLoginAt: '2026-08-17T00:00:00.000Z',
    hasPassword: true,
    roles: [{ id: '019489f0-0000-7000-8000-0000000000b2', key: 'AUDITOR', name: 'Auditor' }],
    departments: [{ departmentId: '019489f0-0000-7000-8000-0000000000c3', isPrimary: true }],
    createdAt: '2026-08-17T00:00:00.000Z',
  });

  it('is an identifier and a label', () => {
    expect([...parsed].sort()).toEqual(['displayName', 'id']);
  });

  it.each([
    ['email', 'an address is how you contact somebody, not how you choose them in a list'],
    ['mfaEnrolled', 'enrolment gaps are a security report on the tenant'],
    ['lastLoginAt', 'who has not signed in is a security report on the tenant'],
    ['hasPassword', 'credential state belongs to the account, never to a picker'],
    ['status', 'the endpoint returns active people; the filter is not the caller’s to change'],
    ['roles', 'role membership is a map of who holds what authority'],
    ['departments', 'membership is the organisation chart, and this is a name in a dropdown'],
  ])('never carries %s — %s', (field) => {
    expect(parsed.has(field)).toBe(false);
  });
});

describe('a confidentiality level, as a picker sees it', () => {
  const parsed = keysOf(confidentialityOptionSchema, {
    id: '019489f0-0000-7000-8000-0000000000d4',
    code: 'INT',
    name: 'Internal',
    rank: 2,
    allowDownload: true,
    allowPrint: false,
    watermark: true,
    requireReason: true,
    description: 'Internal use only',
    documentTypeCount: 4,
    createdBy: '019489f0-0000-7000-8000-0000000000a1',
  });

  it('is a label and an order, because the order is what the form enforces', () => {
    expect([...parsed].sort()).toEqual(['code', 'id', 'name', 'rank']);
  });

  it.each([['allowDownload'], ['allowPrint'], ['watermark'], ['requireReason']])(
    'never carries %s, which is the tenant’s handling policy rather than a label',
    (field) => {
      expect(parsed.has(field)).toBe(false);
    },
  );

  it('never carries documentTypeCount, which exists to explain why a delete is blocked', () => {
    expect(parsed.has('documentTypeCount')).toBe(false);
  });
});

describe('a department, as a picker sees it', () => {
  const parsed = keysOf(departmentOptionSchema, {
    id: '019489f0-0000-7000-8000-0000000000e5',
    code: 'QA',
    name: 'Quality Assurance',
    path: 'Acme/Quality Assurance',
    memberCount: 12,
    childCount: 2,
    entityId: '019489f0-0000-7000-8000-0000000000f6',
    entityName: 'Acme Ltd',
    branchId: null,
    branchName: null,
    depth: 1,
  });

  it('is a label and its ancestry', () => {
    expect([...parsed].sort()).toEqual(['code', 'id', 'name', 'path']);
  });

  it.each([
    ['memberCount', 'headcount per organisational unit is not a picker’s business'],
    ['entityName', 'the corporate structure is Organization’s to administer'],
    ['branchName', 'the corporate structure is Organization’s to administer'],
  ])('never carries %s — %s', (field) => {
    expect(parsed.has(field)).toBe(false);
  });
});

describe('a document type, as the form that fills it in sees it', () => {
  const parsed = keysOf(documentTypeOptionSchema, {
    id: '019489f0-0000-7000-8000-000000000a11',
    code: 'SOP',
    name: 'Standard operating procedure',
    isActive: true,
    defaultConfidentialityId: '019489f0-0000-7000-8000-0000000000d4',
    fields: [],
    numberingRuleId: '019489f0-0000-7000-8000-000000000b22',
    numberingRuleName: 'SOP numbering',
    workflowDefinitionId: null,
    workflowDefinitionName: null,
    retentionPolicyId: null,
    retentionPolicyName: null,
    revisionLabelStyle: 'NUMERIC',
    description: 'The tenant’s procedures',
  });

  it('carries what a picker and a metadata form need', () => {
    expect([...parsed].sort()).toEqual([
      'code',
      'defaultConfidentialityId',
      'fields',
      'id',
      'isActive',
      'name',
    ]);
  });

  it.each([
    ['numberingRuleName', 'how a number is assembled is Administration’s'],
    ['retentionPolicyName', 'the retention schedule is Administration’s'],
    ['workflowDefinitionName', 'which approval runs is Administration’s'],
    ['revisionLabelStyle', 'nothing on the filing forms reads it'],
  ])('never carries %s — %s', (field) => {
    expect(parsed.has(field)).toBe(false);
  });

  it('keeps isActive, because the properties form must resolve a retired type', () => {
    // A type may be deactivated while documents already carry it. Dropping inactive types would
    // render an empty metadata section for every one of those documents.
    expect(parsed.has('isActive')).toBe(true);
  });
});

describe('a type’s field, as the form that fills it in sees it', () => {
  const parsed = keysOf(typeFieldOptionSchema, {
    metadataFieldId: '019489f0-0000-7000-8000-000000000c33',
    key: 'project',
    name: 'Project',
    dataType: 'SELECT',
    isRequired: true,
    sortOrder: 0,
    defaultValue: null,
    options: [{ value: 'alpha', label: 'Alpha' }],
    description: 'Which project this belongs to',
    validation: { pattern: '^[A-Z]+$', maxLength: 20 },
    isSearchable: true,
    documentTypeCount: 3,
  });

  it('carries the options and the hint, which is what removed the field catalogue as a dependency', () => {
    expect(parsed.has('options')).toBe(true);
    expect(parsed.has('description')).toBe(true);
  });

  it('never carries validation, which the API enforces and no client has ever rendered', () => {
    // A tenant-authored regular expression is a server-side rule. Shipping it invites a client to
    // pre-validate against a copy that will drift from the one that decides.
    expect(parsed.has('validation')).toBe(false);
  });

  it('never carries the catalogue-wide facts a single form has no use for', () => {
    expect(parsed.has('isSearchable')).toBe(false);
    expect(parsed.has('documentTypeCount')).toBe(false);
  });
});

describe('a category, as a picker sees it', () => {
  const parsed = keysOf(categoryOptionSchema, {
    id: '019489f0-0000-7000-8000-000000000d44',
    code: 'DRW',
    name: 'Drawings',
    parentId: null,
    path: 'Drawings',
    depth: 1,
    description: 'Engineering drawings',
    childCount: 7,
    createdBy: '019489f0-0000-7000-8000-0000000000a1',
  });

  it('is a label, its place in the tree, and nothing administered', () => {
    expect([...parsed].sort()).toEqual(['code', 'depth', 'id', 'name', 'parentId', 'path']);
  });
});

describe('an operational list query', () => {
  const schema = optionListQuerySchema(['name']);

  it('cannot ask for deleted rows, because the parameter does not exist', () => {
    // The administration lists offer `deleted=live|deleted|all`. A picker has no recycle bin, and
    // a withdrawn part of the vocabulary is not something a consumer may enumerate.
    const parsed = schema.parse({ page: '1', pageSize: '25', deleted: 'all' });
    expect('deleted' in parsed).toBe(false);
  });

  it('still pages, sorts and searches', () => {
    const parsed = schema.parse({ page: '2', pageSize: '10', sortBy: 'name', search: 'quality' });
    expect(parsed.page).toBe(2);
    expect(parsed.sortBy).toBe('name');
    expect(parsed.search).toBe('quality');
  });

  it('allow-lists the sortable columns', () => {
    expect(() => schema.parse({ sortBy: 'passwordHash' })).toThrow();
  });
});
