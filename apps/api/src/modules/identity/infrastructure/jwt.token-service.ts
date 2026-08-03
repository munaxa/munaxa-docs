import { Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  type PermissionKey,
  type TenantId,
  type UserId,
  asId,
  isPermissionKey,
} from '@edms/domain';

import type { AppConfig } from '../../../core/config/configuration';
import { APP_CONFIG } from '../../../core/config/config.module';
import type { AccessTokenClaims, TokenVerifier } from '../../../core/auth/access-token';
import { UnauthenticatedError } from '../../../core/errors/application-errors';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import type {
  AccessTokenIssuer,
  AccessTokenRequest,
  IssuedAccessToken,
} from '../application/authentication.ports';

/**
 * Access tokens: HS256 JWTs, signed and verified here.
 *
 * Written against `node:crypto` rather than a JWT library, for two reasons. The algorithm is
 * fixed at HS256 and compared as a constant, which removes the `alg` confusion class of bug
 * — `alg: none` and RS256-verified-as-HMAC are both structurally impossible here rather than
 * mitigated by configuration. And the API's dependency list stays as short as its most
 * security-critical path deserves.
 *
 * The shared secret comes from `JWT_ACCESS_SECRET`, which configuration requires to be at
 * least 32 characters and refuses to boot without. Rotation to asymmetric keys, or to a
 * tenant's own OIDC issuer, replaces this class behind `TokenVerifier` without touching a
 * use case.
 */
@Injectable()
export class JwtTokenService implements AccessTokenIssuer, TokenVerifier {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
  ) {}

  issue(request: AccessTokenRequest): IssuedAccessToken {
    const now = this.clock.now();
    const issuedAtSeconds = Math.floor(now.getTime() / 1000);
    const expiresAtSeconds = issuedAtSeconds + this.config.auth.accessTtlSeconds;

    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
      iss: this.config.auth.issuer,
      aud: this.config.auth.audience,
      sub: request.userId,
      tenantId: request.tenantId,
      roles: [...request.roles],
      permissions: [...request.permissions],
      sessionId: request.sessionId,
      permVersion: request.permissionVersion,
      iat: issuedAtSeconds,
      exp: expiresAtSeconds,
    };

    const signingInput = `${encode(header)}.${encode(payload)}`;
    return {
      token: `${signingInput}.${this.sign(signingInput)}`,
      expiresAt: new Date(expiresAtSeconds * 1000),
    };
  }

  verify(token: string): Promise<AccessTokenClaims> {
    // Every rejection below throws the same error. A verifier that explains *why* a token was
    // refused is a probe for forging one.
    const parts = token.split('.');
    if (parts.length !== 3) {
      return Promise.reject(new UnauthenticatedError('That token is not valid.'));
    }
    const [rawHeader, rawPayload, signature] = parts as [string, string, string];

    const expected = this.sign(`${rawHeader}.${rawPayload}`);
    const presented = Buffer.from(signature);
    const computed = Buffer.from(expected);
    if (presented.length !== computed.length || !timingSafeEqual(presented, computed)) {
      return Promise.reject(new UnauthenticatedError('That token is not valid.'));
    }

    const header = decode(rawHeader);
    // Checked *after* the signature, and compared to a constant: the header is attacker-
    // controlled input until the signature says otherwise.
    if (!header || header['alg'] !== 'HS256' || header['typ'] !== 'JWT') {
      return Promise.reject(new UnauthenticatedError('That token is not valid.'));
    }

    const payload = decode(rawPayload);
    if (!payload) {
      return Promise.reject(new UnauthenticatedError('That token is not valid.'));
    }

    const claims = this.toClaims(payload);
    if (!claims) {
      return Promise.reject(new UnauthenticatedError('That token is not valid.'));
    }
    if (claims.expiresAt.getTime() <= this.clock.now().getTime()) {
      return Promise.reject(new UnauthenticatedError('That session has expired.'));
    }
    return Promise.resolve(claims);
  }

  private sign(signingInput: string): string {
    return createHmac('sha256', this.config.auth.accessSecret)
      .update(signingInput)
      .digest('base64url');
  }

  /**
   * Narrows an untrusted payload to the claims the product understands.
   *
   * Permissions are filtered against the catalogue in `@edms/domain`: a token naming a
   * permission that no longer exists carries no authority, and one naming a permission that
   * never existed is not given the benefit of the doubt.
   */
  private toClaims(payload: Record<string, unknown>): AccessTokenClaims | null {
    if (
      payload['iss'] !== this.config.auth.issuer ||
      payload['aud'] !== this.config.auth.audience
    ) {
      return null;
    }

    const sub = payload['sub'];
    const tenantId = payload['tenantId'];
    const sessionId = payload['sessionId'];
    const issuedAt = payload['iat'];
    const expiresAt = payload['exp'];
    const permVersion = payload['permVersion'];

    if (
      typeof sub !== 'string' ||
      typeof tenantId !== 'string' ||
      typeof sessionId !== 'string' ||
      typeof issuedAt !== 'number' ||
      typeof expiresAt !== 'number' ||
      typeof permVersion !== 'number'
    ) {
      return null;
    }

    const roles = Array.isArray(payload['roles'])
      ? payload['roles'].filter((role): role is string => typeof role === 'string')
      : [];
    const permissions = Array.isArray(payload['permissions'])
      ? payload['permissions'].filter(
          (permission): permission is PermissionKey =>
            typeof permission === 'string' && isPermissionKey(permission),
        )
      : [];

    return {
      sub: asId<UserId>(sub),
      tenantId: asId<TenantId>(tenantId),
      roles,
      permissions,
      sessionId,
      permVersion,
      issuedAt: new Date(issuedAt * 1000),
      expiresAt: new Date(expiresAt * 1000),
    };
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
