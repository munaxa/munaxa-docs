'use client';

import { QueryClient } from '@tanstack/react-query';

import { DomainError, ErrorCode } from '@edms/domain';

/**
 * The single cache for everything the API owns.
 *
 * There is no global client store: Redux-shaped state for server data is the most common
 * source of stale UI in systems like this, so the query cache is the source of truth and
 * invalidation is explicit (`docs/architecture/16-frontend-architecture.md` §4).
 *
 * The staleness defaults here are the conservative ones. A screen that can tolerate more —
 * the folder tree, admin configuration — raises its own; nothing lowers the retry rule,
 * because retrying a permission failure or an illegal transition only produces the same
 * answer more slowly.
 */
const NEVER_RETRY: readonly string[] = [
  ErrorCode.FORBIDDEN,
  ErrorCode.NOT_FOUND,
  ErrorCode.UNAUTHENTICATED,
  ErrorCode.VALIDATION_FAILED,
  ErrorCode.INVALID_TRANSITION,
  ErrorCode.VERSION_CONFLICT,
  ErrorCode.LOCKED,
  ErrorCode.LEGAL_HOLD,
];

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 300_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          if (error instanceof DomainError && NEVER_RETRY.includes(error.code)) {
            return false;
          }
          return failureCount < 2;
        },
      },
      mutations: {
        // Approvals, publishing and deletion are never optimistic: the server's answer is
        // the only truth worth showing (16-frontend-architecture.md §4).
        retry: false,
      },
    },
  });
}
