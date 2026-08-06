import { type ScryptOptions, scrypt, timingSafeEqual } from 'node:crypto';
import type { PasswordHasher as PlatformPasswordHasher } from '@munaxa/crypto';

/**
 * Verifies password hashes written before the platform migration.
 *
 * Munaxa Docs stored `scrypt$<N>$<r>$<p>$<salt-b64>$<hash-b64>`. The platform stores a PHC-style
 * `$scrypt$v=1$n=…,r=…,p=…$<salt>$<hash>`. The two are not interchangeable, and every credential
 * row in every tenant is in the old format — so deleting this class is a mass lockout, not a
 * cleanup.
 *
 * It is registered as a legacy verifier on `PasswordHasherRegistry`, which routes by encoded
 * prefix. Verification still succeeds for those rows; `needsRehash` returns true for all of them
 * by definition, and the existing upgrade-on-sign-in path in `DefaultAuthenticationService`
 * rewrites each one into the platform format the next time its owner signs in.
 *
 * This is the only cryptography left in Munaxa Docs, and it is verify-only on purpose: it cannot
 * produce a hash in the old format, so nothing new can be written in it. Once telemetry shows no
 * `scrypt$` rows remain — the reason `legacyHashCount` exists on the identity admin read model —
 * unregister it and delete this file.
 */
const SCHEME = 'scrypt';
const FIELD_COUNT = 6;

/** scrypt's default maxmem (32 MB) is far below what the legacy N=2^17 parameters need. */
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;

interface LegacyParams {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly expected: Buffer;
  readonly keyBytes: number;
}

/**
 * `promisify(scrypt)` picks the three-argument overload, which cannot carry the cost parameters.
 * Wrapping it by hand keeps them.
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

export class LegacyScryptVerifier implements PlatformPasswordHasher {
  /** Matches the prefix this verifier is registered under. */
  readonly id = SCHEME;

  hash(): Promise<string> {
    // Deliberately unreachable through the registry, which only ever calls `hash` on the primary.
    // Throwing rather than silently producing a legacy hash keeps the format one-way.
    return Promise.reject(
      new Error('LegacyScryptVerifier verifies pre-migration hashes; it cannot produce them'),
    );
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
      derived = await scryptAsync(password.normalize('NFKC'), parsed.salt, parsed.keyBytes, {
        N: parsed.n,
        r: parsed.r,
        p: parsed.p,
        maxmem: MAX_MEMORY_BYTES,
      });
    } catch {
      // Parameters recorded in the row that this process refuses to honour — for example a cost
      // raised beyond the memory limit. Not a match, and not a crash.
      return false;
    }

    if (derived.length !== parsed.expected.length) {
      return false;
    }
    return timingSafeEqual(derived, parsed.expected);
  }

  /** Every legacy hash is behind the current scheme, so every one of them wants rewriting. */
  needsRehash(): boolean {
    return true;
  }

  /** True when this verifier owns the encoded hash. */
  static owns(encodedHash: string): boolean {
    return encodedHash.startsWith(`${SCHEME}$`);
  }

  private parse(encodedHash: string): LegacyParams | null {
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
