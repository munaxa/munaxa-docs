import { createHash, createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';

/**
 * OIDC ID-token verification, from the Node standard library and nothing else — Phase 17.
 *
 * ## Why this is hand-written, and why that is not the trade Phase 14 refused
 *
 * The lockfile cannot gain a dependency, and the answer had to come from a command rather than an
 * assumption. It did:
 *
 * ```
 * $ node -e "require.resolve('jose')"            # from apps/api
 * Error: Cannot find module 'jose'
 * $ node -e "require.resolve('openid-client')"
 * Error: Cannot find module 'openid-client'
 * $ ls node_modules/.pnpm | grep -iE '^(jose|jsonwebtoken|openid)'
 *                                                # absent from the store entirely
 * ```
 *
 * So the question is whether verification is reachable without one, and the answer turns on a
 * second command:
 *
 * ```
 * $ node -e "const c=require('node:crypto');
 *            const {publicKey}=c.generateKeyPairSync('rsa',{modulusLength:2048});
 *            const jwk=publicKey.export({format:'jwk'});
 *            c.createPublicKey({key:jwk,format:'jwk'});"      # Node 22: works
 * ```
 *
 * Node's `crypto` imports a JWK directly and verifies RS256 and ES256 natively. **There is no
 * cryptography written here.** What is written is the parsing and the *checks* — a base64url
 * split, an `alg` allow-list, an issuer comparison, an audience comparison, an expiry — and every
 * one of those is a string or a number comparison that a reader can check by eye.
 *
 * That is what makes this a different trade from the one Phase 14 refused for WebAuthn and Phase
 * 17 refuses for SAML. Those need **CBOR decoding, COSE key parsing, attestation-statement formats
 * and XML canonicalisation** — formats where the hard part is the parsing itself, where a subtly
 * wrong implementation still verifies valid input, and where "should not be hand-written in a
 * security product" is exactly right. Here the hard part is delegated to OpenSSL and the easy part
 * is a comparison.
 *
 * ## The four checks that are load-bearing, and what each attack looks like without it
 *
 * 1. **`alg` is allow-listed against the key's own type.** The `none` algorithm and the
 *    RS256→HS256 confusion attack are the two oldest JWT vulnerabilities there are: the first
 *    accepts an unsigned token, the second lets an attacker sign a token with the *public* key as
 *    an HMAC secret, which is public. So the algorithm is read from a fixed list and matched to
 *    the JWK's `kty`, and a symmetric algorithm is never accepted here at all.
 * 2. **The issuer matches the configured one exactly.** Without it, a token from *any* provider
 *    verifies, and an attacker registers their own OIDC application anywhere and signs in as
 *    whoever they like.
 * 3. **The audience contains our client id.** Without it, a token this provider issued for a
 *    *different* relying party — an attacker's application on the same tenant's directory — is
 *    accepted here. This is the check most hand-rolled implementations omit.
 * 4. **The nonce matches the one we generated.** Without it, an ID token captured from another
 *    flow can be replayed into ours.
 *
 * Everything here is pure: it takes a token, keys and expectations, and returns claims or a
 * refusal. No I/O, no clock of its own, no configuration.
 */

/** The algorithms accepted, and every one of them asymmetric. */
const ALLOWED_ALGORITHMS: Readonly<Record<string, { kty: string; node: string }>> = Object.freeze({
  RS256: { kty: 'RSA', node: 'RSA-SHA256' },
  RS384: { kty: 'RSA', node: 'RSA-SHA384' },
  RS512: { kty: 'RSA', node: 'RSA-SHA512' },
  ES256: { kty: 'EC', node: 'SHA256' },
  ES384: { kty: 'EC', node: 'SHA384' },
});

export interface Jwk {
  readonly kty: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly n?: string;
  readonly e?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
}

export interface IdTokenExpectation {
  readonly issuer: string;
  readonly audience: string;
  readonly nonce: string;
  readonly now: Date;
  /** Tolerance for a provider whose clock differs from ours. Sixty seconds is the usual figure. */
  readonly clockSkewSeconds?: number;
}

export type IdTokenClaims = Readonly<Record<string, unknown>>;

export type VerificationOutcome =
  | { readonly ok: true; readonly claims: IdTokenClaims }
  | { readonly ok: false; readonly reason: string };

/**
 * Verifies an ID token against a JWKS.
 *
 * Returns a refusal rather than throwing, so the caller decides what a failure means. Every
 * refusal names the check that failed — those strings reach a log and never a caller, for the
 * reason every authentication failure in this product is uniform to the person presenting it.
 */
export function verifyIdToken(
  token: string,
  keys: readonly Jwk[],
  expectation: IdTokenExpectation,
): VerificationOutcome {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);
  if (!header || !payload) {
    return { ok: false, reason: 'MALFORMED' };
  }

  const alg = typeof header['alg'] === 'string' ? header['alg'] : '';
  const spec = ALLOWED_ALGORITHMS[alg];
  // `none` and every symmetric algorithm fail here, because neither is in the table. This is the
  // check whose absence is the oldest JWT vulnerability there is.
  if (!spec) {
    return { ok: false, reason: 'ALGORITHM_NOT_ALLOWED' };
  }

  const kid = typeof header['kid'] === 'string' ? header['kid'] : null;
  // A `kid` narrows to one key; without one, every key of the right type is tried. Trying several
  // is not a weakness — each is a full signature verification — and it is what keeps a provider
  // that publishes an unlabelled JWKS working.
  const candidates = keys.filter(
    (key) => key.kty === spec.kty && (kid === null || key.kid === undefined || key.kid === kid),
  );
  if (candidates.length === 0) {
    return { ok: false, reason: 'NO_MATCHING_KEY' };
  }

  const signed = `${encodedHeader}.${encodedPayload}`;
  const signature = Buffer.from(encodedSignature, 'base64url');
  const verified = candidates.some((key) => verifyWith(key, spec.node, signed, signature, alg));
  if (!verified) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }

  // The issuer, exactly. Not normalised, not trailing-slash-insensitive: OIDC Core §2 says `iss`
  // is compared as a string, and "helpfully" normalising is how one provider's issuer starts
  // matching another's.
  if (payload['iss'] !== expectation.issuer) {
    return { ok: false, reason: 'ISSUER_MISMATCH' };
  }

  // The audience. `aud` is a string or an array of them; both mean "who this token is for", and
  // omitting this check accepts a token the provider minted for somebody else's application.
  const audience = payload['aud'];
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (!audiences.includes(expectation.audience)) {
    return { ok: false, reason: 'AUDIENCE_MISMATCH' };
  }
  // `azp` is required when there are several audiences, and must be us. A token listing our client
  // id among four others was not issued *to* us unless it says so.
  if (audiences.length > 1 && payload['azp'] !== expectation.audience) {
    return { ok: false, reason: 'AUTHORIZED_PARTY_MISMATCH' };
  }

  const skew = expectation.clockSkewSeconds ?? 60;
  const seconds = Math.floor(expectation.now.getTime() / 1000);
  const exp = numberClaim(payload['exp']);
  if (exp === null || seconds - skew >= exp) {
    return { ok: false, reason: 'EXPIRED' };
  }
  const nbf = numberClaim(payload['nbf']);
  if (nbf !== null && seconds + skew < nbf) {
    return { ok: false, reason: 'NOT_YET_VALID' };
  }
  const iat = numberClaim(payload['iat']);
  // An ID token issued more than a day ago is not a fresh authentication however long its expiry
  // says. Providers set `exp` generously; this bounds what "just signed in" can mean.
  if (iat === null || seconds - iat > 86_400) {
    return { ok: false, reason: 'STALE' };
  }

  // The nonce, in constant time. It is a CSRF and replay defence: without it, an ID token captured
  // from any other flow with this provider can be replayed into ours.
  const nonce = payload['nonce'];
  if (typeof nonce !== 'string' || !constantTimeEquals(nonce, expectation.nonce)) {
    return { ok: false, reason: 'NONCE_MISMATCH' };
  }

  const subject = payload['sub'];
  if (typeof subject !== 'string' || subject.length === 0) {
    return { ok: false, reason: 'NO_SUBJECT' };
  }

  return { ok: true, claims: payload };
}

/**
 * The `c_hash`/`at_hash`-style binding between an authorization code and the token that came back.
 *
 * Not used on the code flow this product implements — the code is exchanged over TLS at the token
 * endpoint with the client secret, which is a stronger binding than a hash — and it is here
 * because `state` verification uses the same primitive and having one implementation of "compare
 * two secrets without leaking their difference in timing" is better than two.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The digest a `state` or `nonce` is stored under, so a stolen store yields neither. */
export function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Reads a claim as a list of strings, whatever shape the provider chose.
 *
 * Entra ID sends `groups` as an array; some providers send a single string; a few send a
 * space-separated one. All three mean the same thing and the difference is not worth a
 * per-provider setting.
 */
export function claimAsStrings(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value === 'string') {
    return value.split(/[\s,]+/).filter((entry) => entry.length > 0);
  }
  return [];
}

function verifyWith(
  key: Jwk,
  nodeAlgorithm: string,
  signed: string,
  signature: Buffer,
  alg: string,
): boolean {
  try {
    const publicKey = createPublicKey({ key: key as never, format: 'jwk' });
    const verifier = createVerify(nodeAlgorithm);
    verifier.update(signed, 'utf8');
    verifier.end();
    // ECDSA JWS signatures are the raw `r||s` concatenation of P1363, and OpenSSL expects DER.
    // `dsaEncoding: 'ieee-p1363'` is what tells it which it is being handed — without it every
    // ES256 token fails to verify, which would look like a provider problem.
    return alg.startsWith('ES')
      ? verifier.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)
      : verifier.verify(publicKey, signature);
  } catch {
    // A malformed JWK is a refusal, not a crash: a provider rotating keys can publish one this
    // build cannot import, and the other candidates must still be tried.
    return false;
  }
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function numberClaim(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
