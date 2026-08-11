import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { en } from '@edms/i18n';

import { Providers } from '../../app/providers';
import { documentSummary } from '../../test/fixtures';
import { RecentScreen } from './recent-screen';

/**
 * The empty Recently-opened screen still has a page — Phase 8.1.
 *
 * `RecentScreen` used to `return <EmptyState … />` before reaching `WorkspacePage`, so a person who
 * had opened nothing got a page with no `Page`, no `PageHeader`, no `<h1>` and no breadcrumb. Phase
 * 8 measured `h1Count: 0` on `/documents/recent` and on no other screen.
 *
 * It survived six phases because every one of them populated the list first, which is the lesson
 * these tests encode: the empty branch is a state a real person meets, and it needs its own render.
 * They assert the *frame*, not the components that build it — a rewrite that keeps the heading and
 * the trail keeps these green.
 */
function renderRecent(rows: Parameters<typeof RecentScreen>[0]['rows']): void {
  render(
    <Providers session={{ userId: 'u', tenantId: 't', locale: 'en' }}>
      <RecentScreen rows={rows} />
    </Providers>,
  );
}

/**
 * A real `RecentDocument`: the shared summary fixture plus the one field this list adds.
 *
 * Typed against the contract rather than hand-built, so a contract change breaks this at compile
 * time instead of producing a row the test renders happily and nobody ships.
 */
const ROW = {
  ...documentSummary({ title: 'Batch release procedure', documentNumber: 'SOP-0001' }),
  viewedAt: '2026-01-02T09:00:00.000Z',
};

describe('recently opened, with nothing opened', () => {
  it('keeps exactly one page heading', () => {
    renderRecent([]);

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe(en.documents.nav.recent);
  });

  it('keeps the breadcrumb back to the library', () => {
    renderRecent([]);

    const trail = screen.getByRole('navigation', { name: en.nav.breadcrumb });
    expect(trail).toBeTruthy();
    // The last crumb is the page you are on and carries no href; the first is the way back.
    expect(screen.getByRole('link', { name: en.nav.documents }).getAttribute('href')).toBe(
      '/documents',
    );
  });

  it('still shows the empty state itself', () => {
    renderRecent([]);

    expect(screen.getByText(en.documents.recent.empty)).toBeTruthy();
    expect(screen.getByText(en.documents.recent.emptyHint)).toBeTruthy();
  });

  it('renders no document list when there is nothing to list', () => {
    renderRecent([]);

    // Scoped to document links rather than to `listitem`: the breadcrumb is a list too, and
    // counting its crumbs would make this assert the frame is *absent*, which is the opposite of
    // what this phase is for.
    expect(screen.queryAllByRole('link', { name: /procedure/i })).toHaveLength(0);
  });
});

describe('recently opened, populated — unchanged by Phase 8.1', () => {
  it('keeps the same single heading and breadcrumb', () => {
    renderRecent([ROW]);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('navigation', { name: en.nav.breadcrumb })).toBeTruthy();
  });

  it('still links each row to its document', () => {
    renderRecent([ROW]);

    expect(screen.getByRole('link', { name: /Batch release procedure/ }).getAttribute('href')).toBe(
      `/documents/${ROW.id}`,
    );
    // `documentNumber` is nullable on the contract; the fixture sets it, and asserting that keeps
    // the test honest about which value it is checking.
    expect(ROW.documentNumber).not.toBeNull();
    expect(screen.getByText(ROW.documentNumber ?? '')).toBeTruthy();
    expect(screen.getByText(ROW.folderName)).toBeTruthy();
  });
});
