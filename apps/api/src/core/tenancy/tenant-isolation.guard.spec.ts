import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { Reflector } from '@nestjs/core';

import { ForbiddenError } from '../errors/application-errors';
import { aRequestContext } from '../../testing/factories';
import { runWithContext } from './tenant-context';
import { TenantIsolationGuard } from './tenant-isolation.guard';

function executionContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ query: {}, body: {}, params: {}, ...request }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

/** A reflector that reports every route as authenticated, unless a reason is supplied. */
function reflectorFor(publicReason?: string): Reflector {
  return { getAllAndOverride: () => publicReason } as unknown as Reflector;
}

describe('TenantIsolationGuard', () => {
  const guard = new TenantIsolationGuard(reflectorFor());

  it('allows a request that names no tenant', () => {
    const context = aRequestContext();
    runWithContext(context, () => {
      expect(guard.canActivate(executionContext({ body: { title: 'Quality manual' } }))).toBe(true);
    });
  });

  it('allows a request that names its own tenant', () => {
    const context = aRequestContext();
    runWithContext(context, () => {
      expect(guard.canActivate(executionContext({ query: { tenantId: context.tenantId } }))).toBe(
        true,
      );
    });
  });

  it('refuses a body naming another tenant', () => {
    runWithContext(aRequestContext(), () => {
      expect(() =>
        guard.canActivate(executionContext({ body: { tenantId: 'someone-elses-tenant' } })),
      ).toThrowError(ForbiddenError);
    });
  });

  it('refuses a query or a path parameter naming another tenant', () => {
    runWithContext(aRequestContext(), () => {
      expect(() =>
        guard.canActivate(executionContext({ query: { tenant_id: 'other' } })),
      ).toThrowError(ForbiddenError);
      expect(() =>
        guard.canActivate(executionContext({ params: { tenant: 'other' } })),
      ).toThrowError(ForbiddenError);
    });
  });

  it('refuses a tenant-named request that arrives with no context at all', () => {
    expect(() => guard.canActivate(executionContext({ body: { tenantId: 'other' } }))).toThrowError(
      ForbiddenError,
    );
  });

  it('exempts a route that is explicitly public', () => {
    // Sign-in has to say which organisation the credentials belong to, and there is no token
    // yet to say it. Without this exemption every correct sign-in was refused with a 403.
    const publicGuard = new TenantIsolationGuard(
      reflectorFor('Signing in cannot require a token.'),
    );

    expect(publicGuard.canActivate(executionContext({ body: { tenant: 'acme' } }))).toBe(true);
  });
});
