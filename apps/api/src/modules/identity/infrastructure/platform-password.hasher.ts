import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PasswordHasherRegistry, ScryptPasswordHasher, toBase64Url } from '@munaxa/crypto';

import type { PasswordHasher } from '../application/authentication.ports';
import { LegacyScryptVerifier } from './legacy-scrypt.verifier';

/**
 * The product's `PasswordHasher` port, backed by `@munaxa/crypto`.
 *
 * Munaxa Docs no longer implements scrypt. What is left here is the two things the platform
 * cannot know about: which cost parameters this product committed to, and how to read the hashes
 * it wrote before the migration.
 *
 * **Cost.** The platform defaults to N=2^14 (~16 MiB, ~50 ms). Munaxa Docs deliberately chose
 * OWASP's N=2^17 (~128 MiB, ~100 ms) and its stored hashes record that. Passing it explicitly
 * keeps both the security posture and the login latency exactly where they were — adopting the
 * platform default would silently weaken every password written from here on.
 *
 * **Legacy rows.** `PasswordHasherRegistry` routes by encoded prefix: `scrypt$…` goes to the
 * pre-migration verifier, everything else to the platform's PHC-format hasher. `needsRehash`
 * reports true for every legacy row, and `DefaultAuthenticationService` already rewrites hashes
 * that need it on successful sign-in, so the estate migrates itself without a forced reset.
 */

/** OWASP scrypt guidance, and the parameters every existing Munaxa Docs hash was written with. */
const DOCS_SCRYPT_PARAMS = Object.freeze({
  N: 2 ** 17,
  r: 8,
  p: 1,
  keyLength: 32,
  saltLength: 16,
});

@Injectable()
export class PlatformPasswordHasher implements PasswordHasher {
  readonly #registry: PasswordHasherRegistry;
  #decoy: string | undefined;

  constructor() {
    this.#registry = new PasswordHasherRegistry(
      new ScryptPasswordHasher(DOCS_SCRYPT_PARAMS),
    ).registerLegacy('scrypt$', new LegacyScryptVerifier());
  }

  hash(password: string): Promise<string> {
    return this.#registry.hash(password);
  }

  verify(password: string, encodedHash: string): Promise<boolean> {
    return this.#registry.verify(password, encodedHash);
  }

  needsRehash(encodedHash: string): boolean {
    return this.#registry.needsRehash(encodedHash);
  }

  /**
   * A hash of a value nobody knows, generated once per process.
   *
   * Sign-in verifies against this when no user was found so that a missing account costs the same
   * time as a wrong password. The platform's `dummyPasswordHash` is async and this port is not —
   * changing the port would ripple into the sign-in path for no benefit — so the decoy is
   * assembled synchronously in the platform's own encoding. What matters is that verifying it
   * runs a full derivation at the same parameters, which it does.
   */
  decoyHash(): string {
    this.#decoy ??= [
      '',
      'scrypt',
      'v=1',
      `n=${DOCS_SCRYPT_PARAMS.N},r=${DOCS_SCRYPT_PARAMS.r},p=${DOCS_SCRYPT_PARAMS.p}`,
      toBase64Url(randomBytes(DOCS_SCRYPT_PARAMS.saltLength)),
      toBase64Url(randomBytes(DOCS_SCRYPT_PARAMS.keyLength)),
    ].join('$');
    return this.#decoy;
  }
}
