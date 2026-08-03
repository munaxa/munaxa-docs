import { describe, expect, it } from 'vitest';

import { ScryptPasswordHasher } from './scrypt-password-hasher';

/**
 * These derive real hashes, so they are slower than the rest of the suite by design — the cost
 * being measured is the cost that protects a stolen table.
 */
describe('ScryptPasswordHasher', () => {
  const hasher = new ScryptPasswordHasher();

  it('accepts the password it hashed', async () => {
    const encoded = await hasher.hash('correct horse battery staple');

    await expect(hasher.verify('correct horse battery staple', encoded)).resolves.toBe(true);
  });

  it('rejects a different password', async () => {
    const encoded = await hasher.hash('correct horse battery staple');

    await expect(hasher.verify('Correct horse battery staple', encoded)).resolves.toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const first = await hasher.hash('correct horse battery staple');
    const second = await hasher.hash('correct horse battery staple');

    expect(first).not.toBe(second);
    await expect(hasher.verify('correct horse battery staple', second)).resolves.toBe(true);
  });

  it('records its parameters, so a stored hash can be re-derived', async () => {
    const encoded = await hasher.hash('correct horse battery staple');

    expect(encoded.split('$').slice(0, 4)).toEqual(['scrypt', '131072', '8', '1']);
  });

  it('returns false for a malformed stored hash instead of throwing', async () => {
    // A corrupt row must not produce a distinctive error: sign-in stays uniform.
    await expect(hasher.verify('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(hasher.verify('anything', 'scrypt$0$0$0$$')).resolves.toBe(false);
    await expect(hasher.verify('anything', '')).resolves.toBe(false);
  });

  it('flags a hash derived with weaker parameters for upgrade', () => {
    expect(hasher.needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(hasher.needsRehash('scrypt$131072$8$1$c2FsdA==$aGFzaA==')).toBe(false);
    expect(hasher.needsRehash('garbage')).toBe(true);
  });

  it('produces a decoy that is stable within a process and matches nothing', async () => {
    expect(hasher.decoyHash()).toBe(hasher.decoyHash());
    await expect(hasher.verify('correct horse battery staple', hasher.decoyHash())).resolves.toBe(
      false,
    );
  });

  it('normalises unicode, so the same typed password works on any keyboard', async () => {
    // U+00E9 and e + U+0301 render identically; a user must not be locked out by which one
    // their input method produced.
    const encoded = await hasher.hash('café passphrase here');

    await expect(hasher.verify('café passphrase here', encoded)).resolves.toBe(true);
  });
});
