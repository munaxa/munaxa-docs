import { AsyncLocalStorage } from 'node:async_hooks';

import { Inject, Injectable } from '@nestjs/common';

import { PrismaService, type PrismaTransaction } from './prisma.service';
import { requireContext } from '../tenancy/tenant-context';

/**
 * The transaction boundary. One use case is one transaction: the aggregate change, the audit
 * event and any outbox rows commit together or not at all
 * (`docs/architecture/02-backend-architecture.md` §6).
 *
 * The active transaction is held in `AsyncLocalStorage` rather than passed as a parameter to
 * every repository, port and writer. That is what lets `DocumentRepository.save()`,
 * `AuditWriter.write()` and `OutboxWriter.publish()` be declared in the *application* layer
 * without any of them naming Prisma — and it removes the failure mode where one call in a
 * use case is accidentally given the outer client and commits on its own.
 *
 * Nothing is enqueued inside `run()`. A job enqueued before commit can be delivered against
 * a transaction that then rolls back; the outbox exists to make that impossible.
 */
export const UNIT_OF_WORK = Symbol('UnitOfWork');

export interface UnitOfWork {
  run<TResult>(work: () => Promise<TResult>): Promise<TResult>;
}

const transactionStorage = new AsyncLocalStorage<PrismaTransaction>();

/** The ambient transaction, for infrastructure that must join it. */
export function currentTransaction(): PrismaTransaction | null {
  return transactionStorage.getStore() ?? null;
}

export class NoActiveTransactionError extends Error {
  constructor() {
    super('This operation must run inside a unit of work. Wrap it in UnitOfWork.run().');
    this.name = 'NoActiveTransactionError';
  }
}

/**
 * The transaction, or a failure. Called by every repository implementation, so a write that
 * escapes its use case's transaction fails immediately instead of committing alone.
 */
export function requireTransaction(): PrismaTransaction {
  const transaction = transactionStorage.getStore();
  if (!transaction) {
    throw new NoActiveTransactionError();
  }
  return transaction;
}

@Injectable()
export class PrismaUnitOfWork implements UnitOfWork {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async run<TResult>(work: () => Promise<TResult>): Promise<TResult> {
    const existing = transactionStorage.getStore();
    if (existing) {
      // Nested use cases join the outer transaction. Opening a second one would deadlock
      // against the first on any row it has already touched.
      return work();
    }
    const { tenantId } = requireContext();
    return this.prisma.withTenant(tenantId, (tx) => transactionStorage.run(tx, work));
  }
}
