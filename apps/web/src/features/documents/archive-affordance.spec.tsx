import { screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DocumentStatus } from '@edms/domain';

import { renderWithProviders } from '../../test/a11y';
import { document } from '../../test/fixtures';
import { DocumentScreen } from './document-screen';

/**
 * The archive affordance, asserted against a rendered screen — Phase 6.1.
 *
 * ## Why this test exists at all
 *
 * `development-recommendations.md` §4 has made it a standing rule since Phase 0 that *"every
 * affordance reads `capabilities`; the UI must never decide access"*, and Phase 19 filed as V-7
 * that **no test anywhere asserted an affordance is hidden without its permission**. Phase 5.1 put
 * it on the backlog and Phase 5.2 did not take it. So this is the first one, and it is here rather
 * than somewhere more convenient because `document:archive` is the permission Phase 6.0 found
 * granted to two roles and enforced by nothing — a control that existed only on paper. Wiring it to
 * a server guard without also asserting the client honours it would be closing half the gap.
 *
 * ## What it is not
 *
 * Not a security test. Hiding the button is a courtesy; `POST /documents/{id}/archive` re-checks
 * the permission and the ACL scope regardless (`08-permission-model.md` §7), and the integration
 * suite is where that refusal is proved. What this asserts is that a person who cannot archive is
 * not offered a button that will fail — which is a usability and support-cost property, and the one
 * the standing rule is actually about.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

function renderScreen(element: ReactElement): void {
  // The suite's own harness, so this renders through the same provider tree every other rendered
  // test uses — including the real translator, which is where the button's accessible name comes
  // from. A stubbed one would let this assert a name the shipped screen does not have.
  renderWithProviders(element);
}

function screenFor(options: { canArchive?: boolean; status?: string } = {}): ReactElement {
  return (
    <DocumentScreen
      document={document({
        ...(options.status !== undefined && { status: options.status as never }),
      })}
      folders={[]}
      categories={[]}
      confidentialityLevels={[]}
      users={[]}
      departments={[]}
      fields={[]}
      canEdit={false}
      canMove={false}
      canDownload={false}
      {...(options.canArchive !== undefined && { canArchive: options.canArchive })}
    />
  );
}

describe('the archive affordance', () => {
  it('is offered to somebody who holds document:archive on a published record', () => {
    renderScreen(screenFor({ canArchive: true }));

    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
  });

  it('is absent without the permission, on the same document', () => {
    // The pair is the assertion: same status, same record, one difference — the permission the
    // server computed. A test that only checked the positive case would pass against a button
    // that is always rendered.
    renderScreen(screenFor({ canArchive: false }));

    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('is absent when the permission is not supplied at all', () => {
    // The prop is optional, and "the server said nothing" must read as "no", never as "yes".
    renderScreen(screenFor({}));

    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('is not offered from a state the lifecycle cannot archive from', () => {
    // `IMPLEMENTED_TRANSITIONS` allows `PUBLISHED`, `EXPIRED` and `SUPERSEDED`. Offering it on a
    // draft would render a button whose only outcome is a 409 — which is the same defect as
    // offering one the permission forbids, arriving from the other direction.
    renderScreen(screenFor({ canArchive: true, status: DocumentStatus.DRAFT }));

    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('offers reinstatement instead once the record is archived', () => {
    renderScreen(screenFor({ canArchive: true, status: DocumentStatus.ARCHIVED }));

    expect(screen.getByRole('button', { name: 'Reinstate' })).toBeTruthy();
    // And not both at once: an archived document cannot be archived again from the screen.
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('offers archival from EXPIRED, which is the state the sweep produces', () => {
    renderScreen(screenFor({ canArchive: true, status: DocumentStatus.EXPIRED }));

    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
  });
});
