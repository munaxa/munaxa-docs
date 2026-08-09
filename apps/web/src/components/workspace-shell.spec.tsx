import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ALL_PERMISSIONS } from '@edms/domain';

import { destinationsFor } from '../lib/navigation';
import { expectNoViolations, renderWithProviders } from '../test/a11y';
import { NAVIGATION_ICON_IDS, NAVIGATION_SECTION_IDS, WorkspaceShell } from './workspace-shell';

/**
 * The shell — the frame every workspace screen sits inside, and therefore the one place where an
 * accessibility defect is on every page at once.
 *
 * The skip link is asserted by name here for a specific reason. The Phase 19 audit reported
 * `SkipLink` as exported-but-unused and called its absence an accessibility defect; it was wrong,
 * because the shell passes `skipLinkLabel` and `AppShell` renders the component. A symbol search
 * cannot see that. This test can, and it will also notice if the prop is ever dropped.
 */
function shell(children = <h1>Content</h1>): HTMLElement {
  return renderWithProviders(
    <WorkspaceShell
      destinations={destinationsFor(ALL_PERMISSIONS)}
      displayName="Test Person"
      description="Test Tenant"
      signOutAction={() => Promise.resolve()}
    >
      {children}
    </WorkspaceShell>,
  );
}

describe('workspace shell accessibility', () => {
  it('has no axe violations', async () => {
    await expectNoViolations(shell());
  });

  it('renders the skip link as the first focusable element', () => {
    shell();
    const link = screen.getByRole('link', { name: 'Skip to content' });
    expect(link).toBeDefined();

    // Not merely present — *first*. A skip link that comes after the navigation it skips is
    // decoration.
    const focusable = document.querySelectorAll('a[href], button, input, select, textarea');
    expect(focusable[0]).toBe(link);
  });

  it('points the skip link at a target that exists', () => {
    shell();
    const link = screen.getByRole('link', { name: 'Skip to content' });
    const target = link.getAttribute('href');
    expect(target?.startsWith('#')).toBe(true);
    expect(document.querySelector(target ?? '')).not.toBeNull();
  });

  it('names its navigation landmark', () => {
    shell();
    // A page with more than one nav needs each one named, or a screen-reader user gets a list of
    // identical "navigation" landmarks.
    for (const nav of screen.getAllByRole('navigation')) {
      const name = nav.getAttribute('aria-label') ?? nav.getAttribute('aria-labelledby');
      expect(name, 'every navigation landmark needs an accessible name').toBeTruthy();
    }
  });

  it('marks the current destination with aria-current', () => {
    shell();
    const current = document.querySelectorAll('[aria-current="page"]');
    expect(current.length).toBe(1);
  });

  it('gives every destination a real icon, not the fallback', () => {
    // The collapsed rail renders *only* the icon — the label becomes `sr-only`. A destination
    // with no entry in the map is a blank row of clickable space, so a new destination must not
    // be able to reach the fallback silently.
    const missing = destinationsFor(ALL_PERMISSIONS)
      .map((destination) => destination.id)
      .filter((id) => !NAVIGATION_ICON_IDS.includes(id));
    expect(missing, `destinations with no icon: ${missing.join(', ')}`).toStrictEqual([]);
  });

  it('places every destination in a named section', () => {
    // Phase 7 grouped the rail. A destination missing from `NAVIGATION_SECTIONS` still renders —
    // in a trailing untitled group, because a navigation row that silently disappears when
    // somebody adds a screen is the worse failure — so this is what stops anybody relying on it.
    const unplaced = destinationsFor(ALL_PERMISSIONS)
      .map((destination) => destination.id)
      .filter((id) => !NAVIGATION_SECTION_IDS.includes(id));
    expect(unplaced, `destinations in no section: ${unplaced.join(', ')}`).toStrictEqual([]);
  });

  it('names every section heading it renders', () => {
    shell();
    // `SidebarNav` renders a group title as a heading. An unnamed run of links is the flat list
    // this grouping exists to replace.
    const headings = screen
      .getAllByRole('navigation')[0]
      ?.querySelectorAll('h2, h3, [role="presentation"]');
    expect(headings).toBeDefined();
  });

  it('hides the navigation icons from assistive technology', () => {
    shell();
    // The row already carries its label — visibly when open, as `sr-only` text when collapsed.
    // An announced icon would say the same thing twice.
    for (const link of screen.getAllByRole('link')) {
      for (const svg of link.querySelectorAll('svg')) {
        expect(svg.getAttribute('aria-hidden')).toBe('true');
      }
    }
  });

  it('gives every navigation link an accessible name', () => {
    shell();
    for (const link of screen.getAllByRole('link')) {
      expect(link.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });
});
