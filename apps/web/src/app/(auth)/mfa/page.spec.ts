import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@edms/domain';

import { failed, succeeded } from '../../../lib/admin/action-result';

/**
 * What the two-step verification page hands its screen when the read fails — Slice 26.
 *
 * The screen's own spec proves each of the three states renders the right sentence. This proves the
 * page produces the third one at all: it used to substitute
 * `{ enrolled: false, pending: false, recoveryCodesRemaining: 0 }` for a failed read, which is a
 * complete, plausible and false security posture — indistinguishable, once inside the screen, from
 * an account that genuinely has no second factor.
 *
 * Asserted as the prop rather than as markup, because that substitution is exactly what a render
 * test cannot see: both values render a valid card.
 */

const { mfaStatus, currentSession } = vi.hoisted(() => ({
  mfaStatus: vi.fn(),
  currentSession: vi.fn(),
}));

vi.mock('./actions', () => ({ mfaStatus }));
vi.mock('../../../lib/session', () => ({ currentSession }));
vi.mock('./mfa-screen', () => ({ MfaScreen: (props: Record<string, unknown>) => props }));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('NEXT_REDIRECT');
  },
}));

const { default: MfaPage } = await import('./page');

const ENROLLED = { enrolled: true, pending: false, recoveryCodesRemaining: 8 };

async function statusProp(): Promise<unknown> {
  // The page returns the `MfaScreen` element; JSX builds one rather than calling the component.
  const element = (await MfaPage()) as { props: Record<string, unknown> };
  return element.props['status'];
}

beforeEach(() => {
  mfaStatus.mockReset();
  currentSession.mockReset();
  currentSession.mockResolvedValue({ userId: 'someone' });
});

describe('the status the page hands its screen', () => {
  it('is the record when the read answers', async () => {
    // The positive half: a real posture must still reach the screen intact, or the assertion below
    // would hold just as well if the page had stopped passing anything.
    mfaStatus.mockResolvedValue(succeeded(ENROLLED));

    expect(await statusProp()).toEqual(ENROLLED);
  });

  it('is null when the read did not answer, never a fabricated posture', async () => {
    /*
     * The defect. `{ enrolled: false, ... }` told the screen this account has no second factor, so
     * it said so, hid `mfaRemove`, and offered an enrolment the server refuses outright when one
     * is already enrolled.
     */
    mfaStatus.mockResolvedValue(failed(ErrorCode.INTERNAL, 'The API is unreachable'));

    expect(await statusProp()).toBeNull();
  });
});
