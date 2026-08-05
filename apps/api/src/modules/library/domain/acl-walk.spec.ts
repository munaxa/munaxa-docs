import { describe, expect, it } from 'vitest';

import { Permission, ScopeType, type ScopeRef, asId } from '@edms/domain';

import { grantSubjectToken, indexAclSubjects } from './acl-subjects';
import {
  type ChainEntry,
  type ChainNode,
  decideFromEntries,
  effectiveChain,
  indexSubjectsFromEntries,
  reachesTenant,
} from './acl-walk';

/**
 * The walk, asserted without a database.
 *
 * These are the rules ADR-0005 states in prose, and every one of them is arithmetic over a chain
 * and a set of entries. Asserting them here as well as in the integration suite is not duplication:
 * the integration suite proves the *queries* return the right rows, and this proves the decision
 * taken over those rows is the one the ADR describes. A defect in the second would otherwise be
 * indistinguishable from a defect in the first.
 */

const TENANT = node(ScopeType.TENANT, 'tenant');
const LIBRARY = node(ScopeType.LIBRARY, 'library');
const FOLDER = node(ScopeType.FOLDER, 'folder', { path: 'folder' });
const SUBFOLDER = node(ScopeType.FOLDER, 'subfolder', { path: 'folder.subfolder' });
const DOCUMENT = node(ScopeType.DOCUMENT, 'document');

const CHAIN: readonly ChainNode[] = [TENANT, LIBRARY, FOLDER, SUBFOLDER, DOCUMENT];

describe('deny precedence', () => {
  it('lets a deny at any level beat an allow at any other, however specific', () => {
    // The `ALLOW` is on the document itself; the `DENY` is four levels above it. ADR-0005's
    // alternative 1 — most-specific-wins — would allow this. Deny-wins refuses it.
    const decision = decideFromEntries(
      CHAIN,
      [allow('document', 'ROLE', 'r1'), deny('library', 'ROLE', 'r1')],
      true,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('DENY');
  });

  it('beats the tenant-level role grant too, which is step 4 running before step 6', () => {
    const decision = decideFromEntries(CHAIN, [deny('folder', 'USER', 'u1')], true);
    expect(decision).toMatchObject({ allowed: false, reason: 'DENY' });
  });

  it('names the nearest denying node, because that is the one an administrator edits', () => {
    const decision = decideFromEntries(
      CHAIN,
      [deny('library', 'ROLE', 'r1'), deny('subfolder', 'ROLE', 'r1')],
      false,
    );
    expect(decision.decidedAt?.id).toBe('subfolder');
  });
});

describe('allow, and closed by default', () => {
  it('allows on an entry with no deny anywhere, and names the node', () => {
    const decision = decideFromEntries(CHAIN, [allow('folder', 'DEPARTMENT', 'd1')], false);
    expect(decision).toMatchObject({ allowed: true, reason: 'ALLOW' });
    expect(decision.decidedAt?.id).toBe('folder');
  });

  it('falls through to the tenant-level role grant when no entry matches', () => {
    const decision = decideFromEntries(CHAIN, [], true);
    expect(decision).toMatchObject({ allowed: true, reason: 'ROLE_GRANT' });
    expect(decision.decidedAt?.type).toBe(ScopeType.TENANT);
  });

  it('refuses when there is neither an entry nor a grant', () => {
    expect(decideFromEntries(CHAIN, [], false)).toMatchObject({
      allowed: false,
      decidedAt: null,
      reason: 'CLOSED_BY_DEFAULT',
    });
  });
});

describe('breaking inheritance', () => {
  const broken: readonly ChainNode[] = [
    TENANT,
    LIBRARY,
    { ...FOLDER, breaksInheritance: true },
    SUBFOLDER,
    DOCUMENT,
  ];

  it('stops the walk at the breaking folder for an ordinary permission', () => {
    const effective = effectiveChain(broken, Permission.DOCUMENT_VIEW);
    expect(effective.map((entry) => entry.scope.id)).toEqual(['folder', 'subfolder', 'document']);
    expect(reachesTenant(effective)).toBe(false);
  });

  it('takes the tenant-level role grant with it — a break is not "allows only"', () => {
    const effective = effectiveChain(broken, Permission.DOCUMENT_VIEW);
    // Holding `document:view` tenant-wide is no longer enough: the grant lives on a node the walk
    // no longer reaches. This is the whole point of the flag, and the sharpest thing about it.
    expect(decideFromEntries(effective, [], true)).toMatchObject({ reason: 'CLOSED_BY_DEFAULT' });
    // An entry at or below the break still grants.
    expect(decideFromEntries(effective, [allow('subfolder', 'USER', 'u1')], false)).toMatchObject({
      allowed: true,
    });
  });

  it('drops a deny above the break as well as an allow, so the break is not a one-way valve', () => {
    const effective = effectiveChain(broken, Permission.DOCUMENT_VIEW);
    expect(
      decideFromEntries(
        effective,
        [deny('library', 'USER', 'u1'), allow('folder', 'USER', 'u1')],
        false,
      ),
    ).toMatchObject({ allowed: true, reason: 'ALLOW' });
  });

  it('is ignored entirely by an administrative permission', () => {
    for (const permission of [Permission.FOLDER_MANAGE, Permission.AUDIT_VIEW] as const) {
      const effective = effectiveChain(broken, permission);
      expect(effective).toHaveLength(broken.length);
      expect(reachesTenant(effective)).toBe(true);
      // Which is what stops a user hiding a subtree from the administrators accountable for it.
      expect(decideFromEntries(effective, [], true)).toMatchObject({ allowed: true });
    }
  });

  it('takes the deepest break when a chain has two', () => {
    const twice: readonly ChainNode[] = [
      TENANT,
      LIBRARY,
      { ...FOLDER, breaksInheritance: true },
      { ...SUBFOLDER, breaksInheritance: true },
      DOCUMENT,
    ];
    expect(effectiveChain(twice, Permission.DOCUMENT_VIEW).map((entry) => entry.scope.id)).toEqual([
      'subfolder',
      'document',
    ]);
  });
});

describe('the index subjects, and their agreement with the decision', () => {
  it('materialises exactly the Phase 8 answer when no entry exists', () => {
    // The contract that keeps a tenant which has never opened the permissions screen from being
    // re-indexed differently by this phase.
    expect(indexSubjectsFromEntries(CHAIN, [], Permission.DOCUMENT_VIEW)).toEqual(
      indexAclSubjects(Permission.DOCUMENT_VIEW),
    );
  });

  it('drops the grant token below a break, and carries explicit subjects instead', () => {
    const effective = effectiveChain(
      [TENANT, LIBRARY, { ...FOLDER, breaksInheritance: true }, DOCUMENT],
      Permission.DOCUMENT_VIEW,
    );
    const subjects = indexSubjectsFromEntries(
      effective,
      [allow('folder', 'ROLE', 'r1')],
      Permission.DOCUMENT_VIEW,
    );
    expect(subjects.allowSubjects).not.toContain(grantSubjectToken(Permission.DOCUMENT_VIEW));
    expect(subjects.allowSubjects).toEqual(['role:r1']);
  });

  it('puts a subject in both lists when it is allowed above and denied below', () => {
    // The search predicate is `allow && caller AND NOT (deny && caller)`, so appearing in both is
    // how the engine reaches the same answer `decideFromEntries` does.
    const entries = [allow('library', 'ROLE', 'r1'), deny('folder', 'ROLE', 'r1')];
    const subjects = indexSubjectsFromEntries(CHAIN, entries, Permission.DOCUMENT_VIEW);
    expect(subjects.allowSubjects).toContain('role:r1');
    expect(subjects.denySubjects).toContain('role:r1');
    expect(decideFromEntries(CHAIN, entries, false).allowed).toBe(false);
  });

  it('ignores an entry on a node the effective chain does not contain', () => {
    const effective = effectiveChain(
      [TENANT, LIBRARY, { ...FOLDER, breaksInheritance: true }, DOCUMENT],
      Permission.DOCUMENT_VIEW,
    );
    const subjects = indexSubjectsFromEntries(
      effective,
      [allow('library', 'USER', 'u1')],
      Permission.DOCUMENT_VIEW,
    );
    expect(subjects.allowSubjects).toEqual([]);
  });
});

// --- Fixtures -----------------------------------------------------------------------------

function node(type: ScopeRef['type'], id: string, extras: { path?: string } = {}): ChainNode {
  return {
    scope: { type, id: asId(id) },
    breaksInheritance: false,
    path: extras.path ?? null,
  };
}

function allow(
  scopeId: string,
  subjectType: ChainEntry['subjectType'],
  subjectId: string,
): ChainEntry {
  return { scopeId, subjectType, subjectId, effect: 'ALLOW' };
}

function deny(
  scopeId: string,
  subjectType: ChainEntry['subjectType'],
  subjectId: string,
): ChainEntry {
  return { scopeId, subjectType, subjectId, effect: 'DENY' };
}
