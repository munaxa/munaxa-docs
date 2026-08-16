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
function shell(children = <h1>Content</h1>, unreadNotifications?: number | null): HTMLElement {
  return renderWithProviders(
    <WorkspaceShell
      destinations={destinationsFor(ALL_PERMISSIONS)}
      displayName="Test Person"
      description="Test Tenant"
      {...(unreadNotifications !== undefined && { unreadNotifications })}
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

  it('renders the four titled sections, and leaves Overview untitled', () => {
    /*
     * This assertion used to read `expect(headings).toBeDefined()`, which a `querySelectorAll`
     * satisfies even when it matches nothing — so it passed for four phases while the rail rendered
     * no headings at all. It was written that way because the headings were genuinely suppressed:
     * `SidebarNav` painted them at 2.78:1 until `@munaxa/platform` 1.0.1, and the product held them
     * behind a constant rather than override platform styling.
     *
     * The bundle this product consumes now paints them at full strength, so the words are back and
     * the test asserts them by name. Overview stays deliberately untitled — a lone dashboard link
     * under the word "Overview" is a heading longer than the thing it heads.
     */
    const rail = shell().querySelector('nav');
    expect(rail).not.toBeNull();

    /*
     * `<p>`, not `<h2>` — and asserted against what the platform actually renders rather than what
     * a group title might be expected to be. `SidebarNav` paints the title as a paragraph and does
     * not point the group's `<div>` at it with `aria-labelledby`, so these runs are grouped
     * visually but not programmatically. That is the platform's decision to revisit, not this
     * product's to override, and writing the assertion against `h2` would only have made this test
     * fail for a reason that has nothing to do with the rail's arrangement.
     */
    const titles = [...(rail?.querySelectorAll('p') ?? [])].map((node) => node.textContent?.trim());
    expect(titles).toStrictEqual(['Library', 'Work', 'Oversight', 'System']);
    expect(titles).not.toContain('Overview');
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

  it('speaks the unread count rather than only drawing it', () => {
    shell(undefined, 3);
    // The pill is `aria-hidden`; the accessible name is what has to carry the number, because a
    // screen reader announcing "Notifications" beside a silent "3" says there is a figure without
    // saying what it counts.
    const bell = screen.getByRole('link', { name: /Notifications, 3 unread/ });
    expect(bell.getAttribute('href')).toBe('/notifications');
  });

  it('draws no badge when there is nothing unread', () => {
    // Queried by *absence of a count*, not by the bare name: the rail carries a "Notifications"
    // destination too, so the name alone matches two links. What distinguishes the badged state is
    // that the accessible name gains the unread clause.
    shell(undefined, 0);
    expect(screen.queryByRole('link', { name: /unread/ })).toBeNull();
  });

  it('draws no badge when the count could not be established', () => {
    // `null` is not zero. Zero asserts "you are up to date"; a failed request knows nothing, and
    // claiming the reassuring answer is the one mistake this state exists to avoid.
    shell(undefined, null);
    expect(screen.queryByRole('link', { name: /unread/ })).toBeNull();
  });

  it('caps the badge rather than widening the top bar', () => {
    const root = shell(undefined, 1284);
    expect(root.textContent).toContain('99+');
  });
});
