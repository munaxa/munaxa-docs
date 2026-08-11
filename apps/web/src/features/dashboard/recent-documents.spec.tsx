import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Providers } from '../../app/providers';
import { administratorDashboard, documentSummary, userDashboard } from '../../test/fixtures';
import { DashboardScreen } from './dashboard-screen';

/**
 * The recent-document row — Phase 7.6B.
 *
 * Before this phase the row rendered a title and a document number and nothing else, while
 * `DocumentSummary` carried the status, the folder, the file's MIME type and `updatedAt` the whole
 * time. The screen was throwing away four fields it had already been given.
 *
 * These assert what the reader can *see*, not how it is built: a status word rather than a raw enum
 * or a key path, the folder the document sits in, and a date. If the row is ever rewritten with
 * different components these should still hold.
 */
function renderDashboard(): void {
  render(
    <Providers session={{ userId: 'u', tenantId: 't', locale: 'en' }}>
      <DashboardScreen
        user={userDashboard()}
        administrator={administratorDashboard()}
        recent={[documentSummary()]}
        favorites={[documentSummary()]}
      />
    </Providers>,
  );
}

describe('dashboard recent documents', () => {
  it('shows the document title, from real data', () => {
    renderDashboard();

    expect(screen.getAllByText(documentSummary().title).length).toBeGreaterThan(0);
  });

  it('shows where the document lives', () => {
    renderDashboard();

    expect(screen.getAllByText(documentSummary().folderName).length).toBeGreaterThan(0);
  });

  it('shows the status as a word, not as an enum or a key path', () => {
    renderDashboard();

    // `documentSummary()` is PUBLISHED; the catalogue says "Published". A row that rendered
    // `PUBLISHED` or `documents.status.PUBLISHED` fails here.
    expect(screen.getAllByText('Published').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/documents\.status\./);
  });

  it('dates the document from updatedAt rather than inventing one', () => {
    renderDashboard();

    const expected = new Date(documentSummary().updatedAt).toLocaleDateString('en');
    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
  });

  it('links the row to the document it names', () => {
    renderDashboard();

    const links = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href') === `/documents/${documentSummary().id}`);
    expect(links.length).toBeGreaterThan(0);
  });
});
