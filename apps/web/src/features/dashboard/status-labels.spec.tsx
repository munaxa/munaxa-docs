import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Providers } from '../../app/providers';
import { administratorDashboard, documentSummary, userDashboard } from '../../test/fixtures';
import { DashboardScreen } from './dashboard-screen';

/**
 * The one place in the product where a server *value* becomes a translation key.
 *
 * The three breakdown tiles build their keys from whatever the API returned —
 * `documents.status.${key}`, `approvals.instance${key}`, `dashboard.admin.userState.${key}` — so
 * `MessageKey` there is a cast, not a guarantee, and the compiler cannot catch a value the
 * catalogue has never heard of.
 *
 * `translate` answers a miss with the key itself, which is right for a literal a developer will see
 * in review and wrong for a value that arrives at runtime: before Phase 7.6A a status outside the
 * catalogue reached the reader as the string `dashboard.admin.userState.SUSPENDED` — an internal
 * path printed on a dashboard. It was found by looking at the rendered baseline, not by reading the
 * source, and nothing in the suite would have failed.
 *
 * These tests are the thing that would now fail.
 */
function renderDashboard(states: readonly string[]): void {
  render(
    <Providers session={{ userId: 'u', tenantId: 't', locale: 'en' }}>
      <DashboardScreen
        user={userDashboard()}
        administrator={{
          ...administratorDashboard(),
          users: {
            state: 'READY',
            total: states.length,
            entries: states.map((key) => ({ key, count: 1 })),
          },
        }}
        recent={[documentSummary()]}
        favorites={[documentSummary()]}
      />
    </Providers>,
  );
}

describe('dashboard breakdown labels', () => {
  it('translates a status the catalogue knows', () => {
    renderDashboard(['ACTIVE']);

    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('falls back to the value itself for a status the catalogue does not know', () => {
    renderDashboard(['SUSPENDED']);

    expect(screen.getByText('SUSPENDED')).toBeTruthy();
  });

  it('never renders a translation key path to the reader', () => {
    renderDashboard(['SUSPENDED', 'ACTIVE']);

    // The defect this file exists for. A key path is recognisable by its dotted namespace, and no
    // real status contains one — so the assertion is on the shape rather than on one known key.
    expect(document.body.textContent).not.toMatch(/dashboard\.admin\.userState\./);
    expect(document.body.textContent).not.toMatch(/\bapprovals\.instance/);
    expect(document.body.textContent).not.toMatch(/\bdocuments\.status\./);
  });
});
