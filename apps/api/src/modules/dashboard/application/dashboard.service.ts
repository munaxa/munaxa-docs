import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  type AnyId,
  type PermissionKey,
  type UserId,
  DocumentStatus,
  Permission,
  ScopeType,
  asId,
} from '@edms/domain';

import { ACTIVITY_READER, type ActivityReader } from '../../../core/activity/activity.port';
import {
  ACL_RESOLVER,
  type AclResolver,
  type AuthorizationSubject,
} from '../../../core/authorization/acl-resolver.port';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  DASHBOARD_APPROVAL_METRICS,
  DASHBOARD_DELEGATION_METRICS,
  DASHBOARD_DOCUMENT_METRICS,
  DASHBOARD_NOTIFICATION_METRICS,
  DASHBOARD_ORGANIZATION_METRICS,
  DASHBOARD_PEOPLE_METRICS,
  DASHBOARD_RETENTION_METRICS,
  DASHBOARD_STORAGE_METRICS,
  type AdministratorDashboardView,
  type CountBreakdown,
  type DashboardActivity,
  type DashboardApprovalMetrics,
  type DashboardDelegation,
  type DashboardDelegationMetrics,
  type DashboardDocumentMetrics,
  type DashboardNotificationMetrics,
  type DashboardOrganizationMetrics,
  type DashboardPeopleMetrics,
  type DashboardRetentionMetrics,
  type DashboardService,
  type DashboardStorageMetrics,
  type DashboardSummary,
  type Tile,
  type UserDashboardView,
  forbidden,
  ready,
  unavailable,
} from './ports';

/**
 * The dashboard, composed.
 *
 * ---
 *
 * ## The scoping rule, stated once so a widget added later inherits it rather than re-deriving it
 *
 * A count is a disclosure. 08 §7 is explicit that fetch-then-filter "leaks totals, facet counts and
 * page boundaries" — which is why Phase 8 pushed the predicate into SQL — and a dashboard is
 * nothing but totals and counts. So every widget in this file answers to exactly one of two
 * sentences, and there is no third:
 *
 * 1. **A user widget is a query whose predicate names the caller.** Drafts and rejected are
 *    `owner_user_id = caller`; pending and overdue are `assignee_id IN (caller + their cover)`;
 *    checked out is `locked_by = caller`; favourites and recents are keyed on the caller; the
 *    activity feed is `forActor(caller)`. None of them can be made to answer a question about
 *    anybody else's work, because there is no parameter by which to ask — the same
 *    enforcement-by-absence the notification and delegation controllers use. That is why the whole
 *    user object sits behind one ordinary grant rather than behind a permission per tile: a widget
 *    that can only ever count the caller's own rows needs no further gate.
 *
 * 2. **An administrator widget crosses the tenant, so it is gated on the permission that already
 *    governs the screen it summarises**, and it is *absent* rather than zero when the caller does
 *    not hold it. Those are different answers: `FORBIDDEN` says "you may not ask", `READY: 0` says
 *    "there are none". Collapsing them would make the first screen everybody opens a daily report
 *    on how much exists in the parts of the tenant they cannot see into — and the day the real
 *    number stops being zero, they would learn that too.
 *
 * A new widget picks a sentence. If it fits neither — if it crosses the tenant and no existing
 * permission governs it — it is not a dashboard tile; it is a report, and reports are Phase 15's.
 *
 * ---
 *
 * ## What this deliberately does not do: apply an ACL predicate its source does not
 *
 * Phase 8 built `visibilityFilter` so a list is filtered in SQL, and the search index consumes it.
 * The document *list* does not, today: it is gated by the tenant-level `document:view` grant and
 * scoped by RLS, which is the whole of the discrimination this generation of `PrismaAclResolver`
 * can make — its own comment says so, since with no ACL entries on any chain every decision falls
 * through to the role grant.
 *
 * So a document count here applies exactly what the list applies, and no more. That is not a
 * shortcut; it is the module README's rule. A count filtered more tightly than the list it
 * summarises would be a second, divergent definition of "your documents", and the first screen of
 * the product would disagree with the second. When the ACL phase pushes `visibilityFilter` into the
 * document list, these counts inherit it in the same commit **without this file changing**, because
 * they are built from that list's own predicate. Phases 11 and 12 each declined to extend the
 * resolver and recorded why; this one declines for the same reason and one more — extending it
 * *here* would make the dashboard the only screen in the product enforcing a rule the library did
 * not.
 *
 * ---
 *
 * ## Cost, and why there is no cache
 *
 * This is the most-loaded route in the product — the one every session opens first — and the naive
 * implementation is one round trip per widget. Three decisions bound it:
 *
 * - **Each widget runs in its own unit of work, and they run together.** `UnitOfWork.run` joins an
 *   outer transaction when one exists, so composing inside a single `run` would let one failing
 *   widget abort every other. Independent transactions are what allow a slow or broken source to
 *   degrade to `UNAVAILABLE` on its own card while the rest of the page renders — the answer to
 *   "what does a widget do when its source is slow rather than making the whole page wait".
 * - **The query count is bounded by the number of widgets, never by the number of rows.** Every
 *   metric is an aggregate in the database — `count` or `groupBy` — so a tenant with a million
 *   documents costs what a tenant with ten costs, in queries. The two list cards take a bounded
 *   `LIMIT`. Nothing here is N+1, and the integration suite asserts the bound rather than trusting
 *   it.
 * - **Nothing is cached, and that is a decision rather than an omission.** 16 §4 assigns staleness
 *   to the approval inbox, document detail and admin configuration; it assigns none to this.
 *   `CACHE_PORT` is bound and per-tenant and would work — but a cached count is a stale count
 *   somebody acts on, and every number here is about *work waiting for the person reading it*.
 *   Being told three approvals are pending when four are is the failure this screen exists to
 *   prevent. Caching the tenant-wide administrator tiles alone was the tempting middle, and it is
 *   worse: they are the numbers somebody reports upward.
 *
 * ---
 *
 * ## This writes nothing, so it has no audit action, and 13 §2 gains no Dashboard group
 *
 * Worth stating rather than leaving to be inferred. Phase 9 already buffers read auditing for
 * documents above a confidentiality rank, and a *count* is not a read of a document: nothing here
 * opens a record, and a row per dashboard load would add one event per person per session to a
 * table that already carries one per document view, answering no question the underlying acts do
 * not. The activity card surfaces only what the trail already contains — `activity.port.ts`'s own
 * constraint — because it reads *through* `ACTIVITY_READER` rather than around it.
 */
@Injectable()
export class DefaultDashboardService implements DashboardService {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
    @Inject(ACTIVITY_READER) private readonly activity: ActivityReader,
    @Inject(DASHBOARD_DOCUMENT_METRICS) private readonly documents: DashboardDocumentMetrics,
    @Inject(DASHBOARD_APPROVAL_METRICS) private readonly approvals: DashboardApprovalMetrics,
    @Inject(DASHBOARD_STORAGE_METRICS) private readonly storage: DashboardStorageMetrics,
    @Inject(DASHBOARD_PEOPLE_METRICS) private readonly people: DashboardPeopleMetrics,
    @Inject(DASHBOARD_ORGANIZATION_METRICS)
    private readonly organization: DashboardOrganizationMetrics,
    @Inject(DASHBOARD_RETENTION_METRICS) private readonly retention: DashboardRetentionMetrics,
    @Inject(LOGGER) private readonly logger: Logger,
    /**
     * Time, through the port, like everything else that does arithmetic on "now".
     *
     * Three widgets ask a question about an instant — is this lock still live, is this task past
     * its deadline, is this schedule due — and a `new Date()` in this file would be the hidden
     * clock read `clock.port.ts` exists to remove. It would also make the one instant three:
     * composed in parallel, each widget would read a slightly different "now", and the pending and
     * overdue counts could disagree about a task whose deadline fell between them.
     */
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    /**
     * The two optional capabilities, for the reason the approval controller's delegation gate is
     * optional: a composition without them serves a narrower dashboard rather than refusing to
     * start, and the narrower one is exactly what the inbox serves in the same composition.
     */
    @Optional()
    @Inject(DASHBOARD_DELEGATION_METRICS)
    private readonly delegations: DashboardDelegationMetrics | null = null,
    @Optional()
    @Inject(DASHBOARD_NOTIFICATION_METRICS)
    private readonly notifications: DashboardNotificationMetrics | null = null,
  ) {}

  /**
   * Phase 0.5's four-field contract, answered from the composed view.
   *
   * Kept because it was declared, and served from the same reads as everything else rather than by
   * four queries of its own — otherwise there would be two definitions of "my drafts" inside the
   * one module that exists to prevent exactly that.
   */
  async summaryFor(userId: UserId): Promise<DashboardSummary> {
    const [view, recentDocumentIds] = await Promise.all([
      this.userDashboard(userId),
      // Read here rather than inside `userDashboard`, because the screen does not want it: its
      // "Recently opened" card calls `/documents/recent`, which is the same list already projected
      // by the module that owns documents. Composing it into the hot path for one caller that does
      // not exist on the hot path would be a query per dashboard load for nothing.
      this.list(() => this.documents.recentDocumentIds(userId, CARD_ROWS), 'documents.recent'),
    ]);
    return {
      pendingApprovals: view.pending.value ?? 0,
      overdueApprovals: view.overdue.value ?? 0,
      myDrafts: view.drafts.value ?? 0,
      recentDocumentIds,
    };
  }

  /**
   * The caller's own dashboard.
   *
   * `assigneeIds` is the caller plus whomever they currently cover, resolved by Identity exactly as
   * the inbox resolves it. Phase 11's rule is that a delegate's own inbox *contains* the
   * delegator's tasks, so a pending count naming only the caller would be smaller than the inbox it
   * summarises — and somebody covering a colleague's leave would read "0 pending" above a list of
   * six.
   */
  async userDashboard(userId: UserId): Promise<UserDashboardView> {
    // Read once for the whole composition, so every widget answers about the same instant.
    const now = this.clock.now();
    const assigneeIds = await this.assigneesFor(userId, now);

    const [ownerCounts, checkedOut, favorites, approvalCounts, unread, activity, delegations] =
      await Promise.all([
        this.tile(() => this.documents.countsForOwner(userId), 'documents.owner'),
        this.tile(() => this.documents.countCheckedOutBy(userId, now), 'documents.checkedOut'),
        this.tile(() => this.documents.countFavorites(userId), 'documents.favorites'),
        this.tile(() => this.approvals.countsForAssignees(assigneeIds), 'approvals.mine'),
        this.optionalTile(
          this.notifications === null ? null : () => this.notifications!.unreadCount(userId),
          'notifications.unread',
        ),
        this.list(() => this.recentActivity(userId), 'activity'),
        this.list(
          () =>
            this.delegations === null
              ? Promise.resolve<readonly DashboardDelegation[]>([])
              : this.delegations.activeFor(userId, now),
          'delegations',
        ),
      ]);

    return {
      drafts: statusTile(ownerCounts, DocumentStatus.DRAFT),
      rejected: statusTile(ownerCounts, DocumentStatus.REJECTED),
      pending: mapTile(approvalCounts, (counts) => counts.pending),
      overdue: mapTile(approvalCounts, (counts) => counts.overdue),
      checkedOut,
      favorites,
      unreadNotifications: unread,
      activity,
      delegations,
    };
  }

  /**
   * The tenant-wide dashboard, one permission at a time.
   *
   * The permissions are resolved in **one** `capabilitiesFor` call against the tenant scope rather
   * than one `resolve` per tile — and not merely to save round trips. The resolver is "the single
   * place an authorisation decision is made", and eight decisions taken a few milliseconds apart
   * are eight chances for the answer to change mid-render: a role revoked between the storage tile
   * and the users tile would produce a screen that was never true at any instant.
   *
   * Reading the token's `permissions` list instead would have been cheaper still, and is wrong: 08
   * §3 makes collecting the subject the resolver's job, and the token is a snapshot taken at
   * sign-in.
   */
  async administratorDashboard(): Promise<AdministratorDashboardView> {
    const context = requireContext();
    const now = this.clock.now();
    const subject: AuthorizationSubject = {
      userId: context.userId ?? asId<UserId>(''),
      roleIds: context.roles.map((role) => asId<AnyId>(role)),
      departmentIds: [],
      delegationIds: [],
    };

    const capabilities = await this.unitOfWork.run(() =>
      this.acl.capabilitiesFor(
        subject,
        { type: ScopeType.TENANT, id: asId<AnyId>(context.tenantId) },
        TILE_PERMISSIONS,
      ),
    );
    const holds = (permission: PermissionKey): boolean => capabilities[permission] === true;

    const [documents, workflow, approvals, storage, users, departments, dispositions, legalHolds] =
      await Promise.all([
        this.gated(
          holds(Permission.REPORT_VIEW),
          () => this.documents.countsByStatus(),
          'admin.documents',
        ),
        this.gated(
          holds(Permission.REPORT_VIEW),
          () => this.approvals.instanceCountsByState(),
          'admin.workflow',
        ),
        this.gated(
          holds(Permission.REPORT_VIEW),
          () => this.approvals.tenantCounts(),
          'admin.approvals',
        ),
        this.gated(holds(Permission.REPORT_VIEW), () => this.storage.usage(), 'admin.storage'),
        this.gated(holds(Permission.USER_MANAGE), () => this.people.countsByState(), 'admin.users'),
        this.gated(
          holds(Permission.ORG_MANAGE),
          () => this.organization.countDepartments(),
          'admin.departments',
        ),
        this.gated(
          holds(Permission.RETENTION_MANAGE),
          () => this.retention.countDispositionsDue(now),
          'admin.dispositions',
        ),
        this.gated(
          holds(Permission.LEGAL_HOLD_MANAGE),
          () => this.retention.countLiveLegalHolds(),
          'admin.legalHolds',
        ),
      ]);

    return {
      anyGranted: TILE_PERMISSIONS.some(holds),
      documents,
      workflow,
      approvals,
      storage,
      users,
      departments,
      dispositionsDue: dispositions,
      legalHolds,
    };
  }

  // --- Composition mechanics ------------------------------------------------------------------

  /**
   * One widget, in its own transaction, unable to take the page down with it.
   *
   * A rejection becomes `UNAVAILABLE` and a log line rather than a failed request. That is the
   * trade this screen wants and very few others do: a document page that cannot load its document
   * has nothing honest to render, and a dashboard that cannot load one of nine cards has eight.
   *
   * It is deliberately not a *timeout*. A per-widget deadline needs a number nothing has measured,
   * and abandoning a query the database is still running does not make it cheaper — it makes the
   * connection unavailable *and* the work wasted. The pool bounds this already, and a source slow
   * enough to matter here is a source whose own screen is already slow.
   */
  private async tile<TValue>(work: () => Promise<TValue>, name: string): Promise<Tile<TValue>> {
    try {
      return ready(await this.unitOfWork.run(work));
    } catch (error) {
      this.logger.warn('Dashboard widget could not be composed', {
        widget: name,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return unavailable<TValue>();
    }
  }

  /**
   * A widget whose module may not be in this composition at all.
   *
   * Unbound answers `UNAVAILABLE`, never `READY: 0`. A deployment without notifications has no
   * unread count; it does not have an unread count of zero, and a badge reading "0" would be the
   * product asserting something it cannot know.
   */
  private async optionalTile<TValue>(
    work: (() => Promise<TValue>) | null,
    name: string,
  ): Promise<Tile<TValue>> {
    return work === null ? unavailable<TValue>() : this.tile(work, name);
  }

  /** The same isolation for a card whose absence is an empty list rather than an absent number. */
  private async list<TItem>(
    work: () => Promise<readonly TItem[]>,
    name: string,
  ): Promise<readonly TItem[]> {
    return (await this.tile(work, name)).value ?? [];
  }

  /** A tile refused before it is attempted — never attempted and then hidden. */
  private async gated<TValue>(
    granted: boolean,
    work: () => Promise<TValue>,
    name: string,
  ): Promise<Tile<TValue>> {
    // The query does not run when the permission is absent. Running it and discarding the answer
    // would put the tenant-wide number in this process's memory for a caller who may not have it,
    // which is the shape 08 §7 calls fetch-then-filter — and the shape that leaks through a timing
    // difference even when the value never reaches the wire.
    return granted ? this.tile(work, name) : forbidden<TValue>();
  }

  /** The caller plus whomever they currently cover — the inbox's own set, or just them. */
  private async assigneesFor(userId: UserId, at: Date): Promise<readonly UserId[]> {
    if (this.delegations === null) {
      return [userId];
    }
    try {
      const delegators = await this.unitOfWork.run(() => this.delegations!.coveredBy(userId, at));
      return [userId, ...delegators];
    } catch (error) {
      // Falling back to the caller's own tasks *undercounts*, which is the safe direction. A
      // pending count that silently grew to include somebody else's work would be a disclosure; one
      // that is too small is a number the inbox corrects the moment it is opened.
      this.logger.warn('Dashboard could not resolve delegation cover; counting own tasks only', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return [userId];
    }
  }

  /**
   * What this person did, from the audit trail.
   *
   * `forActor(caller)` and nothing else — and the absence of a tenant-wide feed is the decision
   * rather than the limitation. `ActivityReader` exposes `forSubject` and `forActor` and no third
   * method, and adding one would have been adding a *disclosure surface*, not a convenience: a
   * tenant-wide feed shows what everybody did, which is the audit search — already built, already
   * behind `audit:view`, already a screen at `/audit`. A second one on the home page differing from
   * it only in permission is how the two come to disagree, and 13 §1 is emphatic that the trail has
   * one reader.
   *
   * This needs no permission because it can contain nothing the caller did not do themselves, which
   * is also why it belongs on the user dashboard rather than the administrator's.
   */
  private async recentActivity(userId: UserId): Promise<readonly DashboardActivity[]> {
    const page = await this.activity.forActor(userId, { page: 1, pageSize: CARD_ROWS });
    return page.data.map((entry) => ({
      id: entry.id,
      occurredAt: entry.occurredAt,
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      outcome: entry.outcome,
    }));
  }
}

/** How many rows a list card holds before it stops being a card and becomes a list. */
const CARD_ROWS = 8;

/**
 * Every permission that gates an administrator tile.
 *
 * One list, resolved in one call, and the source of `anyGranted` — so the panel is hidden by the
 * same data that hides each tile inside it. A second list would be a second chance to hide a card
 * the guard still serves, or to render an empty panel to somebody holding nothing.
 *
 * `report:view` gates four of them, and that is the boundary with Phase 15 drawn where it belongs.
 * The permission for "may see aggregate figures about this tenant" already existed and already
 * means exactly this. What it does *not* buy is a report — a parameterised, paged, exportable
 * query — which is `REPORTING_SERVICE.run`, still bound to nothing, and still Phase 15's.
 */
const TILE_PERMISSIONS: readonly PermissionKey[] = Object.freeze([
  Permission.REPORT_VIEW,
  Permission.USER_MANAGE,
  Permission.ORG_MANAGE,
  Permission.RETENTION_MANAGE,
  Permission.LEGAL_HOLD_MANAGE,
]);

function mapTile<TFrom, TTo>(tile: Tile<TFrom>, map: (value: TFrom) => TTo): Tile<TTo> {
  return tile.value === null ? { state: tile.state, value: null } : ready(map(tile.value));
}

/**
 * One status out of a breakdown.
 *
 * A status absent from the breakdown is a real zero, not a missing answer: the `groupBy` returned
 * every status that has rows, so "not present" means "none of these" — which is why this maps to
 * `READY: 0` while a failed query above it maps to `UNAVAILABLE`.
 */
function statusTile(tile: Tile<CountBreakdown>, status: string): Tile<number> {
  return mapTile(
    tile,
    (breakdown) => breakdown.entries.find((entry) => entry.key === status)?.count ?? 0,
  );
}
