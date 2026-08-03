import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { Permission } from '@edms/domain';

import { ForbiddenError } from '../errors/application-errors';
import { aRequestContext } from '../../testing/factories';
import { runWithContext } from '../tenancy/tenant-context';
import { PUBLIC_ROUTE } from '../auth/public.decorator';
import { REQUIRED_PERMISSIONS } from './permission.decorator';
import { RbacGuard } from './rbac.guard';

/** A reflector that answers from a fixed map, standing in for route metadata. */
function reflectorReturning(metadata: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
}

const anyContext = {
  getHandler: () => () => undefined,
  getClass: () => class {},
} as unknown as ExecutionContext;

describe('RbacGuard', () => {
  it('lets a public route through without a permission', () => {
    const guard = new RbacGuard(reflectorReturning({ [PUBLIC_ROUTE]: 'health checks' }));
    expect(guard.canActivate(anyContext)).toBe(true);
  });

  it('allows a caller holding every required permission', () => {
    const guard = new RbacGuard(
      reflectorReturning({ [REQUIRED_PERMISSIONS]: [Permission.DOCUMENT_VIEW] }),
    );
    runWithContext(aRequestContext({ permissions: [Permission.DOCUMENT_VIEW] }), () => {
      expect(guard.canActivate(anyContext)).toBe(true);
    });
  });

  it('refuses a caller missing one of several required permissions', () => {
    const guard = new RbacGuard(
      reflectorReturning({
        [REQUIRED_PERMISSIONS]: [Permission.DOCUMENT_ARCHIVE, Permission.DOCUMENT_PUBLISH],
      }),
    );
    runWithContext(aRequestContext({ permissions: [Permission.DOCUMENT_ARCHIVE] }), () => {
      expect(() => guard.canActivate(anyContext)).toThrowError(ForbiddenError);
    });
  });

  it('is closed by default: no context means no permissions', () => {
    const guard = new RbacGuard(
      reflectorReturning({ [REQUIRED_PERMISSIONS]: [Permission.DOCUMENT_VIEW] }),
    );
    expect(() => guard.canActivate(anyContext)).toThrowError(ForbiddenError);
  });
});
