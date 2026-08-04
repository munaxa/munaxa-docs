import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import {
  type DocumentId,
  type DocumentTypeId,
  type NumberOriginKey,
  type NumberReservationId,
  type NumberReservationStateKey,
  type NumberingRuleId,
  type WorkflowInstanceId,
  asId,
} from '@edms/domain';
import { type Page, skipFor, toPage } from '@edms/utils';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { NumberSegment } from '../domain/numbering';
import type {
  IssuableRule,
  NewReservation,
  NumberIssueRepository,
  ReservationListRequest,
  ReservationRecord,
} from '../application/numbering-issue.ports';

/**
 * The issuance tables, under the locking rules of `09-numbering-architecture.md` §2.
 *
 * `claimNext` and `fastForward` are raw SQL because Prisma has no single-statement upsert whose
 * conflict arm reads the row it hit — and two statements would reintroduce exactly the window the
 * one statement exists to close.
 */
@Injectable()
export class PrismaNumberIssueRepository implements NumberIssueRepository {
  async ruleShape(id: NumberingRuleId): Promise<IssuableRule | null> {
    const row = await requireTransaction().numberingRule.findFirst({
      where: { id, tenantId: this.tenantId(), deletedAt: null },
      select: {
        id: true,
        separator: true,
        segments: true,
        resetScope: true,
        reserveOnSubmit: true,
        strictGapless: true,
      },
    });
    return row === null
      ? null
      : {
          id: asId<NumberingRuleId>(row.id),
          separator: row.separator,
          segments: row.segments as unknown as readonly NumberSegment[],
          resetScope: row.resetScope,
          reserveOnSubmit: row.reserveOnSubmit,
          strictGapless: row.strictGapless,
        };
  }

  async ruleIdForDocumentType(documentTypeId: DocumentTypeId): Promise<NumberingRuleId | null> {
    const row = await requireTransaction().documentType.findFirst({
      where: { id: documentTypeId, tenantId: this.tenantId(), deletedAt: null },
      select: { numberingRuleId: true },
    });
    return row === null ? null : asId<NumberingRuleId>(row.numberingRuleId);
  }

  async claimNext(input: {
    readonly numberingRuleId: NumberingRuleId;
    readonly scopeKey: string;
    readonly freshId: string;
    readonly at: Date;
  }): Promise<bigint> {
    // The insert arm seeds `next_value = 2` because this call is itself the draw of 1; the
    // conflict arm increments under the row lock the conflict takes. Either way the statement
    // returns the moved-past value, which is the claim.
    const rows = await requireTransaction().$queryRaw<{ claimed: bigint }[]>`
      INSERT INTO number_sequence (id, tenant_id, numbering_rule_id, scope_key, next_value, created_at, updated_at)
      VALUES (${input.freshId}::uuid, ${this.tenantId()}::uuid, ${input.numberingRuleId}::uuid, ${input.scopeKey}, 2, ${input.at}, ${input.at})
      ON CONFLICT (tenant_id, numbering_rule_id, scope_key)
      DO UPDATE SET next_value = number_sequence.next_value + 1, updated_at = ${input.at}
      RETURNING next_value - 1 AS claimed`;
    const claimed = rows[0]?.claimed;
    if (claimed === undefined) {
      throw new Error('Claiming a sequence value returned no row.');
    }
    return claimed;
  }

  async fastForward(input: {
    readonly numberingRuleId: NumberingRuleId;
    readonly scopeKey: string;
    readonly past: bigint;
    readonly freshId: string;
    readonly at: Date;
  }): Promise<void> {
    await requireTransaction().$executeRaw`
      INSERT INTO number_sequence (id, tenant_id, numbering_rule_id, scope_key, next_value, created_at, updated_at)
      VALUES (${input.freshId}::uuid, ${this.tenantId()}::uuid, ${input.numberingRuleId}::uuid, ${input.scopeKey}, ${input.past + 1n}, ${input.at}, ${input.at})
      ON CONFLICT (tenant_id, numbering_rule_id, scope_key)
      DO UPDATE SET next_value = GREATEST(number_sequence.next_value, ${input.past + 1n}), updated_at = ${input.at}`;
  }

  async insertReservation(reservation: NewReservation): Promise<void> {
    await requireTransaction().numberReservation.create({
      data: {
        id: reservation.id,
        tenantId: this.tenantId(),
        numberingRuleId: reservation.numberingRuleId,
        scopeKey: reservation.scopeKey,
        sequenceValue: reservation.sequenceValue,
        formatted: reservation.formatted,
        state: reservation.state,
        origin: reservation.origin,
        documentId: reservation.documentId,
        workflowInstanceId: reservation.workflowInstanceId,
        reservedAt: reservation.reservedAt,
        assignedAt: reservation.assignedAt,
        note: reservation.note,
        createdBy: requireContext().userId,
      },
    });
  }

  async reservationById(id: NumberReservationId): Promise<ReservationRecord | null> {
    const row = await requireTransaction().numberReservation.findFirst({
      where: { id, tenantId: this.tenantId() },
    });
    return row === null ? null : toRecord(row);
  }

  async reservationForInstance(
    workflowInstanceId: WorkflowInstanceId,
  ): Promise<ReservationRecord | null> {
    const row = await requireTransaction().numberReservation.findFirst({
      where: { tenantId: this.tenantId(), workflowInstanceId, state: 'RESERVED' },
    });
    return row === null ? null : toRecord(row);
  }

  async pendingFormattedForDocument(documentId: DocumentId): Promise<string | null> {
    const row = await requireTransaction().numberReservation.findFirst({
      where: { tenantId: this.tenantId(), documentId, state: 'RESERVED' },
      select: { formatted: true },
    });
    return row?.formatted ?? null;
  }

  async findByFormatted(formatted: string): Promise<ReservationRecord | null> {
    const row = await requireTransaction().numberReservation.findFirst({
      where: { tenantId: this.tenantId(), formatted },
    });
    return row === null ? null : toRecord(row);
  }

  async markAssigned(input: {
    readonly id: NumberReservationId;
    readonly documentId: string;
    readonly at: Date;
    readonly from: readonly NumberReservationStateKey[];
  }): Promise<boolean> {
    const result = await requireTransaction().numberReservation.updateMany({
      where: { id: input.id, tenantId: this.tenantId(), state: { in: [...input.from] } },
      data: {
        state: 'ASSIGNED',
        documentId: input.documentId,
        assignedAt: input.at,
        updatedAt: input.at,
      },
    });
    return result.count > 0;
  }

  async markVoided(input: {
    readonly id: NumberReservationId;
    readonly reason: string;
    readonly at: Date;
    readonly from: readonly NumberReservationStateKey[];
  }): Promise<boolean> {
    const result = await requireTransaction().numberReservation.updateMany({
      where: { id: input.id, tenantId: this.tenantId(), state: { in: [...input.from] } },
      data: { state: 'VOIDED', voidReason: input.reason, voidedAt: input.at, updatedAt: input.at },
    });
    return result.count > 0;
  }

  async listReservations(
    numberingRuleId: NumberingRuleId,
    request: ReservationListRequest,
  ): Promise<Page<ReservationRecord>> {
    const tx = requireTransaction();
    const where: Prisma.NumberReservationWhereInput = {
      tenantId: this.tenantId(),
      numberingRuleId,
      ...(request.state !== undefined && { state: request.state }),
    };
    const [rows, total] = await Promise.all([
      tx.numberReservation.findMany({
        where,
        orderBy: { reservedAt: 'desc' },
        skip: skipFor(request),
        take: request.pageSize,
      }),
      tx.numberReservation.count({ where }),
    ]);
    return toPage(rows.map(toRecord), total, request);
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

interface ReservationRow {
  id: string;
  numberingRuleId: string;
  scopeKey: string;
  sequenceValue: bigint;
  formatted: string;
  state: string;
  origin: string;
  documentId: string | null;
  workflowInstanceId: string | null;
  reservedAt: Date;
  assignedAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
  note: string | null;
}

function toRecord(row: ReservationRow): ReservationRecord {
  return {
    id: asId<NumberReservationId>(row.id),
    numberingRuleId: asId<NumberingRuleId>(row.numberingRuleId),
    scopeKey: row.scopeKey,
    sequenceValue: row.sequenceValue,
    formatted: row.formatted,
    state: row.state as NumberReservationStateKey,
    origin: row.origin as NumberOriginKey,
    documentId: row.documentId === null ? null : asId<DocumentId>(row.documentId),
    workflowInstanceId:
      row.workflowInstanceId === null ? null : asId<WorkflowInstanceId>(row.workflowInstanceId),
    reservedAt: row.reservedAt,
    assignedAt: row.assignedAt,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    note: row.note,
  };
}
