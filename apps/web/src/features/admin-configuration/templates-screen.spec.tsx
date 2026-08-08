import { describe, expect, it } from 'vitest';

import type { DocumentTemplate } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { ADMIN_PERMISSIONS, ADMIN_SECTIONS, sectionsFor } from '../../lib/admin/sections';
import { expectAccessible } from '../../test/a11y';
import { listState } from '../../test/fixtures';
import { TemplatesScreen } from './templates-screen';

/**
 * The document-template surface — Phase 6.5.
 *
 * Two questions, and they are different. The first is whether the screen an administrator sees is
 * usable by somebody who cannot use a mouse or a screen without help, which axe answers against a
 * rendered tree. The second is whether the *menu* and the *page* agree about who may reach it,
 * which no rendering can answer and which is the mismatch `sections.ts` exists to prevent: a
 * destination advertised to somebody the page then refuses is a dead end, and a page reachable
 * without the menu entry that names it is a screen nobody finds.
 *
 * Neither is an authorization control. `template:manage` is enforced by the five API routes behind
 * this screen and by nothing here — the menu hides what a caller cannot administer as a courtesy
 * (08 §7), and the assertions below are about that courtesy being *consistent*, never about it
 * being sufficient.
 */

function aTemplate(overrides: Partial<DocumentTemplate> = {}): DocumentTemplate {
  return {
    id: '019489f0-0000-7000-8000-000000000001',
    name: 'Deviation report',
    description: 'The starting point for a recorded deviation.',
    documentTypeId: '019489f0-0000-7000-8000-000000000002',
    documentTypeName: 'Deviation',
    categoryId: null,
    confidentialityId: '019489f0-0000-7000-8000-000000000003',
    confidentialityName: 'Internal',
    defaultFolderId: null,
    defaultFolderPath: null,
    fileObjectId: null,
    filename: null,
    defaultMetadata: {},
    isActive: true,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-02T09:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

const CHOICES = {
  documentTypes: [{ value: aTemplate().documentTypeId, label: 'Deviation' }],
  confidentialityLevels: [{ value: aTemplate().confidentialityId, label: 'Internal' }],
  categories: [],
  folders: [],
};

describe('the document templates screen', () => {
  it('is accessible with rows', async () => {
    await expectAccessible(
      <TemplatesScreen
        rows={[aTemplate(), aTemplate({ id: 'b', name: 'CAPA record', isActive: false })]}
        total={2}
        state={listState()}
        {...CHOICES}
      />,
    );
  });

  it('is accessible with nothing to show', async () => {
    // The empty branch renders an `EmptyState` where the populated one renders a table, so it is
    // different markup and the one nobody looks at.
    await expectAccessible(
      <TemplatesScreen rows={[]} total={0} state={listState()} {...CHOICES} />,
    );
  });

  it('is accessible when a prerequisite is missing', async () => {
    // A third distinct tree: no table, no create button, an alert instead. A template cannot exist
    // before the type it names, and saying so up front is what this branch is.
    await expectAccessible(
      <TemplatesScreen
        rows={[]}
        total={0}
        state={listState()}
        {...CHOICES}
        documentTypes={[]}
      />,
    );
  });
});

describe('reaching the screen', () => {
  const destination = ADMIN_SECTIONS.flatMap((section) => section.destinations).find(
    (entry) => entry.id === 'templates',
  );

  it('is advertised at the same permission its page guards on', () => {
    // `TemplatesPage` calls `adminAccess(Permission.TEMPLATE_MANAGE)`. If these two ever disagree
    // the product either offers a link that refuses the person who clicks it, or hides a screen
    // from somebody entitled to it — the exact failure `sections.ts` was written to make
    // impossible, asserted rather than described.
    expect(destination?.permission).toBe(Permission.TEMPLATE_MANAGE);
    expect(destination?.href).toBe('/admin/templates');
  });

  it('is the one destination in Configuration not gated on settings:manage', () => {
    // Deliberate, and worth holding: authoring the starting point for a controlled document is the
    // document controller's job, and `template:manage` is a separate permission precisely so a
    // system administrator does not acquire it by virtue of administering everything else.
    const classification = ADMIN_SECTIONS.find((section) =>
      section.destinations.some((entry) => entry.id === 'templates'),
    );
    const others = classification?.destinations.filter((entry) => entry.id !== 'templates') ?? [];
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((entry) => entry.permission === Permission.SETTINGS_MANAGE)).toBe(true);
  });

  it('shows a template administrator that destination and nothing else', () => {
    const visible = sectionsFor([Permission.TEMPLATE_MANAGE]).flatMap(
      (section) => section.destinations,
    );
    expect(visible.map((entry) => entry.id)).toEqual(['templates']);
  });

  it('hides it from somebody who administers everything else', () => {
    // The converse, and the one that would fail if the destination had been given `settings:manage`
    // for convenience: holding it must not confer sight of templates.
    const visible = sectionsFor([Permission.SETTINGS_MANAGE]).flatMap(
      (section) => section.destinations,
    );
    expect(visible.some((entry) => entry.id === 'templates')).toBe(false);
  });

  it('lets template:manage reach Administration at all', () => {
    // `ADMIN_PERMISSIONS` gates the top-level menu entry and is derived from the destinations, so
    // this passes by construction — which is the point of asserting it: a future refactor that
    // hardcoded the list would strand this screen behind a menu its holder cannot see.
    expect(ADMIN_PERMISSIONS).toContain(Permission.TEMPLATE_MANAGE);
  });
});
