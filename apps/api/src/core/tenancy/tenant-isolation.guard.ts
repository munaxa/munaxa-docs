import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { ForbiddenError } from '../errors/application-errors';
import { currentContext } from './tenant-context';

/**
 * Isolation layer 3: rejects any request that *names* a tenant.
 *
 * The tenant is taken from the signed token and from nowhere else. A body, query or path
 * carrying `tenantId` is not filtered out and ignored — it is refused, because a client
 * sending one is either broken or probing, and both deserve a hard answer
 * (`docs/architecture/17-security-architecture.md` §4).
 */
const TENANT_FIELDS = ['tenantId', 'tenant_id', 'tenant'];

@Injectable()
export class TenantIsolationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const claimed = currentContext()?.tenantId ?? null;

    for (const source of [request.query, request.body, request.params]) {
      const named = this.namedTenant(source);
      if (named !== null && named !== claimed) {
        throw new ForbiddenError('act on behalf of another organisation');
      }
    }
    return true;
  }

  private namedTenant(source: unknown): string | null {
    if (typeof source !== 'object' || source === null) {
      return null;
    }
    const record = source as Record<string, unknown>;
    for (const field of TENANT_FIELDS) {
      const value = record[field];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return null;
  }
}
