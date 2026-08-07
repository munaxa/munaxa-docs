import { describe, expect, it } from 'vitest';
import {
  generateTotpSecret as platformSecret,
  totpCode as platformCode,
  verifyTotp as platformVerify,
} from '@munaxa/auth';

import {
  generateTotpSecret as localSecret,
  totpCode as localCode,
  verifyTotp as localVerify,
} from './totp';

/**
 * Whether `@munaxa/auth` could replace this product's TOTP — measured, not assumed.
 *
 * Phase 5 asks for this explicitly, and the reason is the sharpest in the whole review: every
 * authenticator already enrolled in every deployment depends on the secret encoding, the step
 * period, the digit count and the HMAC algorithm all agreeing. A mismatch does not degrade
 * gracefully. It signs out every user with MFA enabled, at once, with no fallback path — a
 * password can be reset, an authenticator cannot be un-broken.
 *
 * So this file does not test the platform and it does not test the product. It tests that a code
 * one produces is a code the other accepts, from the same secret at the same instant, which is
 * the only question a migration decision actually rests on.
 *
 * It runs whether or not anybody intends to migrate: if a future platform release changes any of
 * those four parameters, this fails, and that is worth knowing before somebody adopts it.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/** A fixed instant, so a step boundary cannot make this flaky. */
const AT_MS = 1_700_000_010_000;
const STEP = Math.floor(AT_MS / 1_000 / STEP_SECONDS);

describe('secret encoding', () => {
  it('produces base32 of the same alphabet and length', () => {
    const local = localSecret();
    const platform = platformSecret();

    expect(local).toMatch(/^[A-Z2-7]+$/);
    expect(platform).toMatch(/^[A-Z2-7]+$/);
    // 20 bytes — RFC 4226's recommended length, and what every authenticator expects from a
    // `otpauth://` URI. A different length is not wrong, but it is a different enrolment.
    expect(local).toHaveLength(32);
    expect(platform).toHaveLength(32);
  });
});

describe('a code from one is a code the other accepts', () => {
  it('agrees digit for digit on a platform-generated secret', () => {
    const secret = platformSecret();
    expect(localCode(secret, STEP, DIGITS)).toBe(platformCode(secret, AT_MS));
  });

  it('agrees digit for digit on a product-generated secret', () => {
    // The direction that matters for a migration: secrets already in the database were minted by
    // this product, and the platform has to read them.
    const secret = localSecret();
    expect(platformCode(secret, AT_MS)).toBe(localCode(secret, STEP, DIGITS));
  });

  it('agrees across many secrets and many steps, not one lucky pair', () => {
    for (let index = 0; index < 50; index++) {
      const secret = localSecret();
      const at = AT_MS + index * 37_000;
      const step = Math.floor(at / 1_000 / STEP_SECONDS);
      expect(localCode(secret, step, DIGITS)).toBe(platformCode(secret, at));
    }
  });

  it('the platform verifies a code this product generated', () => {
    const secret = localSecret();
    const code = localCode(secret, STEP, DIGITS);
    expect(platformVerify(secret, code, AT_MS)).toBe(STEP);
  });

  it('this product verifies a code the platform generated', () => {
    const secret = platformSecret();
    const code = platformCode(secret, AT_MS);
    expect(localVerify(secret, code, { step: STEP, digits: DIGITS, skewSteps: 1 })).toBe(STEP);
  });
});

describe('drift', () => {
  it('both accept one step either side, and neither accepts two', () => {
    // The window is a security parameter: each extra step multiplies an attacker's guessing
    // surface. A migration that silently widened it would be a weakening.
    const secret = localSecret();
    const previous = localCode(secret, STEP - 1, DIGITS);
    const twoBack = localCode(secret, STEP - 2, DIGITS);

    expect(platformVerify(secret, previous, AT_MS)).toBe(STEP - 1);
    expect(localVerify(secret, previous, { step: STEP, digits: DIGITS, skewSteps: 1 })).toBe(
      STEP - 1,
    );

    expect(platformVerify(secret, twoBack, AT_MS)).toBeUndefined();
    expect(localVerify(secret, twoBack, { step: STEP, digits: DIGITS, skewSteps: 1 })).toBeNull();
  });
});
