import { Inject, Injectable } from '@nestjs/common';
import type {
  AuditAppendOptions,
  AuditQuery,
  AuditRecord,
  AuditRepositoryPort,
  AuditSealer,
  ChainHead,
} from '@munaxa/interfaces';
import type { TenantId as PlatformTenantId } from '@munaxa/types';
import type { DocsAuditAction } from '@edms/domain';

import { requireContext } from '../../../core/tenancy/tenant-context';
import { currentTransaction } from '../../../core/prisma/unit-of-work';
import {
  AUDIT_REPOSITORY,
  type AuditEventRecord,
  type AuditRepository,
} from '../application/ports';
import { toAuditEventRecord, toPlatformRecord } from './platform-audit.mapping';

/**
 * `audit_event`, as the Platform's `AuditRepositoryPort`.
 *
 * The division of labour is the point of this class, and it is not the obvious one.
 *
 * **The adapter still owns ordering.** `appendChained` is specified so that the adapter reads the
 * head, calls `seal`, and persists the result — all in one transaction. That is exactly where this
 * product's guarantees live: a per-tenant `pg_advisory_xact_lock`, and a sequence allocated as
 * `tail + 1` rather than from a PostgreSQL sequence, which would gap on rollback and make a
 * deletion indistinguishable from an ordinary abort (`13-audit-architecture.md` §4). Both stay
 * here, byte for byte as they were, because the Platform never asked for them.
 *
 * **The Platform owns sealing.** The canonical material, the digest, the chain linkage, the
 * sequence advance and the format stamp are `AuditService`'s now. This class computes no hash.
 */
@Injectable()
export class PlatformAuditRepository implements AuditRepositoryPort<DocsAuditAction> {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepository) {}

  /**
   * The append joins the caller's unit of work rather than opening its own.
   *
   * Declared so `AuditService` knows not to retry a chain conflict itself: a conflict has already
   * aborted the caller's transaction, and a second attempt inside an aborted transaction cannot
   * commit. The retry belongs at the level that owns the transaction.
   */
  readonly joinsTransactions = true;

  async appendChained(
    tenantId: PlatformTenantId,
    seal: AuditSealer<DocsAuditAction>,
    options: AuditAppendOptions = {},
  ): Promise<AuditRecord<DocsAuditAction>> {
    assertAmbientTransaction(tenantId, options);

    // The advisory lock and the head read, inside the caller's transaction. Two concurrent writers
    // for one tenant cannot compute the same `previousHash`, because the second waits here.
    const head = await this.repository.lockAndReadTail();
    const record = seal(headOf(head));

    await this.repository.append(toAuditEventRecord(record));
    return record;
  }

  /**
   * Unchained writes have no meaning on this store.
   *
   * `AuditSinkPort.write` accepts an already-sealed record, which is right for a mirror — a SIEM,
   * a log — and wrong for the chain itself: the record was sealed against a head this method never
   * read, so persisting it would fork the chain or leave a hole. Nothing in this product calls it,
   * and if something starts to, it should fail loudly rather than corrupt the trail.
   */
  write(): Promise<void> {
    return Promise.reject(
      new Error(
        'The audit chain is append-only through appendChained(); an unchained write would fork it.',
      ),
    );
  }

  query(_query: AuditQuery): Promise<{ items: readonly AuditRecord<DocsAuditAction>[] }> {
    return Promise.reject(
      new Error(
        'Audit reads go through AuditReadService, which serves the filters ' +
          '13-audit-architecture.md §6 specifies. This port is write-side only.',
      ),
    );
  }

  /** The last record written for this tenant. Diagnostic: a head read is stale as it returns. */
  async latest(tenantId: PlatformTenantId): Promise<AuditRecord<DocsAuditAction> | undefined> {
    assertTenant(tenantId);
    const tail = await this.repository.readTail();
    if (tail.sequence === 0n) {
      return undefined;
    }
    const { events } = await this.repository.sliceBySequence(tail.sequence - 1n, 1);
    const last = events[0];
    return last === undefined ? undefined : toPlatformRecord(last);
  }
}

/**
 * One tenant's buffered batch: one lock, one head read, one insert.
 *
 * The read-audit buffer exists so that a hundred page views cost one advisory lock rather than a
 * hundred (`13-audit-architecture.md` §5). Routing each buffered event through the singleton
 * adapter would have re-read the head and issued a separate `INSERT` per event, which is the cost
 * the buffer was built to avoid — so the batch gets its own adapter instead of its own hashing.
 *
 * The head is read once under the lock and then advanced in memory as each record is sealed. That
 * is not a weakening: the lock is held for the whole transaction, so no other writer can advance
 * the chain underneath, and every record still chains to the digest of the one before it. It is
 * the same argument `appendMany` already relies on.
 *
 * Not `@Injectable()`: one instance per flush, holding that flush's head. A shared instance would
 * have shared mutable chain state, which is the bug this shape exists to make impossible.
 */
export class BatchedPlatformAuditRepository implements AuditRepositoryPort<DocsAuditAction> {
  #head: ChainHead | null = null;
  #started = false;
  readonly #rows: AuditEventRecord[] = [];

  constructor(private readonly repository: AuditRepository) {}

  readonly joinsTransactions = true;

  /** Takes the lock and reads the head, once, for the whole batch. */
  async begin(): Promise<void> {
    const tail = await this.repository.lockAndReadTail();
    this.#head = headOf(tail);
    this.#started = true;
  }

  appendChained(
    tenantId: PlatformTenantId,
    seal: AuditSealer<DocsAuditAction>,
    options: AuditAppendOptions = {},
  ): Promise<AuditRecord<DocsAuditAction>> {
    assertAmbientTransaction(tenantId, options);
    if (!this.#started) {
      throw new Error('begin() must run before the batch is sealed; it holds the advisory lock.');
    }
    const record = seal(this.#head);
    this.#head = { sequence: record.sequence, hash: record.hash };
    this.#rows.push(toAuditEventRecord(record));
    return Promise.resolve(record);
  }

  /** The whole batch, in one statement, in the transaction that holds the lock. */
  async commit(): Promise<void> {
    if (this.#rows.length > 0) {
      await this.repository.appendMany(this.#rows);
    }
  }

  write(): Promise<void> {
    return Promise.reject(new Error('A buffered audit record is sealed by appendChained().'));
  }

  query(): Promise<{ items: readonly AuditRecord<DocsAuditAction>[] }> {
    return Promise.reject(new Error('This adapter is write-side only.'));
  }

  /**
   * Undefined, always.
   *
   * The head this adapter holds is the batch's working position, not a written record — the rows
   * are still in memory until `commit()`. Reconstructing a record from it would report a write
   * that has not happened and may yet roll back, so the honest answer is that this adapter has no
   * latest record to offer. Nothing calls it; sequencing is `appendChained`'s job.
   */
  latest(): Promise<AuditRecord<DocsAuditAction> | undefined> {
    return Promise.resolve(undefined);
  }
}

/**
 * The store's head, as the Platform's sealer wants it.
 *
 * An empty chain is `{ sequence: 0n, hash: GENESIS_HASH }` here and `null` there — but handing the
 * Platform the literal zero head is what keeps the first record's sequence a `bigint` rather than
 * the number `1` that `null` would produce, and the Docs formats hash `previousHash ?? GENESIS`,
 * so the 64 zeros and `null` canonicalise identically. One representation reaches the column.
 */
function headOf(tail: { readonly sequence: bigint; readonly hash: string }): ChainHead {
  return { sequence: tail.sequence, hash: tail.hash };
}

/**
 * The tenant the Platform names must be the tenant the lock and the row-level policy apply to.
 *
 * `lockAndReadTail` keys the advisory lock on the ambient request context, and RLS scopes the
 * insert to the same. A caller naming a different tenant would serialise against one chain and
 * append to another, which is the one way this design could fork a chain.
 */
function assertTenant(tenantId: PlatformTenantId): void {
  const ambient = requireContext().tenantId;
  if (String(tenantId) !== String(ambient)) {
    throw new Error(
      `Audit append names tenant ${String(tenantId)} but the request context is ${String(ambient)}.`,
    );
  }
}

/**
 * The append must be inside the transaction it is recording, and inside *that* caller's.
 *
 * The unit of work is ambient — `AsyncLocalStorage` rather than a handle threaded through — so the
 * check has two halves. There must be a transaction at all, because opening one here would let a
 * rolled-back change leave a permanent record of something that never happened. And a caller that
 * names a handle must name *this* one: `AuditAppendOptions` warns that an adapter which quietly
 * accepts a handle it does not recognise produces exactly that corrupted trail, so a handle from
 * some other unit of work is refused rather than ignored.
 */
function assertAmbientTransaction(tenantId: PlatformTenantId, options: AuditAppendOptions): void {
  assertTenant(tenantId);
  const ambient = currentTransaction();
  if (ambient === null) {
    throw new Error(
      'An audit append must run inside the transaction it is recording. Opening one here would ' +
        'let a rolled-back change leave a permanent record of something that never happened.',
    );
  }
  if (options.transaction !== undefined && options.transaction !== ambient) {
    throw new Error(
      'This adapter joins the ambient unit of work; it cannot adopt a different transaction.',
    );
  }
}
