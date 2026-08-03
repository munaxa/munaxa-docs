/**
 * What the product requires of a password.
 *
 * The rules follow NIST SP 800-63B rather than the older composition orthodoxy: length is the
 * control that matters, and forced character classes push people toward `Password1!` — a
 * predictable shape that is weaker than the passphrase they would otherwise have chosen.
 *
 * Pure, so the same rules can be stated in the API's validation error and checked again
 * before hashing, without either copy drifting from the other.
 */

/** Long enough to resist offline attack once stretched; NIST's floor is 8, this is stricter. */
export const MINIMUM_PASSWORD_LENGTH = 12;

/**
 * Bounded because the hash function's cost is a function of input length, and an unbounded
 * password is a denial-of-service vector against our own CPU.
 */
export const MAXIMUM_PASSWORD_LENGTH = 256;

export type PasswordRejection =
  'TOO_SHORT' | 'TOO_LONG' | 'WHITESPACE_ONLY' | 'CONTAINS_IDENTIFIER';

/**
 * Checks a candidate password, optionally against the identifiers it must not contain.
 *
 * Returns every reason it fails rather than the first, so a person fixing their password is
 * told once what is wrong with it instead of discovering the rules one rejection at a time.
 */
export function checkPassword(
  password: string,
  identifiers: readonly string[] = [],
): readonly PasswordRejection[] {
  const rejections: PasswordRejection[] = [];

  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    rejections.push('TOO_SHORT');
  }
  if (password.length > MAXIMUM_PASSWORD_LENGTH) {
    rejections.push('TOO_LONG');
  }
  if (password.trim().length === 0) {
    rejections.push('WHITESPACE_ONLY');
  }

  // A password containing the account's own email or display name is guessable by anyone who
  // knows who the account belongs to, which is everyone in the tenant's directory.
  const haystack = password.toLowerCase();
  const containsIdentifier = identifiers.some((identifier) => {
    const needle = identifier.trim().toLowerCase();
    return needle.length >= 4 && haystack.includes(needle);
  });
  if (containsIdentifier) {
    rejections.push('CONTAINS_IDENTIFIER');
  }

  return rejections;
}

export function isAcceptablePassword(
  password: string,
  identifiers: readonly string[] = [],
): boolean {
  return checkPassword(password, identifiers).length === 0;
}
