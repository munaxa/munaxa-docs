import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, type AuditSubjectTypeKey, AuditOutcome, TenantStatus } from '@edms/domain';

import { AUDIT_WRITER, type AuditActor, type AuditWriter } from '../audit/audit-writer.port';
import { TenantReadOnlyError } from '../errors/application-errors';
import { UNIT_OF_WORK, type UnitOfWork, requireTransaction } from '../prisma/unit-of-work';
import { requireContext } from '../tenancy/tenant-context';
import { RecordStamps } from './record-stamps';

/**
 * The choreography every administrative write repeats: one transaction, one audit event, one
 * actor, one instant.
 *
 * Not a generic repository, deliberately. Each resource keeps its own typed repository and its own
 * explicit rules, because a generic store over eighteen aggregates ends up typed loosely enough
 * that the tenant filter and the soft-delete filter stop being checked — and those are the two
 * clauses whose absence is a disclosure rather than a bug. What is genuinely identical is only
 * this: open the unit of work, do the thing, record that it happened, commit or roll back both.
 *
 * The audit event is written **inside** the transaction. That is the whole point: there is no
 * window in which a document type changed and the trail does not say so, and no window in which
 * the trail claims a change that rolled back (`13-audit-architecture.md`).
 */

/**
 * What was done to the record. The catalogue in `13-audit-architecture.md` §2 names an action per
 * *area* — `ORG_CHANGED`, `TYPE_CHANGED` — so the operation lives in the payload rather than
 * inflating the action list. That keeps compliance reports grouping by an action they already know
 * while "who deleted the QA department" stays answerable from the payload.
 */
export const AdministrativeOperation = {
  CREATED: 'CREATED',
  UPDATED: 'UPDATED',
  DELETED: 'DELETED',
  RESTORED: 'RESTORED',
  MOVED: 'MOVED',
} as const;

export type AdministrativeOperationKey =
  (typeof AdministrativeOperation)[keyof typeof AdministrativeOperation];

export interface AdministrativeChange {
  readonly action: string;
  readonly subjectType: AuditSubjectTypeKey;
  readonly subjectId: AnyId;
  readonly operation: AdministrativeOperationKey;
  /**
   * Only the fields that changed, and never a secret.
   *
   * A password hash, a token or a whole copy of the row would each turn the audit trail into a
   * second store of the data it is describing — one with no soft delete and no retention policy
   * (`13-audit-architecture.md` §3).
   */
  readonly before?: Readonly<Record<string, unknown>>;
  readonly after?: Readonly<Record<string, unknown>>;
}

@Injectable()
export class AdministeredWriter {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    private readonly stamps: RecordStamps,
  ) {}

  /**
   * Runs `work` in one transaction and records one audit event describing it.
   *
   * `work` returns the change to record as well as its own result, rather than being handed a
   * pre-built entry, because what changed is usually only knowable *after* the row is read — a
   * patch's `before` is the row's current state, and nothing outside the transaction has seen it.
   */
  async write<TResult>(
    work: () => Promise<{ readonly result: TResult; readonly change: AdministrativeChange }>,
  ): Promise<TResult> {
    return this.unitOfWork.run(async () => {
      await this.refuseWhenReadOnly();
      const { result, change } = await work();
      await this.audit.write(this.actor(), {
        action: change.action,
        subjectType: change.subjectType,
        subjectId: change.subjectId,
        outcome: AuditOutcome.SUCCESS,
        payload: {
          operation: change.operation,
          ...(change.before ? { before: change.before } : {}),
          ...(change.after ? { after: change.after } : {}),
        },
      });
      return result;
    });
  }

  /** A read that needs a transaction — every repository here joins the ambient one. */
  read<TResult>(work: () => Promise<TResult>): Promise<TResult> {
    return this.unitOfWork.run(work);
  }

  get clock(): RecordStamps {
    return this.stamps;
  }

  /**
   * A suspended tenant is read-only, everywhere (`08-permission-model.md` §4).
   *
   * Checked here rather than per endpoint because "everywhere" is the requirement, and eighteen
   * resources each remembering to check is seventeen chances to forget. Reads are untouched: a
   * suspended tenant can still see its configuration, it just cannot change it.
   *
   * Read from the row rather than from a token claim, inside the transaction that is about to
   * write. A claim would be minted at sign-in and stale for the lifetime of the token, so
   * suspending a tenant would not take effect until everybody's session expired — which is the
   * opposite of what suspension is for. One primary-key read on a mutating request is not a cost
   * worth trading that for.
   *
   * `tenant` is the one table with no row-level security policy, so the filter is explicit here
   * for the same reason it is in the settings repository: nothing else is separating one tenant's
   * row from another's.
   */
  private async refuseWhenReadOnly(): Promise<void> {
    const { tenantId } = requireContext();
    const tenant = await requireTransaction().tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (tenant !== null && tenant.status !== TenantStatus.ACTIVE) {
      throw new TenantReadOnlyError();
    }
  }

  private actor(): AuditActor {
    const context = requireContext();
    return {
      tenantId: context.tenantId,
      userId: context.userId,
      channel: 'WEB',
      correlationId: context.correlationId,
      ipAddress: null,
      userAgent: null,
    };
  }
}
