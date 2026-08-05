import { z } from 'zod';

import { ALL_SIGNATURE_PURPOSES, type SignaturePurposeKey } from '@edms/domain';

import { isoDateTimeSchema, uuidSchema } from '../common/identifiers';

/**
 * Electronic signatures — what the wire calls them, and what it is careful not to call them.
 *
 * ADR-0017 decides which of four readings this product means: a **21 CFR Part 11 §11.50 signature
 * manifestation** — printed name, instant, meaning — bound under §11.70 to the signed revision's
 * content digest, and witnessed by the server with the construction Phase 9 already uses for audit
 * checkpoints and evidence manifests.
 *
 * It is **not** an eIDAS qualified electronic signature, and the contract says so where a client
 * would otherwise be tempted to imply it: the verification response names the *witness* rather
 * than a certificate subject, and there is no field anywhere here for one. A UI rendering "digitally
 * signed" beside a certificate icon would be asserting something no part of this system checked.
 */

export const signaturePurposeSchema = z.enum(
  ALL_SIGNATURE_PURPOSES as unknown as [SignaturePurposeKey, ...SignaturePurposeKey[]],
);

/**
 * Signing a revision.
 *
 * `password` is present, optional in the schema and required in practice whenever
 * `signature.requireReauthentication` is on — which it is by default, because §11.200 requires two
 * distinct identification components and a session cookie is one that was checked at sign-in and
 * has been in a browser ever since. `mfaCode` joins it when the signer has a confirmed
 * authenticator: Phase 14 built the factor, and a signature is the one act in the product where
 * re-proving it is worth the friction.
 *
 * Optional in the schema rather than required, because the tenant setting decides — and a schema
 * that demanded a password from a tenant that had turned re-authentication off would make the
 * setting unusable.
 */
export const signRevisionSchema = z.object({
  revisionId: uuidSchema,
  purpose: signaturePurposeSchema,
  /** The signer's own words. Never a substitute for `purpose`, which is what is queryable. */
  statement: z.string().trim().max(2_000).optional(),
  password: z.string().min(1).max(256).optional(),
  mfaCode: z.string().trim().min(6).max(16).optional(),
});

export const withdrawSignatureSchema = z.object({
  /** Required. A withdrawal with no stated ground is the record of an act nobody can review. */
  reason: z.string().trim().min(1).max(1_000),
});

export const documentSignatureSchema = z.object({
  id: uuidSchema,
  documentId: uuidSchema,
  revisionId: uuidSchema,
  revisionLabel: z.string(),
  signerUserId: uuidSchema,
  /** As it stood at the instant of signing (§11.50). Never re-resolved from the user row. */
  signerName: z.string(),
  purpose: signaturePurposeSchema,
  statement: z.string().nullable(),
  signedAt: isoDateTimeSchema,
  /** Whether the signer proved their credentials again. A fact about this signature. */
  reauthenticated: z.boolean(),
  withdrawnAt: isoDateTimeSchema.nullable(),
  withdrawnReason: z.string().nullable(),
});

/**
 * What a verification answers.
 *
 * Three booleans rather than one, because they fail for different reasons and a caller must be
 * able to tell them apart. `signatureValid` is whether the witnessed bytes still verify against
 * the key — false means the row was tampered with, or the key is gone. `contentMatches` is whether
 * the revision's file still has the digest that was signed — false means the signature is intact
 * and is about content this revision no longer holds, which is a §11.70 finding rather than a
 * broken signature. `withdrawn` is neither: the signature is perfectly valid and its signer took
 * it back.
 *
 * A single `valid` flag would collapse "somebody edited the database" and "somebody withdrew their
 * approval" into one word.
 */
export const signatureVerificationSchema = z.object({
  signatureId: uuidSchema,
  signatureValid: z.boolean(),
  contentMatches: z.boolean(),
  withdrawn: z.boolean(),
  /** Who witnessed it — this product, by key. Deliberately not a certificate subject. */
  witnessedBy: z.string(),
  algorithm: z.string(),
  /** The exact bytes that were signed, so a verifier need not rebuild them. */
  statementBody: z.string(),
});

export type SignRevisionBody = z.infer<typeof signRevisionSchema>;
export type WithdrawSignatureBody = z.infer<typeof withdrawSignatureSchema>;
export type DocumentSignature = z.infer<typeof documentSignatureSchema>;
export type SignatureVerification = z.infer<typeof signatureVerificationSchema>;
