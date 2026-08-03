import { Injectable } from '@nestjs/common';

import type { Capabilities } from '@edms/contracts';
import type { PermissionKey, ScopeRef } from '@edms/domain';

import type {
  AclResolver,
  AuthorizationSubject,
  Decision,
  VisibilityFilter,
} from './acl-resolver.port';

/**
 * The resolver in force until the Library module binds the real one.
 *
 * It denies everything, and that direction is the entire point. A skeleton that allowed
 * everything until the real implementation arrived would let every endpoint written before
 * then appear to work, and the day the resolver lands, half of them would break — or worse,
 * one would ship without ever having been checked.
 *
 * Closed by default is also what the permission model requires of the real resolver
 * (`docs/architecture/08-permission-model.md` §3, step 7): absent an entry, the answer is no.
 * This is that rule with an empty entry set.
 */
@Injectable()
export class DenyAllAclResolver implements AclResolver {
  resolve(
    _subject: AuthorizationSubject,
    _scope: ScopeRef,
    _permission: PermissionKey,
  ): Promise<Decision> {
    return Promise.resolve({ allowed: false, decidedAt: null, reason: 'CLOSED_BY_DEFAULT' });
  }

  capabilitiesFor(
    _subject: AuthorizationSubject,
    _scope: ScopeRef,
    permissions: readonly PermissionKey[],
  ): Promise<Capabilities> {
    const capabilities: Capabilities = {};
    for (const permission of permissions) {
      capabilities[permission] = false;
    }
    return Promise.resolve(capabilities);
  }

  visibilityFilter(
    _subject: AuthorizationSubject,
    _permission: PermissionKey,
  ): Promise<VisibilityFilter> {
    // An empty subject set with `unrestricted: false` makes any query built from this filter
    // match nothing, rather than silently omitting the predicate and matching everything.
    return Promise.resolve({
      subjectIds: [],
      deniedScopeIds: [],
      unrestricted: false,
      fingerprint: 'deny-all',
    });
  }
}
