import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { type RequestContext, requireContext } from '../tenancy/tenant-context';

/**
 * The authenticated caller, from the request context rather than from the request object —
 * so a handler cannot be fooled by a body field named `user`.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, _context: ExecutionContext): RequestContext => requireContext(),
);
