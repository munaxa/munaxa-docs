import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { type PermissionKey, type TenantId, type UserId, Permission, asId } from '@edms/domain';

import type { AppConfig } from '../../../core/config/configuration';
import { FakeClock } from '../../../testing/fake-ports';
import { JwtTokenService } from './jwt.token-service';

/**
 * The token service is the only thing standing between a forged string and a trusted identity,
 * so these tests are mostly attempts to forge one.
 */

const SECRET = 'a'.repeat(32);

function serviceAt(now: Date, secret = SECRET): { service: JwtTokenService; clock: FakeClock } {
  const clock = new FakeClock(now);
  const config = {
    auth: {
      issuer: 'https://docs.munaxa.test',
      audience: 'munaxa-docs',
      accessSecret: secret,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 2_592_000,
    },
  } as unknown as AppConfig;
  return { service: new JwtTokenService(config, clock), clock };
}

const request = {
  userId: asId<UserId>('01900000-0000-7000-8000-000000000001'),
  tenantId: asId<TenantId>('01900000-0000-7000-8000-00000000000a'),
  roles: ['TENANT_ADMIN'],
  permissions: [Permission.USER_MANAGE] as readonly PermissionKey[],
  sessionId: '01900000-0000-7000-8000-0000000000f1',
  permissionVersion: 3,
};

describe('JwtTokenService', () => {
  it('round-trips the claims it signed', async () => {
    const { service } = serviceAt(new Date('2026-01-01T00:00:00Z'));
    const issued = service.issue(request);

    const claims = await service.verify(issued.token);

    expect(claims.sub).toBe(request.userId);
    expect(claims.tenantId).toBe(request.tenantId);
    expect(claims.roles).toEqual(['TENANT_ADMIN']);
    expect(claims.permissions).toEqual([Permission.USER_MANAGE]);
    expect(claims.sessionId).toBe(request.sessionId);
    expect(claims.permVersion).toBe(3);
  });

  it('rejects a token whose payload was edited', async () => {
    const { service } = serviceAt(new Date('2026-01-01T00:00:00Z'));
    const issued = service.issue(request);
    const [header, payload, signature] = issued.token.split('.') as [string, string, string];

    // Escalate to a different tenant, keeping the original signature.
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    decoded['tenantId'] = '01900000-0000-7000-8000-00000000000b';
    const forged = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');

    await expect(service.verify(`${header}.${forged}.${signature}`)).rejects.toThrowError();
  });

  it('rejects an unsigned token claiming alg none', async () => {
    const { service } = serviceAt(new Date('2026-01-01T00:00:00Z'));
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://docs.munaxa.test',
        aud: 'munaxa-docs',
        sub: request.userId,
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        permVersion: 1,
        iat: 1,
        exp: 9_999_999_999,
      }),
    ).toString('base64url');

    await expect(service.verify(`${header}.${payload}.`)).rejects.toThrowError();
  });

  it('rejects a token signed with a different secret', async () => {
    const { service: theirs } = serviceAt(new Date('2026-01-01T00:00:00Z'), 'b'.repeat(32));
    const { service: ours } = serviceAt(new Date('2026-01-01T00:00:00Z'));

    await expect(ours.verify(theirs.issue(request).token)).rejects.toThrowError();
  });

  it('rejects a token once it has expired', async () => {
    const { service, clock } = serviceAt(new Date('2026-01-01T00:00:00Z'));
    const issued = service.issue(request);

    clock.advanceBy(901 * 1000);

    await expect(service.verify(issued.token)).rejects.toThrowError();
  });

  it('rejects a token minted for another audience', async () => {
    const { service: theirs } = serviceAt(new Date('2026-01-01T00:00:00Z'));
    const foreign = {
      auth: {
        issuer: 'https://docs.munaxa.test',
        audience: 'another-product',
        accessSecret: SECRET,
        accessTtlSeconds: 900,
        refreshTtlSeconds: 2_592_000,
      },
    } as unknown as AppConfig;
    const issued = new JwtTokenService(
      foreign,
      new FakeClock(new Date('2026-01-01T00:00:00Z')),
    ).issue(request).token;

    // Same secret, same issuer, different audience: still refused.
    await expect(theirs.verify(issued)).rejects.toThrowError();
  });

  it('drops a permission that is not in the catalogue', async () => {
    const { service } = serviceAt(new Date('2026-01-01T00:00:00Z'));
    const issued = service.issue({
      ...request,
      permissions: [Permission.USER_MANAGE, 'document:invent' as PermissionKey],
    });

    const claims = await service.verify(issued.token);

    // A token naming a permission the product does not define carries no authority from it.
    expect(claims.permissions).toEqual([Permission.USER_MANAGE]);
  });
});
