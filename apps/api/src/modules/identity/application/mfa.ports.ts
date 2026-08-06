import type { AnyId, UserId } from '@edms/domain';

/**
 * The second factor — `17-security-architecture.md` §2, the TOTP half.
 *
 * `user.mfa_enrolled` has existed since Phase 1, read by the auth response and the admin view and
 * **written by nothing**. A boolean that has answered "no" for thirteen phases whatever the truth
 * was is not a feature that is missing; it is a fact the product asserts and does not check.
 */
export const MFA_REPOSITORY = Symbol('MfaRepository');
export const MFA_SERVICE = Symbol('MfaService');

export interface MfaEnrolmentRecord {
  readonly id: AnyId;
  readonly userId: UserId;
  /** Sealed at rest; the service unseals it and nothing above the service sees it. */
  readonly secret: string;
  /**
   * True when the row was sealed under a key this deployment no longer seals with — Phase 18.
   *
   * The rotation mechanism, and the reason it is a flag rather than a migration: re-sealing every
   * row at deploy time would need every row's plaintext in one process at one moment, which is the
   * one thing sealing exists to avoid. Instead a stale row is re-sealed the next time its owner
   * proves it, inside the transaction that records the success — so a rotation completes as people
   * sign in, and a row nobody uses stays readable under the old key until they do.
   */
  readonly staleSeal: boolean;
  readonly confirmedAt: Date | null;
  /** The last time step consumed, so a captured code cannot be replayed inside its own window. */
  readonly lastStep: number | null;
  readonly failedAttempts: number;
}

export interface MfaRepository {
  findFor(userId: UserId): Promise<MfaEnrolmentRecord | null>;
  /** Replaces any *unconfirmed* enrolment; a confirmed one is refused by the service first. */
  startEnrolment(userId: UserId, secret: string): Promise<AnyId>;
  confirm(
    enrolmentId: AnyId,
    userId: UserId,
    step: number,
    codeHashes: readonly string[],
  ): Promise<void>;
  /** Records a successful challenge: the step consumed, and the failure counter reset. */
  recordSuccess(enrolmentId: AnyId, step: number): Promise<void>;
  /**
   * Re-seals a secret under the deployment's current key — Phase 18's rotation path.
   *
   * Takes the plaintext because the caller has just unsealed it to verify a code, and a repository
   * that re-sealed from its own read would be unsealing a second time for no reason. It writes
   * nothing else: the value is byte-identical after the round trip, so this changes the ciphertext
   * and never the secret.
   */
  reseal(enrolmentId: AnyId, secret: string): Promise<void>;
  /** Records a failure and answers how many consecutive ones there have now been. */
  recordFailure(enrolmentId: AnyId): Promise<number>;
  /** Removes the enrolment and every recovery code with it, and clears `user.mfa_enrolled`. */
  remove(userId: UserId): Promise<void>;
  /** Live recovery codes for an enrolment, hashed — the service compares, never the database. */
  liveRecoveryCodes(enrolmentId: AnyId): Promise<readonly { id: AnyId; codeHash: string }[]>;
  markRecoveryCodeUsed(id: AnyId, at: Date): Promise<void>;
  countLiveRecoveryCodes(enrolmentId: AnyId): Promise<number>;
}

export interface MfaEnrolmentOffer {
  /** The base32 secret, shown once. It is never returned by any other read path. */
  readonly secret: string;
  /** `otpauth://` — what an authenticator scans. */
  readonly uri: string;
  readonly digits: number;
  readonly stepSeconds: number;
}

export interface MfaConfirmation {
  /** Shown once and never again; the hashes are all that is stored. */
  readonly recoveryCodes: readonly string[];
}

export interface MfaStatus {
  readonly enrolled: boolean;
  /** True for an enrolment that was started and not yet proved — the "finish setting up" state. */
  readonly pending: boolean;
  readonly recoveryCodesRemaining: number;
}

export interface MfaService {
  statusFor(userId: UserId): Promise<MfaStatus>;
  /** Issues a secret. Refuses when a confirmed enrolment already exists — remove it first. */
  begin(userId: UserId, account: string): Promise<MfaEnrolmentOffer>;
  /** Proves the authenticator holds the secret, and issues the recovery codes. */
  confirm(userId: UserId, code: string): Promise<MfaConfirmation>;
  /**
   * Answers a challenge at sign-in. `null` when the caller is not enrolled and no challenge is
   * owed; `true` / `false` otherwise.
   */
  challenge(userId: UserId, code: string): Promise<boolean>;
  /** Whether this person owes a code before a session is issued. */
  isRequired(userId: UserId): Promise<boolean>;
  /** Un-enrols, ends every session, and audits both. */
  remove(userId: UserId): Promise<void>;
}
