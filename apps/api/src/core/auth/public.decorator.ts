import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = 'edms:public-route';

/**
 * Marks a route as reachable without authentication.
 *
 * The reason is a required argument, not a comment: a public route is a decision someone
 * must be able to review later, and an unexplained one is indistinguishable from a mistake
 * (`docs/architecture/15-api-architecture.md` §5).
 */
export const Public = (reason: string): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIC_ROUTE, reason);
