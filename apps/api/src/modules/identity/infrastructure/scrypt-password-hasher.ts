import { Injectable } from '@nestjs/common';
import { type ScryptOptions, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import type { PasswordHasher } from '../application/authentication.ports';

/**
 * `promisify(scrypt)` picks the three-argument overload, which cannot carry the cost
 * parameters. Wrapping it by hand keeps them.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keyBytes: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyBytes, options, (error, derived) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derived);
    });
  });
}

/**
 * Password hashing with scrypt, from the Node standard library.
 *
 * scrypt rather than argon2id only because argon2 is not in the standard library: both are
 * memory-hard and both are accepted by OWASP, and a dependency-free implementation is one
 * fewer supply-chain surface on the most security-critical path in the product. If argon2id
 * is wanted later it is a new class behind this same interface, and `needsRehash` plus the
 * upgrade-on-sign-in path in `DefaultAuthenticationService` migrate everyone without a reset.
 *
 * Parameters follow OWASP's scrypt guidance (N=2^17, r=8, p=1): roughly 128 MB and ~100 ms per
 * derivation on current hardware. That cost is the point — it is what makes an offline attack
 * against a stolen table expensive.
 */
const CURRENT = Object.freeze({
  /** CPU/memory cost. Must be a power of two. */
  n: 2 ** 17,
  /** Block size; with N, this sets the memory requirement. */
  r: 8,
  /** Parallelisation. */
  p: 1,
  saltBytes: 16,
  keyBytes: 32,
});

/** scrypt's default is 32 MB, which is far below what these parameters need. */
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;

const SCHEME = 'scrypt';
const FIELD_COUNT = 6;

@Injectable()
export class ScryptPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(CURRENT.saltBytes);
    const derived = await this.derive(password, salt, CURRENT);
    return [
      SCHEME,
      CURRENT.n,
      CURRENT.r,
      CURRENT.p,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  async verify(password: string, encodedHash: string): Promise<boolean> {
    const parsed = this.parse(encodedHash);
    if (!parsed) {
      // A malformed stored hash is a data problem, not a caller problem. Returning false keeps
      // the sign-in path uniform: one row with a corrupt hash must not produce a distinctive
      // error that says so.
      return false;
    }

    let derived: Buffer;
    try {
      derived = await this.derive(password, parsed.salt, parsed);
    } catch {
      // Parameters recorded in the row that this process refuses to honour — for example a
      // cost raised beyond the memory limit. Not a match, and not a crash.
      return false;
    }

    if (derived.length !== parsed.expected.length) {
      return false;
    }
    return timingSafeEqual(derived, parsed.expected);
  }

  needsRehash(encodedHash: string): boolean {
    const parsed = this.parse(encodedHash);
    if (!parsed) {
      // Unparseable means it cannot be verified either, so there is nothing to preserve.
      return true;
    }
    return parsed.n < CURRENT.n || parsed.r < CURRENT.r || parsed.p < CURRENT.p;
  }

  /**
   * A hash of a value nobody knows, generated once per process.
   *
   * Sign-in verifies against this when no user was found so that a missing account costs the
   * same time as a wrong password. It is computed lazily rather than at construction because
   * a derivation on the module-loading path would add ~100 ms to every process start.
   */
  decoyHash(): string {
    this.decoy ??= [
      SCHEME,
      CURRENT.n,
      CURRENT.r,
      CURRENT.p,
      randomBytes(CURRENT.saltBytes).toString('base64'),
      randomBytes(CURRENT.keyBytes).toString('base64'),
    ].join('$');
    return this.decoy;
  }

  private decoy: string | undefined;

  private derive(
    password: string,
    salt: Buffer,
    parameters: { n: number; r: number; p: number; keyBytes?: number },
  ): Promise<Buffer> {
    return scryptAsync(password.normalize('NFKC'), salt, parameters.keyBytes ?? CURRENT.keyBytes, {
      N: parameters.n,
      r: parameters.r,
      p: parameters.p,
      maxmem: MAX_MEMORY_BYTES,
    });
  }

  private parse(
    encodedHash: string,
  ): { n: number; r: number; p: number; salt: Buffer; expected: Buffer; keyBytes: number } | null {
    const parts = encodedHash.split('$');
    if (parts.length !== FIELD_COUNT || parts[0] !== SCHEME) {
      return null;
    }
    const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
    const n = Number(rawN);
    const r = Number(rawR);
    const p = Number(rawP);
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
      return null;
    }
    if (n <= 1 || (n & (n - 1)) !== 0 || r < 1 || p < 1) {
      return null;
    }

    const salt = Buffer.from(rawSalt ?? '', 'base64');
    const expected = Buffer.from(rawHash ?? '', 'base64');
    if (salt.length === 0 || expected.length === 0) {
      return null;
    }
    return { n, r, p, salt, expected, keyBytes: expected.length };
  }
}
