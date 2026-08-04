import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type DocumentId,
  type DocumentTypeId,
  type NumberOriginKey,
  type NumberReservationId,
  type NumberingRuleId,
  type WorkflowInstanceId,
  AuditSubjectType,
  NumberOrigin,
  NumberReservationState,
  Settings,
  asId,
  calendarDay,
} from '@edms/domain';
import type { Page } from '@edms/utils';

import {
  DuplicateError,
  NotFoundError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { AdministrationAudit } from '../domain/audit-actions';
import {
  type NumberingContext,
  formatNumber,
  matchManualNumber,
  scopeKeyFor,
} from '../domain/numbering';
import type { IssuedNumber, NumberingCodes, NumberingPolicy, NumberingService } from './ports';
import {
  NUMBER_ISSUE_REPOSITORY,
  type IssuableRule,
  type NumberIssueRepository,
  type ReservationListRequest,
  type ReservationRecord,
} from './numbering-issue.ports';

/**
 * Drawing real values from real sequences — the half of `09-numbering-architecture.md` that
 * Phase 2's administration deliberately did not build.
 *
 * Everything here joins the caller's ambient transaction. The counter's row lock is taken by
 * `claimNext`'s single upsert statement and held to commit, and it is always the last lock a
 * transaction takes — the callers already hold their instance and document rows — so approvals
 * in one series serialise on the counter for microseconds and approvals in different series
 * never meet (§2).
 *
 * `YEAR` and `MONTH` render from the **assignment-side instant in the tenant's timezone** —
 * `locale.timezone`, the same clock the working calendar reads — never from `new Date()`'s UTC
 * fields. And they render **once**, when the value is drawn: a reservation drawn in December
 * and approved in January keeps its December text and its December series, because the pending
 * reference reviewers held is the number the document receives. The gap that would otherwise
 * appear in neither year's series appears in the old year's, which is where the value was spent.
 *
 * Every mutation writes its own audit event — the Numbering group of
 * `13-audit-architecture.md` §2 — through the same choreography as every administered write, so
 * an approval's transaction carries its approval entry and its numbering entry or neither.
 */
@Injectable()
export class NumberingIssueService implements NumberingService {
  constructor(
    @Inject(NUMBER_ISSUE_REPOSITORY) private readonly repository: NumberIssueRepository,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly writer: AdministeredWriter,
  ) {}

  async policyFor(documentTypeId: DocumentTypeId): Promise<NumberingPolicy | null> {
    return this.writer.read(async () => {
      const ruleId = await this.repository.ruleIdForDocumentType(documentTypeId);
      if (ruleId === null) {
        return null;
      }
      const rule = await this.repository.ruleShape(ruleId);
      if (rule === null) {
        return null;
      }
      return {
        numberingRuleId: rule.id,
        // Gapless collapses to draw-at-approval through the same path: no reservation exists
        // that could be voided, which is the whole of what the mode guarantees (§2).
        reserveOnSubmit: rule.reserveOnSubmit && !rule.strictGapless,
        strictGapless: rule.strictGapless,
      };
    });
  }

  async reserve(input: {
    readonly numberingRuleId: NumberingRuleId;
    readonly codes: NumberingCodes;
    readonly documentId: DocumentId;
    readonly workflowInstanceId: WorkflowInstanceId;
  }): Promise<IssuedNumber> {
    return this.writer.write(async () => {
      const rule = await this.requireRule(input.numberingRuleId);
      const issued = await this.draw(rule, input.codes);

      await this.repository.insertReservation({
        id: issued.reservationId,
        numberingRuleId: rule.id,
        scopeKey: issued.scopeKey,
        sequenceValue: issued.sequenceValue,
        formatted: issued.formatted,
        state: NumberReservationState.RESERVED,
        origin: NumberOrigin.AUTOMATIC,
        documentId: input.documentId,
        workflowInstanceId: input.workflowInstanceId,
        reservedAt: this.writer.clock.now(),
        assignedAt: null,
        note: null,
      });

      return {
        result: issued,
        change: {
          action: AdministrationAudit.NUMBER_RESERVED,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(input.documentId),
          operation: AdministrativeOperation.CREATED,
          after: {
            formatted: issued.formatted,
            numberingRuleId: rule.id,
            scopeKey: issued.scopeKey,
            sequenceValue: issued.sequenceValue.toString(),
            workflowInstanceId: input.workflowInstanceId,
          },
        },
      };
    });
  }

  async commit(reservationId: NumberReservationId, documentId: DocumentId): Promise<string> {
    return this.writer.write(async () => {
      const reservation = await this.repository.reservationById(reservationId);
      if (reservation === null) {
        throw new NotFoundError('The requested reservation');
      }
      const claimed = await this.repository.markAssigned({
        id: reservationId,
        documentId,
        at: this.writer.clock.now(),
        from: [NumberReservationState.RESERVED],
      });
      if (!claimed) {
        // Voided, already assigned, or held — none of which an approval may spend.
        throw new ValidationError('This reservation can no longer be assigned.', [
          { field: 'reservation', message: reservation.state },
        ]);
      }

      return {
        result: reservation.formatted,
        change: {
          action: AdministrationAudit.NUMBER_ASSIGNED,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(documentId),
          operation: AdministrativeOperation.UPDATED,
          after: {
            formatted: reservation.formatted,
            numberingRuleId: reservation.numberingRuleId,
            scopeKey: reservation.scopeKey,
            sequenceValue: reservation.sequenceValue.toString(),
            origin: reservation.origin,
          },
        },
      };
    });
  }

  async release(reservationId: NumberReservationId, reason: string): Promise<void> {
    await this.writer.write(async () => {
      const reservation = await this.repository.reservationById(reservationId);
      if (reservation === null) {
        throw new NotFoundError('The requested reservation');
      }
      const voided = await this.repository.markVoided({
        id: reservationId,
        reason,
        at: this.writer.clock.now(),
        from: [NumberReservationState.RESERVED],
      });
      if (!voided) {
        throw new ValidationError('This reservation can no longer be voided.', [
          { field: 'reservation', message: reservation.state },
        ]);
      }

      return {
        result: undefined,
        change: {
          action: AdministrationAudit.NUMBER_VOIDED,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(reservation.documentId ?? reservationId),
          operation: AdministrativeOperation.UPDATED,
          after: {
            formatted: reservation.formatted,
            reason,
            // Stated in the entry because it is the guarantee: a voided value is retained and
            // never returns to the pool (§2).
            reusable: false,
          },
        },
      };
    });
  }

  reservationForInstance(workflowInstanceId: WorkflowInstanceId): Promise<IssuedNumber | null> {
    return this.writer.read(async () => {
      const reservation = await this.repository.reservationForInstance(workflowInstanceId);
      return reservation === null ? null : toIssued(reservation);
    });
  }

  pendingForDocument(documentId: DocumentId): Promise<string | null> {
    return this.writer.read(() => this.repository.pendingFormattedForDocument(documentId));
  }

  async assignManual(input: {
    readonly numberingRuleId: NumberingRuleId;
    readonly codes: NumberingCodes;
    readonly documentId: DocumentId;
    readonly requested: string;
    readonly origin: NumberOriginKey;
  }): Promise<IssuedNumber> {
    return this.writer.write(async () => {
      const rule = await this.requireRule(input.numberingRuleId);
      const match = matchManualNumber(rule, input.codes, input.requested);
      if (typeof match === 'string') {
        throw new ValidationError(
          'That number does not match the shape this document numbers under.',
          [{ field: 'documentNumber', message: match }],
        );
      }

      // A legacy number belongs to the series its own text names: `…-2019-0154` fast-forwards
      // 2019's counter, not this year's, so a live series is never spent by an import (§3).
      const context = await this.contextFor(input.codes, match.encodedDate ?? undefined);
      const scopeKey = scopeKeyFor(rule, context);
      const now = this.writer.clock.now();

      const existing = await this.repository.findByFormatted(input.requested);
      let issued: IssuedNumber;
      if (existing === null) {
        await this.repository.fastForward({
          numberingRuleId: rule.id,
          scopeKey,
          past: match.sequenceValue,
          freshId: this.writer.clock.nextId(),
          at: now,
        });
        const reservationId = this.writer.clock.nextId();
        await this.repository.insertReservation({
          id: reservationId,
          numberingRuleId: rule.id,
          scopeKey,
          sequenceValue: match.sequenceValue,
          formatted: input.requested,
          state: NumberReservationState.ASSIGNED,
          origin: input.origin,
          documentId: input.documentId,
          workflowInstanceId: null,
          reservedAt: now,
          assignedAt: now,
          note: null,
        });
        issued = {
          reservationId: asId<NumberReservationId>(reservationId),
          formatted: input.requested,
          sequenceValue: match.sequenceValue,
          scopeKey,
          numberingRuleId: rule.id,
        };
      } else if (existing.state === NumberReservationState.HELD) {
        // The offline process the block was held for has come back. The held row becomes the
        // assignment rather than colliding with it.
        const claimed = await this.repository.markAssigned({
          id: existing.id,
          documentId: input.documentId,
          at: now,
          from: [NumberReservationState.HELD],
        });
        if (!claimed) {
          throw new DuplicateError('document number', 'documentNumber');
        }
        issued = toIssued({ ...existing, documentId: input.documentId });
      } else {
        // Assigned, reserved or voided: the value is spent, and a deleted document's number is
        // spent forever. The same refusal the unique constraints would give, said politely.
        throw new DuplicateError('document number', 'documentNumber');
      }

      return {
        result: issued,
        change: {
          action: AdministrationAudit.NUMBER_ASSIGNED,
          subjectType: AuditSubjectType.DOCUMENT,
          subjectId: asId<AnyId>(input.documentId),
          operation: AdministrativeOperation.UPDATED,
          after: {
            formatted: issued.formatted,
            numberingRuleId: rule.id,
            scopeKey: issued.scopeKey,
            sequenceValue: issued.sequenceValue.toString(),
            origin: input.origin,
          },
        },
      };
    });
  }

  // --- The administration surface: held blocks (§3) ---------------------------------------

  /**
   * Sets a run of values aside for an offline process.
   *
   * Each value is drawn from the counter like any other, so the automatic path can never reach
   * one — the sequence has already moved past the block. One audit event for the whole block:
   * the values are consecutive, and fifty entries saying `HELD` would bury the one fact that
   * matters, which is who set aside how many and why.
   */
  async holdBlock(input: {
    readonly numberingRuleId: NumberingRuleId;
    readonly codes: NumberingCodes;
    readonly count: number;
    readonly note: string | null;
  }): Promise<readonly IssuedNumber[]> {
    return this.writer.write(async () => {
      const rule = await this.requireRule(input.numberingRuleId);
      const now = this.writer.clock.now();
      const values: IssuedNumber[] = [];
      for (let drawn = 0; drawn < input.count; drawn += 1) {
        const issued = await this.draw(rule, input.codes);
        await this.repository.insertReservation({
          id: issued.reservationId,
          numberingRuleId: rule.id,
          scopeKey: issued.scopeKey,
          sequenceValue: issued.sequenceValue,
          formatted: issued.formatted,
          state: NumberReservationState.HELD,
          origin: NumberOrigin.MANUAL,
          documentId: null,
          workflowInstanceId: null,
          reservedAt: now,
          assignedAt: null,
          note: input.note,
        });
        values.push(issued);
      }

      return {
        result: values,
        change: {
          action: AdministrationAudit.NUMBER_RESERVED,
          subjectType: AuditSubjectType.CONFIGURATION,
          subjectId: asId<AnyId>(input.numberingRuleId),
          operation: AdministrativeOperation.CREATED,
          after: {
            held: values.map((value) => value.formatted),
            count: input.count,
            note: input.note,
          },
        },
      };
    });
  }

  /** Voids a held value a controller no longer needs. It is retained, never re-issued. */
  async releaseHeld(reservationId: NumberReservationId, reason: string): Promise<void> {
    await this.writer.write(async () => {
      const reservation = await this.repository.reservationById(reservationId);
      if (reservation === null) {
        throw new NotFoundError('The requested reservation');
      }
      const voided = await this.repository.markVoided({
        id: reservationId,
        reason,
        at: this.writer.clock.now(),
        from: [NumberReservationState.HELD],
      });
      if (!voided) {
        throw new ValidationError('Only a held value can be released here.', [
          { field: 'reservation', message: reservation.state },
        ]);
      }

      return {
        result: undefined,
        change: {
          action: AdministrationAudit.NUMBER_VOIDED,
          subjectType: AuditSubjectType.CONFIGURATION,
          subjectId: asId<AnyId>(reservation.numberingRuleId),
          operation: AdministrativeOperation.UPDATED,
          after: { formatted: reservation.formatted, reason, reusable: false },
        },
      };
    });
  }

  listReservations(
    numberingRuleId: NumberingRuleId,
    request: ReservationListRequest,
  ): Promise<Page<ReservationRecord>> {
    return this.writer.read(() => this.repository.listReservations(numberingRuleId, request));
  }

  // --- Internals ---------------------------------------------------------------------------

  private async requireRule(id: NumberingRuleId): Promise<IssuableRule> {
    const rule = await this.repository.ruleShape(id);
    if (rule === null) {
      throw new NotFoundError('The numbering rule for this document');
    }
    return rule;
  }

  /** Claims the next value of the right series and renders it. The one path every draw takes. */
  private async draw(rule: IssuableRule, codes: NumberingCodes): Promise<IssuedNumber> {
    const context = await this.contextFor(codes);
    const scopeKey = scopeKeyFor(rule, context);
    const sequenceValue = await this.repository.claimNext({
      numberingRuleId: rule.id,
      scopeKey,
      freshId: this.writer.clock.nextId(),
      at: this.writer.clock.now(),
    });
    const { formatted } = formatNumber(rule, context, sequenceValue);
    return {
      reservationId: asId<NumberReservationId>(this.writer.clock.nextId()),
      formatted,
      sequenceValue,
      scopeKey,
      numberingRuleId: rule.id,
    };
  }

  /**
   * The formatter's context: the caller's codes, dated in the tenant's timezone.
   *
   * `YEAR`/`MONTH` come from the drawing instant read on a clock in `locale.timezone` — the
   * same zone the working calendar counts deadlines in — because a number drawn at 23:30 on
   * 31 December in Amman belongs to the year Amman says it is, whatever UTC thinks. The date
   * arrives as a `Date` whose UTC fields carry the zone's wall date, which is the contract the
   * pure formatter states for itself.
   */
  private async contextFor(codes: NumberingCodes, encoded?: Date): Promise<NumberingContext> {
    const assignedAt =
      encoded ??
      new Date(
        `${calendarDay(this.writer.clock.now(), await this.settings.get(Settings.TIMEZONE))}T00:00:00.000Z`,
      );
    return {
      companyCode: codes.companyCode,
      entityCode: codes.entityCode,
      branchCode: codes.branchCode,
      departmentCode: codes.departmentCode,
      documentTypeCode: codes.documentTypeCode,
      categoryCode: codes.categoryCode,
      assignedAt,
    };
  }
}

function toIssued(record: ReservationRecord): IssuedNumber {
  return {
    reservationId: record.id,
    formatted: record.formatted,
    sequenceValue: record.sequenceValue,
    scopeKey: record.scopeKey,
    numberingRuleId: record.numberingRuleId,
  };
}
