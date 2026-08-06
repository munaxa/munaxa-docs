import { scrypt } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { PlatformPasswordHasher } from './platform-password.hasher';

/**
 * These derive real hashes, so they are slower than the rest of the suite by design — the cost
 * being measured is the cost that protects a stolen table.
 *
 * Everything the pre-migration `ScryptPasswordHasher` spec asserted is asserted here, because the
 * point of the migration is that none of it changed. The additions are the cases that only exist
 * once a product has history: hashes written before the migration must keep working, and must be
 * flagged for rewrite.
 */
describe('PlatformPasswordHasher', () => {
  const hasher = new PlatformPasswordHasher();
  const PASSWORD = 'correct horse battery staple';

  /** Writes a hash exactly as Munaxa Docs wrote them before the platform migration. */
  function legacyHash(password: string, n = 2 ** 17): Promise<string> {
    const salt = Buffer.from('a-fixed-legacy-salt');
    return new Promise((resolve, reject) => {
      scrypt(
        password.normalize('NFKC'),
        salt,
        32,
        { N: n, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
        (error, derived) => {
          if (error) reject(error);
          else
            resolve(
              ['scrypt', n, 8, 1, salt.toString('base64'), derived.toString('base64')].join('$'),
            );
        },
      );
    });
  }

  it('accepts the password it hashed', async () => {
    const encoded = await hasher.hash(PASSWORD);

    await expect(hasher.verify(PASSWORD, encoded)).resolves.toBe(true);
  });

  it('rejects a different password', async () => {
    const encoded = await hasher.hash(PASSWORD);

    await expect(hasher.verify('Correct horse battery staple', encoded)).resolves.toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const first = await hasher.hash(PASSWORD);
    const second = await hasher.hash(PASSWORD);

    expect(first).not.toBe(second);
    await expect(hasher.verify(PASSWORD, second)).resolves.toBe(true);
  });

  it('keeps the cost this product chose, not the platform default', async () => {
    // The platform defaults to N=2^14. Munaxa Docs committed to OWASP's N=2^17, and adopting the
    // lighter default during a migration would silently weaken every password written afterwards.
    const encoded = await hasher.hash(PASSWORD);

    expect(encoded.startsWith('$scrypt$v=1$n=131072,r=8,p=1$')).toBe(true);
  });

  it('verifies a hash written before the migration', async () => {
    // The whole estate is in this format. If this fails, every user is locked out.
    const encoded = await legacyHash(PASSWORD);

    await expect(hasher.verify(PASSWORD, encoded)).resolves.toBe(true);
    await expect(hasher.verify('wrong', encoded)).resolves.toBe(false);
  });

  it('flags every pre-migration hash for rewrite, whatever its parameters', async () => {
    // Sign-in rewrites these transparently, so the estate migrates without a forced reset.
    await expect(legacyHash(PASSWORD).then((h) => hasher.needsRehash(h))).resolves.toBe(true);
    await expect(legacyHash(PASSWORD, 2 ** 14).then((h) => hasher.needsRehash(h))).resolves.toBe(
      true,
    );
  });

  it('does not flag a hash it just wrote', async () => {
    expect(hasher.needsRehash(await hasher.hash(PASSWORD))).toBe(false);
  });

  it('flags an unreadable hash for upgrade rather than trusting it', () => {
    expect(hasher.needsRehash('garbage')).toBe(true);
  });

  it('returns false for a malformed stored hash instead of throwing', async () => {
    // A corrupt row must not produce a distinctive error: sign-in stays uniform.
    await expect(hasher.verify('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(hasher.verify('anything', 'scrypt$0$0$0$$')).resolves.toBe(false);
    await expect(hasher.verify('anything', '')).resolves.toBe(false);
  });

  it('produces a decoy that is stable within a process and matches nothing', async () => {
    expect(hasher.decoyHash()).toBe(hasher.decoyHash());
    await expect(hasher.verify(PASSWORD, hasher.decoyHash())).resolves.toBe(false);
  });

  it('spends real work verifying the decoy, or it is not a timing defence', async () => {
    // A decoy the verifier rejects on a parse error costs nothing, and the endpoint goes back to
    // answering "does this address have an account?" with a stopwatch.
    const real = await hasher.hash(PASSWORD);

    const decoyStart = performance.now();
    await hasher.verify('anything', hasher.decoyHash());
    const decoyCost = performance.now() - decoyStart;

    const realStart = performance.now();
    await hasher.verify('anything', real);
    const realCost = performance.now() - realStart;

    expect(decoyCost).toBeGreaterThan(realCost * 0.5);
  });

  it('normalises unicode, so the same typed password works on any keyboard', async () => {
    // U+00E9 and e + U+0301 render identically; a user must not be locked out by which one
    // their input method produced.
    const encoded = await hasher.hash('café passphrase here');

    await expect(hasher.verify('café passphrase here', encoded)).resolves.toBe(true);
  });
});
