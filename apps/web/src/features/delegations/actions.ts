'use server';

import {
  declareEmergencyDelegationSchema,
  declineDelegationSchema,
  requestDelegationSchema,
  revokeDelegationSchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Writes to a delegation.
 *
 * Server actions, like every other write in this product, so the access token stays in its
 * `httpOnly` cookie and never reaches client JavaScript.
 *
 * **No delegator anywhere.** A delegation is always the caller's own to give away, and the API
 * reads the actor from the request context — so there is no field here to carry somebody else's
 * identifier, and none for a client to invent. That absence *is* the `own` scope the Phase 1 seed
 * described when it granted `delegation:manage` to authors and approvers.
 *
 * **The emergency declaration is its own action**, calling its own endpoint, because it bypasses
 * the approval an ordinary request waits for. A boolean on `requestDelegation` would have put the
 * bypass one property away from the ordinary path — in the schema, in the form, and in every
 * future caller that spreads an object into it.
 */

export async function requestDelegation(input: unknown): Promise<ActionResult<{ id: string }>> {
  return validated(requestDelegationSchema, input, (body) =>
    adminWrite<{ id: string }>({ path: '/delegations', method: 'POST', body }),
  );
}

/**
 * Cover put in place without waiting for anybody.
 *
 * The reason is mandatory in the schema, and it is what the trail records in its own attested
 * `reason` column rather than in a payload field — which is the difference between an emergency
 * delegation and an ordinary one, in the place a verifier can address.
 */
export async function declareEmergencyDelegation(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return validated(declareEmergencyDelegationSchema, input, (body) =>
    adminWrite<{ id: string }>({ path: '/delegations/emergency', method: 'POST', body }),
  );
}

export async function approveDelegation(id: string): Promise<ActionResult> {
  return adminWrite({ path: `/delegations/${id}/approve`, method: 'POST' });
}

export async function declineDelegation(id: string, input: unknown): Promise<ActionResult> {
  return validated(declineDelegationSchema, input, (body) =>
    adminWrite({ path: `/delegations/${id}/decline`, method: 'POST', body }),
  );
}

/**
 * Ending cover before its end date.
 *
 * Immediate, and nothing is reassigned — because nothing ever moved. The delegate was never the
 * assignee, so the moment the delegation stops being active every in-flight task is the
 * delegator's again, which it always was.
 */
export async function revokeDelegation(id: string, input: unknown): Promise<ActionResult> {
  return validated(revokeDelegationSchema, input, (body) =>
    adminWrite({ path: `/delegations/${id}/revoke`, method: 'POST', body }),
  );
}
