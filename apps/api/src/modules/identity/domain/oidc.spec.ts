import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { claimAsStrings, constantTimeEquals, verifyIdToken, type Jwk } from './oidc';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const RSA_JWK = rsa.publicKey.export({ format: 'jwk' }) as unknown as Jwk;
const EC_JWK = ec.publicKey.export({ format: 'jwk' }) as unknown as Jwk;

const NOW = new Date('2026-08-06T12:00:00Z');
const SECONDS = Math.floor(NOW.getTime() / 1000);

const EXPECTATION = {
  issuer: 'https://login.microsoftonline.com/tenant/v2.0',
  audience: 'client-abc',
  nonce: 'nonce-1',
  now: NOW,
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key = rsa.privateKey,
  algorithm = 'RSA-SHA256',
): string {
  const signed = `${encode(header)}.${encode(payload)}`;
  const signer = createSign(algorithm);
  signer.update(signed, 'utf8');
  signer.end();
  const signature =
    algorithm === 'SHA256' && header['alg'] === 'ES256'
      ? signer.sign({ key, dsaEncoding: 'ieee-p1363' })
      : signer.sign(key);
  return `${signed}.${signature.toString('base64url')}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: EXPECTATION.issuer,
    aud: EXPECTATION.audience,
    sub: 'external-subject-1',
    nonce: 'nonce-1',
    email: 'ada@acme.com',
    name: 'Ada Lovelace',
    iat: SECONDS - 10,
    exp: SECONDS + 3_600,
    ...overrides,
  };
}

describe('verifying an ID token', () => {
  it('accepts a well-formed RS256 token', () => {
    const token = sign({ alg: 'RS256', kid: 'k1' }, claims());
    const outcome = verifyIdToken(token, [{ ...RSA_JWK, kid: 'k1' }], EXPECTATION);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.claims['sub']).toBe('external-subject-1');
    }
  });

  it('accepts ES256, which needs the P1363 signature encoding', () => {
    // Without `dsaEncoding: 'ieee-p1363'` in the verifier this fails, and it would look like a
    // provider problem rather than ours — which is why it has a test of its own.
    const token = sign({ alg: 'ES256' }, claims(), ec.privateKey, 'SHA256');
    expect(verifyIdToken(token, [EC_JWK], EXPECTATION).ok).toBe(true);
  });

  it('refuses alg: none', () => {
    // The oldest JWT vulnerability there is. `none` is not in the table, so there is no branch
    // that could accept it.
    const unsigned = `${encode({ alg: 'none' })}.${encode(claims())}.`;
    expect(verifyIdToken(unsigned, [RSA_JWK], EXPECTATION)).toEqual({
      ok: false,
      reason: 'ALGORITHM_NOT_ALLOWED',
    });
  });

  it('refuses HS256 — the algorithm-confusion attack', () => {
    // An attacker signs with the *public* key as an HMAC secret. Refused because no symmetric
    // algorithm is in the table at all, rather than because a check noticed.
    const token = `${encode({ alg: 'HS256' })}.${encode(claims())}.AAAA`;
    expect(verifyIdToken(token, [RSA_JWK], EXPECTATION)).toEqual({
      ok: false,
      reason: 'ALGORITHM_NOT_ALLOWED',
    });
  });

  it('refuses a token signed by a key it does not hold', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = sign({ alg: 'RS256' }, claims(), other.privateKey);
    expect(verifyIdToken(token, [RSA_JWK], EXPECTATION).ok).toBe(false);
  });

  it('refuses another issuer', () => {
    // Without this, a token from *any* provider verifies and anybody can register an application
    // and sign in as whoever they like.
    const token = sign({ alg: 'RS256' }, claims({ iss: 'https://evil.example' }));
    expect(verifyIdToken(token, [RSA_JWK], EXPECTATION)).toMatchObject({
      reason: 'ISSUER_MISMATCH',
    });
  });

  it('refuses a token minted for another relying party', () => {
    // The check most hand-rolled implementations omit: the same provider issues tokens to many
    // applications, and one of them may be the attacker's.
    const token = sign({ alg: 'RS256' }, claims({ aud: 'someone-elses-client' }));
    expect(verifyIdToken(token, [RSA_JWK], EXPECTATION)).toMatchObject({
      reason: 'AUDIENCE_MISMATCH',
    });
  });

  it('requires azp to be us when several audiences are listed', () => {
    const token = sign({ alg: 'RS256' }, claims({ aud: ['client-abc', 'other'], azp: 'other' }));
    expect(verifyIdToken(token, [RSA_JWK], EXPECTATION)).toMatchObject({
      reason: 'AUTHORIZED_PARTY_MISMATCH',
    });
  });

  it('refuses an expired token, and one issued too long ago to be a fresh sign-in', () => {
    expect(
      verifyIdToken(
        sign({ alg: 'RS256' }, claims({ exp: SECONDS - 3_600 })),
        [RSA_JWK],
        EXPECTATION,
      ),
    ).toMatchObject({ reason: 'EXPIRED' });
    expect(
      verifyIdToken(
        sign({ alg: 'RS256' }, claims({ iat: SECONDS - 200_000 })),
        [RSA_JWK],
        EXPECTATION,
      ),
    ).toMatchObject({ reason: 'STALE' });
  });

  it('refuses a replayed token whose nonce is another flow’s', () => {
    const token = sign({ alg: 'RS256' }, claims({ nonce: 'somebody-elses-nonce' }));
    expect(verifyIdToken(token, [RSA_JWK], EXPECTATION)).toMatchObject({
      reason: 'NONCE_MISMATCH',
    });
  });

  it('refuses a token with no subject', () => {
    const token = sign({ alg: 'RS256' }, claims({ sub: '' }));
    expect(verifyIdToken(token, [RSA_JWK], EXPECTATION)).toMatchObject({ reason: 'NO_SUBJECT' });
  });

  it('refuses rubbish without throwing', () => {
    expect(verifyIdToken('not.a.token', [RSA_JWK], EXPECTATION).ok).toBe(false);
    expect(verifyIdToken('', [RSA_JWK], EXPECTATION)).toEqual({ ok: false, reason: 'MALFORMED' });
  });
});

describe('claim shapes', () => {
  it('reads groups however the provider sends them', () => {
    // Entra ID sends an array; some providers send one string; a few send a space-separated one.
    expect(claimAsStrings(['a', 'b'])).toEqual(['a', 'b']);
    expect(claimAsStrings('a b')).toEqual(['a', 'b']);
    expect(claimAsStrings('a,b')).toEqual(['a', 'b']);
    // Google Workspace's ID token has no groups claim at all.
    expect(claimAsStrings(undefined)).toEqual([]);
  });
});

describe('constant-time comparison', () => {
  it('compares without throwing on a length mismatch', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
  });
});
