import { describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import type { SearchRebuild, SettingsResponse } from '@edms/contracts';

import { expectAccessible, renderWithProviders } from '../../test/a11y';
import { SettingsScreen } from './settings-screen';

/**
 * The search-index operator action — Phase 6.5.
 *
 * `POST /search/rebuild` and its status endpoint have declared `settings:manage` since Phase 8 and
 * had no caller in the product: rebuilding an index meant hand-crafting a request. It is exposed on
 * the settings screen rather than as a destination of its own because 12 §12 separates operator
 * actions from user features, and creating an operations console for one button is what that
 * section tells this phase not to do.
 *
 * What is asserted here is the part a screenshot would not catch: that **every state the API can
 * report renders**, including the two that only occur on a bad day. A tenant that has never rebuilt
 * gets a `404`, which the page turns into `null` rather than an error boundary; a failed rebuild
 * carries an `error` string that must reach a person rather than be swallowed.
 */

const SETTINGS: SettingsResponse = {
  data: [],
  diagnostics: { fellBack: [], unrecognised: [] },
};

function aRebuild(overrides: Partial<SearchRebuild> = {}): SearchRebuild {
  return {
    id: '019489f0-0000-7000-8000-00000000000a',
    state: 'COMPLETED',
    documentsIndexed: 412,
    startedAt: '2026-08-08T09:00:00.000Z',
    completedAt: '2026-08-08T09:04:00.000Z',
    error: null,
    ...overrides,
  };
}

describe('the search index section', () => {
  it('is accessible when the tenant has never rebuilt', async () => {
    await expectAccessible(<SettingsScreen settings={SETTINGS} searchRebuild={null} />);
  });

  it('is accessible while a rebuild is running', async () => {
    await expectAccessible(
      <SettingsScreen
        settings={SETTINGS}
        searchRebuild={aRebuild({ state: 'RUNNING', completedAt: null })}
      />,
    );
  });

  it('is accessible when the last rebuild failed', async () => {
    await expectAccessible(
      <SettingsScreen
        settings={SETTINGS}
        searchRebuild={aRebuild({ state: 'FAILED', error: 'The lane stopped responding.' })}
      />,
    );
  });

  it('says so plainly when no rebuild has ever run', () => {
    renderWithProviders(<SettingsScreen settings={SETTINGS} searchRebuild={null} />);
    expect(screen.getByTestId('search-rebuild-state').textContent).toContain('never');
  });

  it('reports the count and the state the API gave it', () => {
    renderWithProviders(<SettingsScreen settings={SETTINGS} searchRebuild={aRebuild()} />);
    const summary = screen.getByTestId('search-rebuild-state').textContent ?? '';
    expect(summary).toContain('412');
    expect(summary).toContain('Completed');
  });

  it('shows a failure reason rather than swallowing it', () => {
    // The whole point of surfacing this: a rebuild that failed silently leaves an index serving
    // stale answers, and nobody finds out unless the screen says so.
    renderWithProviders(
      <SettingsScreen
        settings={SETTINGS}
        searchRebuild={aRebuild({ state: 'FAILED', error: 'The lane stopped responding.' })}
      />,
    );
    expect(screen.getByText('The lane stopped responding.')).toBeTruthy();
  });

  it('offers the action whatever the last outcome was', () => {
    // Not disabled while one is running: the API decides whether a second request is admissible,
    // and a client that guessed would block a legitimate re-run after a failure.
    for (const rebuild of [null, aRebuild({ state: 'RUNNING' }), aRebuild({ state: 'FAILED' })]) {
      renderWithProviders(<SettingsScreen settings={SETTINGS} searchRebuild={rebuild} />);
      const buttons = screen.getAllByRole('button', { name: /rebuild the search index/i });
      expect(buttons.at(-1)?.hasAttribute('disabled')).toBe(false);
      cleanup();
    }
  });
});
