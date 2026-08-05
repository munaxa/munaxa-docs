import { describe, expect, it } from 'vitest';

import {
  generateRecoveryCode,
  generateTotpSecret,
  normalizeRecoveryCode,
  totpCode,
  totpUri,
  verifyTotp,
} from './totp';

/**
 * RFC 6238's own test vectors, plus the properties the service depends on.
 *
 * The vectors matter more than usual here: this is a hand-written implementation of a published
 * algorithm, and "it agrees with itself" is exactly the assertion a wrong implementation also
 * passes. The secret is RFC 6238 Appendix B's `12345678901234567890`, base32-encoded.
 */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('RFC 6238 test vectors', () => {
  // Appendix B, SHA-1 column, truncated to eight digits.
  const vectors: readonly (readonly [number, string])[] = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ];

  for (const [seconds, expected] of vectors) {
    it(`matches the published code at t=${String(seconds)}`, () => {
      expect(totpCode(RFC_SECRET, Math.floor(seconds / 30), 8)).toBe(expected);
    });
  }

  it('produces the six-digit form every authenticator actually uses', () => {
    expect(totpCode(RFC_SECRET, Math.floor(59 / 30), 6)).toBe('287082');
  });
});

describe('verification', () => {
  const step = 57_000_000;

  it('accepts the current step and reports which step it was', () => {
    const code = totpCode(RFC_SECRET, step, 6);
    expect(verifyTotp(RFC_SECRET, code, { step, digits: 6, skewSteps: 1 })).toBe(step);
  });

  it('accepts one step either side, so a slow phone clock is not a lock-out', () => {
    for (const offset of [-1, 1]) {
      const code = totpCode(RFC_SECRET, step + offset, 6);
      expect(verifyTotp(RFC_SECRET, code, { step, digits: 6, skewSteps: 1 })).toBe(step + offset);
    }
  });

  it('refuses two steps away when the window is one', () => {
    const code = totpCode(RFC_SECRET, step + 2, 6);
    expect(verifyTotp(RFC_SECRET, code, { step, digits: 6, skewSteps: 1 })).toBeNull();
  });

  it('refuses anything that is not the right number of digits', () => {
    for (const presented of ['', '12345', '1234567', 'abcdef', '12 34 56']) {
      expect(verifyTotp(RFC_SECRET, presented, { step, digits: 6, skewSteps: 1 })).toBeNull();
    }
  });

  it('returns the step, which is what makes replay preventable', () => {
    // The service stores this and refuses a code whose step is not greater than the last — the
    // reason `verifyTotp` answers with a number rather than a boolean.
    const matched = verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step, 6), {
      step,
      digits: 6,
      skewSteps: 1,
    });
    expect(matched).toBe(step);
  });
});

describe('secrets, codes and the URI', () => {
  it('generates a base32 secret it can then use', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(verifyTotp(secret, totpCode(secret, 1, 6), { step: 1, digits: 6, skewSteps: 0 })).toBe(
      1,
    );
  });

  it('escapes the label and the issuer, so an authenticator entry is readable', () => {
    const uri = totpUri({
      secret: RFC_SECRET,
      account: 'ada@example.test',
      issuer: 'Munaxa Docs',
      digits: 6,
      stepSeconds: 30,
    });
    expect(uri.startsWith('otpauth://totp/Munaxa%20Docs:ada%40example.test?')).toBe(true);
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('period=30');
  });

  it('normalises a recovery code past its hyphen and its case', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect(normalizeRecoveryCode(code.toLowerCase())).toBe(normalizeRecoveryCode(code));
    expect(normalizeRecoveryCode(code.replace('-', ' '))).toBe(normalizeRecoveryCode(code));
  });
});
