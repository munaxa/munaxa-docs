import type { DocumentId, UserId } from '@edms/domain';

/**
 * The dashboard owns no data.
 *
 * It composes what other modules already expose — the approval inbox, recent documents,
 * overdue tasks — so a widget cannot become a second, divergent definition of "overdue".
 *
 * **Phase 13 keeps that literally true rather than approximately.** This module has no
 * `infrastructure/` folder and no Prisma import anywhere in it. What it needs from each
 * contributing module is declared below in *the dashboard's* vocabulary, and implemented by the
 * module that owns the table — the inverted-dependency shape Document already uses for
 * `REVISION_WRITER` and `DOCUMENT_CONTENT_GATE`. The composition root binds them; nothing here
 * imports another module.
 *
 * The alternative — one query service in this module issuing its own aggregate SQL — is what the
 * paragraph above forbids. A `SELECT count(*) … WHERE due_at < now()` written here would be the
 * second definition of "overdue", and the day it disagrees with the inbox the dashboard is the one
 * people believe. Every adapter that satisfies one of these ports is built from the *same*
 * predicate function its module's own list is built from; that is the property, and it is asserted
 * in the integration suite rather than asked for in review.
 */
export const DASHBOARD_SERVICE = Symbol('DashboardService');

/**
 * The four-field summary Phase 0.5 declared.
 *
 * Kept exactly as shipped. Phase 13 serves a wider object than this, and widening *this* interface
 * would have changed a contract that had been stable since the skeleton — so the richer read is its
 * own type and `summaryFor` is answered from it rather than by four queries of its own.
 */
export interface DashboardSummary {
  readonly pendingApprovals: number;
  readonly overdueApprovals: number;
  readonly myDrafts: number;
  readonly recentDocumentIds: readonly DocumentId[];
}

// --- What one widget answers with -------------------------------------------------------------

/**
 * A tile's three-valued state, on the inside of the API as well as on the wire.
 *
 * `FORBIDDEN` is a permission answer and is stable — refreshing will not change it. `UNAVAILABLE`
 * is a source that did not respond. Keeping them apart inside the service, rather than mapping both
 * to null at the edge, is what stops a failing query reading as "you may not see this" and sending
 * somebody to ask for a permission they already hold.
 */
export type TileState = 'READY' | 'FORBIDDEN' | 'UNAVAILABLE';

export interface Tile<TValue> {
  readonly state: TileState;
  readonly value: TValue | null;
}

export function ready<TValue>(value: TValue): Tile<TValue> {
  return { state: 'READY', value };
}

export function forbidden<TValue>(): Tile<TValue> {
  return { state: 'FORBIDDEN', value: null };
}

export function unavailable<TValue>(): Tile<TValue> {
  return { state: 'UNAVAILABLE', value: null };
}

export interface CountBreakdown {
  readonly total: number;
  /** One entry per key present in the data; a key with no rows is simply absent. */
  readonly entries: readonly { readonly key: string; readonly count: number }[];
}

// --- What Dashboard needs from Document -------------------------------------------------------

export const DASHBOARD_DOCUMENT_METRICS = Symbol('DashboardDocumentMetrics');

/**
 * Implemented in the Document module, over the same `where` builder its list uses.
 *
 * That is the point of the seam rather than an implementation detail: `countsForOwner` and
 * `list({ ownerUserId, status })` produce the same predicate from the same function, so "you have
 * 4 drafts" and the four rows behind the link are the same question asked twice. A count assembled
 * independently would be one release away from being wrong.
 */
export interface DashboardDocumentMetrics {
  /** The caller's own documents by lifecycle status. */
  countsForOwner(ownerUserId: UserId): Promise<CountBreakdown>;
  /** Documents this person holds a live, unexpired check-out lock on. */
  countCheckedOutBy(userId: UserId, at: Date): Promise<number>;
  countFavorites(userId: UserId): Promise<number>;
  /**
   * This person's own reading history, newest first.
   *
   * Read only by `summaryFor`, which is Phase 0.5's declared contract and names the field. The
   * dashboard *screen* does not use it: its "Recently opened" card calls `GET /documents/recent`,
   * which is the same list, already projected by the module that owns documents.
   */
  recentDocumentIds(userId: UserId, limit: number): Promise<readonly DocumentId[]>;
  /** Tenant-wide, by status — the administrator tile. Gated by its caller, never here. */
  countsByStatus(): Promise<CountBreakdown>;
}

// --- What Dashboard needs from Workflow -------------------------------------------------------

export const DASHBOARD_APPROVAL_METRICS = Symbol('DashboardApprovalMetrics');

export interface ApprovalCounts {
  readonly pending: number;
  readonly overdue: number;
}

export interface DashboardApprovalMetrics {
  /**
   * How many tasks await these people, and how many of those are overdue.
   *
   * `assigneeIds` rather than one identifier, because Phase 11's cover is resolved by the caller —
   * who may be covered is Identity's answer, and a read model that asked would be a read model
   * holding a policy. The inbox passes the same set for the same reason.
   */
  countsForAssignees(assigneeIds: readonly UserId[]): Promise<ApprovalCounts>;
  /** Tenant-wide, for the administrator tile. */
  tenantCounts(): Promise<ApprovalCounts>;
  /** Workflow instances by state — the administrator's "Workflow" tile. */
  instanceCountsByState(): Promise<CountBreakdown>;
}

// --- What Dashboard needs from Storage --------------------------------------------------------

export const DASHBOARD_STORAGE_METRICS = Symbol('DashboardStorageMetrics');

export interface StorageUsage {
  readonly blobCount: number;
  /** What the blobs occupy — one row per distinct content, because they are deduplicated. */
  readonly storedBytes: number;
  /** What they would occupy if every reference were its own copy: `sum(size × ref_count)`. */
  readonly referencedBytes: number;
  /** `ref_count = 0`: what a reclamation sweep would remove. */
  readonly unreferencedBlobs: number;
}

/**
 * Bytes held, never bytes allowed.
 *
 * There is no entitlement in this interface and there deliberately cannot be one: Phase 10 recorded
 * "no quota accounting" as a limit, and what a tenant *may* store is ADR-0012's data and Phase 21's
 * enforcement. A method here called `quotaBytes` would be this module inventing the denominator
 * every "% full" gauge in the product would then divide by.
 */
export interface DashboardStorageMetrics {
  usage(): Promise<StorageUsage>;
}

// --- What Dashboard needs from Identity and Organization --------------------------------------

export const DASHBOARD_PEOPLE_METRICS = Symbol('DashboardPeopleMetrics');

export interface DashboardPeopleMetrics {
  /** Users by account state. Counts only — naming them is Administration's list. */
  countsByState(): Promise<CountBreakdown>;
}

export const DASHBOARD_ORGANIZATION_METRICS = Symbol('DashboardOrganizationMetrics');

export interface DashboardOrganizationMetrics {
  countDepartments(): Promise<number>;
}

/**
 * Phase 11's deferred widget, and the cover the pending count needs.
 *
 * Optional in the composition root: a deployment without delegation bound serves a dashboard with
 * no delegation card and a pending count of the caller's own tasks — which is exactly what the
 * inbox serves in the same composition. Failing to start would make the dashboard the thing that
 * decides delegation is mandatory.
 */
export const DASHBOARD_DELEGATION_METRICS = Symbol('DashboardDelegationMetrics');

export interface DashboardDelegation {
  readonly id: string;
  /** Which way round the arrangement runs, from the dashboard reader's point of view. */
  readonly direction: 'GIVEN' | 'RECEIVED';
  readonly counterpartId: UserId;
  readonly counterpartName: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
}

export interface DashboardDelegationMetrics {
  /** Whom this person may currently act for, under the permission the inbox routes on. */
  coveredBy(userId: UserId, at: Date): Promise<readonly UserId[]>;
  /** Every arrangement in force for this person, in either direction. */
  activeFor(userId: UserId, at: Date): Promise<readonly DashboardDelegation[]>;
}

/**
 * Phase 12's badge, on the endpoint built for it.
 *
 * Optional for the same reason as delegation. `GET /notifications/unread-count` exists precisely so
 * a badge has something to call, and this is the in-process equivalent — the dashboard composes
 * server-side and calling its own API over HTTP to render one number would be a round trip through
 * the guard chain to reach a service already in the container.
 */
export const DASHBOARD_NOTIFICATION_METRICS = Symbol('DashboardNotificationMetrics');

export interface DashboardNotificationMetrics {
  unreadCount(userId: UserId): Promise<number>;
}

// --- What Dashboard needs from Retention ------------------------------------------------------

export const DASHBOARD_RETENTION_METRICS = Symbol('DashboardRetentionMetrics');

/**
 * Two numbers, and they answer to two different people.
 *
 * `retention:manage` holds the disposition queue: how much is due for review is a
 * records-management workload. `legal-hold:manage` holds the register: *which* records are held,
 * and on what matter, is counsel's business — the retention controller already reads holds behind
 * the same grant as writing them, deliberately, and a dashboard that leaked the count under the
 * looser permission would undo that in one tile.
 */
export interface DashboardRetentionMetrics {
  /** Schedules due or awaiting review — the queue the retention screen renders in full. */
  countDispositionsDue(at: Date): Promise<number>;
  countLiveLegalHolds(): Promise<number>;
}

// --- The service ------------------------------------------------------------------------------

export interface UserDashboardView {
  readonly drafts: Tile<number>;
  readonly rejected: Tile<number>;
  readonly pending: Tile<number>;
  readonly overdue: Tile<number>;
  readonly checkedOut: Tile<number>;
  readonly favorites: Tile<number>;
  readonly unreadNotifications: Tile<number>;
  readonly activity: readonly DashboardActivity[];
  readonly delegations: readonly DashboardDelegation[];
}

/** One line of the caller's own trail, as the card renders it. */
export interface DashboardActivity {
  readonly id: string;
  readonly occurredAt: Date;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcome: string;
}

export interface AdministratorDashboardView {
  readonly anyGranted: boolean;
  readonly documents: Tile<CountBreakdown>;
  readonly workflow: Tile<CountBreakdown>;
  readonly approvals: Tile<ApprovalCounts>;
  readonly storage: Tile<StorageUsage>;
  readonly users: Tile<CountBreakdown>;
  readonly departments: Tile<number>;
  readonly dispositionsDue: Tile<number>;
  readonly legalHolds: Tile<number>;
}

export interface DashboardService {
  summaryFor(userId: UserId): Promise<DashboardSummary>;
  userDashboard(userId: UserId): Promise<UserDashboardView>;
  administratorDashboard(): Promise<AdministratorDashboardView>;
}
