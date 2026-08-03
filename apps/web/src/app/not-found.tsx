import type { ReactNode } from 'react';

import { EmptyState } from '@munaxa/ui';

import { en } from '@edms/i18n';

/**
 * Also what a user sees for a document in another tenant, or one they may not reach: the API
 * answers 404 rather than 403 so existence is never leaked
 * (`docs/architecture/15-api-architecture.md` §4).
 */
export default function NotFound(): ReactNode {
  return <EmptyState title={en.state.notFound} description={en.state.notFoundHint} />;
}
