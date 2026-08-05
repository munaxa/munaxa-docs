import { z } from 'zod';

import { DelegationKind, DelegationStatus, Permission } from '@edms/domain';

import { isoDateTimeSchema, uuidSchema } from '../common/identifiers';
import { pageQuerySchema } from '../common/pagination';

/**
 * Phase 11 — delegation (`docs/architecture/07-workflow-architecture.md` §4).
 *
 * Four shapes, and what each one deliberately is not.
 *
 * **A request states a period, never a status.** There is no field anywhere in this file by which
 * a client says a delegation is active. Whether it is in force is decided by the server from the
 * tenant's approval setting and from who has agreed to it, because a client that could name the
 * status could grant itself the authority the approval exists to gate.
 *
 * **A delegation names the permissions it passes, and they are a closed set.** The catalogue is
 * `@edms/domain`'s, and a permission that is not in it does not exist (`08-permission-model.md`
 * §2). What the API refuses in addition — and what no schema can express — is a permission the
 * *delegator* does not hold, checked again at decision time rather than only here.
 *
 * **An emergency delegation is a different request, not a flag on this one.** It bypasses the
 * approval an ordinary delegation waits for, so it has its own endpoint, its own bound and a
 * mandatory stated ground. Making it a boolean on the ordinary body would put the bypass one
 * character away from the ordinary path.
 *
 * **A revocation states a ground and takes effect immediately.** There is no "revoke at" — §4 says
 * revocation is immediate and in-flight tasks revert to the delegator, and a scheduled revocation
 * would be an end date, which the delegation already has.
 */

export const delegationStatusSchema = z.nativeEnum(DelegationStatus);
export const delegationKindSchema = z.nativeEnum(DelegationKind);

/**
 * The permissions a delegation may carry.
 *
 * The whole catalogue, validated against it, rather than a hand-picked subset — because "which
 * permissions are delegable" is a policy question whose answer is already "the ones the delegator
 * holds", and that is a fact about a person rather than a fact about a key. A narrower schema here
 * would be a second, quietly diverging catalogue.
 */
export const delegatedPermissionSchema = z.nativeEnum(Permission);

/** One delegation, as every screen and both directions of the list render it. */
export interface Delegation {
  readonly id: string;
  readonly delegatorId: string;
  readonly delegatorName: string | null;
  readonly delegateId: string;
  readonly delegateName: string | null;
  readonly kind: z.infer<typeof delegationKindSchema>;
  readonly status: z.infer<typeof delegationStatusSchema>;
  readonly permissions: readonly string[];
  readonly startsAt: string;
  readonly endsAt: string;
  /** Why it was needed. Required for an emergency delegation, optional otherwise. */
  readonly reason: string | null;
  /**
   * Zero for a delegation of the delegator's own authority; one for a re-delegation.
   *
   * On the wire because the screen has to show it: "acting under Alice's delegation to Bob" is a
   * materially different arrangement from "Bob's own", and a reader who cannot tell them apart
   * cannot review either.
   */
  readonly depth: number;
  readonly requestedAt: string;
  readonly approvedById: string | null;
  readonly approvedByName: string | null;
  readonly approvedAt: string | null;
  readonly declineReason: string | null;
  readonly revokedById: string | null;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
  /** How many decisions have been taken under it. The delegator's own visibility rule (§4). */
  readonly useCount: number;
  readonly version: number;
}

/**
 * A decision somebody took under a delegation.
 *
 * The delegation history §4's visibility row requires: "the delegator sees every action taken on
 * their behalf". It is a projection of `approval_task` rather than a table of its own, because the
 * task *is* the record — a second table would be a copy of it that could disagree.
 */
export interface DelegationUse {
  readonly taskId: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly documentNumber: string | null;
  readonly decision: string | null;
  readonly decidedById: string;
  readonly decidedByName: string | null;
  readonly onBehalfOfId: string;
  readonly decidedAt: string | null;
}

// --- Requesting ------------------------------------------------------------------------------

/**
 * Bounded like every stored sentence in this product, and for the same reason: it is shown beside
 * the row rather than behind a tooltip.
 */
const reasonSchema = z.string().trim().min(1).max(500);

export const requestDelegationSchema = z.object({
  delegateId: uuidSchema,
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  /**
   * At least one. A delegation carrying nothing is a row that authorises nothing, and accepting
   * one would mean a delegate discovering at decision time that they were handed an empty set.
   */
  permissions: z.array(delegatedPermissionSchema).min(1).max(32),
  reason: reasonSchema.optional(),
});

/**
 * The emergency path: no approval, a much tighter bound, and a mandatory ground.
 *
 * `reason` is required here and optional above, which is the only structural difference between
 * the two bodies — and it is the difference that matters. Whatever an emergency delegation
 * bypasses, it does not bypass the audit: the ground is written to the trail's own `reason`
 * column, which the hash chain attests.
 */
export const declareEmergencyDelegationSchema = z.object({
  delegateId: uuidSchema,
  endsAt: isoDateTimeSchema,
  permissions: z.array(delegatedPermissionSchema).min(1).max(32),
  reason: reasonSchema,
});

export const declineDelegationSchema = z.object({
  reason: reasonSchema,
});

export const revokeDelegationSchema = z.object({
  reason: reasonSchema,
});

// --- Listing ---------------------------------------------------------------------------------

/**
 * Which side of the arrangement the caller is asking about.
 *
 * Three answers rather than two booleans: what I have given away, what I have been given, and what
 * is waiting for my agreement. The third is not a filter over the first two — a request awaiting
 * me names neither me as delegator nor me as delegate — and folding it into one of them would make
 * the approval queue unreachable.
 */
export const delegationDirectionSchema = z.enum(['GIVEN', 'RECEIVED', 'AWAITING_MY_APPROVAL']);

export type DelegationDirection = z.infer<typeof delegationDirectionSchema>;

export const delegationQuerySchema = pageQuerySchema.extend({
  direction: delegationDirectionSchema.default('GIVEN'),
  status: delegationStatusSchema.optional(),
  /**
   * Whether to include delegations that are over.
   *
   * Off by default, because the screen is a working list and a delegation history of any length is
   * mostly history. `07-workflow-architecture.md` §4's visibility rule is served by turning it on,
   * not by making every list a register.
   */
  includeEnded: z.enum(['true', 'false']).default('false'),
});

export type DelegationQuery = z.infer<typeof delegationQuerySchema>;
export type RequestDelegationBody = z.infer<typeof requestDelegationSchema>;
export type DeclareEmergencyDelegationBody = z.infer<typeof declareEmergencyDelegationSchema>;
export type DeclineDelegationBody = z.infer<typeof declineDelegationSchema>;
export type RevokeDelegationBody = z.infer<typeof revokeDelegationSchema>;
