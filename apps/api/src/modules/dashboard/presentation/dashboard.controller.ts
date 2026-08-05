import { Controller, Get, Inject } from '@nestjs/common';

import type {
  AdministratorDashboard,
  BreakdownTile,
  CountTile,
  Dashboard,
  DashboardActivityEntry,
  DashboardDelegation as WireDelegation,
  StorageTile,
  UserDashboard,
} from '@edms/contracts';
import { Permission, type UserId } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { UnauthenticatedError } from '../../../core/errors/application-errors';
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  DASHBOARD_SERVICE,
  type AdministratorDashboardView,
  type ApprovalCounts,
  type CountBreakdown,
  type DashboardDelegation,
  type DashboardService,
  type StorageUsage,
  type Tile,
  type UserDashboardView,
} from '../application/ports';

/**
 * The dashboards, on the API — 16 §2's `page.tsx`, served.
 *
 * **One route, and it takes no user identifier.** That absence is the authorisation for everything
 * on the user half: there is no subject on the wire for a client to substitute, so "read somebody
 * else's dashboard" is not a request this API can express. It is the same enforcement-by-absence
 * the notification and delegation controllers use, and it is why the *whole* user object sits
 * behind one ordinary grant instead of a permission per widget.
 *
 * `document:view` gates the route because that is what the user dashboard is: the caller's own
 * documents and their own approvals, summarised. Every seeded role that can hold a document holds
 * it, and somebody without it has no drafts, no favourites and no inbox to summarise.
 *
 * **The administrator half is not a second route.** It is a field on this one, gated *inside* the
 * service, tile by tile, against the ACL resolver. A separate `/dashboard/administration` endpoint
 * would need a permission of its own to guard it, and there is no single permission that means
 * "may see some administrative figure" — `report:view` is one of five, and gating the route on the
 * loosest of them is exactly the mistake `NavigationDestination.anyOf` exists to avoid. Composing
 * both halves here also means one round trip for the screen that renders both.
 *
 * A caller holding none of the five gets `anyGranted: false` and eight `FORBIDDEN` tiles, which the
 * web client renders as no panel at all. It is not an error: being an ordinary user is not a
 * failure to be an administrator.
 */
@Controller({ path: 'dashboard', version: '1' })
@RequirePermission(Permission.DOCUMENT_VIEW)
export class DashboardController {
  constructor(@Inject(DASHBOARD_SERVICE) private readonly dashboard: DashboardService) {}

  @Get()
  async get(): Promise<Dashboard> {
    const caller = this.caller();
    // Both halves together. They are independent reads, and the administrator half is eight
    // permission-gated aggregates that mostly do not run — so serialising them would make an
    // ordinary user's dashboard wait on a resolver call whose every answer is "no".
    const [user, administrator] = await Promise.all([
      this.dashboard.userDashboard(caller),
      this.dashboard.administratorDashboard(),
    ]);
    return { user: toUserDashboard(user), administrator: toAdministrator(administrator) };
  }

  /**
   * Who is asking.
   *
   * From the request context, never from the wire. A route that accepted a user identifier here
   * would be a route by which anybody could read anybody's workload — what they are drafting, what
   * they have checked out, what they have been doing — and no permission check would make that
   * safe, which is why the identifier is absent rather than guarded.
   */
  private caller(): UserId {
    const { userId } = requireContext();
    if (userId === null) {
      throw new UnauthenticatedError('This request has no user behind it.');
    }
    return userId;
  }
}

/**
 * A tile on the wire.
 *
 * The state travels beside the value rather than the value being nullable on its own, because a
 * client has to render three different things and cannot tell them apart from `null`: a permission
 * it does not hold, a source that failed, and a genuine zero.
 */
function toCountTile(tile: Tile<number>): CountTile {
  return { state: tile.state, count: tile.value };
}

function toBreakdown(tile: Tile<CountBreakdown>): BreakdownTile {
  return {
    state: tile.state,
    total: tile.value?.total ?? null,
    entries: tile.value === null ? [] : tile.value.entries.map((entry) => ({ ...entry })),
  };
}

function toApprovals(tile: Tile<ApprovalCounts>): AdministratorDashboard['approvals'] {
  return {
    state: tile.state,
    pending: tile.value?.pending ?? null,
    overdue: tile.value?.overdue ?? null,
  };
}

function toStorage(tile: Tile<StorageUsage>): StorageTile {
  return {
    state: tile.state,
    blobCount: tile.value?.blobCount ?? null,
    storedBytes: tile.value?.storedBytes ?? null,
    referencedBytes: tile.value?.referencedBytes ?? null,
    unreferencedBlobs: tile.value?.unreferencedBlobs ?? null,
  };
}

function toDelegation(delegation: DashboardDelegation): WireDelegation {
  return {
    id: delegation.id,
    direction: delegation.direction,
    // The identifier is deliberately absent from the wire: the card says who and when, and the
    // delegation screen is where somebody acts on one. Putting a user identifier on the home page's
    // payload would be putting the directory on it one row at a time.
    counterpartName: delegation.counterpartName,
    startsAt: delegation.startsAt.toISOString(),
    endsAt: delegation.endsAt?.toISOString() ?? null,
  };
}

/**
 * The user half.
 *
 * **No document rows and no document identifiers.** "Recently opened" and "Favourites" already have
 * endpoints that serve exactly those lists, and the cards call them. Projecting a document here
 * would give the product two definitions of what a document summary contains, and they would
 * disagree the first time a column was added to one of them.
 */
function toUserDashboard(view: UserDashboardView): UserDashboard {
  return {
    drafts: toCountTile(view.drafts),
    rejected: toCountTile(view.rejected),
    pending: toCountTile(view.pending),
    overdue: toCountTile(view.overdue),
    checkedOut: toCountTile(view.checkedOut),
    favorites: toCountTile(view.favorites),
    unreadNotifications: toCountTile(view.unreadNotifications),
    activity: view.activity.map((entry): DashboardActivityEntry => ({
      id: entry.id,
      occurredAt: entry.occurredAt.toISOString(),
      // 13 §2's own action code, rendered verbatim by the client — the rule Phase 9's timeline
      // established: the code is what an auditor filters by and what an evidence export
      // contains, and a phrase in its place would give one event two names.
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      outcome: entry.outcome,
    })),
    delegations: view.delegations.map(toDelegation),
  };
}

function toAdministrator(view: AdministratorDashboardView): AdministratorDashboard {
  return {
    anyGranted: view.anyGranted,
    documents: toBreakdown(view.documents),
    workflow: toBreakdown(view.workflow),
    approvals: toApprovals(view.approvals),
    storage: toStorage(view.storage),
    users: toBreakdown(view.users),
    departments: toCountTile(view.departments),
    dispositionsDue: toCountTile(view.dispositionsDue),
    legalHolds: toCountTile(view.legalHolds),
  };
}
