'use server';

import { z } from 'zod';

import type { ActionResult } from '../../../lib/admin/action-result';
import { adminRead, adminWrite } from '../../../lib/admin/api';
import { validated } from '../../../lib/admin/validated';

const codeSchema = z.object({ code: z.string().min(1).max(32) });

export interface MfaStatus {
  readonly enrolled: boolean;
  readonly pending: boolean;
  readonly recoveryCodesRemaining: number;
}

export interface MfaOffer {
  readonly secret: string;
  readonly uri: string;
  readonly digits: number;
  readonly stepSeconds: number;
}

/**
 * The caller's own authenticator.
 *
 * Server actions, so the access token stays in its `httpOnly` cookie — and, here, so the **secret
 * never reaches client JavaScript except as the string being rendered once**. It is not stored, not
 * put in a query parameter, and not re-fetchable: the enrolment endpoint mints a new one if this
 * page is opened again before confirmation.
 *
 * None of these takes a user identifier, which is the same enforcement-by-absence the delegation
 * and notification surfaces use: there is no request by which one person could touch another's
 * factor.
 */

export async function mfaStatus(): Promise<ActionResult<MfaStatus>> {
  return adminRead<MfaStatus>('/auth/mfa');
}

export async function beginEnrolment(): Promise<ActionResult<MfaOffer>> {
  return adminWrite<MfaOffer>({ path: '/auth/mfa/enrolment', method: 'POST' });
}

export async function confirmEnrolment(
  input: unknown,
): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  return validated(codeSchema, input, (body) =>
    adminWrite<{ recoveryCodes: string[] }>({
      path: '/auth/mfa/enrolment/confirm',
      method: 'POST',
      body,
    }),
  );
}

export async function removeEnrolment(): Promise<ActionResult> {
  return adminWrite({ path: '/auth/mfa/enrolment', method: 'DELETE' });
}
