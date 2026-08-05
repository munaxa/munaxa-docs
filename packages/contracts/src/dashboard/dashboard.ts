import { z } from 'zod';

/**
 * Phase 13 — the dashboards (`docs/architecture/16-frontend-architecture.md` §2's `page.tsx`).
 *
 * Two shapes, and the difference between them is an authorisation decision rather than a layout
 * one.
 *
 * **The user dashboard is every widget the caller could already ask for.** Drafts, pending,
 * rejected, checked out, recent and favourites are all *the caller's own* — each is a query whose
 * predicate names them, and none of them can answer a question about somebody else's work. So the
 * whole object is one gate, `document:view`, and every number in it is one the caller could reach
 * by opening the list beside it.
 *
 * **The administrator dashboard is a bag of independently gated tiles, and each one is nullable.**
 * A tile the caller may not see is `null` — *absent* — never `0`. Those are different answers and
 * the difference is the disclosure: "you may not ask" is a statement about the caller, and "there
 * are none" is a statement about the tenant. A dashboard that answered zero to an ungated question
 * would tell somebody there is nothing in a tenant they cannot see into, and the day the real
 * number is not zero they would learn that too.
 *
 * **No tile carries a quota, a percentage of an entitlement, or a limit.** Storage reports bytes
 * held and bytes saved by deduplication, which is arithmetic over rows that exist. What a tenant
 * is *entitled* to is ADR-0012's and Phase 21's, and a "72% full" tile would be this phase
 * inventing an entitlement to divide by.
 *
 * **Every tile can be unavailable.** `TileState` is three-valued rather than two, because a
 * dashboard composes a dozen independent sources and the honest answer when one of them is slow or
 * broken is to say so on that tile rather than to fail the page or to render a zero somebody acts
 * on.
 */

/**
 * Whether a tile has a number behind it.
 *
 * `FORBIDDEN` and `UNAVAILABLE` are separate on purpose. The first is a permission answer and is
 * stable — refreshing will not change it. The second is a transient failure of a source, and the
 * screen says "could not be loaded" rather than implying the caller is not allowed.
 */
export const tileStateSchema = z.enum(['READY', 'FORBIDDEN', 'UNAVAILABLE']);

export type TileState = z.infer<typeof tileStateSchema>;

/** One counted widget: the state, and the number when there is one. */
export const countTileSchema = z.object({
  state: tileStateSchema,
  /** Null unless `state` is `READY`. A tile without an answer never carries a number. */
  count: z.number().int().min(0).nullable(),
});

export type CountTile = z.infer<typeof countTileSchema>;

// --- The user dashboard -----------------------------------------------------------------------

/**
 * One line of the caller's own activity, projected from the audit trail.
 *
 * `forActor(caller)` and nothing else — see `core/activity/activity.port.ts`. It is what *this
 * person* did, so it can disclose nothing they did not already do.
 *
 * `action` is the audit action code from 13 §2's catalogue, and the client renders it verbatim —
 * the rule Phase 9's timeline established and stated: the code is what an auditor filters by and
 * what an evidence export contains, and a phrase in its place would give one event two names.
 */
export const activityEntrySchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  action: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  outcome: z.string(),
});

export type DashboardActivityEntry = z.infer<typeof activityEntrySchema>;

/** A delegation summarised for the dashboard — Phase 11's deferred widget. */
export const dashboardDelegationSchema = z.object({
  id: z.string(),
  /** Which way round the arrangement runs, from the caller's point of view. */
  direction: z.enum(['GIVEN', 'RECEIVED']),
  /** The other person. Null when their display name is not readable. */
  counterpartName: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
});

export type DashboardDelegation = z.infer<typeof dashboardDelegationSchema>;

export const userDashboardSchema = z.object({
  /** The caller's own documents, by the status each widget names. */
  drafts: countTileSchema,
  rejected: countTileSchema,
  /** Approval tasks awaiting the caller — including those they cover for, exactly as the inbox. */
  pending: countTileSchema,
  overdue: countTileSchema,
  /** Documents the caller holds a live check-out lock on. */
  checkedOut: countTileSchema,
  favorites: countTileSchema,
  /** Phase 12's badge, on the one endpoint built for it. */
  unreadNotifications: countTileSchema,
  /**
   * **The two document cards are deliberately not here.**
   *
   * "Recently opened" and "Favourites" already have endpoints that serve exactly those lists —
   * `GET /documents/recent` and `GET /documents?favorite=true` — and the cards call them. Putting
   * document rows on this payload would make the dashboard a *second projection of a document*,
   * which would drift from the library's the first time a column was added and then show the same
   * document two ways on two screens. Putting identifiers here instead would be no better: the
   * client would still have to resolve them, and there is no "these ids" filter to resolve them
   * with.
   *
   * What is here is what nothing else answers: the counts, the caller's own trail, and the cover
   * in force.
   */
  activity: z.array(activityEntrySchema),
  delegations: z.array(dashboardDelegationSchema),
});

export type UserDashboard = z.infer<typeof userDashboardSchema>;

// --- The administrator dashboard --------------------------------------------------------------

/** A `(label, count)` pair — documents per status, instances per state, users per state. */
export const breakdownEntrySchema = z.object({
  key: z.string(),
  count: z.number().int().min(0),
});

export type BreakdownEntry = z.infer<typeof breakdownEntrySchema>;

export const breakdownTileSchema = z.object({
  state: tileStateSchema,
  total: z.number().int().min(0).nullable(),
  entries: z.array(breakdownEntrySchema),
});

export type BreakdownTile = z.infer<typeof breakdownTileSchema>;

/**
 * What the tenant is holding, in bytes.
 *
 * `storedBytes` is what the blobs occupy; `referencedBytes` is what they would occupy if every
 * reference were its own copy. The difference is what content addressing saved, which is the only
 * honest storage figure this phase can report — see the file's opening note on why there is no
 * quota here.
 */
export const storageTileSchema = z.object({
  state: tileStateSchema,
  blobCount: z.number().int().min(0).nullable(),
  storedBytes: z.number().int().min(0).nullable(),
  referencedBytes: z.number().int().min(0).nullable(),
  /** Blobs no revision or artefact references — what a retention sweep would reclaim. */
  unreferencedBlobs: z.number().int().min(0).nullable(),
});

export type StorageTile = z.infer<typeof storageTileSchema>;

export const administratorDashboardSchema = z.object({
  /** False when the caller holds none of the tile permissions — the panel renders not at all. */
  anyGranted: z.boolean(),
  documents: breakdownTileSchema,
  workflow: breakdownTileSchema,
  approvals: z.object({
    state: tileStateSchema,
    pending: z.number().int().min(0).nullable(),
    overdue: z.number().int().min(0).nullable(),
  }),
  storage: storageTileSchema,
  users: breakdownTileSchema,
  departments: countTileSchema,
  /** Phase 10's review queue, as a number — the register itself is on the retention screen. */
  dispositionsDue: countTileSchema,
  legalHolds: countTileSchema,
});

export type AdministratorDashboard = z.infer<typeof administratorDashboardSchema>;

export const dashboardSchema = z.object({
  user: userDashboardSchema,
  administrator: administratorDashboardSchema,
});

export type Dashboard = z.infer<typeof dashboardSchema>;
