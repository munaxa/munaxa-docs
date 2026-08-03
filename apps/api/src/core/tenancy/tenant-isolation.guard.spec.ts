import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ForbiddenError } from '../errors/application-errors';
import { aRequestContext } from '../../testing/factories';
import { runWithContext } from './tenant-context';
import { TenantIsolationGuard } from './tenant-isolation.guard';

function executionContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ query: {}, body: {}, params: {}, ...request }) }),
  } as unknown as ExecutionContext;
}

describe('TenantIsolationGuard', () => {
  const guard = new TenantIsolationGuard();

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
});
