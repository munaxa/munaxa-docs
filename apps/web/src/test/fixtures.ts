import type {
  AdministratorDashboard,
  ApprovalInboxItem,
  Document,
  DocumentSignature,
  DocumentSummary,
  Folder,
  Library,
  SearchHit,
  SearchResults,
  UserDashboard,
} from '@edms/contracts';
import { DocumentStatus } from '@edms/domain';

import type { ListState } from '../lib/admin/list-state';

/**
 * Fixtures for the rendered suites.
 *
 * Typed against the real contracts rather than cast, so a contract change breaks these at compile
 * time instead of producing a screen the tests render happily and nobody ships. That is the whole
 * value: a fixture that drifts is a test asserting a shape the API stopped returning.
 *
 * Values are deliberately boring except where a value is *load-bearing for accessibility* — a
 * document with no number, a task under a delegation, a result set with facets — because those are
 * the branches that render extra markup, and extra markup is where an unnamed control appears.
 */

const STAMPS = {
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: '019489f0-0000-7000-8000-00000000000a',
  updatedAt: '2026-01-02T00:00:00.000Z',
  updatedBy: '019489f0-0000-7000-8000-00000000000a',
  deletedAt: null,
  deletedBy: null,
} as const;

export function documentSummary(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    ...STAMPS,
    id: '019489f0-0000-7000-8000-000000000101',
    title: 'Quality Manual',
    status: DocumentStatus.PUBLISHED,
    documentNumber: 'QM-0001',
    folderId: '019489f0-0000-7000-8000-000000000201',
    folderName: 'Quality',
    documentTypeName: 'Manual',
    categoryName: 'Quality Management',
    confidentialityName: 'Internal',
    ownerUserId: '019489f0-0000-7000-8000-00000000000a',
    isFavorite: false,
    file: null,
    ...overrides,
  };
}

/**
 * A whole document, for the record screen.
 *
 * Phase 5.2 named `DocumentScreen` the largest uncovered surface precisely because this fixture did
 * not exist — sixteen props including a full document. It is typed against the contract like every
 * other fixture here, so a contract change breaks it at compile time rather than producing a screen
 * the tests render happily.
 *
 * `PUBLISHED` by default, because that is the state most of the record screen's affordances are
 * gated on — including Phase 6.1's archive.
 */
export function document(overrides: Partial<Document> = {}): Document {
  const revision = {
    id: '019489f0-0000-7000-8000-000000000401',
    ordinal: 0,
    label: 'Rev 0',
    status: 'PUBLISHED' as const,
    changeNote: null,
    createdAt: STAMPS.createdAt,
    createdBy: STAMPS.createdBy,
    file: {
      fileObjectId: '019489f0-0000-7000-8000-000000000501',
      filename: 'quality-manual.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      checksumSha256: 'a'.repeat(64),
      scanStatus: 'CLEAN' as const,
      reachable: true,
      thumbnailUrl: null,
    },
  };
  return {
    ...STAMPS,
    id: '019489f0-0000-7000-8000-000000000101',
    folderId: '019489f0-0000-7000-8000-000000000201',
    folderName: 'Quality',
    folderPath: 'quality',
    libraryId: '019489f0-0000-7000-8000-000000000301',
    libraryName: 'Quality',
    documentTypeId: '019489f0-0000-7000-8000-000000000601',
    documentTypeName: 'Manual',
    categoryId: null,
    categoryName: null,
    confidentialityId: '019489f0-0000-7000-8000-000000000701',
    confidentialityName: 'Internal',
    confidentialityRank: 10,
    title: 'Quality Manual',
    description: null,
    status: DocumentStatus.PUBLISHED,
    origin: 'UPLOAD',
    documentNumber: 'QM-0001',
    numberedAt: STAMPS.createdAt,
    pendingNumber: null,
    ownerUserId: STAMPS.createdBy,
    latestRevision: revision,
    currentRevision: revision,
    liveLock: null,
    metadata: [],
    isFavorite: false,
    ...overrides,
  };
}

/**
 * One electronic signature, as the API returns it — Phase 6.6.
 *
 * `statementBody` is deliberately absent, because the list response deliberately omits it:
 * `toSignature` on the controller does not map it, and only verification returns the signed bytes.
 * A fixture that invented the field would let a screen render something the API never sends.
 */
export function signature(overrides: Partial<DocumentSignature> = {}): DocumentSignature {
  return {
    id: '019489f0-0000-7000-8000-000000000801',
    documentId: '019489f0-0000-7000-8000-000000000101',
    revisionId: '019489f0-0000-7000-8000-000000000401',
    revisionLabel: 'Rev 0',
    signerUserId: 'test-user',
    signerName: 'Ada Lovelace',
    purpose: 'APPROVAL',
    statement: null,
    signedAt: '2026-02-01T09:30:00.000Z',
    reauthenticated: true,
    withdrawnAt: null,
    withdrawnReason: null,
    ...overrides,
  };
}

/** A row with nothing optional filled in — the branch that renders fallbacks. */
export function bareDocumentSummary(): DocumentSummary {
  return documentSummary({
    id: '019489f0-0000-7000-8000-000000000102',
    title: 'Untitled draft',
    status: DocumentStatus.DRAFT,
    documentNumber: null,
    categoryName: null,
    file: null,
  });
}

export function library(overrides: Partial<Library> = {}): Library {
  return {
    ...STAMPS,
    id: '019489f0-0000-7000-8000-000000000301',
    code: 'QUA',
    name: 'Quality',
    description: null,
    ownerScopeType: 'COMPANY',
    ownerScopeId: null,
    ownerScopeName: 'Munaxa',
    rootFolderId: '019489f0-0000-7000-8000-000000000200',
    folderCount: 1,
    ...overrides,
  };
}

export function folder(overrides: Partial<Folder> = {}): Folder {
  return {
    ...STAMPS,
    id: '019489f0-0000-7000-8000-000000000201',
    libraryId: '019489f0-0000-7000-8000-000000000301',
    libraryName: 'Quality',
    parentId: null,
    name: 'Procedures',
    description: null,
    path: '/Procedures',
    depth: 1,
    inheritAcl: true,
    isRoot: false,
    childCount: 0,
    ...overrides,
  };
}

export function listState(overrides: Partial<ListState> = {}): ListState {
  return {
    page: 1,
    pageSize: 25,
    sortBy: null,
    sortDirection: 'asc',
    search: '',
    deleted: 'live',
    filters: {},
    ...overrides,
  };
}

export function approvalInboxItem(overrides: Partial<ApprovalInboxItem> = {}): ApprovalInboxItem {
  return {
    id: '019489f0-0000-7000-8000-000000000401',
    workflowInstanceId: '019489f0-0000-7000-8000-000000000403',
    stageId: '019489f0-0000-7000-8000-000000000402',
    stageIndex: 0,
    stageName: 'Quality review',
    assigneeId: '019489f0-0000-7000-8000-00000000000a',
    assigneeName: 'Test Person',
    resolvedBy: 'ROLE',
    sequence: 1,
    state: 'PENDING',
    decision: null,
    decidedById: null,
    decidedByName: null,
    decidedAt: null,
    comment: null,
    onBehalfOfId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    dueAt: '2026-02-01T00:00:00.000Z',
    documentId: '019489f0-0000-7000-8000-000000000101',
    documentTitle: 'Quality Manual',
    documentNumber: 'QM-0001',
    documentTypeName: 'Manual',
    overdue: false,
    onBehalfOf: null,
    ...overrides,
    // The one assertion in this file, and it is necessary rather than lazy: spreading
    // `Partial<T>` widens every required-but-nullable field to include `undefined`, which
    // `onBehalfOf` and `comment` both are. The base above is exhaustive, so the shape is right.
  } as ApprovalInboxItem;
}

export function searchResults(overrides: Partial<SearchResults> = {}): SearchResults {
  return {
    data: [],
    meta: { total: 0, unrestricted: false },
    facets: {},
    nextCursor: null,
    ...overrides,
  };
}

/** The document type a hit points at, so a caller can build the `typeLabels` map that matches. */
export const SEARCH_HIT_TYPE_ID = '019489f0-0000-7000-8000-0000000000a1';

/**
 * One result — Phase 7.7B.
 *
 * The revision label is **`R2`**, which is what `revisionLabelFor` actually mints for ordinal 2
 * under the `NUMERIC` style. That matters: the screen used to wrap the label in "Rev {label}", so a
 * fixture whose label already said `Rev 0` was the only reason anybody saw the duplication. A
 * fixture carrying a label the domain really produces makes the assertion about the *product*.
 */
export function searchHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    documentId: '019489f0-0000-7000-8000-000000000201',
    score: 1,
    title: 'Batch release procedure',
    documentNumber: 'SOP-0001',
    status: DocumentStatus.PUBLISHED,
    documentTypeId: SEARCH_HIT_TYPE_ID,
    categoryId: null,
    libraryId: '019489f0-0000-7000-8000-000000000202',
    folderId: '019489f0-0000-7000-8000-000000000203',
    ownerId: '019489f0-0000-7000-8000-000000000204',
    filename: 'batch-release.pdf',
    revisionOrdinal: 2,
    revisionLabel: 'R2',
    language: 'en',
    bodySource: 'TEXT',
    contentPending: false,
    lowConfidence: false,
    confidentialityRank: 0,
    updatedAt: '2026-01-02T09:00:00.000Z',
    publishedAt: '2026-01-02T09:00:00.000Z',
    effectiveFrom: null,
    highlights: {},
    ...overrides,
  };
}

/** A populated result set, with the facet rail a real search comes back with. */
export function populatedSearchResults(): SearchResults {
  return searchResults({
    data: [searchHit()],
    meta: { total: 1, unrestricted: false },
    facets: {
      status: [{ value: DocumentStatus.PUBLISHED, count: 1 }],
      type: [{ value: SEARCH_HIT_TYPE_ID, count: 1 }],
      year: [{ value: '2026', count: 1 }],
    },
  });
}

// --- Dashboard --------------------------------------------------------------------------------

const READY_COUNT = { state: 'READY', count: 3 } as const;
/** A tile the caller may not see. Renders different markup from a counted one. */
const FORBIDDEN_COUNT = { state: 'FORBIDDEN', count: null } as const;

export function userDashboard(overrides: Partial<UserDashboard> = {}): UserDashboard {
  return {
    drafts: READY_COUNT,
    rejected: READY_COUNT,
    pending: READY_COUNT,
    overdue: { state: 'READY', count: 0 },
    checkedOut: READY_COUNT,
    favorites: READY_COUNT,
    unreadNotifications: READY_COUNT,
    activity: [
      {
        id: 'a1',
        occurredAt: '2026-01-02T09:00:00.000Z',
        action: 'DOCUMENT_APPROVED',
        subjectType: 'DOCUMENT',
        subjectId: '019489f0-0000-7000-8000-000000000101',
        outcome: 'SUCCESS',
      },
    ],
    delegations: [
      {
        id: 'd1',
        direction: 'RECEIVED',
        counterpartName: 'Other Person',
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: null,
      },
    ],
    ...overrides,
  };
}

export function administratorDashboard(
  overrides: Partial<AdministratorDashboard> = {},
): AdministratorDashboard {
  const breakdown = {
    state: 'READY' as const,
    total: 4,
    entries: [
      { key: 'DRAFT', count: 1 },
      { key: 'PUBLISHED', count: 3 },
    ],
  };

  return {
    anyGranted: true,
    documents: breakdown,
    workflow: breakdown,
    approvals: { state: 'READY', pending: 2, overdue: 1 },
    storage: {
      state: 'READY',
      blobCount: 10,
      storedBytes: 1024,
      referencedBytes: 1024,
      unreferencedBlobs: 0,
    },
    users: breakdown,
    departments: READY_COUNT,
    dispositionsDue: FORBIDDEN_COUNT,
    legalHolds: READY_COUNT,
    ...overrides,
  };
}
