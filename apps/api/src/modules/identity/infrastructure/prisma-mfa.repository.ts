import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, type UserId, asId } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { RecordStamps } from '../../../core/persistence/record-stamps';
import { requireTransaction } from '../../../core/prisma';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { MfaEnrolmentRecord, MfaRepository } from '../application/mfa.ports';

/**
 * `mfa_enrolment` and `mfa_recovery_code`.
 *
 * ## The secret is sealed, and what that is and is not worth
 *
 * A TOTP secret is a symmetric key: unlike a password it cannot be hashed, because verifying a code
 * requires computing one. Stored plainly it is a row that lets a database read mint valid codes
 * forever, so it is sealed here with AES-256-GCM under a key derived from the application's own
 * signing secret.
 *
 * **This is defence against a database disclosure, not against a compromised application.** Anything
 * that can read the sealing key can unseal these, so the second property is not the one being
 * bought. What it buys is that a backup, a replica, a dump handed to a support engineer, or a
 * `SELECT` through an injection does not carry usable second factors.
 *
 * ## Phase 18: the key stopped being borrowed, and became rotatable
 *
 * Phase 14's report left a row asking for "a key management service", and reading it as a request
 * for an integration is the mistake. **The deployment's secret store already is the key management
 * service** — a KMS, a sealed secret, a mounted file, a vault agent, or in the smallest on-premise
 * installation an environment variable in a systemd unit — and every other secret this product
 * holds (`JWT_ACCESS_SECRET`, `AUDIT_CHECKPOINT_SECRET`, `SIGNATURE_WITNESS_SECRET`) already comes
 * from it. Adding a `KEY_MANAGEMENT_PORT` here would have been an eleventh port with one adapter,
 * bought for one column, and would still have had exactly this file at the end of it.
 *
 * What the row was actually about is two properties the old arrangement did not have, and they are
 * what this phase built ([ADR-0020](../../../../../docs/architecture/adr/0020-key-management-and-rotation.md)):
 *
 * **One key, one purpose.** `MFA_TOTP_SEALING_KEY` is its own secret. Phase 14 derived one from
 * `JWT_ACCESS_SECRET`, and that derivation was careful — a domain-separated SHA-256, precisely so
 * one string was not doing two cryptographic jobs — but it left the two on **one rotation clock**:
 * rotating the token secret, which is a routine act with a fifteen-minute blast radius, silently
 * made every enrolled authenticator unreadable. That is the coupling the separate key removes.
 *
 * **Every sealed value names the key that sealed it.** The stored format carries a version, so a
 * rotation is survivable rather than a mass invalidation: both keys unseal, new seals use the
 * current one, and a stale row is re-sealed the next time its owner proves a code. `v1` is the
 * derived key and stays readable for ever, so no existing enrolment breaks on the upgrade to this
 * version — which is what makes the change deployable rather than a migration nobody can run.
 *
 * The nonce is stored with the ciphertext because it must be — GCM's nonce is not a secret and must
 * never repeat for one key, which random-per-write guarantees at these volumes.
 *
 * ## Recovery codes are hashed, not sealed
 *
 * Because they *can* be: a recovery code is compared, never recomputed, so it is a password and is
 * treated as one. SHA-256 rather than scrypt, and that is the deliberate difference from
 * `credential.password_hash`: a recovery code is fifty bits of machine-generated entropy that
 * nobody reuses anywhere, so the offline-guessing attack scrypt's cost exists to slow does not
 * apply, and a login path that spent scrypt ten times over a code list would be a denial of service
 * on the account it protects.
 */
/**
 * The sealing key versions this build can read.
 *
 * `V1` is Phase 14's derivation from the token secret, kept for ever because rows sealed under it
 * exist and there is no deploy-time pass that could re-seal them — the plaintext is only available
 * when its owner proves a code. `V2` is the deployment's own key.
 */
const SealVersion = { V1: 'v1', V2: 'v2' } as const;
type SealVersionKey = (typeof SealVersion)[keyof typeof SealVersion];

@Injectable()
export class PrismaMfaRepository implements MfaRepository {
  /** Every key this deployment can unseal with, by version. */
  private readonly keys: ReadonlyMap<SealVersionKey, Buffer>;
  /** The one new seals are written under. */
  private readonly currentVersion: SealVersionKey;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly stamps: RecordStamps,
  ) {
    const keys = new Map<SealVersionKey, Buffer>();
    // Phase 14's key. Derived rather than the secret itself, and kept so that upgrading to this
    // version reads every enrolment already in the database.
    keys.set(
      SealVersion.V1,
      createHash('sha256').update(`munaxa-docs:mfa-secret:${config.auth.accessSecret}`).digest(),
    );
    const dedicated = config.mfa.sealingKey;
    if (dedicated !== null) {
      keys.set(
        SealVersion.V2,
        createHash('sha256').update(`munaxa-docs:mfa-secret:v2:${dedicated}`).digest(),
      );
    }
    this.keys = keys;
    this.currentVersion = dedicated === null ? SealVersion.V1 : SealVersion.V2;
  }

  async findFor(userId: UserId): Promise<MfaEnrolmentRecord | null> {
    const row = await requireTransaction().mfaEnrolment.findFirst({
      where: { userId, tenantId: requireContext().tenantId },
    });
    return row === null
      ? null
      : {
          id: asId<AnyId>(row.id),
          userId,
          secret: this.unseal(row.secret),
          staleSeal: versionOf(row.secret) !== this.currentVersion,
          confirmedAt: row.confirmedAt,
          lastStep: row.lastStep === null ? null : Number(row.lastStep),
          failedAttempts: row.failedAttempts,
        };
  }

  async startEnrolment(userId: UserId, secret: string): Promise<AnyId> {
    const tx = requireTransaction();
    const { tenantId } = requireContext();
    const now = this.stamps.now();
    // Deleting any unconfirmed attempt first is what "start again" means when somebody lost the
    // authenticator app mid-setup. A *confirmed* one is refused by the service before this runs.
    await tx.mfaEnrolment.deleteMany({ where: { tenantId, userId, confirmedAt: null } });

    const id = this.stamps.nextId();
    await tx.mfaEnrolment.create({
      data: {
        id,
        tenantId,
        userId,
        secret: this.seal(secret),
        createdAt: now,
        createdBy: userId,
        updatedAt: now,
        updatedBy: userId,
      },
    });
    return asId<AnyId>(id);
  }

  async confirm(
    enrolmentId: AnyId,
    userId: UserId,
    step: number,
    codeHashes: readonly string[],
  ): Promise<void> {
    const tx = requireTransaction();
    const { tenantId } = requireContext();
    const now = this.stamps.now();

    await tx.mfaEnrolment.updateMany({
      where: { id: String(enrolmentId), tenantId },
      data: {
        confirmedAt: now,
        lastStep: BigInt(step),
        failedAttempts: 0,
        updatedAt: now,
        updatedBy: userId,
        version: { increment: 1 },
      },
    });
    await tx.mfaRecoveryCode.createMany({
      data: codeHashes.map((codeHash) => ({
        id: this.stamps.nextId(),
        tenantId,
        enrolmentId: String(enrolmentId),
        codeHash,
        createdAt: now,
      })),
    });
    // The derived column, written in the same transaction as the thing it derives from. Nothing
    // that reads `user.mfa_enrolled` — the auth response, the admin list — has to learn a new
    // column, and it stops being a claim nothing checks.
    await tx.user.updateMany({ where: { id: userId, tenantId }, data: { mfaEnrolled: true } });
  }

  async claimStep(enrolmentId: AnyId, step: number): Promise<boolean> {
    const { count } = await requireTransaction().mfaEnrolment.updateMany({
      where: {
        id: String(enrolmentId),
        tenantId: requireContext().tenantId,
        // The same question the caller already asked of the row it read, asked again by the write
        // itself. Between the two, another challenge holding the same code can have spent it.
        OR: [{ lastStep: null }, { lastStep: { lt: BigInt(step) } }],
      },
      data: { lastStep: BigInt(step), failedAttempts: 0, updatedAt: this.stamps.now() },
    });
    return count === 1;
  }

  async recordSuccess(enrolmentId: AnyId, step: number): Promise<void> {
    await requireTransaction().mfaEnrolment.updateMany({
      where: { id: String(enrolmentId), tenantId: requireContext().tenantId },
      data: { lastStep: BigInt(step), failedAttempts: 0, updatedAt: this.stamps.now() },
    });
  }

  async reseal(enrolmentId: AnyId, secret: string): Promise<void> {
    // No `updatedBy` and no `updatedAt`: re-sealing is not a change to the enrolment. It is the
    // same secret under a different key, and stamping it would put a modification in the record
    // for something nobody did.
    await requireTransaction().mfaEnrolment.updateMany({
      where: { id: String(enrolmentId), tenantId: requireContext().tenantId },
      data: { secret: this.seal(secret) },
    });
  }

  async recordFailure(enrolmentId: AnyId): Promise<number> {
    const tx = requireTransaction();
    const { tenantId } = requireContext();
    await tx.mfaEnrolment.updateMany({
      where: { id: String(enrolmentId), tenantId },
      data: { failedAttempts: { increment: 1 }, updatedAt: this.stamps.now() },
    });
    const row = await tx.mfaEnrolment.findFirst({
      where: { id: String(enrolmentId), tenantId },
      select: { failedAttempts: true },
    });
    return row?.failedAttempts ?? 0;
  }

  async remove(userId: UserId): Promise<void> {
    const tx = requireTransaction();
    const { tenantId } = requireContext();
    // The recovery codes go with it — `ON DELETE CASCADE`, because a code has no meaning without
    // the enrolment it backs up and the un-enrolment is what the trail records.
    await tx.mfaEnrolment.deleteMany({ where: { tenantId, userId } });
    await tx.user.updateMany({ where: { id: userId, tenantId }, data: { mfaEnrolled: false } });
  }

  async liveRecoveryCodes(enrolmentId: AnyId): Promise<readonly { id: AnyId; codeHash: string }[]> {
    const rows = await requireTransaction().mfaRecoveryCode.findMany({
      where: {
        tenantId: requireContext().tenantId,
        enrolmentId: String(enrolmentId),
        usedAt: null,
      },
      select: { id: true, codeHash: true },
    });
    return rows.map((row) => ({ id: asId<AnyId>(row.id), codeHash: row.codeHash }));
  }

  async claimRecoveryCode(id: AnyId, at: Date): Promise<boolean> {
    const { count } = await requireTransaction().mfaRecoveryCode.updateMany({
      where: {
        id: String(id),
        tenantId: requireContext().tenantId,
        // What the caller believed when it listed this code, asked again by the write itself.
        // Without it there is nothing for the second write to re-evaluate: the row lock orders
        // the two updates and then both of them succeed, and the later one moves `used_at` off
        // the instant the code was actually spent.
        usedAt: null,
      },
      data: { usedAt: at },
    });
    return count === 1;
  }

  async countLiveRecoveryCodes(enrolmentId: AnyId): Promise<number> {
    return requireTransaction().mfaRecoveryCode.count({
      where: {
        tenantId: requireContext().tenantId,
        enrolmentId: String(enrolmentId),
        usedAt: null,
      },
    });
  }

  // --- Sealing ------------------------------------------------------------------------------

  /**
   * Seals under the current key, naming it.
   *
   * `v1` writes the three-part form Phase 14 wrote, byte-compatible with what is in the database:
   * a deployment that has not been given a dedicated key produces exactly what it produced before,
   * so this change is invisible until an operator opts into rotation.
   */
  private seal(secret: string): string {
    const key = this.keyFor(this.currentVersion);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const sealed = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const parts = [
      nonce.toString('base64'),
      sealed.toString('base64'),
      cipher.getAuthTag().toString('base64'),
    ];
    return this.currentVersion === SealVersion.V1
      ? parts.join('.')
      : [this.currentVersion, ...parts].join('.');
  }

  private unseal(stored: string): string {
    const parts = stored.split('.');
    const version = versionOf(stored);
    const [nonce, sealed, tag] = version === SealVersion.V1 ? parts : parts.slice(1);
    if (nonce === undefined || sealed === undefined || tag === undefined) {
      throw new Error('The stored authenticator secret is not in the sealed format.');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.keyFor(version),
      Buffer.from(nonce, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  private keyFor(version: SealVersionKey): Buffer {
    const key = this.keys.get(version);
    if (key === undefined) {
      // Reachable exactly one way: a deployment that had `MFA_TOTP_SEALING_KEY` and removed it,
      // leaving rows nothing can read. Naming the variable is the only useful thing to say, and
      // saying it beats an authentication failure that looks like a wrong code.
      throw new Error(
        `An authenticator secret was sealed under ${version}, which this deployment has no key for. Restore MFA_TOTP_SEALING_KEY.`,
      );
    }
    return key;
  }
}

/**
 * Which key sealed a stored value.
 *
 * Phase 14's format is three dot-separated base64 segments with no version, and base64 contains no
 * dot — so a four-segment value is versioned and a three-segment one is `v1`. That is a structural
 * distinction rather than a guess, and it is the same trick Phase 17 reached for after its API-key
 * separator turned out to be inside its own alphabet.
 */
function versionOf(stored: string): SealVersionKey {
  const parts = stored.split('.');
  return parts.length === 4 && parts[0] === SealVersion.V2 ? SealVersion.V2 : SealVersion.V1;
}
