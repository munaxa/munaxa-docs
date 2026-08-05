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
 * that can read `JWT_ACCESS_SECRET` can unseal these, and it could also mint access tokens directly,
 * so the second property is not the one being bought. What it buys is that a backup, a replica, a
 * dump handed to a support engineer, or a `SELECT` through an injection does not carry usable
 * second factors. 05's schema has no column-encryption facility and adding one for a single column
 * would be a wider change than this phase warrants; the phase report records that, and names the
 * phase that would do it properly with a key management service.
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
@Injectable()
export class PrismaMfaRepository implements MfaRepository {
  private readonly key: Buffer;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly stamps: RecordStamps,
  ) {
    // A derived key rather than the secret itself: the signing secret is used to sign tokens, and
    // one string doing two cryptographic jobs is how a rotation in one breaks the other silently.
    this.key = createHash('sha256')
      .update(`munaxa-docs:mfa-secret:${config.auth.accessSecret}`)
      .digest();
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

  async recordSuccess(enrolmentId: AnyId, step: number): Promise<void> {
    await requireTransaction().mfaEnrolment.updateMany({
      where: { id: String(enrolmentId), tenantId: requireContext().tenantId },
      data: { lastStep: BigInt(step), failedAttempts: 0, updatedAt: this.stamps.now() },
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

  async markRecoveryCodeUsed(id: AnyId, at: Date): Promise<void> {
    await requireTransaction().mfaRecoveryCode.updateMany({
      where: { id: String(id), tenantId: requireContext().tenantId },
      data: { usedAt: at },
    });
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

  private seal(secret: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const sealed = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [
      nonce.toString('base64'),
      sealed.toString('base64'),
      cipher.getAuthTag().toString('base64'),
    ].join('.');
  }

  private unseal(stored: string): string {
    const [nonce, sealed, tag] = stored.split('.');
    if (nonce === undefined || sealed === undefined || tag === undefined) {
      throw new Error('The stored authenticator secret is not in the sealed format.');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
