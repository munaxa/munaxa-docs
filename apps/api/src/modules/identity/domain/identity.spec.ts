import { describe, expect, it } from 'vitest';

import { UserStatus } from '@edms/domain';

import { MINIMUM_PASSWORD_LENGTH, checkPassword, isAcceptablePassword } from './password-policy';
import { canSignIn, canTransition, isPlausibleEmail, normalizeEmail } from './user';

describe('email handling', () => {
  it('normalises case and surrounding space, because people do not', () => {
    expect(normalizeEmail('  Ada.Lovelace@Acme.TEST ')).toBe('ada.lovelace@acme.test');
  });

  it('leaves dots and plus-tags alone', () => {
    // Stripping them is Gmail's rule, not everyone's; applying it would merge two different
    // people at a corporate domain.
    expect(normalizeEmail('a.b+docs@acme.test')).toBe('a.b+docs@acme.test');
  });

  it('accepts ordinary addresses and rejects shapes that cannot be delivered', () => {
    expect(isPlausibleEmail('ada@acme.test')).toBe(true);
    expect(isPlausibleEmail('ada+docs@sub.acme.co.uk')).toBe(true);

    expect(isPlausibleEmail('ada')).toBe(false);
    expect(isPlausibleEmail('@acme.test')).toBe(false);
    expect(isPlausibleEmail('ada@')).toBe(false);
    expect(isPlausibleEmail('ada@@acme.test')).toBe(false);
    expect(isPlausibleEmail('ada@acme')).toBe(false);
    expect(isPlausibleEmail('ada@acme.')).toBe(false);
    expect(isPlausibleEmail('')).toBe(false);
  });
});

describe('sign-in eligibility', () => {
  it('admits only active users', () => {
    expect(canSignIn(UserStatus.ACTIVE)).toBe(true);
    // An invitation is an offer, not an account.
    expect(canSignIn(UserStatus.INVITED)).toBe(false);
    expect(canSignIn(UserStatus.DISABLED)).toBe(false);
  });
});

describe('status transitions', () => {
  it('allows an invitation to be accepted or withdrawn', () => {
    expect(canTransition(UserStatus.INVITED, UserStatus.ACTIVE)).toBe(true);
    expect(canTransition(UserStatus.INVITED, UserStatus.DISABLED)).toBe(true);
  });

  it('allows disabling and re-enabling', () => {
    expect(canTransition(UserStatus.ACTIVE, UserStatus.DISABLED)).toBe(true);
    expect(canTransition(UserStatus.DISABLED, UserStatus.ACTIVE)).toBe(true);
  });

  it('never returns a user to invited', () => {
    // Otherwise an administrator could reset someone's account by demoting it.
    expect(canTransition(UserStatus.ACTIVE, UserStatus.INVITED)).toBe(false);
    expect(canTransition(UserStatus.DISABLED, UserStatus.INVITED)).toBe(false);
  });
});

describe('password policy', () => {
  it('accepts a long passphrase with no special characters', () => {
    expect(isAcceptablePassword('correct horse battery staple')).toBe(true);
  });

  it('rejects anything shorter than the minimum', () => {
    expect(checkPassword('a'.repeat(MINIMUM_PASSWORD_LENGTH - 1))).toContain('TOO_SHORT');
    expect(checkPassword('a'.repeat(MINIMUM_PASSWORD_LENGTH))).not.toContain('TOO_SHORT');
  });

  it('rejects an unbounded password, which is a denial of service against our own CPU', () => {
    expect(checkPassword('a'.repeat(257))).toContain('TOO_LONG');
  });

  it('rejects whitespace pretending to be length', () => {
    expect(checkPassword(' '.repeat(20))).toContain('WHITESPACE_ONLY');
  });

  it('rejects a password containing the account it protects', () => {
    expect(checkPassword('ada@acme.test-2026', ['ada@acme.test'])).toContain('CONTAINS_IDENTIFIER');
    expect(checkPassword('Ada Lovelace rocks!!', ['Ada Lovelace'])).toContain(
      'CONTAINS_IDENTIFIER',
    );
  });

  it('ignores identifiers too short to mean anything', () => {
    // A three-letter display name would otherwise ban most of the dictionary.
    expect(checkPassword('correct horse battery staple', ['ada'])).toEqual([]);
  });

  it('reports every reason at once rather than one at a time', () => {
    expect(checkPassword('   ')).toEqual(expect.arrayContaining(['TOO_SHORT', 'WHITESPACE_ONLY']));
  });
});
