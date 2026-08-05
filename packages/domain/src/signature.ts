/**
 * Electronic signatures, as vocabulary — Phase 16, and the thing this phase was most likely to get
 * wrong.
 *
 * "Digital signature" means at least four different things in a compliance product, and
 * [ADR-0017](../../../docs/architecture/adr/0017-electronic-signature-as-witnessed-attestation.md)
 * argues all four before choosing. What this file encodes is the choice: a signature here is a
 * **21 CFR Part 11 §11.50 signature manifestation** — a named person, an instant, and a stated
 * *meaning* — bound under §11.70 to the exact bytes it is about, and witnessed by the server with
 * the same construction Phase 9's evidence manifest and audit checkpoints already use.
 *
 * It is **not** an eIDAS qualified signature. That needs a certificate from a trust-service
 * provider and a key the signer alone controls, and this product has neither. Calling what it does
 * produce "digital signature" in prose is fine; calling it a *qualified* one in a regulated
 * customer's validation pack would be a lie, so the vocabulary here says `signature` and the
 * verification response says who witnessed it.
 *
 * Pure: the statement is a string, built the same way in the API, in a verifier and in any future
 * offline tool. The HMAC over it lives in the module that holds the key, because a domain package
 * that could sign would be a domain package holding a secret.
 */

/**
 * What the signer is saying.
 *
 * Part 11 §11.50(a)(3) requires the *meaning* of a signature to be part of the manifestation — a
 * signature that does not say what it means is a mark, and six months later nobody can tell an
 * author's "this is my work" from a QA manager's "this is fit for release". So it is a closed
 * vocabulary rather than free text: free text would be unqueryable and untranslatable, and "what
 * did the second signatory attest to" is exactly the question an inspector asks.
 *
 * Five values, each mapping to an act this product already has a lifecycle for, plus `REVIEWED`
 * for the reading that has no workflow behind it. A tenant needing a sixth is a catalogue change
 * here — not a free-text column, which is how this always erodes.
 */
export const SignaturePurpose = {
  /** "I wrote this." The author putting their name to the content. */
  AUTHORSHIP: 'AUTHORSHIP',
  /** "I have read this and raise nothing." A review that is not an approval gate. */
  REVIEWED: 'REVIEWED',
  /** "I approve this for release." The signature beside an approval decision. */
  APPROVAL: 'APPROVAL',
  /** "I accept this on behalf of the receiving party." Handover, acceptance, sign-off. */
  ACCEPTANCE: 'ACCEPTANCE',
  /** "I witnessed the act above." A second signatory attesting to somebody else's signature. */
  WITNESS: 'WITNESS',
} as const;

export type SignaturePurposeKey = (typeof SignaturePurpose)[keyof typeof SignaturePurpose];

export const ALL_SIGNATURE_PURPOSES: readonly SignaturePurposeKey[] = Object.freeze(
  Object.values(SignaturePurpose),
);

const PURPOSE_SET: ReadonlySet<string> = new Set<string>(ALL_SIGNATURE_PURPOSES);

export function isSignaturePurpose(value: string): value is SignaturePurposeKey {
  return PURPOSE_SET.has(value);
}

/**
 * Everything a signature attests, before it is a signature.
 *
 * Every field is here because omitting it would let the signature be true of something else. The
 * tenant, because a digest is not unique across tenants and a signature lifted from one database
 * into another must not verify. The revision *and* the content digest, because a revision
 * identifier alone would let a row be repointed at other bytes — §11.70's "signature/record
 * linking" is exactly this. The signer's name and email as they stood at the instant of signing,
 * because §11.50 requires the *printed name* to be part of the manifestation and a person who
 * marries next year must not retroactively change what the record says was signed. The purpose,
 * because meaning is required. The instant, because it is.
 *
 * `documentNumber` is nullable and that is deliberate rather than sloppy: a draft can be signed
 * for authorship before it has ever been through approval, and a number is assigned at approval
 * (ADR-0004). Recording `null` is honest; recording the number it later receives would be
 * backdating.
 */
export interface SignatureStatement {
  readonly tenantId: string;
  readonly documentId: string;
  readonly documentNumber: string | null;
  readonly revisionId: string;
  readonly revisionLabel: string;
  /** The SHA-256 of the signed revision's file, lower-case hex. What §11.70 binds to. */
  readonly contentDigest: string;
  readonly signerUserId: string;
  readonly signerName: string;
  readonly signerEmail: string;
  readonly purpose: SignaturePurposeKey;
  /** The signer's own words, when they added any. Never a substitute for `purpose`. */
  readonly statement: string | null;
  /** ISO-8601, UTC, to the millisecond. */
  readonly signedAt: string;
}

/**
 * The exact bytes a signature is over.
 *
 * A hand-written, field-ordered, newline-delimited serialisation rather than `JSON.stringify`, and
 * the reason is the one Phase 9 hit and wrote down: a signature over a re-serialisation is a
 * signature that depends on two `JSON.stringify` calls agreeing about key order, which is a
 * property of a runtime rather than of a format. This ordering is fixed here, versioned by the
 * first line, and an added field means a new version rather than an edited one — because a
 * verifier that must produce byte-identical input years later cannot be asked to guess which
 * fields existed when.
 *
 * Values are not escaped and do not need to be: every field is either an identifier, a hex digest,
 * an ISO timestamp or a catalogue key, except `signerName` and `statement`. Those two are
 * newline-stripped rather than escaped, because a newline is the only character that could forge a
 * field boundary and a display name containing one is malformed input rather than a case to
 * preserve.
 */
export const SIGNATURE_STATEMENT_VERSION = 1 as const;

export function serialiseSignatureStatement(statement: SignatureStatement): string {
  const lines: readonly string[] = [
    `munaxa-docs-signature/v${String(SIGNATURE_STATEMENT_VERSION)}`,
    `tenant:${statement.tenantId}`,
    `document:${statement.documentId}`,
    `number:${statement.documentNumber ?? ''}`,
    `revision:${statement.revisionId}`,
    `label:${oneLine(statement.revisionLabel)}`,
    `content-sha256:${statement.contentDigest}`,
    `signer:${statement.signerUserId}`,
    `signer-name:${oneLine(statement.signerName)}`,
    `signer-email:${oneLine(statement.signerEmail)}`,
    `purpose:${statement.purpose}`,
    `statement:${oneLine(statement.statement ?? '')}`,
    `signed-at:${statement.signedAt}`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Collapses the two free-text fields onto one line.
 *
 * Every newline and carriage return becomes a space. Not an escape, because an escape has an
 * inverse and this deliberately does not: the serialisation exists to be hashed, never parsed
 * back, and a lossless encoding would only invite somebody to write the parser.
 */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').trim();
}

/**
 * Whether a revision may be signed at all, from its status alone.
 *
 * A `DISCARDED` revision is a draft somebody abandoned; signing one produces an attestation about
 * content that was deliberately thrown away, which is worse than useless because it is
 * indistinguishable from a real signature in a list. Everything else is signable, including
 * `DRAFT` — Part 11 has no notion of "too early to sign", authorship is routinely signed before
 * review, and the `purpose` is what says which of those this was.
 */
export function revisionIsSignable(status: string): boolean {
  return status !== 'DISCARDED';
}
