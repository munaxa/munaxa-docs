/**
 * The demo starter configuration: what a fresh Testing or development tenant is given so that
 * somebody learning the product has libraries to file into, document types to choose from and
 * numbers that appear when a document is approved.
 *
 * **Data only.** Every entry here is written in the shape an administrator would send to the
 * HTTP API, and the seeder runs each one through the same `@edms/contracts` schema the controller
 * uses before handing it to the same application service. Nothing in this file is trusted: a value
 * that the administration screens would refuse is refused here too, by the same code.
 *
 * References between entries are by **code or key**, never by id. Ids are only known once the
 * referenced row exists in the tenant (or is found already existing on a re-run), so the seeder
 * resolves them as it goes.
 *
 * Deliberately generic — a small company with a quality system, people, finance and IT — because
 * this is for learning the application, not a template for any real customer. An administrator
 * edits, retires or deletes any of it from the administration screens like anything else.
 */

/** Departments created under the tenant's root entity (the one provisioning made). */
export const STARTER_DEPARTMENTS = [
  { code: 'QA', name: 'Quality Assurance' },
  { code: 'HR', name: 'Human Resources' },
  { code: 'FIN', name: 'Finance' },
  { code: 'OPS', name: 'Operations' },
  { code: 'IT', name: 'Information Technology' },
] as const;

/** Ranks are unique per tenant and compared by workflows, so they are spaced to leave room. */
export const STARTER_CONFIDENTIALITY = [
  {
    code: 'PUBLIC',
    name: 'Public',
    description: 'May be shared outside the organisation.',
    rank: 10,
    allowDownload: true,
    allowPrint: true,
    watermark: false,
    requireReason: false,
  },
  {
    code: 'INTERNAL',
    name: 'Internal',
    description: 'For everybody inside the organisation. The default for most documents.',
    rank: 20,
    allowDownload: true,
    allowPrint: true,
    watermark: false,
    requireReason: false,
  },
  {
    code: 'CONFIDENTIAL',
    name: 'Confidential',
    description: 'Limited to the people who need it. Downloads and prints are watermarked.',
    rank: 30,
    allowDownload: true,
    allowPrint: true,
    watermark: true,
    requireReason: false,
  },
  {
    code: 'RESTRICTED',
    name: 'Restricted',
    description: 'View only, with a stated reason recorded for every read.',
    rank: 40,
    allowDownload: false,
    allowPrint: false,
    watermark: true,
    requireReason: true,
  },
] as const;

export const STARTER_RETENTION = [
  {
    code: 'STD-7Y',
    name: 'Standard - 7 years after superseded',
    description:
      'Controlled documents are kept for seven years after a newer revision replaces them.',
    trigger: 'ON_SUPERSEDE',
    periodMonths: 84,
    disposition: 'ARCHIVE',
    reviewRequired: false,
  },
  {
    code: 'FIN-10Y',
    name: 'Financial - 10 years',
    description: 'Financial and contractual records are reviewed ten years after publication.',
    trigger: 'ON_PUBLISH',
    periodMonths: 120,
    disposition: 'REVIEW',
    reviewRequired: true,
  },
  {
    code: 'SHORT-2Y',
    name: 'Short term - 2 years after archive',
    description: 'Working records, reviewed by a person before anything is removed.',
    trigger: 'ON_ARCHIVE',
    periodMonths: 24,
    disposition: 'PURGE',
    reviewRequired: true,
  },
] as const;

/** Subject-matter categories. They cut across libraries; `parent` names another entry's code. */
export const STARTER_CATEGORIES = [
  { code: 'MS', name: 'Management System', parent: null },
  { code: 'AUDIT', name: 'Audits and Inspections', parent: 'MS' },
  { code: 'HSE', name: 'Health, Safety and Environment', parent: null },
  { code: 'PEOPLE', name: 'People', parent: null },
  { code: 'FINANCE', name: 'Finance', parent: null },
  { code: 'TECH', name: 'Technology', parent: null },
  { code: 'GENERAL', name: 'General', parent: null },
] as const;

export const STARTER_METADATA_FIELDS = [
  {
    key: 'effective-date',
    name: 'Effective date',
    description: 'The date from which the document applies.',
    dataType: 'DATE',
    options: [],
    validation: {},
    isSearchable: true,
  },
  {
    key: 'review-due',
    name: 'Next review due',
    description: 'When the document owner should next review the content.',
    dataType: 'DATE',
    options: [],
    validation: {},
    isSearchable: true,
  },
  {
    key: 'counterparty',
    name: 'Counterparty',
    description: 'The other party to a contract or the supplier on an invoice.',
    dataType: 'TEXT',
    options: [],
    validation: { maxLength: 200 },
    isSearchable: true,
  },
  {
    key: 'external-reference',
    name: 'External reference',
    description: 'A reference number issued by somebody else, such as a supplier invoice number.',
    dataType: 'TEXT',
    options: [],
    validation: { maxLength: 100 },
    isSearchable: true,
  },
  {
    key: 'amount',
    name: 'Amount',
    description: 'The total value, in the organisation currency.',
    dataType: 'NUMBER',
    options: [],
    validation: { minimum: 0 },
    isSearchable: true,
  },
  {
    key: 'contract-end',
    name: 'Contract end date',
    description: 'When the contract expires or must be renewed.',
    dataType: 'DATE',
    options: [],
    validation: {},
    isSearchable: true,
  },
  {
    key: 'language',
    name: 'Language',
    description: 'The language the document is written in.',
    dataType: 'SELECT',
    options: [
      { value: 'en', label: 'English' },
      { value: 'ar', label: 'Arabic' },
      { value: 'de', label: 'German' },
    ],
    validation: {},
    isSearchable: true,
  },
] as const;

/**
 * Three numbering patterns that between them show what the numbering engine does:
 *
 * - `controlled-document` — `POL-QA-0001`: the type code, the owning department when the folder has
 *   one, and a counter per document type that never resets.
 * - `yearly-record` — `INV-2026-00001`: the type code, the year, and a counter that restarts every
 *   January for each type.
 * - `general-sequence` — `DOC-000001`: one running number for everything that uses it.
 */
export const STARTER_NUMBERING_RULES = [
  {
    key: 'controlled-document',
    name: 'Controlled document',
    description: 'Type code, owning department when there is one, then a running number per type.',
    separator: '-',
    segments: [
      { kind: 'DOCUMENT_TYPE_CODE' },
      { kind: 'DEPARTMENT_CODE', optional: true },
      { kind: 'SEQUENCE', padding: 4 },
    ],
    resetScope: ['PER_DOCUMENT_TYPE'],
    reserveOnSubmit: true,
    strictGapless: false,
  },
  {
    key: 'yearly-record',
    name: 'Yearly record',
    description: 'Type code and year, with a running number that restarts each year per type.',
    separator: '-',
    segments: [
      { kind: 'DOCUMENT_TYPE_CODE' },
      { kind: 'YEAR', digits: 4 },
      { kind: 'SEQUENCE', padding: 5 },
    ],
    resetScope: ['PER_DOCUMENT_TYPE', 'YEARLY'],
    reserveOnSubmit: true,
    strictGapless: false,
  },
  {
    key: 'general-sequence',
    name: 'General sequence',
    description: 'One running number shared by every type that uses it.',
    separator: '-',
    segments: [
      { kind: 'LITERAL', value: 'DOC' },
      { kind: 'SEQUENCE', padding: 6 },
    ],
    resetScope: ['NEVER'],
    reserveOnSubmit: true,
    strictGapless: false,
  },
] as const;

/**
 * An approval group the starter workflow routes to.
 *
 * Seeded with the tenant's current administrators (see the seeder), so that a single person
 * testing the product can submit a document and approve it themselves. An administrator replaces
 * the members from Administration as soon as there are real colleagues to route to.
 */
export const STARTER_APPROVAL_GROUP = {
  key: 'document-approvers',
  name: 'Document approvers',
  description: 'Who approves controlled documents. Starts with the administrators; edit freely.',
} as const;

/** One stage, any member of the group may decide, five days with a reminder the day before. */
export const STARTER_WORKFLOW = {
  key: 'standard-approval',
  name: 'Standard approval',
  description: 'One approval by any member of the Document approvers group.',
  definition: {
    stages: [
      {
        name: 'Approval',
        participants: [{ kind: 'GROUP', groupKey: STARTER_APPROVAL_GROUP.key }],
        completionRule: 'ANY',
        ordered: false,
        condition: null,
        deadline: { duration: 'P5D' },
        reminders: [{ before: 'P1D' }],
        onOverdue: { action: 'NOTIFY_ONLY' },
      },
    ],
  },
} as const;

export interface StarterTypeField {
  readonly key: string;
  readonly isRequired: boolean;
}

export interface StarterDocumentType {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly numberingRule: string;
  /** `null` for a reference type that is published without approval. */
  readonly workflow: string | null;
  readonly retention: string | null;
  readonly confidentiality: string;
  readonly revisionLabelStyle: 'NUMERIC' | 'ALPHABETIC' | 'MAJOR_MINOR';
  readonly fields: readonly StarterTypeField[];
}

const CONTROLLED_FIELDS: readonly StarterTypeField[] = [
  { key: 'effective-date', isRequired: false },
  { key: 'review-due', isRequired: false },
  { key: 'language', isRequired: false },
];

export const STARTER_DOCUMENT_TYPES: readonly StarterDocumentType[] = [
  {
    code: 'POL',
    name: 'Policy',
    description: 'A statement of what the organisation commits to.',
    numberingRule: 'controlled-document',
    workflow: STARTER_WORKFLOW.key,
    retention: 'STD-7Y',
    confidentiality: 'INTERNAL',
    revisionLabelStyle: 'MAJOR_MINOR',
    fields: CONTROLLED_FIELDS,
  },
  {
    code: 'SOP',
    name: 'Standard Operating Procedure',
    description: 'How a process is carried out, step by step.',
    numberingRule: 'controlled-document',
    workflow: STARTER_WORKFLOW.key,
    retention: 'STD-7Y',
    confidentiality: 'INTERNAL',
    revisionLabelStyle: 'NUMERIC',
    fields: CONTROLLED_FIELDS,
  },
  {
    code: 'WI',
    name: 'Work Instruction',
    description: 'Detailed instructions for a single task.',
    numberingRule: 'controlled-document',
    workflow: STARTER_WORKFLOW.key,
    retention: 'STD-7Y',
    confidentiality: 'INTERNAL',
    revisionLabelStyle: 'NUMERIC',
    fields: CONTROLLED_FIELDS,
  },
  {
    code: 'FRM',
    name: 'Form',
    description: 'A blank form or template that people fill in.',
    numberingRule: 'controlled-document',
    workflow: STARTER_WORKFLOW.key,
    retention: 'STD-7Y',
    confidentiality: 'INTERNAL',
    revisionLabelStyle: 'ALPHABETIC',
    fields: [{ key: 'effective-date', isRequired: false }],
  },
  {
    code: 'CTR',
    name: 'Contract',
    description: 'An agreement with a customer, supplier or partner.',
    numberingRule: 'yearly-record',
    workflow: STARTER_WORKFLOW.key,
    retention: 'FIN-10Y',
    confidentiality: 'CONFIDENTIAL',
    revisionLabelStyle: 'NUMERIC',
    fields: [
      { key: 'counterparty', isRequired: true },
      { key: 'contract-end', isRequired: false },
      { key: 'amount', isRequired: false },
    ],
  },
  {
    code: 'INV',
    name: 'Invoice',
    description: 'A supplier invoice, kept as a record. No approval step.',
    numberingRule: 'yearly-record',
    workflow: null,
    retention: 'FIN-10Y',
    confidentiality: 'CONFIDENTIAL',
    revisionLabelStyle: 'NUMERIC',
    fields: [
      { key: 'counterparty', isRequired: true },
      { key: 'external-reference', isRequired: false },
      { key: 'amount', isRequired: false },
    ],
  },
  {
    code: 'RPT',
    name: 'Report',
    description: 'A management, audit or project report. No approval step.',
    numberingRule: 'yearly-record',
    workflow: null,
    retention: 'STD-7Y',
    confidentiality: 'INTERNAL',
    revisionLabelStyle: 'NUMERIC',
    fields: [{ key: 'language', isRequired: false }],
  },
  {
    code: 'MEMO',
    name: 'Memo',
    description: 'An internal note or announcement. No approval step.',
    numberingRule: 'general-sequence',
    workflow: null,
    retention: 'SHORT-2Y',
    confidentiality: 'INTERNAL',
    revisionLabelStyle: 'NUMERIC',
    fields: [],
  },
];

export interface StarterLibrary {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  /** `null` for a library owned by the whole organisation, else a department code above. */
  readonly department: string | null;
  readonly folders: readonly string[];
}

export const STARTER_LIBRARIES: readonly StarterLibrary[] = [
  {
    code: 'QMS',
    name: 'Quality Management',
    description: 'Policies, procedures, work instructions and forms of the management system.',
    department: null,
    folders: ['Policies', 'Procedures', 'Work Instructions', 'Forms'],
  },
  {
    code: 'HR',
    name: 'Human Resources',
    description: 'People policies and HR templates.',
    department: 'HR',
    folders: ['Policies', 'Templates'],
  },
  {
    code: 'FIN',
    name: 'Finance',
    description: 'Contracts, invoices and financial reports.',
    department: 'FIN',
    folders: ['Contracts', 'Invoices', 'Reports'],
  },
  {
    code: 'GEN',
    name: 'General',
    description: 'Memos, announcements and anything that does not belong elsewhere.',
    department: null,
    folders: ['Memos', 'Shared'],
  },
];
