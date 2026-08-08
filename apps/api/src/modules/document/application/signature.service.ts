import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  type DocumentId,
  type RevisionId,
  SIGNATURE_STATEMENT_VERSION,
  type SignaturePurposeKey,
  Settings,
  asId,
  revisionIsSignable,
  serialiseSignatureStatement,
} from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import {
  ForbiddenError,
  NotFoundError,
  ProviderNotConfiguredError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { DocumentAudit } from '../domain/audit-actions';
import {
  DOCUMENT_CONTENT_GATE,
  DOCUMENT_REPOSITORY,
  REVISION_WRITER,
  type DocumentContentGate,
  type DocumentRepository,
  type RevisionWriter,
} from './ports';
import {
  DOCUMENT_SIGNATURE_REPOSITORY,
  SIGNER_AUTHENTICATOR,
  type DocumentSignatureRepository,
  type SignatureRecord,
  type SignerAuthenticator,
} from './signature.ports';
import { DOCUMENT_CONFIGURATION, type DocumentConfiguration } from './configuration.port';
import { DuplicateSignatureError } from '../infrastructure/prisma-signature.repository';

/**
 * Taking, withdrawing and verifying an electronic signature.
 *
 * [ADR-0017](../../../../../docs/architecture/adr/0017-electronic-signature-as-witnessed-attestation.md)
 * decides what one is: a 21 CFR Part 11 §11.50 manifestation — printed name, instant, meaning —
 * bound under §11.70 to the signed revision's content digest, witnessed by the server with the same
 * HMAC construction Phase 9 uses for audit checkpoints. Everything in this class is one of those
 * four requirements made into code, and the comments say which.
 *
 * ## What it will not do
 *
 * It will not sign without a witness key. A deployment with no `SIGNATURE_WITNESS_SECRET` refuses
 * rather than writing an unwitnessed row, because a signature nothing witnessed is a row that looks
 * identical to one that was — and would be discovered to differ during the inspection it exists
 * for. That is the same posture the checkpoint secret takes, deliberately.
 *
 * It will not sign a `DISCARDED` revision. Attesting content somebody deliberately threw away
 * produces a signature indistinguishable, in any list, from one about content that matters.
 *
 * It will not re-resolve the signer's name at read time. §11.50 asks for the printed name *in the
 * manifestation*, and a person who marries next year must not retroactively change what the record
 * says was signed.
 */
@Injectable()
export class DocumentSignatureService {
  constructor(
    @Inject(DOCUMENT_SIGNATURE_REPOSITORY) private readonly signatures: DocumentSignatureRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(REVISION_WRITER) private readonly revisions: RevisionWriter,
    @Inject(DOCUMENT_CONTENT_GATE) private readonly content: DocumentContentGate,
    @Inject(SIGNER_AUTHENTICATOR) private readonly authenticator: SignerAuthenticator,
    @Inject(DOCUMENT_CONFIGURATION) private readonly configuration: DocumentConfiguration,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly writer: AdministeredWriter,
  ) {}

  async sign(input: {
    readonly documentId: string;
    readonly revisionId: string;
    readonly purpose: SignaturePurposeKey;
    readonly statement: string | null;
    readonly password: string | null;
    readonly mfaCode: string | null;
  }): Promise<SignatureRecord> {
    if (!(await this.settings.get(Settings.FEATURE_ELECTRONIC_SIGNATURES))) {
      throw new ValidationError('Electronic signatures are turned off for this organisation.', [
        { field: 'feature', message: 'disabled' },
      ]);
    }
    const secret = this.config.signature.witnessSecret;
    if (secret === null) {
      throw new ProviderNotConfiguredError('signature witness', 'SIGNATURE_WITNESS_SECRET');
    }

    const signerId = this.requireActor();
    // §11.200: a session cookie is one identification component and it was checked at sign-in. The
    // second is proved here, now, or the tenant has said in its own settings that it does not
    // operate under a regime that requires one.
    const reauthenticated = await this.settings.get(Settings.SIGNATURE_REQUIRE_REAUTHENTICATION);
    if (reauthenticated) {
      const proved = await this.authenticator.reauthenticate({
        userId: asId(signerId),
        password: input.password,
        mfaCode: input.mfaCode,
      });
      if (!proved) {
        // One refusal for every cause. Distinguishing "wrong password" from "code required" would
        // tell somebody holding a stolen session which half of the credentials they still need.
        throw new ForbiddenError('sign without proving your credentials');
      }
    }

    try {
      return await this.signWithin({
        input,
        signerId,
        secret,
        reauthenticated,
      });
    } catch (error) {
      // The same refusal the in-transaction check produces, for the same situation reached a
      // different way — Phase 6.7. That check is a read-then-write and `TenantDatabase.withTenant`
      // opens its transaction with no `isolationLevel`, so under READ COMMITTED a concurrent signer
      // can pass it. `uq_document_signature_live` is what actually stops the second insert; its
      // violation is translated here into the outcome a caller already understands, rather than
      // reaching the API as a `500`.
      if (error instanceof DuplicateSignatureError) {
        throw new ValidationError('You have already signed this revision for that purpose.', [
          { field: 'purpose', message: 'duplicate' },
        ]);
      }
      throw error;
    }
  }

  private async signWithin(context: {
    readonly input: {
      readonly documentId: string;
      readonly revisionId: string;
      readonly purpose: SignaturePurposeKey;
      readonly statement: string | null;
    };
    readonly signerId: string;
    readonly secret: string;
    readonly reauthenticated: boolean;
  }): Promise<SignatureRecord> {
    const { input, signerId, secret, reauthenticated } = context;
    return this.writer.write<SignatureRecord>(async () => {
      const document = await this.documents.findById(asId<DocumentId>(input.documentId), false);
      if (document === null) {
        throw new NotFoundError('The requested document');
      }
      const revision = await this.revisions.describe(input.documentId, input.revisionId);
      if (revision === null) {
        throw new NotFoundError('The requested revision');
      }
      if (!revisionIsSignable(revision.status)) {
        throw new ValidationError('A discarded revision cannot be signed.', [
          { field: 'revisionId', message: revision.status },
        ]);
      }
      if (
        await this.signatures.liveSignatureExists({
          revisionId: input.revisionId,
          signerUserId: signerId,
          purpose: input.purpose,
        })
      ) {
        throw new ValidationError('You have already signed this revision for that purpose.', [
          { field: 'purpose', message: 'duplicate' },
        ]);
      }

      // The digest is read from the *revision's own file*, never from the request. §11.70's
      // signature/record link is only a link if the record decides what is signed.
      const file = await this.fileDigestOf(revision.fileObjectId);
      const signer = await this.configuration.signer(signerId);
      const signedAt = this.writer.clock.now();

      const statementBody = serialiseSignatureStatement({
        tenantId: requireContext().tenantId,
        documentId: document.id,
        documentNumber: document.documentNumber,
        revisionId: revision.id,
        revisionLabel: revision.label,
        contentDigest: file,
        signerUserId: signerId,
        signerName: signer?.displayName ?? signerId,
        signerEmail: signer?.email ?? '',
        purpose: input.purpose,
        statement: input.statement,
        signedAt: signedAt.toISOString(),
      });

      const id = this.writer.clock.nextId();
      await this.signatures.insert({
        id,
        documentId: document.id,
        revisionId: revision.id,
        signerUserId: signerId,
        purpose: input.purpose,
        statement: input.statement,
        contentSha256: file,
        statementBody,
        signature: witness(statementBody, secret),
        algorithm: 'HMAC-SHA256',
        keyId: keyIdFor(secret),
        signedAt,
        reauthenticated,
      });

      const saved = await this.signatures.findById(id);
      if (saved === null) {
        throw new NotFoundError('The requested signature');
      }
      return {
        result: saved,
        change: {
          action: DocumentAudit.DOCUMENT_SIGNED,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(document.id),
          operation: AdministrativeOperation.CREATED,
          // Minimised (13 §3): what was signed and what it meant, never the statement body — which
          // is on the row, and putting it here too would be a second copy of the signed bytes in a
          // table with no retention policy.
          after: {
            signatureId: id,
            revisionId: revision.id,
            revisionLabel: revision.label,
            purpose: input.purpose,
            contentSha256: file,
            reauthenticated,
          },
          ...(input.statement !== null && { reason: input.statement }),
        },
      };
    });
  }

  /**
   * Taking a signature back.
   *
   * A row's own columns rather than a delete, so "withdrawn by whom, why and when" survives — and a
   * second audit event rather than an edit to the first, because the trail refuses `UPDATE` and
   * because a withdrawal is its own act with its own actor.
   *
   * Only the signer may withdraw their own signature. Not an administrator, and that is the
   * decision: a signature is a personal attestation, and somebody else retracting it on your behalf
   * is a different fact that this product has no way to record honestly. An administrator who needs
   * a signature gone has the audit trail and the document's own history, both of which say it
   * happened.
   */
  async withdraw(signatureId: string, reason: string): Promise<SignatureRecord> {
    return this.writer.write<SignatureRecord>(async () => {
      const current = await this.signatures.findById(signatureId);
      if (current === null) {
        throw new NotFoundError('The requested signature');
      }
      const actor = this.requireActor();
      if ((current.signerUserId as string) !== actor) {
        throw new ForbiddenError("withdraw somebody else's signature");
      }
      if (current.withdrawnAt !== null) {
        throw new ValidationError('This signature has already been withdrawn.', [
          { field: 'signatureId', message: 'withdrawn' },
        ]);
      }
      const at = this.writer.clock.now();
      await this.signatures.withdraw({ id: signatureId, by: actor, reason, at });
      const saved = await this.signatures.findById(signatureId);
      if (saved === null) {
        throw new NotFoundError('The requested signature');
      }
      return {
        result: saved,
        change: {
          action: DocumentAudit.DOCUMENT_SIGNED,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(current.documentId),
          operation: AdministrativeOperation.DELETED,
          after: { signatureId, purpose: current.purpose, withdrawn: true },
          reason,
        },
      };
    });
  }

  listForDocument(documentId: string): Promise<readonly SignatureRecord[]> {
    return this.writer.read(() => this.signatures.listForDocument(asId<DocumentId>(documentId)));
  }

  listForRevision(revisionId: string): Promise<readonly SignatureRecord[]> {
    return this.writer.read(() => this.signatures.listForRevision(asId<RevisionId>(revisionId)));
  }

  /**
   * Three answers, not one.
   *
   * `signatureValid` — the witness still verifies over the stored bytes. False means the row was
   * altered, or the key that made it is gone; the two are distinguished by `witnessedBy`.
   *
   * `contentMatches` — the revision's file still has the digest that was signed. False means the
   * signature is perfectly intact and is about content this revision no longer holds, which is a
   * §11.70 finding rather than a broken signature. Given ADR-0003 and the check-in model this
   * should be impossible; verifying it anyway is the point of verifying it.
   *
   * `withdrawn` — neither of the above. The signature is valid and its signer took it back.
   */
  async verify(signatureId: string): Promise<{
    readonly signature: SignatureRecord;
    readonly signatureValid: boolean;
    readonly contentMatches: boolean;
    readonly withdrawn: boolean;
    readonly witnessedBy: string;
  }> {
    return this.writer.read(async () => {
      const record = await this.signatures.findById(signatureId);
      if (record === null) {
        throw new NotFoundError('The requested signature');
      }
      const secret = this.config.signature.witnessSecret;
      const currentKeyId = secret === null ? null : keyIdFor(secret);
      const signatureValid =
        secret !== null &&
        currentKeyId === record.keyId &&
        verifyWitness(record.statementBody, record.signature, secret);

      const revision = await this.revisions.describe(record.documentId, record.revisionId);
      const currentDigest =
        revision === null ? null : await this.fileDigestOf(revision.fileObjectId);

      return {
        signature: record,
        signatureValid,
        contentMatches: currentDigest !== null && currentDigest === record.contentSha256,
        withdrawn: record.withdrawnAt !== null,
        // The witness, named. Deliberately a key identifier rather than a certificate subject:
        // ADR-0017 refuses to let this product imply a trust framework it is not party to. A key
        // this deployment no longer holds is named as the row recorded it, so a verification that
        // cannot check says *why*.
        witnessedBy:
          currentKeyId === record.keyId
            ? `munaxa-docs:${record.keyId}`
            : `munaxa-docs:${record.keyId} (key not held by this deployment)`,
      };
    });
  }

  /**
   * The signed revision's content digest, read from the blob itself.
   *
   * Through the content gate rather than from the joined document row, and the difference matters
   * for exactly the case that makes signatures interesting: an older, superseded revision is
   * perfectly signable — "I attest that Rev 2 said this" is an ordinary act — and it is neither the
   * latest nor the published revision, so it is not on the joined row at all. The gate answers for
   * any blob this tenant holds.
   *
   * The digest is the blob's own, which under ADR-0007 *is* its identity: a `file_object` is named
   * by the hash of its content, so this is not a re-hash that could drift from the row.
   */
  private async fileDigestOf(fileObjectId: string): Promise<string> {
    const file = await this.content.describe(fileObjectId);
    if (file === null) {
      throw new NotFoundError('The requested file');
    }
    return file.checksumSha256;
  }

  private requireActor(): string {
    const { userId } = requireContext();
    if (userId === null) {
      throw new ForbiddenError('sign as nobody');
    }
    return userId;
  }
}

/** The witness. `SIGNATURE_STATEMENT_VERSION` is in the signed bytes, so the algorithm is bound. */
function witness(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** Constant-time, because a signature check that leaks its own progress is not a check. */
function verifyWitness(body: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The key's identifier, derived from the key.
 *
 * Derived rather than configured beside it, so an operator who rotates the secret cannot forget to
 * change the name — and every signature made under the old key goes on naming it, which is what
 * turns a rotation into a survivable event rather than a mass invalidation. It is a *truncated*
 * digest of the secret, which is not a disclosure at sixteen hex characters of SHA-256 and is
 * exactly enough to tell two keys apart.
 */
function keyIdFor(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16);
}

/** Kept beside the statement version so a reader sees both in one place. */
export const SIGNATURE_ALGORITHM = `HMAC-SHA256/v${String(SIGNATURE_STATEMENT_VERSION)}` as const;
