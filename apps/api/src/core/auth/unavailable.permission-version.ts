import { Injectable } from '@nestjs/common';

import type { UserId } from '@edms/domain';

import type { PermissionVersionReader } from './permission-version';

/**
 * The default `PERMISSION_VERSION_READER`: nobody's version can be established, so nobody passes.
 *
 * The same posture `NoIssuerTokenVerifier` takes for `TOKEN_VERIFIER`, and for the same reason. A
 * deployment that has not bound a real reader must not decide that every token is therefore
 * current — that is precisely the fail-open this port exists to close. `null` means "there is no
 * authoritative answer here", and `AuthenticationGuard` refuses it, so an unwired process boots,
 * serves its `@Public` health probes, and admits nothing behind the guard.
 */
@Injectable()
export class UnavailablePermissionVersionReader implements PermissionVersionReader {
  currentFor(_userId: UserId): Promise<number | null> {
    return Promise.resolve(null);
  }
}
