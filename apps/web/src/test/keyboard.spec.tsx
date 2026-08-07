import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button, Dialog, Field, Input, Select } from '@munaxa/ui';

import { ALL_PERMISSIONS } from '@edms/domain';

import { WorkspaceShell } from '../components/workspace-shell';
import { destinationsFor } from '../lib/navigation';
import { renderWithProviders } from './a11y';

/**
 * Keyboard operability — Part 2 of the brief, asserted rather than reviewed.
 *
 * axe checks whether the markup *can* be operated; it does not press Tab. These tests do, because
 * the failures that matter here — a dialogue that lets focus escape behind it, a skip link that
 * comes after the navigation it skips, a control that cannot be reached at all — are properties of
 * a sequence of key presses and of nothing else.
 *
 * What is *not* asserted: visible focus. That is a rendered outline, and jsdom has no layout to
 * render it into. The platform sets `focus-visible:ring-*` on its controls and this product defines
 * no focus styles of its own, so it cannot suppress them — but "cannot suppress" is an argument,
 * not a test, and the Phase 5.2 report records it as one.
 */

function shell(): void {
  renderWithProviders(
    <WorkspaceShell
      destinations={destinationsFor(ALL_PERMISSIONS)}
      displayName="Test Person"
      description="Test Tenant"
      signOutAction={() => Promise.resolve()}
    >
      <h1>Content</h1>
      <Button>In content</Button>
    </WorkspaceShell>,
  );
}

describe('skip link', () => {
  it('is the first thing Tab reaches', async () => {
    const user = userEvent.setup();
    shell();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Skip to content' }));
  });

  it('points at a main region that can actually receive focus', () => {
    shell();

    const link = screen.getByRole('link', { name: 'Skip to content' });
    const target = document.querySelector(link.getAttribute('href') ?? '');
    expect(target).not.toBeNull();

    // The target carries `tabindex="-1"`, which is what makes a non-interactive region focusable
    // by a link. Without it the browser scrolls but leaves focus where it was, and the next Tab
    // goes back into the navigation the user just skipped.
    expect(target?.getAttribute('tabindex')).toBe('-1');
  });
});

describe('navigation', () => {
  it('reaches every destination by keyboard', async () => {
    const user = userEvent.setup();
    shell();

    const links = screen
      .getAllByRole('link')
      .filter((link) => link.textContent !== 'Skip to content');
    const reached = new Set<Element>();

    // Bounded rather than `while`: an unreachable control would otherwise hang the suite instead
    // of failing it.
    for (let press = 0; press < 40; press += 1) {
      await user.tab();
      if (document.activeElement !== null) reached.add(document.activeElement);
    }

    const unreachable = links.filter((link) => !reached.has(link));
    expect(
      unreachable.map((link) => link.textContent),
      'navigation links never reached by Tab',
    ).toStrictEqual([]);
  });

  it('puts nothing in a positive tab order', () => {
    shell();
    // A positive `tabindex` reorders the whole page, not just the element carrying it, and is
    // almost always a mistake.
    const positive = [...document.querySelectorAll('[tabindex]')].filter(
      (element) => Number(element.getAttribute('tabindex')) > 0,
    );
    expect(positive).toStrictEqual([]);
  });
});

describe('dialogs', () => {
  function Harness({ onClose }: { onClose: () => void }): React.ReactNode {
    return (
      <>
        <Button>Behind the dialogue</Button>
        <Dialog open title="Edit document" description="Change its properties" onClose={onClose}>
          <Field label="Title" htmlFor="title">
            <Input id="title" name="title" />
          </Field>
          <Field label="Status" htmlFor="status">
            <Select id="status" name="status">
              <option value="DRAFT">Draft</option>
            </Select>
          </Field>
          <Button type="submit">Save</Button>
        </Dialog>
      </>
    );
  }

  it('traps focus inside itself', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog');
    const outside = screen.getByRole('button', { name: 'Behind the dialogue' });

    // Twenty presses is several times round a five-control dialogue. If focus can escape, it
    // will have.
    for (let press = 0; press < 20; press += 1) {
      await user.tab();
      expect(document.activeElement).not.toBe(outside);
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(<Harness onClose={onClose} />);

    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('is announced as a dialogue with an accessible name', async () => {
    renderWithProviders(<Harness onClose={vi.fn()} />);

    const dialog = await screen.findByRole('dialog');
    // A dialogue with no name is announced as "dialog" and nothing else.
    expect(
      dialog.getAttribute('aria-labelledby') ?? dialog.getAttribute('aria-label'),
    ).toBeTruthy();
  });
});

describe('form controls', () => {
  it('associates every label with its control, so clicking the label focuses it', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <form>
        <Field label="Actor" htmlFor="actor">
          <Input id="actor" name="actorId" />
        </Field>
      </form>,
    );

    await user.click(screen.getByText('Actor'));
    expect(document.activeElement).toBe(screen.getByLabelText('Actor'));
  });
});
