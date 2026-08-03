import { Permission, type PermissionKey, type TenantId, type UserId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { RequestContext } from '../core/tenancy/tenant-context';

/**
 * Fixtures and factories.
 *
 * Every factory takes overrides and fills the rest, so a test states only what it is about:
 * a test that cares about permissions should not have to invent a correlation id, and a test
 * that reads as a list of unexplained constants is a test nobody will maintain.
 */
export function aTenantId(): TenantId {
  return asId<TenantId>(uuidv7());
}

export function aUserId(): UserId {
  return asId<UserId>(uuidv7());
}

export type ContextOverrides = Partial<RequestContext>;

export function aRequestContext(overrides: ContextOverrides = {}): RequestContext {
  return {
    tenantId: aTenantId(),
    userId: aUserId(),
    roles: ['READER'],
    permissions: [Permission.DOCUMENT_VIEW],
    sessionId: uuidv7(),
    correlationId: uuidv7(),
    permissionVersion: 1,
    locale: 'en',
    ...overrides,
  };
}

/** A caller who holds everything — for tests about *other* rules than permission. */
export function anAdminContext(permissions: readonly PermissionKey[]): RequestContext {
  return aRequestContext({ roles: ['TENANT_ADMIN'], permissions });
}
