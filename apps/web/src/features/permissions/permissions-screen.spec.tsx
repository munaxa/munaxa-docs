import { describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import type { StoredAclEntry } from '@edms/contracts';
import { AclEffect, AclSubjectType, Permission } from '@edms/domain';

import { expectAccessible, renderWithProviders } from '../../test/a11y';
import { PermissionsScreen } from './permissions-screen';

/**
 * Who an entry names, as the table says it — Slice 12.
 *
 * ## Why this file exists
 *
 * The screen used to caption its entries by looking each subject up in the three picker pools, and
 * those pools came from `/admin/users`, `/admin/roles` and `/admin/departments` — `user:manage`,
 * `role:manage` and `org:manage`. The seeded document controller holds `document:permission:manage`
 * and none of the three, so the page threw before it could render at all.
 *
 * The caption now arrives on the entry, and the pools are only pickers. That is a claim about what
 * this component reads, and the page-level request test cannot make it: the page passes `explicit`
 * straight through, so a screen that quietly went back to the pool would keep every one of those
 * tests green while showing an administrator a raw identifier — or, worse, showing them nothing
 * they could recognise on the screen where they decide who may read a document.
 *
 * So the assertions below are deliberately about a rendered *name* with **empty pools**. Any
 * implementation that resolves through a pool fails them.
 */

const NOBODY: readonly { readonly id: string; readonly name: string }[] = [];

function entry(overrides: Partial<StoredAclEntry> = {}): StoredAclEntry {
  return {
    id: '019489f0-0000-7000-8000-0000000000e1',
    scopeType: 'DOCUMENT',
    scopeId: '019489f0-0000-7000-8000-000000000001',
    subjectType: AclSubjectType.ROLE,
    subjectId: '019489f0-0000-7000-8000-0000000000r1',
    permission: Permission.DOCUMENT_VIEW,
    effect: AclEffect.ALLOW,
    createdAt: '2026-08-17T00:00:00.000Z',
    createdBy: null,
    ...overrides,
  };
}

function screenFor(entries: readonly StoredAclEntry[]) {
  return (
    <PermissionsScreen
      scopeType="DOCUMENT"
      scopeId="019489f0-0000-7000-8000-000000000001"
      documentTitle="Quality Manual"
      explicit={entries}
      chain={[{ type: 'LIBRARY', id: 'lib-1', name: 'Quality', breaksInheritance: false }]}
      inheritanceBroken={false}
      effective={null}
      subjectUserId={null}
      // Empty on purpose: a caller who cannot fill a picker must still read the table.
      people={NOBODY}
      roles={NOBODY}
      departments={NOBODY}
      canManage
      folderId="fol-1"
      folderInherits
    />
  );
}

function render(entries: readonly StoredAclEntry[]): HTMLElement {
  cleanup();
  return renderWithProviders(screenFor(entries));
}

describe('the entries table names its subjects without any picker', () => {
  it.each([
    ['a role', AclSubjectType.ROLE, 'Document controller'],
    ['a person', AclSubjectType.USER, 'Ada Lovelace'],
    ['a department', AclSubjectType.DEPARTMENT, 'Quality Assurance'],
  ])('shows the name the server resolved for %s', (_what, subjectType, subjectName) => {
    render([entry({ subjectType, subjectName })]);

    expect(screen.getByText(subjectName)).toBeTruthy();
  });

  it('falls back to the identifier when the server had no name to give', () => {
    /*
     * An entry outlives its subject — `PermissionService.validate` never checks that the identifier
     * names anything — and this is the case an administrator most needs to see, because a stale
     * entry showing a raw identifier is the one they should revoke. A blank cell would hide it.
     */
    const orphan = entry({ subjectId: '019489f0-0000-7000-8000-00000000dead' });
    render([orphan]);

    expect(screen.getByText(orphan.subjectId)).toBeTruthy();
  });

  it('stays accessible with the pickers empty', async () => {
    // The degraded state is a real state now, so it is one the axe pass has to cover: a `<select>`
    // with only its placeholder is still a labelled control an administrator will tab through.
    cleanup();

    await expectAccessible(screenFor([entry({ subjectName: 'Document controller' })]));
  });
});
