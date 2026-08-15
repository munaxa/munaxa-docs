import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { Dialog } from '@munaxa/ui';

import type { PermissionDescriptor } from '@edms/contracts';

import { PermissionMatrix } from './admin-identity/permission-matrix';
import { DefinitionEditor, STARTING_DEFINITION } from './admin-workflows/definition-editor';

/**
 * Phase 8.24 — the heading outline inside a dialogue.
 *
 * `Dialog` renders its title as an `h2`, so the first heading a dialogue's own content contributes
 * has to be an `h3`. Both components below render an `Accordion`, whose trigger takes its heading
 * level as a prop precisely because it has to follow the surrounding outline — and both passed
 * **4**.
 *
 * Measured in the running product before the fix:
 *
 *   `/admin/roles`     → `h1 Roles` · `h2 Add role` · **eighteen** level-4 headings
 *   `/admin/workflows` → `h1 Approval workflows` · `h2 Add workflow` · a level-4 stage heading
 *
 * axe reports one `heading-order` node per dialogue, being the first jump, which understates it:
 * the entire permission matrix sat a level too deep, and moving by heading is how somebody reaches
 * the eighteenth permission group.
 *
 * The assertions are about the *relationship* — every heading the content contributes is exactly
 * one level below the dialogue's own — rather than about the number 3, so they still hold if the
 * dialogue's own level ever changes, and they fail if either component drifts back.
 */

const CATALOGUE: PermissionDescriptor[] = [
  { key: 'document:view', resource: 'document', action: 'view', survivesBrokenInheritance: false },
  {
    key: 'document:create',
    resource: 'document',
    action: 'create',
    survivesBrokenInheritance: false,
  },
  { key: 'role:manage', resource: 'role', action: 'manage', survivesBrokenInheritance: true },
];

interface Heading {
  readonly level: number;
  readonly text: string;
}

/** Every heading the rendered tree exposes, in document order. */
function outline(container: HTMLElement): Heading[] {
  return [...container.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].map(
    (element) => {
      const explicit = element.getAttribute('aria-level');
      return {
        level: explicit === null ? Number(element.tagName.slice(1)) : Number(explicit),
        text: (element.textContent ?? '').trim().slice(0, 40),
      };
    },
  );
}

describe('the heading outline a dialogue presents', () => {
  it('puts the permission matrix one level below the dialogue title', () => {
    const { baseElement } = render(
      <Dialog open title="Add role" onClose={() => {}}>
        <PermissionMatrix catalogue={CATALOGUE} defaultValue={[]} />
      </Dialog>,
    );

    const headings = outline(baseElement);
    const title = headings.find((heading) => heading.text === 'Add role');
    expect(title, 'the dialogue title is what the rest is measured against').toBeDefined();

    const contributed = headings.filter((heading) => heading !== title);
    expect(
      contributed.length,
      'nothing rendered, so an assertion about levels would mean nothing',
    ).toBe(2);
    for (const heading of contributed) {
      expect(
        heading.level,
        `"${heading.text}" is level ${String(heading.level)} under a level-${String(title?.level)} title`,
      ).toBe((title?.level ?? 2) + 1);
    }
  });

  it('puts the workflow stage headings one level below the dialogue title', () => {
    const { baseElement } = render(
      <Dialog open title="Add workflow" onClose={() => {}}>
        <DefinitionEditor
          value={STARTING_DEFINITION}
          documentTypes={[]}
          onChange={() => {
            /* read-only for this assertion */
          }}
        />
      </Dialog>,
    );

    const headings = outline(baseElement);
    const title = headings.find((heading) => heading.text === 'Add workflow');
    expect(title).toBeDefined();

    const contributed = headings.filter((heading) => heading !== title);
    expect(contributed.length, 'the editor contributes a heading per stage').toBeGreaterThan(0);
    for (const heading of contributed) {
      expect(heading.level, `"${heading.text}" skips a level`).toBe((title?.level ?? 2) + 1);
    }
  });

  it('reads as a contiguous outline, which is the thing a skipped level breaks', () => {
    const { baseElement } = render(
      <Dialog open title="Add role" onClose={() => {}}>
        <PermissionMatrix catalogue={CATALOGUE} defaultValue={[]} />
      </Dialog>,
    );

    const levels = outline(baseElement).map((heading) => heading.level);
    expect(levels.length).toBeGreaterThan(1);
    for (let index = 1; index < levels.length; index += 1) {
      const previous = levels[index - 1] ?? 0;
      const current = levels[index] ?? 0;
      expect(
        current - previous,
        `heading ${String(index)} jumps from ${String(previous)} to ${String(current)}`,
      ).toBeLessThanOrEqual(1);
    }
  });
});
