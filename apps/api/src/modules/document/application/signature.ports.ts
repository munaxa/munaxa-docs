import type { AnyId, DocumentId, RevisionId, SignaturePurposeKey, UserId } from '@edms/domain';

/**
 * What signing needs, in Document's own words.
 *
 * Two ports and a repository, and the split follows the one this module already uses for revisions
 * and bytes: Document owns the *act* of signing — what a signature means, what it attests, who may
 * take one — and declares what it needs from the modules that own credentials and identities.
 */
export const DOCUMENT_SIGNATURE_REPOSITORY = Symbol('DocumentSignatureRepository');
export const SIGNER_AUTHENTICATOR = Symbol('SignerAuthenticator');

/**
 * Re-proving who is signing — 21 CFR Part 11 §11.200, implemented by Identity.
 *
 * Declared here and implemented there for the reason every inverted port in this module exists:
 * Identity owns `user_credential` and is the only interface in the product that can see a password
 * hash, and a document use case that could verify a password would be a document use case holding
 * the credential surface. What Document needs is one boolean, and this is it.
 *
 * `mfaCode` is checked when the signer has a confirmed authenticator and ignored when they do not.
 * Phase 14 built the factor and the challenge; a signature is the one act in this product where
 * re-proving it is worth the friction, and reusing `MfaService.challenge` means the recovery-code
 * path and the replay protection come with it rather than being reimplemented at a second door.
 */
export interface SignerAuthenticator {
  /**
   * Whether these credentials are this user's, right now.
   *
   * Answers false rather than throwing for every failure — wrong password, missing password, an
   * owed factor not supplied, a wrong code. The caller turns that into one refusal with one
   * message, because distinguishing them would tell somebody holding a stolen session which half
   * of the credentials they still need.
   */
  reauthenticate(input: {
    readonly userId: UserId;
    readonly password: string | null;
    readonly mfaCode: string | null;
  }): Promise<boolean>;
}

export interface SignatureRecord {
  readonly id: AnyId;
  readonly documentId: DocumentId;
  readonly revisionId: RevisionId;
  readonly revisionLabel: string;
  readonly signerUserId: UserId;
  /** As it stood when the signature was taken (§11.50). Never re-resolved from the user row. */
  readonly signerName: string;
  readonly purpose: SignaturePurposeKey;
  readonly statement: string | null;
  readonly contentSha256: string;
  readonly statementBody: string;
  readonly signature: string;
  readonly algorithm: string;
  readonly keyId: string;
  readonly signedAt: Date;
  readonly reauthenticated: boolean;
  readonly withdrawnAt: Date | null;
  readonly withdrawnBy: string | null;
  readonly withdrawnReason: string | null;
}

export interface NewSignature {
  readonly id: string;
  readonly documentId: string;
  readonly revisionId: string;
  readonly signerUserId: string;
  readonly purpose: SignaturePurposeKey;
  readonly statement: string | null;
  readonly contentSha256: string;
  readonly statementBody: string;
  readonly signature: string;
  readonly algorithm: string;
  readonly keyId: string;
  readonly signedAt: Date;
  readonly reauthenticated: boolean;
}

export interface DocumentSignatureRepository {
  insert(signature: NewSignature): Promise<void>;
  findById(id: string): Promise<SignatureRecord | null>;
  /** Every signature on a revision, newest first. Withdrawn ones included — they are history. */
  listForRevision(revisionId: RevisionId): Promise<readonly SignatureRecord[]>;
  listForDocument(documentId: DocumentId): Promise<readonly SignatureRecord[]>;
  /**
   * Whether this person already holds a live signature on this revision for this purpose.
   *
   * Checked rather than enforced by a unique index, and the reason is the withdrawal: a partial
   * unique index on `(revision, signer, purpose) WHERE withdrawn_at IS NULL` would express it, and
   * would give a duplicate attempt a constraint violation instead of a sentence. A signature is an
   * act somebody takes deliberately; telling them "you have already signed this as the author"
   * is worth the extra read.
   */
  liveSignatureExists(input: {
    readonly revisionId: string;
    readonly signerUserId: string;
    readonly purpose: SignaturePurposeKey;
  }): Promise<boolean>;
  withdraw(input: {
    readonly id: string;
    readonly by: string;
    readonly reason: string;
    readonly at: Date;
  }): Promise<boolean>;
}
