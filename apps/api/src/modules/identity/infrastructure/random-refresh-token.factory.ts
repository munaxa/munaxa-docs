import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import type { AppConfig } from '../../../core/config/configuration';
import { APP_CONFIG } from '../../../core/config/config.module';
import type { MintedRefreshToken, RefreshTokenFactory } from '../application/authentication.ports';

/** 256 bits. Unguessable, and the same width as the SHA-256 digest it is stored as. */
const TOKEN_BYTES = 32;

/**
 * Refresh tokens: opaque random strings, stored as SHA-256 digests.
 *
 * Two deliberate choices.
 *
 * **Opaque, not a JWT.** A self-describing token is valid until it expires no matter what the
 * server believes, and the entire design here depends on being able to revoke a session the
 * instant reuse is detected.
 *
 * **SHA-256, not a password hash.** This is the one place a fast digest is right: the input is
 * 256 bits of entropy from a CSPRNG, so there is no dictionary to attack and nothing for a
 * slow KDF to protect against — while lookup happens on every refresh and must be an indexed
 * equality match. Passwords get scrypt because passwords are guessable; these are not.
 */
@Injectable()
export class RandomRefreshTokenFactory implements RefreshTokenFactory {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  create(now: Date): MintedRefreshToken {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    return {
      token,
      hash: this.hash(token),
      expiresAt: new Date(now.getTime() + this.config.auth.refreshTtlSeconds * 1000),
    };
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
