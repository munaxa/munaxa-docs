import { type UserStatusKey, UserStatus } from '@edms/domain';

/**
 * The rules about a user that hold regardless of how a user is stored or delivered.
 *
 * Pure by construction — no Nest, no Prisma, no clock, no I/O. Everything here is a decision
 * the product makes about identity, expressed so it can be tested without a database and
 * reused by anything that needs the same answer.
 */

/**
 * The form of an address used for lookup and uniqueness.
 *
 * Addresses are matched case-insensitively because people do not remember how they
 * capitalised their own email, and the partial unique index in the database is built on this
 * value. The original spelling is kept separately and is what the product displays.
 *
 * Deliberately *not* done: stripping dots or `+tags` from the local part. That is
 * provider-specific behaviour, and applying Gmail's rules to a corporate address would merge
 * two genuinely different people.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Whether an address is well-formed enough to store.
 *
 * Intentionally permissive: the authoritative test of an address is whether mail sent to it
 * arrives, which is what the invitation flow does. A stricter pattern here would reject valid
 * addresses — quoted local parts, new top-level domains — and buy nothing.
 */
export function isPlausibleEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (normalized.length === 0 || normalized.length > 320) {
    return false;
  }
  const at = normalized.indexOf('@');
  if (at <= 0 || at !== normalized.lastIndexOf('@') || at === normalized.length - 1) {
    return false;
  }
  const domain = normalized.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

/**
 * Whether a user in this state may hold a session.
 *
 * `INVITED` is deliberately excluded: an invitation is an offer, not an account. The
 * invitation flow sets a password and moves the user to `ACTIVE` in the same transaction, so
 * there is no window in which an invited user can sign in.
 */
export function canSignIn(status: UserStatusKey): boolean {
  return status === UserStatus.ACTIVE;
}

/**
 * The status changes the product allows.
 *
 * A disabled user can be re-enabled; a user can never return to `INVITED`, because the
 * invitation has already been accepted and re-issuing one would let an administrator reset
 * someone's account by demoting it.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<UserStatusKey, readonly UserStatusKey[]>> =
  Object.freeze({
    [UserStatus.INVITED]: [UserStatus.ACTIVE, UserStatus.DISABLED],
    [UserStatus.ACTIVE]: [UserStatus.DISABLED],
    [UserStatus.DISABLED]: [UserStatus.ACTIVE],
  });

export function canTransition(from: UserStatusKey, to: UserStatusKey): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
