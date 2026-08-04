import { describe, expect, it } from 'vitest';

import { decodeTransferToken, encodeTransferToken } from './local-transfer-token';

/**
 * The only authorisation on the local transfer endpoints.
 *
 * It is reached before authentication runs, so every one of these cases is a case where being wrong
 * means serving somebody else's document. They are written as attacks rather than as round trips
 * for that reason.
 */
const SECRET = 'a-deployment-secret-of-at-least-thirty-two-characters';
const NOW = new Date('2026-08-04T10:00:00.000Z');
const LATER = new Date('2026-08-04T10:05:00.000Z');

const GRANT = {
  key: 'tenants/acme/ab/cd/abcdef',
  method: 'GET',
  expiresAt: LATER,
  disposition: 'attachment; filename="QA-014.pdf"',
} as const;

function decode(token: string, method: 'PUT' | 'GET' = 'GET', now = NOW) {
  return decodeTransferToken(SECRET, token, method, now);
}

describe('a transfer capability', () => {
  it('round-trips every field it was given', () => {
    const decoded = decode(encodeTransferToken(SECRET, GRANT));
    expect('grant' in decoded && decoded.grant).toMatchObject({
      key: GRANT.key,
      method: 'GET',
      disposition: GRANT.disposition,
    });
  });

  it('carries the upload size, which is what binds a target to what was approved', () => {
    const token = encodeTransferToken(SECRET, {
      key: 'tenants/acme/x',
      method: 'PUT',
      expiresAt: LATER,
      maxBytes: 40_960,
      contentType: 'application/pdf',
    });
    const decoded = decode(token, 'PUT');
    expect('grant' in decoded && decoded.grant.maxBytes).toBe(40_960);
  });
});

describe('a transfer capability is refused when', () => {
  it('its signature was made with a different secret', () => {
    const forged = encodeTransferToken('another-deployment-entirely-with-32-chars', GRANT);
    expect(decode(forged)).toEqual({ rejection: 'BAD_SIGNATURE' });
  });

  it('the key was edited to name another tenant', () => {
    // The whole point. A signed capability for Acme's object, repointed at Rival's, must not
    // verify — and it does not, because the key is inside the signed payload.
    const token = encodeTransferToken(SECRET, GRANT);
    const [encoded = '', signature = ''] = token.split('.');
    const payload = Buffer.from(encoded, 'base64url')
      .toString('utf8')
      .replace('tenants/acme', 'tenants/rival');
    const tampered = `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature}`;
    expect(decode(tampered)).toEqual({ rejection: 'BAD_SIGNATURE' });
  });

  it('the expiry was pushed out', () => {
    const token = encodeTransferToken(SECRET, GRANT);
    const [encoded = '', signature = ''] = token.split('.');
    const payload = Buffer.from(encoded, 'base64url')
      .toString('utf8')
      .replace(String(LATER.getTime()), String(LATER.getTime() + 86_400_000));
    expect(decode(`${Buffer.from(payload, 'utf8').toString('base64url')}.${signature}`)).toEqual({
      rejection: 'BAD_SIGNATURE',
    });
  });

  it('it has expired', () => {
    const token = encodeTransferToken(SECRET, GRANT);
    expect(decode(token, 'GET', new Date(LATER.getTime() + 1))).toEqual({ rejection: 'EXPIRED' });
  });

  it('it expires exactly now — the boundary is closed, not open', () => {
    expect(decode(encodeTransferToken(SECRET, GRANT), 'GET', LATER)).toEqual({
      rejection: 'EXPIRED',
    });
  });

  it('a download URL is presented as an upload', () => {
    expect(decode(encodeTransferToken(SECRET, GRANT), 'PUT')).toEqual({
      rejection: 'WRONG_METHOD',
    });
  });

  it('an upload URL is presented as a download', () => {
    const token = encodeTransferToken(SECRET, {
      key: 'tenants/acme/x',
      method: 'PUT',
      expiresAt: LATER,
      maxBytes: 1,
    });
    expect(decode(token, 'GET')).toEqual({ rejection: 'WRONG_METHOD' });
  });

  it('it is empty, truncated or not a token at all', () => {
    for (const token of ['', '.', 'nonsense', 'a.b', Buffer.from('x').toString('base64url')]) {
      const decoded = decode(token);
      expect('rejection' in decoded).toBe(true);
    }
  });

  it('the signature is a prefix of the real one', () => {
    const token = encodeTransferToken(SECRET, GRANT);
    expect(decode(token.slice(0, -1))).toEqual({ rejection: 'BAD_SIGNATURE' });
  });
});

describe('domain separation', () => {
  it('signs the fields in a way that two different grants cannot collide on', () => {
    // Fields joined without a separator would let `key="a", disposition="b"` and
    // `key="ab", disposition=""` sign identically — one capability serving two objects.
    const first = encodeTransferToken(SECRET, {
      key: 'a',
      method: 'GET',
      expiresAt: LATER,
      contentType: 'b',
    });
    const second = encodeTransferToken(SECRET, {
      key: 'ab',
      method: 'GET',
      expiresAt: LATER,
    });
    expect(first).not.toBe(second);
  });
});
