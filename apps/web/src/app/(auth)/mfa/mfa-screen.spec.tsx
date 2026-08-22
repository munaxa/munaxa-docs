import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../../test/a11y';
import { MfaScreen } from './mfa-screen';

/**
 * What the two-step verification screen says when it does not know — Slice 26.
 *
 * ## The defect
 *
 * `mfa/page.tsx` read `GET /auth/mfa` through `adminRead` and, on `ok: false`, handed the screen
 * `{ enrolled: false, pending: false, recoveryCodesRemaining: 0 }`. The screen renders that as
 * **"Add an authenticator app so a stolen password is not enough to reach your documents."** —
 * a statement that this account has no second factor, on the one page somebody opens to check
 * precisely that, asserted because a read failed.
 *
 * Three things follow, and the second is the one that bites:
 *
 * 1. The claim is false for anybody enrolled.
 * 2. `mfaRemove` is inside the enrolled branch, so an enrolled caller loses the only control that
 *    manages the factor they have.
 * 3. The button offered instead is refused by `MfaService.begin` — *"An authenticator is already
 *    enrolled. Remove it before enrolling another."* — so the server contradicts the page.
 *
 * It fails closed rather than destructively, which is why this is a false-claim defect and not a
 * data-loss one: `begin` refuses a confirmed enrolment by design, "because re-enrolling would
 * invalidate the recovery codes somebody may be holding on paper".
 *
 * ## Why the assertions are the sentences
 *
 * Because the three states are one card that differs only in its prose and its button. Asserting
 * that the card rendered would pass in every state, including the broken one.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

const ENROLLED = { enrolled: true, pending: false, recoveryCodesRemaining: 8 } as const;
const NOT_ENROLLED = { enrolled: false, pending: false, recoveryCodesRemaining: 0 } as const;

const UNAVAILABLE =
  'Your two-step verification settings could not be read just now. Reload to try again — nothing has changed.';
const NOT_ENROLLED_HINT =
  'Add an authenticator app so a stolen password is not enough to reach your documents.';

function renderScreen(status: typeof ENROLLED | typeof NOT_ENROLLED | null): void {
  renderWithProviders(<MfaScreen status={status} />);
}

describe('the two-step verification screen', () => {
  it('says an authenticator is set up, and offers to remove it', () => {
    // The positive state first. Both assertions below are about *not* saying this, and neither
    // would mean anything if the enrolled branch had stopped saying it at all.
    renderScreen(ENROLLED);

    expect(screen.getByText(/An authenticator app is set up/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove the authenticator' })).toBeTruthy();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });

  it('offers to set one up when the account genuinely has none', () => {
    renderScreen(NOT_ENROLLED);

    expect(screen.getByText(NOT_ENROLLED_HINT)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set up an authenticator' })).toBeTruthy();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });

  it('claims nothing about the account when the status could not be read', () => {
    /*
     * The defect, in one state. `null` is "we could not ask", and the screen must not turn it into
     * either posture — nor offer an action whose outcome it cannot predict.
     */
    renderScreen(null);

    expect(screen.getByText(UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByText(NOT_ENROLLED_HINT)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set up an authenticator' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove the authenticator' })).toBeNull();
  });
});
